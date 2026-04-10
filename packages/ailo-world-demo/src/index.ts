#!/usr/bin/env node

import { promptTCPPort } from "@greatlhd/ailo-endpoint-sdk";
import { startWorldDemoServer } from "./server.js";
import { StateStore } from "./state-store.js";
import { DeviceHub } from "./device-hub.js";

async function main(): Promise<void> {
  const port = await promptTCPPort({
    question: "请输入 Ailo World Demo 本地页面端口号: ",
  });
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
