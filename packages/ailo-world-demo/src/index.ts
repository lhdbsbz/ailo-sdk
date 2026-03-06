#!/usr/bin/env node

import { createInterface } from "readline";
import { startWorldDemoServer } from "./server.js";
import { StateStore } from "./state-store.js";
import { DeviceHub } from "./device-hub.js";

async function promptPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number | null>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("请输入 Ailo World Demo 本地页面端口号: ", (answer) => {
        rl.close();
        const value = Number(answer.trim());
        resolve(!Number.isNaN(value) && value > 0 && value < 65536 ? value : null);
      });
    });
    if (port !== null) return port;
    console.error("无效端口，请输入 1-65535 之间的数字");
  }
}

async function main(): Promise<void> {
  const port = await promptPort();
  const store = new StateStore();
  const hub = new DeviceHub(store);
  const server = startWorldDemoServer({ port, store, hub });

  console.log(`[world-demo] 本地页面已启动: http://localhost:${port}`);
  console.log("[world-demo] 在页面里填写 Ailo 的 ws 地址和一个 endpoint key 即可连接全部设备。");

  const shutdown = async () => {
    console.log("\n[world-demo] 正在关闭...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[world-demo] 启动失败:", error);
  process.exit(1);
});
