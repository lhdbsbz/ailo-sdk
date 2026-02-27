/**
 * Skills Manager — three-layer directory management (builtin → customized → active).
 * Compatible with CoPaw's skill format and marketplace protocol.
 */

import { readdir, readFile, writeFile, mkdir, stat, cp, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { installFromUrl, type SkillBundle } from "./skills_hub.js";

const AGENTS_DIR = join(homedir(), ".agents");
const ACTIVE_DIR = join(AGENTS_DIR, "skills");
const CUSTOMIZED_DIR = join(AGENTS_DIR, "customized_skills");
const DISABLED_FILE = join(AGENTS_DIR, "disabled_skills.json");

export interface SkillInfo {
  name: string;
  description: string;
  source: "builtin" | "customized";
  dir: string;
  enabled: boolean;
}

export class SkillsManager {
  private builtinDir: string;

  constructor(builtinDir?: string) {
    this.builtinDir = builtinDir ?? this.resolveBuiltinDir();
  }

  private resolveBuiltinDir(): string {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      return resolve(dirname(thisFile), "../../..", "skills");
    } catch {
      return join(process.cwd(), "skills");
    }
  }

  async init(): Promise<void> {
    await mkdir(ACTIVE_DIR, { recursive: true });
    await mkdir(CUSTOMIZED_DIR, { recursive: true });
    await this.syncToActive();
  }

  private async readDisabledSet(): Promise<Set<string>> {
    try {
      const raw = await readFile(DISABLED_FILE, "utf-8");
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((x): x is string => typeof x === "string"));
    } catch {
      return new Set();
    }
  }

  private async writeDisabledSet(set: Set<string>): Promise<void> {
    await mkdir(AGENTS_DIR, { recursive: true });
    const arr = [...set].sort();
    await writeFile(DISABLED_FILE, JSON.stringify(arr, null, 2), "utf-8");
  }

  async syncToActive(force = false): Promise<void> {
    const builtin = await this.scanDir(this.builtinDir);
    const customized = await this.scanDir(CUSTOMIZED_DIR);
    const merged = new Map<string, string>();
    for (const [name, dir] of builtin) merged.set(name, dir);
    for (const [name, dir] of customized) merged.set(name, dir);

    const disabled = await this.readDisabledSet();

    for (const [name, srcDir] of merged) {
      if (disabled.has(name)) continue;
      const dstDir = join(ACTIVE_DIR, name);
      if (!force && existsSync(join(dstDir, "SKILL.md"))) continue;
      await mkdir(dstDir, { recursive: true });
      await cp(srcDir, dstDir, { recursive: true, force: true });
    }
  }

  async listAll(): Promise<SkillInfo[]> {
    const result: SkillInfo[] = [];
    const activeNames = new Set((await this.scanDir(ACTIVE_DIR)).keys());
    const builtin = await this.scanDir(this.builtinDir);
    const customized = await this.scanDir(CUSTOMIZED_DIR);
    const seen = new Set<string>();

    for (const [name, dir] of customized) {
      seen.add(name);
      const meta = await this.parseMeta(dir, name);
      result.push({ ...meta, source: "customized", dir, enabled: activeNames.has(name) });
    }
    for (const [name, dir] of builtin) {
      if (seen.has(name)) continue;
      const meta = await this.parseMeta(dir, name);
      result.push({ ...meta, source: "builtin", dir, enabled: activeNames.has(name) });
    }
    return result;
  }

  async listAvailable(): Promise<SkillInfo[]> {
    const active = await this.scanDir(ACTIVE_DIR);
    const result: SkillInfo[] = [];
    for (const [name, dir] of active) {
      const meta = await this.parseMeta(dir, name);
      result.push({ ...meta, source: "builtin", dir, enabled: true });
    }
    return result;
  }

  async enableSkill(name: string, force = false): Promise<void> {
    const disabled = await this.readDisabledSet();
    disabled.delete(name);
    await this.writeDisabledSet(disabled);

    let srcDir = join(CUSTOMIZED_DIR, name);
    if (!existsSync(join(srcDir, "SKILL.md"))) {
      srcDir = join(this.builtinDir, name);
    }
    if (!existsSync(join(srcDir, "SKILL.md"))) throw new Error(`Skill not found: ${name}`);
    const dstDir = join(ACTIVE_DIR, name);
    await mkdir(dstDir, { recursive: true });
    await cp(srcDir, dstDir, { recursive: true, force });
  }

  async disableSkill(name: string): Promise<void> {
    const disabled = await this.readDisabledSet();
    disabled.add(name);
    await this.writeDisabledSet(disabled);

    const dir = join(ACTIVE_DIR, name);
    if (existsSync(dir)) await rm(dir, { recursive: true });
  }

  async createSkill(name: string, content: string): Promise<void> {
    const dir = join(CUSTOMIZED_DIR, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content, "utf-8");
  }

  async deleteSkill(name: string): Promise<void> {
    const disabled = await this.readDisabledSet();
    disabled.delete(name);
    await this.writeDisabledSet(disabled);

    const customDir = join(CUSTOMIZED_DIR, name);
    if (existsSync(customDir)) await rm(customDir, { recursive: true });
    const activeDir = join(ACTIVE_DIR, name);
    if (existsSync(activeDir)) await rm(activeDir, { recursive: true });
  }

  async installFromHub(url: string, enable = true): Promise<SkillBundle> {
    const bundle = await installFromUrl(url, CUSTOMIZED_DIR);
    if (enable) await this.enableSkill(bundle.name, true);
    return bundle;
  }

  async getSkillContent(name: string): Promise<string | null> {
    for (const base of [ACTIVE_DIR, CUSTOMIZED_DIR, this.builtinDir]) {
      const path = join(base, name, "SKILL.md");
      try { return await readFile(path, "utf-8"); } catch {}
    }
    return null;
  }

  /**
   * Returns skill meta (name, description, content) for all skills currently in ACTIVE_DIR.
   * Used when connecting to Ailo so only enabled skills are reported to the cloud.
   */
  async getEnabledSkillsMeta(): Promise<{ name: string; description: string; content: string }[]> {
    const active = await this.scanDir(ACTIVE_DIR);
    const result: { name: string; description: string; content: string }[] = [];
    for (const [, dir] of active) {
      const meta = await this.parseSkillMdFromDir(dir);
      if (meta) result.push(meta);
    }
    return result;
  }

  private async parseSkillMdFromDir(dir: string): Promise<{ name: string; description: string; content: string } | null> {
    const skillFile = join(dir, "SKILL.md");
    try {
      const raw = await readFile(skillFile, "utf-8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const dirName = dir.split(/[/\\]/).pop() ?? "skill";
      let name = dirName;
      let description = "";
      let content: string;
      if (trimmed.startsWith("---")) {
        const endIdx = trimmed.indexOf("---", 3);
        if (endIdx > 0) {
          const frontmatter = trimmed.slice(3, endIdx);
          content = trimmed.slice(endIdx + 3).trim();
          for (const line of frontmatter.split("\n")) {
            const colonIdx = line.indexOf(":");
            if (colonIdx < 0) continue;
            const key = line.slice(0, colonIdx).trim().toLowerCase();
            const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
            if (key === "name" && val) name = val;
            if (key === "description" && val) description = val;
          }
        } else {
          content = trimmed;
        }
      } else {
        content = trimmed;
      }
      if (!description) {
        const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#"));
        description = firstLine?.trim().slice(0, 200) ?? name;
      }
      return { name, description, content };
    } catch {
      return null;
    }
  }

  private async scanDir(dir: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(dir, entry.name, "SKILL.md");
        try {
          await stat(skillPath);
          result.set(entry.name, join(dir, entry.name));
        } catch {}
      }
    } catch {}
    return result;
  }

  private async parseMeta(dir: string, fallback: string): Promise<{ name: string; description: string }> {
    try {
      const raw = await readFile(join(dir, "SKILL.md"), "utf-8");
      const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fmMatch) return { name: fallback, description: "" };
      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      return {
        name: nameMatch?.[1]?.trim() ?? fallback,
        description: descMatch?.[1]?.trim() ?? "",
      };
    } catch {
      return { name: fallback, description: "" };
    }
  }
}
