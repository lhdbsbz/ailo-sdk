/**
 * CLI init command for ailo-desktop.
 * Usage: ailo-desktop init [--defaults]
 */

import { createInterface } from "readline";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { SkillsManager } from "./skills_manager.js";

const ENV_PATH = join(process.cwd(), ".env");
const AGENTS_DIR = join(homedir(), ".agents");

async function prompt(question: string, defaultVal = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

export async function runInit(useDefaults = false): Promise<void> {
  console.log("=== Ailo Desktop 初始化 ===\n");

  const wsUrl = useDefaults ? "ws://127.0.0.1:19800/ws" : await prompt("Ailo WebSocket URL", "ws://127.0.0.1:19800/ws");
  const apiKey = useDefaults ? "" : await prompt("API Key (留空稍后配置)");
  const endpointId = useDefaults ? "desktop-01" : await prompt("端点 ID", "desktop-01");
  const displayName = useDefaults ? "桌面Agent" : await prompt("显示名称", "桌面Agent");

  const envContent = [
    `AILO_WS_URL=${wsUrl}`,
    apiKey ? `AILO_API_KEY=${apiKey}` : `# AILO_API_KEY=`,
    `AILO_ENDPOINT_ID=${endpointId}`,
    `DISPLAY_NAME=${displayName}`,
  ].join("\n") + "\n";

  await writeFile(ENV_PATH, envContent, "utf-8");
  console.log(`\n已写入 ${ENV_PATH}`);

  await mkdir(AGENTS_DIR, { recursive: true });
  const skillsMgr = new SkillsManager();
  await skillsMgr.init();
  console.log("Skills 已初始化");

  console.log("\n初始化完成！运行 ailo-desktop 启动桌面端点。");
  console.log(`配置界面: http://127.0.0.1:19801`);
}

// 不在此处自执行：由 index.ts 在子命令 init 时 import 并调用 runInit，避免重复执行。
