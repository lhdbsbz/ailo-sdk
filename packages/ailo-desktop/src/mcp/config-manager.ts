import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface MCPServerConfig {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

const CONFIG_DIR = join(homedir(), ".agents");
const CONFIG_PATH = join(CONFIG_DIR, "mcp_config.json");

export class MCPConfigManager {
  private configs = new Map<string, MCPServerConfig>();
  private lastMtime = 0;

  getConfigPath(): string {
    return CONFIG_PATH;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const data = JSON.parse(raw) as MCPConfigFile;
      this.configs.clear();
      for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
        this.configs.set(name, cfg);
      }
      try {
        const s = await stat(CONFIG_PATH);
        this.lastMtime = s.mtimeMs;
      } catch {}
    } catch {
      // no config file yet
    }
  }

  async save(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    const data: MCPConfigFile = { mcpServers: Object.fromEntries(this.configs) };
    await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
    try {
      const s = await stat(CONFIG_PATH);
      this.lastMtime = s.mtimeMs;
    } catch {}
  }

  get(name: string): MCPServerConfig | undefined {
    return this.configs.get(name);
  }

  set(name: string, config: MCPServerConfig): void {
    this.configs.set(name, config);
  }

  delete(name: string): boolean {
    return this.configs.delete(name);
  }

  getAll(): Map<string, MCPServerConfig> {
    return new Map(this.configs);
  }

  getLastMtime(): number {
    return this.lastMtime;
  }

  async checkChanged(): Promise<boolean> {
    try {
      const s = await stat(CONFIG_PATH);
      return s.mtimeMs > this.lastMtime;
    } catch {
      return false;
    }
  }
}
