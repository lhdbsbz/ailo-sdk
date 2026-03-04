import { exec, spawn, ChildProcess } from "child_process";
import * as os from "os";

type Args = Record<string, unknown>;

const tasks = new Map<string, { proc: ChildProcess; output: string[]; done: boolean }>();
let taskSeq = 0;

export async function execTool(args: Args): Promise<string> {
  const action = args.action as string;
  switch (action) {
    case "run":
      return doRun(args);
    case "poll":
      return doPoll(args);
    case "stop":
      return doStop(args);
    case "list":
      return doList();
    case "write":
      return doWrite(args);
    default:
      throw new Error(`未知 action: ${action}`);
  }
}

async function doRun(args: Args): Promise<string> {
  const command = args.command as string;
  if (!command) throw new Error("command 必填");
  const timeout = ((args.timeout as number) ?? 30) * 1000;

  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    const shell = isWin ? "powershell" : "/bin/sh";
    const wrappedCommand = isWin
      ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
      : command;
    const shellArgs = isWin ? ["-Command", wrappedCommand] : ["-c", command];
    const cwd = (args.cwd as string) || undefined;
    const env = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    const proc = spawn(shell, shellArgs, { stdio: ["pipe", "pipe", "pipe"], cwd, env });

    const output: string[] = [];
    proc.stdout?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));
    proc.stderr?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));

    let finished = false;

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      const text = output.join("").trim();
      const truncated = text.length > 50000 ? text.slice(0, 25000) + "\n...[截断]...\n" + text.slice(-25000) : text;
      resolve(`[exit_code: ${code}]\n${truncated}`);
    });

    setTimeout(() => {
      if (finished) return;
      finished = true;
      taskSeq++;
      const taskId = `task_${taskSeq}`;
      tasks.set(taskId, { proc, output, done: false });
      proc.on("close", () => {
        const t = tasks.get(taskId);
        if (t) t.done = true;
      });
      resolve(`命令超时（${timeout / 1000}s），已转后台运行。taskId: ${taskId}\n已输出:\n${output.join("").slice(-2000)}`);
    }, timeout);
  });
}

function doPoll(args: Args): string {
  const taskId = args.task_id as string;
  if (!taskId) throw new Error("task_id 必填");
  const task = tasks.get(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const text = task.output.join("").trim();
  const status = task.done ? "已完成" : "运行中";
  const tail = text.length > 10000 ? text.slice(-10000) : text;
  return `[${status}]\n${tail}`;
}

function doStop(args: Args): string {
  const taskId = args.task_id as string;
  if (!taskId) throw new Error("task_id 必填");
  const task = tasks.get(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  task.proc.kill();
  tasks.delete(taskId);
  return `已终止任务 ${taskId}`;
}

function doList(): string {
  if (tasks.size === 0) return "没有运行中的任务";
  const lines: string[] = [];
  for (const [id, t] of tasks) {
    lines.push(`${id}: ${t.done ? "已完成" : "运行中"}`);
  }
  return lines.join("\n");
}

function doWrite(args: Args): string {
  const taskId = args.task_id as string;
  const data = args.data as string;
  if (!taskId) throw new Error("task_id 必填");
  if (!data) throw new Error("data 必填");
  const task = tasks.get(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  if (task.done) throw new Error(`任务已完成: ${taskId}`);
  task.proc.stdin?.write(data + "\n");
  return `已向 ${taskId} 发送输入`;
}
