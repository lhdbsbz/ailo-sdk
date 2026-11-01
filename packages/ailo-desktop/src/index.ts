#!/usr/bin/env node
/**
 * Ailo Desktop —— 一台电脑作为肢体。
 *
 * 它只有动作：文件读写、搜索、shell、补丁。没有技能、没有 MCP 客户端、没有聊天界面：
 * 那些都是大脑的事。它上报的东西只有两类：动作结果，以及（可选）观测。
 *
 * 子命令：ailo-desktop init [--defaults] [--config-dir <path>] —— 生成 config.json。
 */

const [, , subcommand] = process.argv;
if (subcommand === "init") {
  import("./cli.js")
    .then(({ runInit }) => {
      const args = process.argv.slice(2);
      let useDefaults = false;
      let configDir: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--defaults") useDefaults = true;
        else if ((args[i] === "--config-dir" || args[i] === "-c") && args[i + 1]) configDir = args[++i];
      }
      return runInit(useDefaults, configDir)
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e);
          process.exit(1);
        });
    })
    .catch((e) => {
      console.error("init 加载失败:", e);
      process.exit(1);
    });
}

import {
  runBody,
  ConsoleLogger,
  createComponentLogger,
  loadConnectionConfig,
  hasValidConfig,
  type Action,
  type ActionHandler,
  type AiloConnectionConfig,
} from "@greatlhd/ailo-body";
import { join } from "path";
import { FS_TOOLS, SEARCH_TOOLS, BASH_TOOLS, toActions } from "./tool_definitions.js";
import { fsTool } from "./fs_tools.js";
import { PersistentShell } from "./persistent_shell.js";
import { BackgroundRegistry } from "./background_registry.js";
import { bashTool } from "./bash_tool.js";
import { bashOutputTool } from "./bash_output_tool.js";
import { bashKillTool } from "./bash_kill_tool.js";
import { globTool } from "./glob_tool.js";
import { grepTool } from "./grep_tool.js";
import { CONFIG_FILENAME } from "./constants.js";
import { errMsg } from "./utils.js";
import { resetToolContext } from "./tool_context.js";
import { setBlobStore } from "./media_bridge.js";

const logger = createComponentLogger("main", new ConsoleLogger("[desktop]"));

function parseArgs(): { configDir?: string } {
  const args = process.argv.slice(2);
  let configDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config-dir" || args[i] === "-c") && args[i + 1]) configDir = args[++i];
  }
  return { configDir };
}

const { configDir: CLI_CONFIG_DIR } = parseArgs();

// ──────────────────────────────────────────────────────────────
// 运行时状态
// ──────────────────────────────────────────────────────────────

const persistentShell = new PersistentShell();
const bgRegistry = new BackgroundRegistry();

// ──────────────────────────────────────────────────────────────
// 动作表
// ──────────────────────────────────────────────────────────────

function buildActions(): Action[] {
  return [
    ...toActions(FS_TOOLS),
    ...toActions(SEARCH_TOOLS),
    ...toActions(BASH_TOOLS),
  ];
}

const FS_ACTION_NAMES = ["read", "write", "edit", "apply_patch"];

function buildHandlers(): Record<string, ActionHandler> {
  const handlers: Record<string, ActionHandler> = {};

  handlers.bash = (args) => bashTool(persistentShell, bgRegistry, args);
  handlers.bash_output = (args) => bashOutputTool(bgRegistry, args);
  handlers.bash_kill = (args) => bashKillTool(bgRegistry, args);
  handlers.glob = (args) => globTool(args);
  handlers.grep = (args) => grepTool(args);

  for (const name of FS_ACTION_NAMES) {
    handlers[name] = (args) => fsTool(name, args);
  }

  return handlers;
}

// ──────────────────────────────────────────────────────────────
// 主函数
// ──────────────────────────────────────────────────────────────

function main(): void {
  const configDir = CLI_CONFIG_DIR ?? process.cwd();
  const configPath = join(configDir, CONFIG_FILENAME);
  logger.info(`配置目录: ${configDir}`);

  const initial = loadConnectionConfig(configPath);
  if (!hasValidConfig(initial)) {
    logger.error(
      `未找到有效的连接配置（${configPath} 的 ailo 段，或 AILO_WS_URL / AILO_API_KEY / AILO_BODY_ID）。` +
        `先跑 ailo-desktop init 生成一份。`,
    );
    process.exit(1);
  }

  startBody(initial, configPath);
}

function startBody(cfg: AiloConnectionConfig, configPath: string): void {
  runBody({
    url: cfg.url,
    apiKey: cfg.apiKey,
    bodyId: cfg.bodyId,
    name: `电脑 ${cfg.bodyId}`,
    description: "这台电脑：文件读写、搜索、shell（一次性命令与常驻终端）、补丁。路径按 cwd 或绝对路径解析。",
    actions: buildActions(),
    handlers: buildHandlers(),
    onConnectFailure: async (err) => {
      // 配置可能被人工改过：每次重试都重新读盘，而不是拿进程启动时的快照重试到天荒地老。
      logger.error(`连接失败：${err.message}；2s 后按最新配置重试`);
      await new Promise((r) => setTimeout(r, 2000));
      const latest = loadConnectionConfig(configPath);
      if (!hasValidConfig(latest)) {
        logger.error("最新配置无效，退出");
        process.exit(1);
      }
      Object.assign(cfg, latest);
    },
    handler: {
      start: async (ctx) => {
        // 图片这类媒体要先上传成 Blob：工具是纯函数，只能从桥上取通道。
        setBlobStore(ctx.media);
        logger.info("肢体已就绪");
      },
      stop: async () => {
        logger.info("肢体正在停止");
        setBlobStore(null);
        resetToolContext();
        persistentShell.close();
        bgRegistry.close();
      },
    },
  });
}

try {
  main();
} catch (e) {
  logger.error(errMsg(e));
  process.exit(1);
}
