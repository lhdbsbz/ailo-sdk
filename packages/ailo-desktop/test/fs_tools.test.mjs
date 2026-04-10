import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";

import { fsTool } from "../dist/fs_tools.js";
import { validateArgs } from "../dist/param_validator.js";
import { resetToolContext } from "../dist/tool_context.js";

const testDir = path.join(tmpdir(), "fs_tools_test");
const testFile = path.join(testDir, "test.txt");
const testContent = "Hello World\nLine 2\nLine 3\n";

function setup() {
  resetToolContext();
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, testContent, "utf-8");
}

function cleanup() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

test("validateArgs validates required string parameter", () => {
  const result = validateArgs({ path: "/tmp/test" }, {
    path: { type: "string", required: true },
  });
  assert.equal(result.path, "/tmp/test");
});

test("validateArgs throws on missing required parameter", () => {
  assert.throws(
    () => validateArgs({}, { path: { type: "string", required: true } }),
    /参数 "path" 是必需的/,
  );
});

test("read reads existing file", async () => {
  setup();
  const result = await fsTool("read", { path: testFile });
  assert.ok(String(result).includes("Hello World"));
  cleanup();
});

test("read throws on non-existent file", async () => {
  setup();
  await assert.rejects(
    async () => fsTool("read", { path: path.join(testDir, "nonexistent.txt") }),
    /文件不存在/,
  );
  cleanup();
});

test("read resolves relative path from cwd", async () => {
  setup();
  const rel = path.relative(process.cwd(), testFile);
  const result = await fsTool("read", { path: rel });
  assert.ok(String(result).includes("Hello World"));
  cleanup();
});

test("read reads with offset and limit", async () => {
  setup();
  const result = await fsTool("read", { path: testFile, offset: 2, limit: 1 });
  assert.ok(String(result).includes("Line 2"));
  assert.ok(!String(result).includes("Line 3"));
  cleanup();
});

test("write creates new file", async () => {
  setup();
  const newFile = path.join(testDir, "new.txt");
  await fsTool("write", { path: newFile, content: "New content" });
  assert.ok(fs.existsSync(newFile));
  assert.equal(fs.readFileSync(newFile, "utf-8"), "New content");
  cleanup();
});

test("edit replaces string in file", async () => {
  setup();
  fs.writeFileSync(testFile, "Hello World", "utf-8");
  await fsTool("edit", {
    path: testFile,
    old_string: "Hello",
    new_string: "Hi",
  });
  assert.equal(fs.readFileSync(testFile, "utf-8"), "Hi World");
  cleanup();
});

test("apply_patch adds file", async () => {
  setup();
  const newPath = path.join(testDir, "patch-new.txt");
  const patch = `*** Begin Patch
*** Add File: ${newPath}
+hello patch
*** End Patch`;
  const result = await fsTool("apply_patch", { input: patch });
  const text = Array.isArray(result) ? result[0].text : String(result);
  assert.ok(text.includes("Success"));
  assert.ok(fs.existsSync(newPath));
  assert.ok(fs.readFileSync(newPath, "utf-8").includes("hello patch"));
  cleanup();
});

