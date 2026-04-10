/**
 * 工具定义集中管理 — 对齐 tools-contract v1.0。
 *
 * 契约内工具：read/write/edit/apply_patch/glob/grep/bash/bash_output/bash_kill/web_fetch/web_search
 * 契约外业务扩展：webchat_send/mcp_manage
 */

import type { ToolCapability } from "@greatlhd/ailo-endpoint-sdk";

export interface ToolDefinition {
  name: string;
  description: string;
  params?: Record<string, any>;
}

/** 文件工具 — 契约 §3.1-§3.4 */
export const FS_TOOLS: ToolDefinition[] = [
  {
    name: "read",
    description:
      "读取本地文件。返回带行号内容；offset/limit 控制窗口。图片返回 image 部分。前台 edit 前必须先 read（stale 协议）。",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（绝对或相对 cwd）" },
        offset: { type: "integer", description: "起始行号（1-based），默认 1" },
        limit: { type: "integer", description: "最多行数，默认 1000，最大 1000" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "创建或完整覆盖文件。成功后清除 read 状态（下次 edit 前须重新 read）。",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "完整写入内容" },
        encoding: { type: "string", description: "编码，默认 utf-8" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "精确替换文件中一段文本。必须先 read 过且文件未被外部修改（stale 协议）。old_string 须在文件中存在。",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        old_string: { type: "string", description: "待替换文本" },
        new_string: { type: "string", description: "替换后文本" },
        replace_all: { type: "boolean", description: "是否替换所有匹配，默认 false" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "apply_patch",
    description:
      "按补丁格式修改一个或多个文件。input 须包含 *** Begin Patch / *** End Patch，支持 Add/Update/Delete/Move。四级模糊匹配。",
    params: {
      type: "object",
      properties: {
        input: { type: "string", description: "完整补丁文本" },
      },
      required: ["input"],
    },
  },
];

/** 搜索工具 — 契约 §3.5-§3.6 */
export const SEARCH_TOOLS: ToolDefinition[] = [
  {
    name: "glob",
    description:
      "按文件名模式在 target_directory 下递归搜索，跳过 .git/node_modules/隐藏目录。单次最多 200 条。",
    params: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式（支持 * / ? / **）" },
        target_directory: { type: "string", description: "起始目录，必须绝对路径" },
      },
      required: ["pattern", "target_directory"],
    },
  },
  {
    name: "grep",
    description:
      "按正则搜索文件内容（优先调本机 rg，不可用时回退纯 TS）。默认最多 50 条结果。",
    params: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则模式" },
        path: { type: "string", description: "搜索根目录（默认 cwd）" },
        glob: { type: "string", description: "文件名过滤" },
        output_mode: { type: "string", description: "content | files_with_matches，默认 content" },
        head_limit: { type: "integer", description: "最多返回条数，默认 50" },
      },
      required: ["pattern"],
    },
  },
];

/** Shell 工具 — 契约 §3.7-§3.9 */
export const BASH_TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description:
      "执行 shell 命令。默认前台模式：所有前台调用共享持久 bash，cd/export 跨调用保留。预估超 5-10 秒的（dev server、watch）请设 run_in_background=true，后台模式每次新独立 shell，返回 bash_id，之后用 bash_output 读输出、bash_kill 终止。",
    params: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        description: { type: "string", description: "一句话描述意图（仅日志用）" },
        timeout_ms: { type: "integer", description: "前台超时毫秒，默认 120000，最大 600000" },
        run_in_background: { type: "boolean", description: "后台执行，默认 false" },
        workdir: { type: "string", description: "仅后台模式生效；前台请在 command 里 cd" },
      },
      required: ["command"],
    },
  },
  {
    name: "bash_output",
    description:
      "读后台 bash 会话的增量输出。省略 bash_id 列出所有后台会话。filter 可选正则，只保留匹配行。",
    params: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: "后台会话 id；省略则列出所有" },
        filter: { type: "string", description: "正则行过滤" },
      },
    },
  },
  {
    name: "bash_kill",
    description:
      "终止一个后台 bash 会话。先 SIGTERM，2s 后追 SIGKILL。建议之后用 bash_output 确认 closed=true。",
    params: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: "要终止的后台会话 id" },
      },
      required: ["bash_id"],
    },
  },
];

/** 契约外业务扩展 */
export const WEBCHAT_SEND_TOOL: ToolDefinition = {
  name: "webchat_send",
  description:
    "通过配置页网页聊天向用户发消息。需已打开 /chat 并保持 WebSocket。participantName 用于匹配目标用户。",
  params: {
    type: "object",
    properties: {
      text: { type: "string", description: "消息文本" },
      participantName: { type: "string", description: "用户称呼，须与页面一致且在线" },
      attachments: {
        type: "array",
        items: { type: "object", properties: { path: { type: "string", description: "本地绝对路径" } } },
      },
    },
    required: ["text", "participantName"],
  },
};

export function toToolCapabilities(definitions: ToolDefinition[]): ToolCapability[] {
  return definitions.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.params,
  }));
}
