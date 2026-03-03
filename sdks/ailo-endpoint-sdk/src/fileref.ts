/**
 * FileRef URI utilities — internal transport mechanism only.
 *
 * FileRef URIs are used internally by Gateway and endpoint SDK for Blob-based
 * file transfer. The LLM never sees these URIs; it works with (endpoint_id, path)
 * tuples instead. Endpoint tools only operate on local paths.
 *
 * URI formats:
 *   ailo://blob/{blob_id}              — Server-side Blob storage
 *   ailo://ep:{endpoint_id}/{abs_path} — Endpoint-local file
 */

const FILEREF_SCHEME = "ailo://";
const FILEREF_BLOB_PREFIX = "ailo://blob/";
const FILEREF_EP_PREFIX = "ailo://ep:";

export type FileRefType = "blob" | "endpoint";

export interface FileRef {
  type: FileRefType;
  blobId?: string;
  endpointId?: string;
  path?: string;
  raw: string;
}

export function parseFileRef(uri: string): FileRef {
  if (!uri.startsWith(FILEREF_SCHEME)) {
    throw new Error(`Not a FileRef URI: ${uri}`);
  }

  if (uri.startsWith(FILEREF_BLOB_PREFIX)) {
    const blobId = uri.slice(FILEREF_BLOB_PREFIX.length);
    if (!blobId) throw new Error(`Empty blob id in: ${uri}`);
    return { type: "blob", blobId, raw: uri };
  }

  if (uri.startsWith(FILEREF_EP_PREFIX)) {
    const rest = uri.slice(FILEREF_EP_PREFIX.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) throw new Error(`Missing endpoint id or path in: ${uri}`);
    const endpointId = rest.slice(0, slashIdx);
    const path = rest.slice(slashIdx + 1);
    if (!path) throw new Error(`Empty path in: ${uri}`);
    return { type: "endpoint", endpointId, path, raw: uri };
  }

  throw new Error(`Unknown FileRef type: ${uri}`);
}

export function isFileRef(s: string): boolean {
  return s.startsWith(FILEREF_SCHEME);
}
