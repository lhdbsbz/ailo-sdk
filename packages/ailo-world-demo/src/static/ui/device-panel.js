function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderDevicePanel(container, counterEl, snapshot) {
  if (!snapshot) return;

  const grouped = new Map();
  snapshot.devices.forEach((device) => {
    const list = grouped.get(device.scene) || [];
    list.push(device);
    grouped.set(device.scene, list);
  });

  container.innerHTML = "";
  snapshot.scenes.forEach((scene) => {
    const devices = grouped.get(scene.id);
    if (!devices || devices.length === 0) return;
    const block = document.createElement("div");
    block.className = "scene-block";
    const title = document.createElement("div");
    title.className = "scene-title";
    title.textContent = scene.label;
    title.style.color = scene.accent;
    block.appendChild(title);

    devices.forEach((device) => {
      const row = document.createElement("div");
      row.className = "device-row";
      row.innerHTML = `
        <div class="status-dot ${device.connected ? "online" : ""}"></div>
        <div class="device-main">
          <div class="device-name">${device.icon} ${device.name}</div>
          <div class="device-summary">${escapeHtml(device.summary)}</div>
          <div class="device-status">${escapeHtml(device.status)} · <span class="device-endpoint">${device.endpointId}</span></div>
        </div>
      `;
      block.appendChild(row);
    });

    container.appendChild(block);
  });

  counterEl.textContent = `${snapshot.connectedCount}/${snapshot.devices.length} 个独立 Endpoint 在线`;
}
