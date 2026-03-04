/**
 * CLI init command for ailo-desktop.
 * Usage: ailo-desktop init [--defaults]
 */

import { createInterface } from "readline";
import { mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { writeConfig } from "@lmcl/ailo-endpoint-sdk";
import { SkillsManager } from "./skills_manager.js";
import { CONFIG_FILENAME } from "./constants.js";

const CONFIG_PATH = join(process.cwd(), CONFIG_FILENAME);
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

  const config = {
    ailo: {
      wsUrl,
      apiKey: apiKey || "",
      endpointId,
    },
  };

  writeConfig(CONFIG_PATH, config);
  console.log(`\n已写入 ${CONFIG_PATH}`);

  await mkdir(AGENTS_DIR, { recursive: true });
  const skillsMgr = new SkillsManager();
  await skillsMgr.init();
  console.log("Skills 已初始化");

  console.log("\n初始化完成！运行 ailo-desktop 启动桌面端点。");
  console.log("配置界面端口：启动时用 --port <端口> 指定，或运行后在控制台按提示输入。");
}
