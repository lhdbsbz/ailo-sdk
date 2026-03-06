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
  const preserved = [...el.classList].filter((name) => !["cleaning", "playing", "alerting", "moving", "washing", "charging", "active", "on", "running", "unlocked", "tracking", "engine-on", "lit", "working", "open"].includes(name));
  el.className = `${preserved.join(" ")} ${extraClass}`.trim();
  el.style.left = `${left}%`;
  el.style.top = `${top}%`;
  el.style.transform = `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
}

export function homeSceneMarkup() {
  return `
    <section class="scene-card home" data-scene="home">
      <div class="scene-header">
        <div class="scene-name">家庭</div>
        <div class="scene-sub">2.5D 生活空间 / 客厅 + 卧室 + 玄关</div>
      </div>
      <div class="status-badge" data-scene-status="home">未连接</div>
      <div class="scene-body">
        <div class="home-floor">
          <div class="room living-room" data-room="living">
            <div class="room-overlay-dark"></div>
            <div class="room-overlay-warm"></div>
            <div class="room-overlay-cool"></div>
            <div class="room-overlay-music"></div>
            <div class="room-overlay-sunbeam"></div>
            <div class="vacuum-trail" data-vacuum-trail-1></div>
            <div class="vacuum-trail" data-vacuum-trail-2></div>
            <div class="vacuum-trail" data-vacuum-trail-3></div>
            <div class="room-label">客厅</div>
            <div class="ceiling-light living-light"></div>
            <div class="window">
              <div class="curtain-panel curtain-left" data-curtain-left></div>
              <div class="curtain-panel curtain-right" data-curtain-right></div>
            </div>
            <div class="sunbeam" data-sunbeam></div>
            <div class="living-rug"></div>
            <div class="furniture sofa-main"></div>
            <div class="furniture sofa-chaise"></div>
            <div class="furniture sofa-back"></div>
            <div class="furniture coffee-table"></div>
            <div class="furniture media-console"></div>
            <div class="furniture tv-panel"></div>
            <div class="furniture floor-lamp"></div>
            <div class="furniture side-plant"></div>
            <div class="robot-dock"></div>
            <div class="device-sprite robot" data-device="home-vacuum"></div>
            <div class="device-sprite speaker" data-device="home-speaker">
              <div class="speaker-waves">
                <div class="speaker-wave"></div>
                <div class="speaker-wave"></div>
                <div class="speaker-wave"></div>
              </div>
            </div>
            <div class="device-sprite ac" data-device="home-ac"><div class="airflow"></div></div>
            <div class="device-sprite light-switch" data-device="home-light-living"></div>
            <div class="device-sprite curtain-switch" data-device="home-curtain"></div>
          </div>

          <div class="room bed-room" data-room="bed">
            <div class="room-overlay-dark"></div>
            <div class="room-overlay-warm"></div>
            <div class="room-overlay-sunbeam"></div>
            <div class="room-label">卧室</div>
            <div class="ceiling-light bed-light"></div>
            <div class="furniture bed-base"></div>
            <div class="furniture bed-headboard"></div>
            <div class="furniture pillow pillow-left"></div>
            <div class="furniture pillow pillow-right"></div>
            <div class="furniture nightstand"></div>
            <div class="furniture wardrobe"></div>
            <div class="device-sprite purifier" data-device="home-purifier"></div>
            <div class="device-sprite watch" data-device="user-watch"></div>
            <div class="device-sprite light-switch" data-device="home-light-bedroom"></div>
          </div>

          <div class="room entry-room" data-room="entry">
            <div class="room-overlay-dark"></div>
            <div class="room-overlay-warm"></div>
            <div class="room-label">玄关 / 家政区</div>
            <div class="door" data-door><div class="door-glow"></div></div>
            <div class="entry-floor-shadow"></div>
            <div class="furniture shoe-cabinet"></div>
            <div class="furniture fridge-tall"></div>
            <div class="furniture washer-box"></div>
            <div class="device-sprite lock" data-device="home-lock"></div>
            <div class="device-sprite camera" data-device="home-camera"></div>
            <div class="device-sprite fridge" data-device="home-fridge"><span class="fridge-temp-label"></span></div>
            <div class="device-sprite washer" data-device="home-washer"></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

export function bindHomeScene(root, refs) {
  refs.scenes.home = {
    root,
    status: root.querySelector("[data-scene-status]"),
  };
  refs.homeLiving = root.querySelector('[data-room="living"]');
  refs.homeBed = root.querySelector('[data-room="bed"]');
  refs.homeEntry = root.querySelector('[data-room="entry"]');
  refs.door = root.querySelector("[data-door]");
  refs.curtainLeft = root.querySelector("[data-curtain-left]");
  refs.curtainRight = root.querySelector("[data-curtain-right]");
  refs.sunbeam = root.querySelector("[data-sunbeam]");
  refs.vacuumTrails = [
    root.querySelector("[data-vacuum-trail-1]"),
    root.querySelector("[data-vacuum-trail-2]"),
    root.querySelector("[data-vacuum-trail-3]"),
  ];
  refs._prevVacuumPos = [];
}

export function updateHomeScene(refs, snapshot) {
  const getDevice = (id) => snapshot.devices.find((device) => device.endpointId === id);

  const vacuum = getDevice("home-vacuum");
  const speaker = getDevice("home-speaker");
  const purifier = getDevice("home-purifier");
  const ac = getDevice("home-ac");
  const lock = getDevice("home-lock");
  const camera = getDevice("home-camera");
  const watch = getDevice("user-watch");
  const fridge = getDevice("home-fridge");
  const washer = getDevice("home-washer");
  const curtain = getDevice("home-curtain");
  const livingLight = getDevice("home-light-living");
  const bedLight = getDevice("home-light-bedroom");

  const livingBrightness = numAttr(livingLight, "brightness", 0);
  const bedBrightness = numAttr(bedLight, "brightness", 0);
  const livingOn = livingBrightness > 6 || boolAttr(livingLight, "on");
  const bedOn = bedBrightness > 6 || boolAttr(bedLight, "on");
  const acOn = boolAttr(ac, "on", false);
  const musicOn = boolAttr(speaker, "playing");
  const curtainPos = Math.max(0, Math.min(100, numAttr(curtain, "position", 36)));
  const curtainOpen = curtainPos > 35;

  refs.homeLiving.classList.toggle("light-on", livingOn);
  refs.homeLiving.classList.toggle("ac-on", acOn);
  refs.homeLiving.classList.toggle("music-on", musicOn);
  refs.homeLiving.classList.toggle("curtain-open", curtainOpen);
  refs.homeLiving.style.setProperty("--light-alpha", String(Math.max(0.08, livingBrightness / 100)));

  refs.homeBed.classList.toggle("light-on", bedOn);
  refs.homeBed.classList.toggle("curtain-open", curtainOpen);
  refs.homeBed.style.setProperty("--light-alpha", String(Math.max(0.08, bedBrightness / 100)));

  const ceilingLiving = refs.homeLiving.querySelector(".living-light");
  if (ceilingLiving) {
    ceilingLiving.style.boxShadow = livingOn
      ? `0 0 ${12 + livingBrightness * 0.3}px ${4 + livingBrightness * 0.2}px rgba(255, 235, 170, ${0.15 + livingBrightness * 0.006})`
      : "0 0 0 6px rgba(255, 235, 170, 0.06)";
  }
  const ceilingBed = refs.homeBed.querySelector(".bed-light");
  if (ceilingBed) {
    ceilingBed.style.boxShadow = bedOn
      ? `0 0 ${12 + bedBrightness * 0.3}px ${4 + bedBrightness * 0.2}px rgba(255, 235, 170, ${0.15 + bedBrightness * 0.006})`
      : "0 0 0 6px rgba(255, 235, 170, 0.06)";
  }

  const panelWidth = `${50 - curtainPos * 0.35}%`;
  if (refs.curtainLeft) refs.curtainLeft.style.width = panelWidth;
  if (refs.curtainRight) refs.curtainRight.style.width = panelWidth;
  if (refs.sunbeam) refs.sunbeam.classList.toggle("open", curtainOpen);
  if (refs.door) refs.door.classList.toggle("unlocked", !boolAttr(lock, "locked", true));
  const doorUnlocked = !boolAttr(lock, "locked", true);
  refs.homeEntry.classList.toggle("light-on", doorUnlocked);

  const vacuumArea = { left: 15, top: 30, width: 65, height: 55 };
  const vacuumPos = positionByNormalized(vacuum || { x: 0.5, y: 0.5 }, vacuumArea);
  const vacuumDeg = Math.atan2(
    (vacuum?.targetY ?? vacuum?.y ?? 0.5) - (vacuum?.y ?? 0.5),
    (vacuum?.targetX ?? vacuum?.x ?? 0.5) - (vacuum?.x ?? 0.5)
  ) * 180 / Math.PI;
  const isCleaning = vacuum?.status === "cleaning";
  setSprite(refs, "home-vacuum", vacuumPos.left, vacuumPos.top, `robot${isCleaning ? " cleaning moving" : ""}`, vacuumDeg);

  if (isCleaning && refs.vacuumTrails) {
    refs._prevVacuumPos.unshift({ left: vacuumPos.left, top: vacuumPos.top });
    if (refs._prevVacuumPos.length > 3) refs._prevVacuumPos.length = 3;
    refs.vacuumTrails.forEach((el, i) => {
      const pos = refs._prevVacuumPos[i];
      if (el && pos) {
        el.style.left = `${pos.left}%`;
        el.style.top = `${pos.top}%`;
        el.style.transform = "translate(-50%, -50%)";
        el.style.opacity = String(0.5 - i * 0.15);
        el.classList.add("visible");
      }
    });
  } else if (refs.vacuumTrails) {
    refs.vacuumTrails.forEach((el) => el?.classList.remove("visible"));
  }

  const purifierRunning = purifier?.status === "running";
  const lockUnlocked = !boolAttr(lock, "locked", true);
  const watchTracking = watch?.status === "tracking";

  setSprite(refs, "home-speaker", 72, 82, `speaker${musicOn ? " playing" : ""}`);
  setSprite(refs, "home-purifier", 30, 58, `purifier${purifierRunning ? " running" : ""}`);
  setSprite(refs, "home-ac", 68, 22, "ac");
  setSprite(refs, "home-lock", 28, 42, `lock${lockUnlocked ? " unlocked" : ""}`);
  setSprite(refs, "home-camera", 20, 18, `camera${camera?.status === "alert" ? " alerting" : ""}`);
  setSprite(refs, "user-watch", 52, 48, `watch${watchTracking ? " tracking" : ""}`);
  setSprite(refs, "home-fridge", 65, 42, "fridge");
  setSprite(refs, "home-washer", 80, 55, `washer${numAttr(washer, "progress", 0) > 0 && numAttr(washer, "progress", 0) < 100 ? " washing active" : ""}`);
  setSprite(refs, "home-light-living", 52, 15, `light-switch${livingOn ? " on" : ""}`);
  setSprite(refs, "home-curtain", 90, 55, `curtain-switch${curtainOpen ? " on" : ""}`);
  setSprite(refs, "home-light-bedroom", 52, 16, `light-switch${bedOn ? " on" : ""}`);

  refs.devices["home-speaker"]?.classList.toggle("playing", musicOn);
  refs.devices["home-ac"]?.querySelector(".airflow")?.classList.toggle("on", acOn);
  if (refs.devices["home-purifier"]) {
    refs.devices["home-purifier"].style.filter = purifier?.connected ? "drop-shadow(0 12px 18px rgba(32,87,255,0.25))" : "grayscale(1)";
  }
  if (refs.devices["home-camera"]) {
    refs.devices["home-camera"].style.boxShadow = camera?.status === "alert" ? "0 0 0 4px rgba(239,68,68,0.18)" : "0 0 0 3px rgba(255,255,255,0.14)";
  }
  if (refs.devices["home-fridge"]) {
    refs.devices["home-fridge"].style.filter = fridge?.connected ? "drop-shadow(0 14px 18px rgba(174,200,255,0.2))" : "grayscale(1)";
    const tempLabel = refs.devices["home-fridge"].querySelector(".fridge-temp-label");
    if (tempLabel) {
      const fridgeTemp = Number(fridge?.attrs?.temp ?? 4);
      tempLabel.textContent = `${fridgeTemp}°C`;
    }
  }
  if (refs.devices["home-washer"]) {
    const progress = Math.max(0, Math.min(100, numAttr(washer, "progress", 0)));
    refs.devices["home-washer"].style.boxShadow = progress > 0 ? "0 0 0 6px rgba(96,165,250,0.10), 0 10px 18px rgba(0,0,0,0.18)" : "0 10px 18px rgba(0,0,0,0.18)";
    refs.devices["home-washer"].style.filter = progress >= 100 ? "drop-shadow(0 0 14px rgba(52,211,153,0.28))" : "";
  }

  refs.scenes.home.status.textContent = `客厅灯 ${livingOn ? "已开" : "已关"} · 卧室灯 ${bedOn ? "已开" : "已关"} · 窗帘 ${Math.round(curtainPos)}%`;
}
