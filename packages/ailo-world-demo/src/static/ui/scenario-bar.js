export function renderScenarioBar(container, snapshot, onRun) {
  if (!snapshot || container.dataset.ready === "1") return;
  container.dataset.ready = "1";
  container.innerHTML = "";
  snapshot.scenarios.forEach((scenario) => {
    const btn = document.createElement("button");
    btn.className = "scenario-chip";
    btn.textContent = scenario.label;
    btn.title = scenario.description;
    btn.onclick = () => onRun(scenario.id);
    container.appendChild(btn);
  });
}
