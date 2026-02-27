import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import * as fs from "fs";
import * as path from "path";
import mime from "mime-types";

export async function sendFile(ctx: EndpointContext, filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`路径不是文件: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const mimeType = (mime.lookup(filePath) || "application/octet-stream") as string;
  const mediaType = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("audio/")
      ? "audio"
      : mimeType.startsWith("video/")
        ? "video"
        : "file";

  await ctx.accept({
    content: [
      {
        type: mediaType as "image" | "audio" | "video" | "file",
        media: {
          type: mediaType,
          base64: buf.toString("base64"),
          mime: mimeType,
          name: path.basename(filePath),
        },
      },
    ],
    contextTags: [],
    requiresResponse: false,
  });

  return `文件已发送：${path.basename(filePath)}`;
}
