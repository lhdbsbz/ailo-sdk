import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface BlobUploadResult {
  fileRef: string;
}

export interface BlobClientOptions {
  httpBase: string;
  apiKey: string;
}

export class BlobClient {
  constructor(private opts: BlobClientOptions) {}

  async upload(localPath: string): Promise<BlobUploadResult> {
    const absPath = path.resolve(localPath);
    const fileBuffer = fs.readFileSync(absPath);
    const fileName = path.basename(absPath);

    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), fileName);

    const res = await fetch(`${this.opts.httpBase}/api/blob/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`blob upload failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as { file_ref: string };
    return { fileRef: json.file_ref };
  }

  async download(blobUrl: string): Promise<string> {
    const tmpDir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ailo_blob_"))));
    const fileName = blobUrl.split("/").pop() || `blob_${Date.now()}`;
    const tmpFile = path.join(tmpDir, `${Date.now()}_${fileName}`);

    const res = await fetch(blobUrl, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`blob download failed: ${res.status}`);
    }

    fs.writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
    return tmpFile;
  }
}

export function deriveHttpBase(wsUrl: string): string {
  let base = wsUrl.replace(/\/ws\/?$/, "");
  if (base.startsWith("wss://")) base = base.replace("wss://", "https://");
  else if (base.startsWith("ws://")) base = base.replace("ws://", "http://");
  return base;
}
