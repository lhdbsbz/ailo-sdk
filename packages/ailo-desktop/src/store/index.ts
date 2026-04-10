import { ConsoleLogger, createComponentLogger } from "@greatlhd/ailo-endpoint-sdk";
import type { AppState, MCPServerState, AiloState } from "./types.js";

const logger = createComponentLogger("store", new ConsoleLogger("[desktop]"));

export interface Subscriber<T> {
  (state: T): void;
}

export interface Unsubscribe {
  (): void;
}

export class Store<T extends object> {
  private state: T;
  private subscribers = new Set<Subscriber<T>>();

  constructor(initialState: T) {
    this.state = initialState;
  }

  getState(): Readonly<T> {
    return this.state;
  }

  setState(updater: (state: T) => T): void {
    const newState = updater(this.state);
    if (newState === this.state) return;
    this.state = newState;
    this.notify();
  }

  subscribe(subscriber: Subscriber<T>): Unsubscribe {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(this.state);
      } catch (e) {
        logger.error("subscriber error:", { error: e });
      }
    }
  }
}

export type { AppState, MCPServerState, AiloState, MCPServiceStatus } from "./types.js";

export const appStore = new Store<AppState>({
  ailo: {
    connected: false,
    endpointId: "",
    tools: [],
  },
  mcp: {
    servers: new Map(),
    tools: [],
  },
});

export const actions = {
  setAiloConnected(connected: boolean, endpointId?: string): void {
    appStore.setState((s) => ({
      ...s,
      ailo: { ...s.ailo, connected, endpointId: endpointId ?? s.ailo.endpointId },
    }));
  },

  setAiloState(partial: Partial<AiloState>): void {
    appStore.setState((s) => ({
      ...s,
      ailo: { ...s.ailo, ...partial },
    }));
  },

  updateMCPServer(name: string, serverState: MCPServerState): void {
    appStore.setState((s) => {
      const servers = new Map(s.mcp.servers);
      servers.set(name, serverState);
      const tools = Array.from(servers.values())
        .filter((sv) => sv.status === "running")
        .flatMap((sv) => sv.tools);
      return { ...s, mcp: { servers, tools } };
    });
  },

  removeMCPServer(name: string): void {
    appStore.setState((s) => {
      const servers = new Map(s.mcp.servers);
      servers.delete(name);
      const tools = Array.from(servers.values())
        .filter((sv) => sv.status === "running")
        .flatMap((sv) => sv.tools);
      return { ...s, mcp: { servers, tools } };
    });
  },

  syncMCPFromManager(
    servers: Map<string, { config: MCPServerState["config"]; running: boolean; tools: MCPServerState["tools"] }>,
  ): void {
    appStore.setState((s) => {
      const newServers = new Map<string, MCPServerState>();
      for (const [name, info] of servers) {
        newServers.set(name, {
          name,
          status: info.running ? "running" : "stopped",
          tools: info.tools,
          config: info.config,
        });
      }
      const tools = Array.from(newServers.values())
        .filter((sv) => sv.status === "running")
        .flatMap((sv) => sv.tools);
      return { ...s, mcp: { servers: newServers, tools } };
    });
  },
};
