/**
 * BackgroundRegistry — 后台 bash 会话管理。
 * 每个后台命令独立 spawn，按 bash_id 注册；4MB ring buffer + 增量读取 + GC。
 *
 * 对齐 tools-contract §3.7 / §3.8。
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";

const MAX_BUF_BYTES = 4 * 1024 * 1024;
const GC_RETENTION_MS = 10 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;

export interface BackgroundSession {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  closed: boolean;
  exitCode: number | null;
  endedAt: number | null;
}

interface InternalSession extends BackgroundSession {
  proc: ChildProcess;
  buf: string[];
  bufLen: number;
  droppedHeadBytes: number;
  totalWritten: number;
  readOff: number;
}

export class BackgroundRegistry {
  private sessions = new Map<string, InternalSession>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
  }

  spawn(command: string, cwd?: string, extraEnv?: Record<string, string>): BackgroundSession {
    const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();

    const proc = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: resolvedCwd,
      env: {
        ...process.env,
        PS1: "",
        PS2: "",
        PROMPT_COMMAND: "",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        TERM: "dumb",
        ...extraEnv,
      },
    });

    const id = randomUUID();
    const session: InternalSession = {
      id,
      command,
      cwd: resolvedCwd,
      pid: proc.pid ?? 0,
      startedAt: Date.now(),
      closed: false,
      exitCode: null,
      endedAt: null,
      proc,
      buf: [],
      bufLen: 0,
      droppedHeadBytes: 0,
      totalWritten: 0,
      readOff: 0,
    };

    const appendBuf = (data: Buffer | string) => {
      const s = typeof data === "string" ? data : data.toString("utf-8");
      session.totalWritten += s.length;
      session.buf.push(s);
      session.bufLen += s.length;
      while (session.bufLen > MAX_BUF_BYTES && session.buf.length > 1) {
        const dropped = session.buf.shift()!;
        session.bufLen -= dropped.length;
        session.droppedHeadBytes += dropped.length;
      }
    };

    proc.stdout?.on("data", appendBuf);
    proc.stderr?.on("data", appendBuf);
    proc.on("close", (code) => {
      session.closed = true;
      session.exitCode = code ?? -1;
      session.endedAt = Date.now();
    });

    this.sessions.set(id, session);
    return this.toPublic(session);
  }

  get(id: string): BackgroundSession | undefined {
    const s = this.sessions.get(id);
    return s ? this.toPublic(s) : undefined;
  }

  list(): BackgroundSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => this.toPublic(s));
  }

  readDelta(id: string): { output: string; droppedHeadBytes: number } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const full = s.buf.join("");
    const start = Math.max(0, s.readOff - s.droppedHeadBytes);
    const slice = full.slice(start);
    s.readOff = s.totalWritten;
    return { output: slice, droppedHeadBytes: s.droppedHeadBytes };
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.closed) return true;
    try {
      s.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!s.closed) {
        try {
          s.proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 2000);
    return true;
  }

  close(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const s of this.sessions.values()) {
      if (!s.closed) {
        try {
          s.proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    this.sessions.clear();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.closed && s.endedAt && now - s.endedAt > GC_RETENTION_MS) {
        this.sessions.delete(id);
      }
    }
  }

  private toPublic(s: InternalSession): BackgroundSession {
    return {
      id: s.id,
      command: s.command,
      cwd: s.cwd,
      pid: s.pid,
      startedAt: s.startedAt,
      closed: s.closed,
      exitCode: s.exitCode,
      endedAt: s.endedAt,
    };
  }
}
