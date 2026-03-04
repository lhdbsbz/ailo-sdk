/** 纯工具函数：post 解析、markdown 适配、@提及提取 */
type PostNode = { tag: string; text?: string; image_key?: string; [k: string]: unknown };

export function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function getPostContentRows(contentJson: string): PostNode[][] | null {
  try {
    const root = JSON.parse(contentJson) as {
      content?: PostNode[][];
      post?: { zh_cn?: { content?: PostNode[][] }; en?: { content?: PostNode[][] } };
    };
    let content: PostNode[][] | null | undefined = root?.content;
    if (!Array.isArray(content) && root?.post) {
      content = (root.post.zh_cn ?? root.post.en)?.content ?? null;
    }
    return Array.isArray(content) ? content : null;
  } catch {
    return null;
  }
}

export function extractTextFromPostContent(contentJson: string): string {
  const content = getPostContentRows(contentJson);
  if (!content) return "";
  const parts: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    const rowParts: string[] = [];
    for (const node of row) {
      if (node?.tag === "text" && typeof node.text === "string") {
        rowParts.push(node.text);
      } else if (node?.tag === "at" && typeof node.user_id === "string") {
        const name = typeof node.user_name === "string" ? node.user_name : "";
        rowParts.push(name ? `@${name}` : `@${node.user_id}`);
      } else if (node?.tag === "a" && typeof node.text === "string") {
        rowParts.push(node.text);
      }
    }
    if (rowParts.length > 0) parts.push(rowParts.join(""));
  }
  return parts.join("\n");
}

export function extractImageKeysFromPostContent(contentJson: string): string[] {
  const content = getPostContentRows(contentJson);
  if (!content) return [];
  const keys: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (node?.tag === "img" && typeof node.image_key === "string") keys.push(node.image_key);
    }
  }
  return keys;
}

export type MentionElement = { userId: string; name: string };

export function extractMentionElements(
  text: string,
  nameToIdCache?: Map<string, string>
): { cleanText: string; atElements: MentionElement[] } {
  const atElements: MentionElement[] = [];
  const seenIds = new Set<string>();

  let cleanText = text.replace(
    /@([^@(]+?)\(([a-zA-Z0-9][a-zA-Z0-9_]{9,})\)/g,
    (_, displayName: string, userId: string) => {
      if (!seenIds.has(userId)) {
        atElements.push({ userId, name: displayName.trim() });
        seenIds.add(userId);
      }
      return "";
    }
  );

  if (nameToIdCache?.size) {
    const names = [...nameToIdCache.keys()].sort((a, b) => b.length - a.length);
    for (const name of names) {
      const openId = nameToIdCache.get(name)!;
      const atMention = `@${name}`;
      if (cleanText.includes(atMention)) {
        if (!seenIds.has(openId)) {
          atElements.push({ userId: openId, name });
          seenIds.add(openId);
        }
        cleanText = cleanText.replaceAll(atMention, "");
      }
    }
  }

  cleanText = cleanText.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, atElements };
}

export function adaptMarkdownForFeishu(text: string): string {
  return text
    .replace(/^#{3,}\s+(.+)$/gm, "**$1**")
    .replace(/^[ \t]+([-*])\s/gm, "$1 ")
    .replace(/^[ \t]+(\d+\.)\s/gm, "$1 ");
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padEnd(str: string, targetWidth: number): string {
  return str + " ".repeat(Math.max(0, targetWidth - getDisplayWidth(str)));
}

export function convertMarkdownTablesToCodeBlock(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) return;
    const rows: string[][] = [];
    for (const line of tableLines) {
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      rows.push(cells);
    }
    if (rows.length === 0) {
      result.push(...tableLines);
      tableLines = [];
      return;
    }
    const colCount = Math.max(...rows.map((r) => r.length));
    const colWidths = Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) colWidths[i] = Math.max(colWidths[i], getDisplayWidth(row[i]));
    }
    const formatted: string[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      formatted.push(rows[ri].map((cell, ci) => padEnd(cell, colWidths[ci])).join(" | "));
      if (ri === 0 && rows.length > 1) formatted.push(colWidths.map((w) => "-".repeat(w)).join("-+-"));
    }
    result.push("```", ...formatted, "```");
    tableLines = [];
  };

  for (const line of lines) {
    if (/^\s*\|/.test(line)) tableLines.push(line);
    else {
      if (tableLines.length > 0) flushTable();
      result.push(line);
    }
  }
  if (tableLines.length > 0) flushTable();
  return result.join("\n");
}
