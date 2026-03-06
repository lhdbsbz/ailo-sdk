import { createApiClient } from "./core/api.js";
import { loadConnectionForm, saveConnectionForm } from "./core/storage.js";
import { renderDevicePanel } from "./ui/device-panel.js";
import { renderLogs } from "./ui/log-panel.js";
import { renderScenarioBar } from "./ui/scenario-bar.js";
import { createWorldStage } from "./scenes/world-stage.js";
import { initDeviceInteraction } from "./ui/device-interact.js";

const state = { snapshot: null };
const api = createApiClient();
const worldStage = createWorldStage(document.getElementById("world-stage"));

const elements = {
  form: document.getElementById("connect-form"),
  wsUrl: document.getElementById("ailo-ws-url"),
  apiKey: document.getElementById("ailo-api-key"),
  disconnect: document.getElementById("disconnect-btn"),
  reset: document.getElementById("reset-btn"),
  scenarios: document.getElementById("scenario-list"),
  connectedCount: document.getElementById("connected-count"),
  deviceList: document.getElementById("device-list"),
  logList: document.getElementById("log-list"),
  clearLog: document.getElementById("clear-log-btn"),
};

function applySnapshot() {
  if (!state.snapshot) return;
  renderScenarioBar(elements.scenarios, state.snapshot, (id) => api.runScenario(id));
  renderDevicePanel(elements.deviceList, elements.connectedCount, state.snapshot);
  renderLogs(elements.logList, state.snapshot);
  worldStage.update(state.snapshot);
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveConnectionForm(elements);
  await api.connectAll(elements.wsUrl.value.trim(), elements.apiKey.value.trim());
});

elements.disconnect.addEventListener("click", async () => {
  await api.disconnectAll();
});

elements.reset.addEventListener("click", async () => {
  await api.resetAll();
});

elements.clearLog.addEventListener("click", () => {
  if (!state.snapshot) return;
  state.snapshot.logs = [];
  renderLogs(elements.logList, state.snapshot);
});

async function init() {
  loadConnectionForm(elements);
  worldStage.ensureStage();
  initDeviceInteraction(api, () => state.snapshot);
  state.snapshot = await api.loadState();
  applySnapshot();
  api.connectStateStream((msg) => {
    if (msg.type === "snapshot") {
      state.snapshot = msg.payload;
      applySnapshot();
      return;
    }
    if (msg.type === "log" && state.snapshot) {
      state.snapshot.logs.push(msg.payload);
      if (state.snapshot.logs.length > 250) state.snapshot.logs.shift();
      renderLogs(elements.logList, state.snapshot);
    }
  });
}

init().catch((error) => {
  console.error(error);
  alert(`初始化失败: ${error.message}`);
});
