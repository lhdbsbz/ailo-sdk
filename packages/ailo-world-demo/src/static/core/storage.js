const WS_KEY = "ailo-world-demo-ws";
const API_KEY = "ailo-world-demo-key";

export function loadConnectionForm(elements) {
  const wsUrl = localStorage.getItem(WS_KEY);
  const apiKey = localStorage.getItem(API_KEY);
  if (wsUrl) elements.wsUrl.value = wsUrl;
  if (apiKey) elements.apiKey.value = apiKey;
}

export function saveConnectionForm(elements) {
  localStorage.setItem(WS_KEY, elements.wsUrl.value.trim());
  localStorage.setItem(API_KEY, elements.apiKey.value.trim());
}
