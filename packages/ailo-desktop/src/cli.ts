/**
 * CLI init command for ailo-desktop.
 * Usage: ailo-desktop init [--defaults] [--config-dir <path>]
 */

import { createInterface } from "readline";
import { join, resolve } from "path";
import { mkdirSync } from "fs";
import { writeConfig } from "@greatlhd/ailo-endpoint-sdk";
import { CONFIG_FILENAME } from "./constants.js";

function parseCliArgs(): { useDefaults: boolean; configDir: string } {
  const args = process.argv.slice(2);
  let useDefaults = false;
  let configDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--defaults") {
      useDefaults = true;
    } else if ((args[i] === "--config-dir" || args[i] === "-c") && args[i + 1]) {
      configDir = resolve(args[++i]);
    }
  }

  return { useDefaults, configDir };
}

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

export async function runInit(useDefaultsArg?: boolean, configDirArg?: string): Promise<void> {
  const { useDefaults, configDir } = useDefaultsArg !== undefined && configDirArg !== undefined
    ? { useDefaults: useDefaultsArg, configDir: configDirArg }
    : parseCliArgs();

  console.log("=== Ailo Desktop 初始化 ===\n");
  console.log(`配置目录: ${configDir}\n`);

  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, CONFIG_FILENAME);

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

  writeConfig(configPath, config);
  console.log(`\n已写入 ${configPath}`);

  console.log("\n初始化完成！运行以下命令启动桌面端点：");
  console.log(`  ailo-desktop --config-dir ${configDir} --port 3000`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runInit().catch(console.error);
}
