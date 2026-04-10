import { appStore, type AppState } from './index.js';
import { ConsoleLogger, createComponentLogger, type EndpointContext } from "@greatlhd/ailo-endpoint-sdk";

const logger = createComponentLogger("store", new ConsoleLogger("[desktop]"));

let endpointCtx: EndpointContext | null = null;

export function setEndpointContext(ctx: EndpointContext | null): void {
  endpointCtx = ctx;
}

export function getEndpointContext(): EndpointContext | null {
  return endpointCtx;
}

function setupMCPEffects(): void {
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  appStore.subscribe((state: AppState) => {
    if (!endpointCtx) return;

    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      if (!endpointCtx) return;

      try {
        await endpointCtx.update({
          register: { mcpTools: state.mcp.tools },
        });
        logger.info(`MCP 工具同步: ${state.mcp.tools.length} 个`);
      } catch (e) {
        logger.error("MCP 工具同步失败:", { error: e });
      }
    }, 500);
  });
}

function setupAiloEffects(): void {
  appStore.subscribe((state: AppState) => {
    const { connected, endpointId } = state.ailo;
    if (connected) {
      logger.info(`Ailo 已连接 (${endpointId})`);
    } else {
      logger.info("Ailo 未连接");
    }
  });
}

export function initEffects(): void {
  setupMCPEffects();
  setupAiloEffects();
  logger.info("副作用系统已初始化");
}
