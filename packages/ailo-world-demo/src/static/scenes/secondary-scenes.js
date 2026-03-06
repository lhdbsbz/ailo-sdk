function boolAttr(device, key, fallback = false) {
  return Boolean(device?.attrs?.[key] ?? fallback);
}

function numAttr(device, key, fallback = 0) {
  const value = Number(device?.attrs?.[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function positionByNormalized(device, area) {
  return {
    left: area.left + device.x * area.width,
    top: area.top + device.y * area.height,
  };
}

function setSprite(refs, deviceId, left, top, extraClass = "", rotationDeg = 0) {
  const el = refs.devices[deviceId];
  if (!el) return;
  const preserved = [...el.classList].filter((name) => !["cleaning", "playing", "alerting", "moving", "charging", "active", "on", "running", "unlocked", "tracking", "engine-on", "lit", "working", "open"].includes(name));
  el.className = `${preserved.join(" ")} ${extraClass}`.trim();
  el.style.left = `${left}%`;
  el.style.top = `${top}%`;
  el.style.transform = `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
}

export function secondaryScenesMarkup() {
  return `
    <section class="scene-card office" data-scene="office">
      <div class="scene-header"><div class="scene-name">公司</div><div class="scene-sub">办公区 / 会议室 / 花园</div></div>
      <div class="status-badge" data-scene-status="office">未连接</div>
      <div class="scene-body">
        <div class="env-overlay" data-env="office"></div>
        <div class="room-card office-floor"></div>
        <div class="grass"></div>
        <div class="furniture desk-main"></div>
        <div class="furniture meeting-table"></div>
        <div class="furniture desk-chair"></div>
        <div class="meeting-chair c1"></div>
        <div class="meeting-chair c2"></div>
        <div class="meeting-chair c3"></div>
        <div class="meeting-chair c4"></div>
        <div class="office-screen-wall"></div>
        <div class="device-sprite robot secondary" data-device="office-mower"></div>
        <div class="device-sprite speaker" data-device="office-screen" style="width:88px;height:56px;border-radius:12px;"></div>
        <div class="device-sprite light-switch" data-device="office-light"></div>
        <div class="device-sprite ac" data-device="office-ac"><div class="airflow"></div></div>
      </div>
    </section>

    <section class="scene-card hotel" data-scene="hotel">
      <div class="scene-header"><div class="scene-name">酒店</div><div class="scene-sub">客房 / 走廊 / 服务机器人</div></div>
      <div class="status-badge" data-scene-status="hotel">未连接</div>
      <div class="scene-body">
        <div class="env-overlay" data-env="hotel"></div>
        <div class="room-card hotel-room" style="left:8%;top:16%;width:56%;height:68%;"></div>
        <div class="corridor"></div>
        <div class="hotel-bed"></div>
        <div class="hotel-headboard"></div>
        <div class="hotel-side-table"></div>
        <div class="hotel-luggage"></div>
        <div class="hotel-window">
          <div class="hotel-curtain-panel left" data-hotel-curtain-left></div>
          <div class="hotel-curtain-panel right" data-hotel-curtain-right></div>
        </div>
        <div class="device-sprite robot secondary" data-device="hotel-robot"></div>
        <div class="device-sprite light-switch" data-device="hotel-light"></div>
        <div class="device-sprite ac" data-device="hotel-ac"><div class="airflow"></div></div>
        <div class="device-sprite curtain-switch" data-device="hotel-curtain"></div>
      </div>
    </section>

    <section class="scene-card car" data-scene="car">
      <div class="scene-header"><div class="scene-name">汽车</div><div class="scene-sub">城市道路 / 停车位 / 行驶路径</div></div>
      <div class="status-badge" data-scene-status="car">未连接</div>
      <div class="scene-body">
        <div class="env-overlay" data-env="car"></div>
        <div class="road road-main"></div>
        <div class="road road-vertical"></div>
        <div class="parking-bay"></div>
        <div class="crosswalk"></div>
        <div class="signal-light"></div>
        <div class="device-sprite car" data-device="car-system"></div>
      </div>
    </section>

    <section class="scene-card hospital" data-scene="hospital">
      <div class="scene-header"><div class="scene-name">医院</div><div class="scene-sub">大厅 / 导诊 / 环境监测</div></div>
      <div class="status-badge" data-scene-status="hospital">未连接</div>
      <div class="scene-body">
        <div class="hall"></div>
        <div class="reception-desk"></div>
        <div class="waiting-seat s1"></div>
        <div class="waiting-seat s2"></div>
        <div class="hospital-sign"></div>
        <div class="device-sprite robot secondary" data-device="hospital-guide"></div>
        <div class="device-sprite monitor" data-device="hospital-monitor"></div>
      </div>
    </section>

    <section class="scene-card city" data-scene="city">
      <div class="scene-header"><div class="scene-name">城市</div><div class="scene-sub">智慧路灯 / 充电桩 / 泳池</div></div>
      <div class="status-badge" data-scene-status="city">未连接</div>
      <div class="scene-body">
        <div class="env-overlay" data-env="city"></div>
        <div class="city-walkway"></div>
        <div class="city-lawn"></div>
        <div class="pool"></div>
        <div class="charging-bay"></div>
        <div class="device-sprite streetlight" data-device="city-streetlight"></div>
        <div class="device-sprite charger" data-device="city-charger"></div>
        <div class="device-sprite robot secondary" data-device="city-pool-robot"></div>
      </div>
    </section>

    <section class="scene-card factory" data-scene="factory">
      <div class="scene-header"><div class="scene-name">工厂</div><div class="scene-sub">产线 / 巡检 / 工业环境</div></div>
      <div class="status-badge" data-scene-status="factory">未连接</div>
      <div class="scene-body">
        <div class="factory-floor"></div>
        <div class="conveyor"></div>
        <div class="machine-block machine-left"></div>
        <div class="machine-block machine-right"></div>
        <div class="warning-strip"></div>
        <div class="device-sprite robot secondary" data-device="factory-patrol"></div>
        <div class="device-sprite monitor" data-device="factory-monitor"></div>
      </div>
    </section>
  `;
}

export function bindSecondaryScenes(root, refs) {
  root.querySelectorAll("[data-scene]").forEach((sceneEl) => {
    refs.scenes[sceneEl.dataset.scene] = {
      root: sceneEl,
      status: sceneEl.querySelector("[data-scene-status]"),
    };
  });
  refs.hotelCurtainLeft = root.querySelector("[data-hotel-curtain-left]");
  refs.hotelCurtainRight = root.querySelector("[data-hotel-curtain-right]");
  refs.envOverlays = {};
  root.querySelectorAll("[data-env]").forEach((el) => {
    refs.envOverlays[el.dataset.env] = el;
  });
}

export function updateSecondaryScenes(refs, snapshot) {
  const getDevice = (id) => snapshot.devices.find((device) => device.endpointId === id);

  const mower = getDevice("office-mower");
  const light = getDevice("office-light");
  const screen = getDevice("office-screen");
  const officeAc = getDevice("office-ac");
  const mowerPos = positionByNormalized(mower || { x: 0.5, y: 0.5 }, { left: 8, top: 25, width: 80, height: 60 });
  const mowerDeg = Math.atan2((mower?.targetY ?? mower?.y ?? 0.5) - (mower?.y ?? 0.5), (mower?.targetX ?? mower?.x ?? 0.5) - (mower?.x ?? 0.5)) * 180 / Math.PI;
  const mowerWorking = mower?.status === "working";
  setSprite(refs, "office-mower", mowerPos.left, mowerPos.top, `robot secondary${mowerWorking ? " cleaning moving" : ""}`, mowerDeg);
  setSprite(refs, "office-screen", 72, 28, "speaker");
  const officeLightOn = numAttr(light, "brightness", 0) > 6;
  setSprite(refs, "office-light", 30, 60, `light-switch${officeLightOn ? " on" : ""}`);
  setSprite(refs, "office-ac", 82, 18, "ac");
  refs.devices["office-screen"].style.background = boolAttr(screen, "meeting") ? "linear-gradient(180deg,#7dc3ff,#2359a8)" : "linear-gradient(180deg,#2b3344,#121720)";
  refs.devices["office-ac"].querySelector(".airflow")?.classList.toggle("on", boolAttr(officeAc, "on", false));
  if (refs.envOverlays.office) {
    refs.envOverlays.office.className = `env-overlay${officeLightOn ? " warm" : " dim"}${boolAttr(officeAc, "on", false) ? " cool" : ""}`;
  }
  refs.scenes.office.status.textContent = screen?.summary || "办公场景待机";

  const hotelRobot = getDevice("hotel-robot");
  const hotelLight = getDevice("hotel-light");
  const hotelAc = getDevice("hotel-ac");
  const hotelCurtain = getDevice("hotel-curtain");
  const hotelPos = positionByNormalized(hotelRobot || { x: 0.5, y: 0.5 }, { left: 10, top: 25, width: 75, height: 60 });
  const hotelDeg = Math.atan2((hotelRobot?.targetY ?? hotelRobot?.y ?? 0.5) - (hotelRobot?.y ?? 0.5), (hotelRobot?.targetX ?? hotelRobot?.x ?? 0.5) - (hotelRobot?.x ?? 0.5)) * 180 / Math.PI;
  const hotelRobotBusy = hotelRobot?.status === "delivering" || hotelRobot?.status === "guiding";
  const hotelLightOn = numAttr(hotelLight, "brightness", 0) > 6;
  const hotelCurtainPos = Math.max(0, Math.min(100, numAttr(hotelCurtain, "position", 36)));
  const hotelCurtainOpen = hotelCurtainPos > 35;
  setSprite(refs, "hotel-robot", hotelPos.left, hotelPos.top, `robot secondary${hotelRobotBusy ? " cleaning moving" : ""}`, hotelDeg);
  setSprite(refs, "hotel-light", 30, 22, `light-switch${hotelLightOn ? " on" : ""}`);
  setSprite(refs, "hotel-ac", 58, 20, "ac");
  setSprite(refs, "hotel-curtain", 50, 32, `curtain-switch${hotelCurtainOpen ? " on" : ""}`);
  refs.devices["hotel-ac"].querySelector(".airflow")?.classList.toggle("on", boolAttr(hotelAc, "on", false));
  if (refs.envOverlays.hotel) {
    const classes = ["env-overlay"];
    if (hotelLightOn) classes.push("warm");
    else classes.push("dim");
    if (hotelCurtainOpen) classes.push("sunbeam-fx");
    refs.envOverlays.hotel.className = classes.join(" ");
  }
  refs.scenes.hotel.status.textContent = `灯 ${hotelLightOn ? "开" : "关"} · 窗帘 ${Math.round(hotelCurtainPos)}%`;

  const car = getDevice("car-system");
  const carPos = positionByNormalized(car || { x: 0.35, y: 0.35 }, { left: 10, top: 15, width: 75, height: 65 });
  const engineOn = boolAttr(car, "engine");
  setSprite(refs, "car-system", carPos.left, carPos.top, `car${engineOn ? " engine-on moving" : ""}`, 0);
  refs.devices["car-system"].style.filter = engineOn ? "drop-shadow(0 0 18px rgba(104,166,255,0.45))" : "";
  if (refs.envOverlays.car) {
    refs.envOverlays.car.className = `env-overlay${engineOn ? " headlight" : ""}`;
  }
  refs.scenes.car.status.textContent = car?.summary || "车辆待机";

  const guide = getDevice("hospital-guide");
  const monitor = getDevice("hospital-monitor");
  const hospitalPos = positionByNormalized(guide || { x: 0.5, y: 0.6 }, { left: 10, top: 20, width: 75, height: 60 });
  const hospitalDeg = Math.atan2((guide?.targetY ?? guide?.y ?? 0.5) - (guide?.y ?? 0.5), (guide?.targetX ?? guide?.x ?? 0.5) - (guide?.x ?? 0.5)) * 180 / Math.PI;
  const guiding = guide?.status === "guiding";
  const monitorRunning = monitor?.connected;
  setSprite(refs, "hospital-guide", hospitalPos.left, hospitalPos.top, `robot secondary${guiding ? " cleaning moving" : ""}`, hospitalDeg);
  setSprite(refs, "hospital-monitor", 22, 72, `monitor${monitorRunning ? " running" : ""}`);
  refs.devices["hospital-monitor"].style.filter = monitorRunning ? "drop-shadow(0 0 12px rgba(20,184,166,0.35))" : "";
  refs.scenes.hospital.status.textContent = guide?.summary || "导诊待机";

  const poolRobot = getDevice("city-pool-robot");
  const street = getDevice("city-streetlight");
  const charger = getDevice("city-charger");
  const cityPos = positionByNormalized(poolRobot || { x: 0.5, y: 0.5 }, { left: 10, top: 20, width: 75, height: 60 });
  const cityDeg = Math.atan2((poolRobot?.targetY ?? poolRobot?.y ?? 0.5) - (poolRobot?.y ?? 0.5), (poolRobot?.targetX ?? poolRobot?.x ?? 0.5) - (poolRobot?.x ?? 0.5)) * 180 / Math.PI;
  const poolCleaning = poolRobot?.status === "cleaning";
  const streetOn = numAttr(street, "brightness", 0) > 6;
  setSprite(refs, "city-pool-robot", cityPos.left, cityPos.top, `robot secondary${poolCleaning ? " cleaning moving" : ""}`, cityDeg);
  setSprite(refs, "city-streetlight", 38, 38, `streetlight${streetOn ? " lit" : ""}`);
  setSprite(refs, "city-charger", 22, 62, `charger${boolAttr(charger, "charging") ? " charging active" : ""}`);
  refs.devices["city-streetlight"].style.filter = streetOn ? "drop-shadow(0 0 16px rgba(255,215,140,0.55))" : "";
  refs.devices["city-charger"].style.filter = boolAttr(charger, "charging") ? "drop-shadow(0 0 16px rgba(96,165,250,0.45))" : "";
  if (refs.envOverlays.city) {
    refs.envOverlays.city.className = `env-overlay${streetOn ? "" : " night"}`;
  }
  refs.scenes.city.status.textContent = charger?.summary || "城市场景待机";

  const patrol = getDevice("factory-patrol");
  const factoryMonitor = getDevice("factory-monitor");
  const factoryPos = positionByNormalized(patrol || { x: 0.5, y: 0.5 }, { left: 10, top: 20, width: 75, height: 60 });
  const factoryDeg = Math.atan2((patrol?.targetY ?? patrol?.y ?? 0.5) - (patrol?.y ?? 0.5), (patrol?.targetX ?? patrol?.x ?? 0.5) - (patrol?.x ?? 0.5)) * 180 / Math.PI;
  const patrolling = patrol?.status === "patrolling";
  const factoryMonitorRunning = factoryMonitor?.connected;
  setSprite(refs, "factory-patrol", factoryPos.left, factoryPos.top, `robot secondary${patrolling ? " cleaning moving" : ""}`, factoryDeg);
  setSprite(refs, "factory-monitor", 72, 78, `monitor${factoryMonitorRunning ? " running" : ""}`);
  refs.devices["factory-monitor"].style.filter = factoryMonitorRunning ? "drop-shadow(0 0 16px rgba(249,115,22,0.35))" : "";
  refs.scenes.factory.status.textContent = patrol?.summary || "巡检待机";
}
