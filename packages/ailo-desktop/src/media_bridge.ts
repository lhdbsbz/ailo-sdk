import type { BlobStore, ContentPart } from "@greatlhd/ailo-body";

/**
 * 工具是纯函数，拿不到运行时上下文；图片这类媒体必须先上传成 Blob 才能引用，
 * 所以由入口把 BlobStore 挂到这里。没挂就等于没有媒体通道，调用会明确报错。
 */
let store: BlobStore | null = null;

export function setBlobStore(next: BlobStore | null): void {
  store = next;
}

export async function uploadLocalFile(localPath: string): Promise<ContentPart> {
  if (!store) throw new Error("blob store not ready: body is not connected yet");
  const ref = await store.upload(localPath);
  return { type: "blob", id: ref.id, mime: ref.mime, name: ref.name, size: ref.size };
}
