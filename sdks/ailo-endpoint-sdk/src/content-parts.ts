import type { ContentPart } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isContentParts(value: unknown): value is ContentPart[] {
  return Array.isArray(value) && value.every(
    (part) => typeof part === "object" && part !== null && "type" in part,
  );
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text;
  } catch {}
  return String(value);
}

export function toContentPart(result: unknown): ContentPart {
  if (isContentParts(result) && result.length === 1) return result[0];
  return { type: "text", text: stringifyValue(result) };
}

export function toContentParts(result: unknown): ContentPart[] | undefined {
  if (result === undefined) return undefined;
  if (isContentParts(result)) return result;
  return [{ type: "text", text: stringifyValue(result) }];
}
