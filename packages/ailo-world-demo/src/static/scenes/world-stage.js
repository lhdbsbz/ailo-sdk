import { bindHomeScene, homeSceneMarkup, updateHomeScene } from "./home-scene.js";
import { bindSecondaryScenes, secondaryScenesMarkup, updateSecondaryScenes } from "./secondary-scenes.js";

export function createWorldStage(container) {
  const refs = {
    scenes: {},
    devices: {},
  };

  function ensureStage() {
    if (container.dataset.ready === "1") return refs;
    container.dataset.ready = "1";
    container.innerHTML = `${homeSceneMarkup()}${secondaryScenesMarkup()}`;

    container.querySelectorAll("[data-device]").forEach((deviceEl) => {
      refs.devices[deviceEl.dataset.device] = deviceEl;
    });

    bindHomeScene(container.querySelector('[data-scene="home"]'), refs);
    bindSecondaryScenes(container, refs);
    return refs;
  }

  function update(snapshot) {
    ensureStage();
    updateHomeScene(refs, snapshot);
    updateSecondaryScenes(refs, snapshot);
  }

  return {
    ensureStage,
    update,
  };
}
