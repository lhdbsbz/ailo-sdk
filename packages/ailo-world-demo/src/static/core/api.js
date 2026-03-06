export function createApiClient() {
  let ws;

  async function request(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    return data;
  }

  function connectStateStream(onMessage) {
    if (ws) ws.close();
    ws = new WebSocket(`ws://${location.host}/demo/ws`);
    ws.onmessage = (event) => onMessage(JSON.parse(event.data));
    return ws;
  }

  return {
    request,
    connectStateStream,
    async loadState() {
      return request("/api/state");
    },
    async connectAll(ailoWsUrl, apiKey) {
      return request("/api/connect", {
        method: "POST",
        body: JSON.stringify({ ailoWsUrl, apiKey }),
      });
    },
    async disconnectAll() {
      return request("/api/disconnect", { method: "POST", body: "{}" });
    },
    async runScenario(id) {
      return request("/api/scenario/run", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
    },
    async resetAll() {
      return request("/api/reset", { method: "POST", body: "{}" });
    },
  };
}
