const TOGGLE_MAP = {
  light:       { on: "set_brightness", onArgs: { brightness: 80 }, off: "turn_off",    offArgs: {},                  key: "on" },
  ac:          { on: "set_temp",       onArgs: { temp: 24 },       off: "turn_off",    offArgs: {},                  key: "on" },
  speaker:     { on: "play",           onArgs: { music: "轻音乐" }, off: "pause",       offArgs: {},                  key: "playing" },
  lock:        { on: "lock",           onArgs: {},                  off: "unlock",      offArgs: {},                  key: "locked" },
  curtain:     { on: "open",           onArgs: {},                  off: "close",       offArgs: {},                  key: null, toggleByStatus: true },
  camera:      { on: "detect_motion",  onArgs: {},                  off: "set_mode",    offArgs: { mode: "watch" },   key: null, toggleByStatus: true },
  washer:      { on: "start_wash",     onArgs: { mode: "standard" },off: "get_status",  offArgs: {},                  key: null, toggleByStatus: true },
  charger:     { on: "start_charge",   onArgs: {},                  off: "stop_charge", offArgs: {},                  key: "charging" },
  purifier:    { on: "set_mode",       onArgs: { mode: "turbo" },   off: "set_mode",    offArgs: { mode: "auto" },    key: null, toggleByStatus: true },
  fridge:      { on: "set_temp",       onArgs: { temp: 2 },         off: "set_temp",    offArgs: { temp: 4 },         key: null, toggleByCustom: (d) => Number(d.attrs?.temp ?? 4) < 3 },
  screen:      { on: "start_meeting",  onArgs: {},                  off: "end_meeting", offArgs: {},                  key: "meeting" },
  watch:       { on: "get_heart_rate", onArgs: {},                  off: "get_steps",   offArgs: {},                  key: null, alwaysToggle: true },
  envMonitor:  { on: "get_temp",       onArgs: {},                  off: "get_humidity", offArgs: {},                 key: null, alwaysToggle: true },
};

function isDeviceOn(device, mapping) {
  if (!device) return false;
  if (mapping.alwaysToggle) return Math.random() > 0.5;
  if (mapping.toggleByCustom) return mapping.toggleByCustom(device);
  if (mapping.key) return Boolean(device.attrs?.[mapping.key]);
  if (mapping.toggleByStatus) {
    return !["idle", "offline", "off", "docked", "locked", "watching"].includes(device.status);
  }
  return false;
}

function createTooltip() {
  const el = document.createElement("div");
  el.className = "device-tooltip";
  el.style.cssText = "display:none;";
  document.body.appendChild(el);
  return el;
}

export function initDeviceInteraction(api, getSnapshot) {
  const tooltip = createTooltip();
  let dragState = null;

  async function sendAction(endpointId, tool, args = {}) {
    try {
      await api.request("/api/device/action", {
        method: "POST",
        body: JSON.stringify({ endpointId, tool, args }),
      });
    } catch (e) {
      console.error("device action failed:", e);
    }
  }

  document.addEventListener("pointerover", (e) => {
    const sprite = e.target.closest("[data-device]");
    if (!sprite) return;
    const snap = getSnapshot();
    if (!snap) return;
    const device = snap.devices.find((d) => d.endpointId === sprite.dataset.device);
    if (!device) return;
    tooltip.textContent = `${device.icon} ${device.name} · ${device.summary}`;
    tooltip.style.display = "block";
    positionTooltip(tooltip, sprite);
  });

  document.addEventListener("pointerout", (e) => {
    const sprite = e.target.closest("[data-device]");
    if (sprite) tooltip.style.display = "none";
  });

  document.addEventListener("pointerdown", (e) => {
    const sprite = e.target.closest("[data-device]");
    if (!sprite) return;
    const id = sprite.dataset.device;
    const snap = getSnapshot();
    if (!snap) return;
    const device = snap.devices.find((d) => d.endpointId === id);
    if (!device) return;

    if (device.movable) {
      e.preventDefault();
      const sceneBody = sprite.closest(".scene-body") || sprite.closest(".room");
      if (!sceneBody) return;
      const rect = sceneBody.getBoundingClientRect();
      dragState = { id, sprite, sceneBody, rect, startX: e.clientX, startY: e.clientY, moved: false };
      sprite.style.zIndex = "20";
      sprite.style.transition = "none";
      sprite.setPointerCapture(e.pointerId);
    }
  });

  document.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragState.moved = true;
    if (!dragState.moved) return;

    const left = ((e.clientX - dragState.rect.left) / dragState.rect.width) * 100;
    const top = ((e.clientY - dragState.rect.top) / dragState.rect.height) * 100;
    dragState.sprite.style.left = `${Math.max(5, Math.min(95, left))}%`;
    dragState.sprite.style.top = `${Math.max(5, Math.min(95, top))}%`;
    tooltip.style.display = "none";
  });

  document.addEventListener("pointerup", (e) => {
    if (!dragState) return;
    const { id, sprite, rect, moved } = dragState;
    sprite.style.zIndex = "";
    sprite.style.transition = "";
    dragState = null;

    if (moved) {
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      sendAction(id, "move", { x: +x.toFixed(3), y: +y.toFixed(3) });
      return;
    }

    handleClick(id);
  });

  document.addEventListener("click", (e) => {
    const sprite = e.target.closest("[data-device]");
    if (!sprite) return;
    const snap = getSnapshot();
    if (!snap) return;
    const device = snap.devices.find((d) => d.endpointId === sprite.dataset.device);
    if (device?.movable) return;
    handleClick(sprite.dataset.device);
  });

  function handleClick(endpointId) {
    const snap = getSnapshot();
    if (!snap) return;
    const device = snap.devices.find((d) => d.endpointId === endpointId);
    if (!device) return;

    const mapping = TOGGLE_MAP[device.type];
    if (mapping) {
      const on = isDeviceOn(device, mapping);
      const tool = on ? mapping.off : mapping.on;
      const args = on ? mapping.offArgs : mapping.onArgs;
      sendAction(endpointId, tool, args);
      showFeedback(device, !on);
      return;
    }

    if (device.type === "vacuum") {
      const cleaning = device.status === "cleaning";
      sendAction(endpointId, cleaning ? "dock" : "clean");
      return;
    }
    if (device.type === "car") {
      const running = Boolean(device.attrs?.engine);
      sendAction(endpointId, running ? "stop_engine" : "start_engine");
      return;
    }
    if (device.type === "mower") {
      sendAction(endpointId, device.status === "working" ? "dock" : "mow");
      return;
    }
    if (device.type === "poolRobot") {
      sendAction(endpointId, device.status === "cleaning" ? "dock" : "clean");
      return;
    }
    if (device.type === "patrolRobot") {
      sendAction(endpointId, device.status === "patrolling" ? "get_status" : "patrol");
      return;
    }
    if (device.type === "serviceRobot") {
      sendAction(endpointId, "deliver_item", { item: "矿泉水", room: "412" });
      return;
    }
    if (device.type === "guideRobot") {
      sendAction(endpointId, "guide", { department: "内科" });
      return;
    }
    if (device.type === "streetlight") {
      const bright = Number(device.attrs?.brightness ?? 60);
      sendAction(endpointId, "set_brightness", { brightness: bright > 30 ? 0 : 80 });
      return;
    }
  }

  function showFeedback(device, turnedOn) {
    const sprite = document.querySelector(`[data-device="${device.endpointId}"]`);
    if (!sprite) return;
    sprite.classList.add("user-acted");
    setTimeout(() => sprite.classList.remove("user-acted"), 600);
  }
}

function positionTooltip(tooltip, anchor) {
  const r = anchor.getBoundingClientRect();
  tooltip.style.left = `${r.left + r.width / 2}px`;
  tooltip.style.top = `${r.top - 8}px`;
}
