/**
 * PersistentShell — 进程内单例的常驻 bash，前台命令共享，cd/export 跨调用保留。
 * 用 sentinel marker 切分命令边界并捕获 exit code。
 *
 * 对齐 tools-contract §3.7：超时一律重建 shell + shell_reset:true。
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as readline from "readline";
import { PassThrough } from "stream";

const MARKER_PREFIX = "__AILO_END_";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface RunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  shellReset: boolean;
  truncated: boolean;
}

export class PersistentShell {
  private proc: ChildProcess | null = null;
  private merged: PassThrough | null = null;
  private rl: readline.Interface | null = null;
  private running = false;

  async run(command: string, timeoutMs: number): Promise<RunResult> {
    if (this.running) {
      throw new Error("persistent shell is busy (concurrent call not allowed)");
    }
    this.running = true;
    try {
      return await this._run(command, timeoutMs);
    } finally {
      this.running = false;
    }
  }

  private ensureStarted(): void {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return;
    }
    this.proc = null;
    this.rl = null;

    const proc = spawn("bash", ["--noprofile", "--norc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PS1: "",
        PS2: "",
        PROMPT_COMMAND: "",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        TERM: "dumb",
      },
    });
    const merged = new PassThrough();
    proc.stdout?.pipe(merged, { end: false });
    proc.stderr?.pipe(merged, { end: false });
    this.proc = proc;
    this.merged = merged;
    this.rl = readline.createInterface({ input: merged });

    proc.on("exit", () => {
      this.proc = null;
      this.merged = null;
      this.rl = null;
    });
  }

  private async prime(): Promise<void> {
    const token = randomUUID().replace(/-/g, "");
    const marker = MARKER_PREFIX + token + ":";
    const script = `printf '\\n${marker}%d\\n' 0\n`;
    this.proc!.stdin!.write(script);
    await this.readUntilMarker(marker, 5000);
  }

  private async _run(command: string, timeoutMs: number): Promise<RunResult> {
    this.ensureStarted();
    if (!this.proc || !this.rl) {
      throw new Error("failed to start persistent shell");
    }

    const needsPrime = this.proc.pid !== undefined;
    if (needsPrime) {
      try {
        await this.prime();
      } catch {
        this.reset();
        this.ensureStarted();
        if (!this.proc || !this.rl) {
          throw new Error("failed to restart persistent shell");
        }
        await this.prime();
      }
    }

    const token = randomUUID().replace(/-/g, "");
    const marker = MARKER_PREFIX + token + ":";
    // < /dev/null 防止用户命令从 stdin 读取（read、cat 等），否则会吞掉后续 sentinel marker
    const script = `{ ${command}\n} < /dev/null 2>&1\nprintf '\\n${marker}%d\\n' "$?"\n`;
    this.proc.stdin!.write(script);

    try {
      const result = await this.readUntilMarker(marker, timeoutMs);
      return result;
    } catch (err: unknown) {
      if (err instanceof TimeoutError) {
        this.reset();
        return {
          output: err.partialOutput,
          exitCode: 0,
          timedOut: true,
          shellReset: true,
          truncated: err.truncated,
        };
      }
      this.reset();
      throw err;
    }
  }

  private readUntilMarker(marker: string, timeoutMs: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const lines: string[] = [];
      let totalLen = 0;
      let truncated = false;
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new TimeoutError(lines.join("\n"), truncated));
      }, timeoutMs);

      const onLine = (line: string) => {
        if (done) return;
        if (line.startsWith(marker)) {
          done = true;
          clearTimeout(timer);
          cleanup();
          const codeStr = line.slice(marker.length).trim();
          const exitCode = parseInt(codeStr, 10) || 0;
          let output = lines.join("\n");
          if (output.endsWith("\n")) {
            output = output.slice(0, -1);
          }
          resolve({ output, exitCode, timedOut: false, shellReset: false, truncated });
          return;
        }
        if (!truncated) {
          if (totalLen + line.length + 1 > MAX_OUTPUT_BYTES) {
            truncated = true;
          } else {
            lines.push(line);
            totalLen += line.length + 1;
          }
        }
      };

      const onClose = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("persistent shell closed unexpectedly"));
      };

      const cleanup = () => {
        this.rl?.off("line", onLine);
        this.rl?.off("close", onClose);
      };

      this.rl!.on("line", onLine);
      this.rl!.on("close", onClose);
    });
  }

  reset(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.rl?.close();
    this.merged?.destroy();
    this.proc = null;
    this.merged = null;
    this.rl = null;
  }

  close(): void {
    this.reset();
  }
}

class TimeoutError extends Error {
  constructor(
    public partialOutput: string,
    public truncated: boolean,
  ) {
    super("timeout");
  }
}
