import { describe, it, expect } from "vitest";
import {
  isRecord,
  isContentParts,
  stringifyValue,
  toContentPart,
  toContentParts,
} from "../src/content-parts.js";

describe("content-parts", () => {
  it("isRecord", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(true);
  });

  it("isContentParts", () => {
    expect(isContentParts([{ type: "text", text: "a" }])).toBe(true);
    expect(isContentParts([])).toBe(true);
    expect(isContentParts([{ foo: 1 }])).toBe(false);
    expect(isContentParts("x")).toBe(false);
  });

  it("stringifyValue", () => {
    expect(stringifyValue("hi")).toBe("hi");
    expect(stringifyValue(42)).toBe("42");
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
  });

  it("toContentPart unwraps single-part array", () => {
    const one = [{ type: "text" as const, text: "x" }];
    expect(toContentPart(one)).toEqual(one[0]);
  });

  it("toContentPart wraps scalar", () => {
    expect(toContentPart(99)).toEqual({ type: "text", text: "99" });
  });

  it("toContentParts", () => {
    expect(toContentParts(undefined)).toBeUndefined();
    const parts = [{ type: "text" as const, text: "y" }];
    expect(toContentParts(parts)).toEqual(parts);
    expect(toContentParts("z")).toEqual([{ type: "text", text: "z" }]);
  });
});
