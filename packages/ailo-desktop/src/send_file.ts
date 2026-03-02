import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import * as fs from "fs";
import * as path from "path";

export async function sendFile(ctx: EndpointContext, filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`路径不是文件: ${filePath}`);
  }
  const fileRef = await ctx.sendFile(filePath);
  return `文件已发送：${path.basename(filePath)} (${fileRef})`;
}
