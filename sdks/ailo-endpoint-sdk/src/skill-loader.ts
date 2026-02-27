/**
 * skill-loader.ts — Scans local SKILL.md files and parses them into SkillMeta[].
 *
 * Compatible with the ~/.agents/skills/ convention used by Cursor, CoPaw and others.
 * Each skill lives in its own subdirectory with a SKILL.md file:
 *
 *   ~/.agents/skills/
 *     pdf-processing/
 *       SKILL.md          ← YAML frontmatter (name, description) + markdown body
 *     ui-analysis/
 *       SKILL.md
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { SkillMeta } from "./types.js";

/**
 * Scan one or more directories for `*​/SKILL.md` files, parse frontmatter, return SkillMeta[].
 * Directories that don't exist are silently skipped.
 */
export function loadSkills(dirs?: string[]): SkillMeta[] {
  const resolved = (dirs && dirs.length > 0)
    ? dirs
    : [path.join(os.homedir(), ".agents", "skills")];

  const skills: SkillMeta[] = [];
  const seen = new Set<string>();

  for (const dir of resolved) {
    const expanded = dir.startsWith("~")
      ? path.join(os.homedir(), dir.slice(1))
      : dir;

    if (!fs.existsSync(expanded)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(expanded, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(expanded, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      try {
        const raw = fs.readFileSync(skillFile, "utf-8");
        const meta = parseSkillMd(raw, entry.name);
        if (meta) {
          if (seen.has(meta.name)) {
            const idx = skills.findIndex((s) => s.name === meta.name);
            if (idx >= 0) skills[idx] = meta;
          } else {
            seen.add(meta.name);
            skills.push(meta);
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return skills;
}

/**
 * Parse a SKILL.md file with optional YAML frontmatter.
 *
 * Frontmatter format:
 * ```
 * ---
 * name: pdf-processing
 * description: Extract text and tables from PDF files
 * ---
 * (markdown body)
 * ```
 *
 * If no frontmatter, `dirName` is used as the name and the first non-empty line as description.
 */
function parseSkillMd(raw: string, dirName: string): SkillMeta | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

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
}
