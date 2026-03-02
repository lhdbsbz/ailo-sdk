/**
 * Skills Hub client — compatible with skills.sh, clawhub.ai, skillsmp.com, GitHub.
 * Downloads SKILL.md + references/ + scripts/ bundles from any supported marketplace URL.
 */

import { get as httpsGet } from "https";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { readConfig } from "@lmcl/ailo-endpoint-sdk";

export interface SkillBundle {
  name: string;
  skillMd: string;
  files: Map<string, string>; // relative path → content
}

type Source = "skills_sh" | "clawhub" | "skillsmp" | "github";

export function detectSource(url: string): Source | null {
  const u = new URL(url);
  const host = u.hostname.replace("www.", "");
  if (host === "skills.sh") return "skills_sh";
  if (host === "clawhub.ai") return "clawhub";
  if (host === "skillsmp.com") return "skillsmp";
  if (host === "github.com") return "github";
  return null;
}

export async function installFromUrl(url: string, targetDir: string): Promise<SkillBundle> {
  const source = detectSource(url);
  if (!source) throw new Error(`Unsupported URL: ${url}. Supported: skills.sh, clawhub.ai, skillsmp.com, github.com`);

  let bundle: SkillBundle;
  switch (source) {
    case "skills_sh": bundle = await fetchSkillsSh(url); break;
    case "clawhub": bundle = await fetchClawhub(url); break;
    case "skillsmp": bundle = await fetchSkillsmp(url); break;
    case "github": bundle = await fetchGitHub(url); break;
  }

  const skillDir = join(targetDir, bundle.name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), bundle.skillMd, "utf-8");
  for (const [relPath, content] of bundle.files) {
    const fullPath = join(skillDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  return bundle;
}

// --- skills.sh ---
// Format: https://skills.sh/{owner}/{repo}/{skill}
async function fetchSkillsSh(url: string): Promise<SkillBundle> {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 3) throw new Error("skills.sh URL must be: skills.sh/{owner}/{repo}/{skill}");
  const [owner, repo, skill] = parts;
  const dirs = [`skills/${skill}`, skill];
  for (const dir of dirs) {
    try {
      return await fetchGitHubDir(owner, repo, "main", dir, skill);
    } catch {
      try { return await fetchGitHubDir(owner, repo, "master", dir, skill); } catch {}
    }
  }
  throw new Error(`Skill not found in ${owner}/${repo}: tried ${dirs.join(", ")}`);
}

// --- clawhub.ai ---
// Format: https://clawhub.ai/{slug}
async function fetchClawhub(url: string): Promise<SkillBundle> {
  const u = new URL(url);
  const slug = u.pathname.split("/").filter(Boolean).pop();
  if (!slug) throw new Error("clawhub URL must contain a slug");
  const cfg = readConfig(join(process.cwd(), "config.json")) as Record<string, unknown>;
  const hubBase = (process.env.COPAW_SKILLS_HUB_BASE_URL || cfg.skillsHubBaseUrl as string) ?? "https://clawhub.ai";
  const meta = await httpJson(`${hubBase}/api/v1/skills/${slug}`) as any;
  const repoUrl = meta.repo_url ?? meta.github_url;
  if (!repoUrl) throw new Error(`No repo_url found for skill ${slug}`);
  return fetchGitHub(repoUrl);
}

// --- skillsmp.com ---
// Format: https://skillsmp.com/{slug}
// Slug: openclaw-openclaw-skills-himalaya-skill-md → owner/repo/skill_hint
async function fetchSkillsmp(url: string): Promise<SkillBundle> {
  const u = new URL(url);
  const slug = u.pathname.split("/").filter(Boolean).pop();
  if (!slug) throw new Error("skillsmp URL must contain a slug");
  const parts = slug.split("-");
  if (parts.length < 3) throw new Error(`Cannot parse skillsmp slug: ${slug}`);
  const owner = parts[0];
  const repo = parts.slice(1, 3).join("-");
  const skillHint = parts.slice(3).join("-").replace(/-skill-md$/, "");
  const dirs = [skillHint, `skills/${skillHint}`];
  for (const dir of dirs) {
    try { return await fetchGitHubDir(owner, repo, "main", dir, skillHint); } catch {}
    try { return await fetchGitHubDir(owner, repo, "master", dir, skillHint); } catch {}
  }
  throw new Error(`Skill not found: ${owner}/${repo} hint=${skillHint}`);
}

// --- GitHub ---
// Format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
// or: https://github.com/{owner}/{repo}/blob/{branch}/{path}/SKILL.md
async function fetchGitHub(url: string): Promise<SkillBundle> {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub URL must be: github.com/{owner}/{repo}/...");
  const owner = parts[0];
  const repo = parts[1];

  if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "blob")) {
    const branch = parts[3];
    let dirPath = parts.slice(4).join("/");
    if (dirPath.endsWith("/SKILL.md") || dirPath.endsWith("SKILL.md")) {
      dirPath = dirPath.replace(/\/?SKILL\.md$/, "");
    }
    const name = dirPath.split("/").pop() || repo;
    return fetchGitHubDir(owner, repo, branch, dirPath, name);
  }

  return fetchGitHubDir(owner, repo, "main", "", repo);
}

// --- Core GitHub fetcher ---
async function fetchGitHubDir(owner: string, repo: string, branch: string, dirPath: string, name: string): Promise<SkillBundle> {
  const prefix = dirPath ? `${dirPath}/` : "";
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  const entries = await httpJson(apiUrl) as Array<{ name: string; path: string; type: string; download_url: string }>;

  if (!Array.isArray(entries)) {
    if ((entries as any).name === "SKILL.md") {
      const content = await httpText((entries as any).download_url);
      return { name, skillMd: content, files: new Map() };
    }
    throw new Error(`Not a directory: ${dirPath}`);
  }

  const skillEntry = entries.find((e) => e.name === "SKILL.md");
  if (!skillEntry) throw new Error(`SKILL.md not found in ${owner}/${repo}/${dirPath}`);

  const skillMd = await httpText(skillEntry.download_url);
  const files = new Map<string, string>();

  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue;
    if (entry.type === "file") {
      const relPath = entry.path.replace(prefix, "");
      try {
        const content = await httpText(entry.download_url);
        files.set(relPath, content);
      } catch {}
    } else if (entry.type === "dir") {
      await fetchGitHubDirRecursive(owner, repo, branch, entry.path, prefix, files);
    }
  }

  return { name, skillMd, files };
}

async function fetchGitHubDirRecursive(
  owner: string, repo: string, branch: string, dirPath: string, rootPrefix: string, files: Map<string, string>,
): Promise<void> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  try {
    const entries = await httpJson(apiUrl) as Array<{ name: string; path: string; type: string; download_url: string }>;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const relPath = entry.path.replace(rootPrefix, "");
      if (entry.type === "file") {
        try {
          const content = await httpText(entry.download_url);
          files.set(relPath, content);
        } catch {}
      } else if (entry.type === "dir") {
        await fetchGitHubDirRecursive(owner, repo, branch, entry.path, rootPrefix, files);
      }
    }
  } catch {}
}

// --- HTTP helpers ---
function httpJson(url: string): Promise<unknown> {
  return httpText(url).then((t) => JSON.parse(t));
}

function httpText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "User-Agent": "ailo-desktop/1.0" };
    const cfg = readConfig(join(process.cwd(), "config.json")) as Record<string, unknown>;
    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (cfg.githubToken as string) || "";
    if (ghToken && url.includes("api.github.com")) headers.Authorization = `token ${ghToken}`;

    const doReq = (reqUrl: string, redirects = 0) => {
      if (redirects > 5) { reject(new Error("Too many redirects")); return; }
      const mod = reqUrl.startsWith("https") ? require("https") : require("http");
      mod.get(reqUrl, { headers }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doReq(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      }).on("error", reject);
    };
    doReq(url);
  });
}
