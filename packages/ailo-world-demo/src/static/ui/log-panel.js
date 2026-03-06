function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderLogs(container, snapshot) {
  if (!snapshot) return;
  container.innerHTML = "";
  snapshot.logs.slice(-90).forEach((log) => {
    const row = document.createElement("div");
    row.className = "log-row";
    const levelClass = `log-${log.level}`;
    row.innerHTML = `
      <span>${new Date(log.ts).toLocaleTimeString()}</span>
      <span class="${levelClass}">${log.level === "up" ? "↑" : log.level === "down" ? "↓" : "•"}</span>
      <span>${escapeHtml(log.name)}</span>
      <span>${escapeHtml(log.message)}</span>
    `;
    container.appendChild(row);
  });
  container.scrollTop = container.scrollHeight;
}
