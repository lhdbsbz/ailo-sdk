import { EventEmitter } from "events";
import { DEVICES, SCENARIOS, SCENES, type DeviceDef, type SceneDef, type ScenarioDef } from "./config.js";

export interface DeviceRuntimeState {
  endpointId: string;
  connected: boolean;
  status: string;
  summary: string;
  scene: DeviceDef["scene"];
  type: DeviceDef["type"];
  icon: string;
  name: string;
  movable: boolean;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  attrs: Record<string, unknown>;
}

export interface LogEntry {
  id: string;
  ts: number;
  level: "up" | "down" | "info" | "error";
  endpointId: string;
  name: string;
  message: string;
}

export interface WorldStateSnapshot {
  devices: DeviceRuntimeState[];
  logs: LogEntry[];
  scenes: SceneDef[];
  scenarios: ScenarioDef[];
  connectedCount: number;
}

export class StateStore extends EventEmitter {
  private devices = new Map<string, DeviceRuntimeState>();
  private logs: LogEntry[] = [];

  constructor() {
    super();
    this.seedDevices();
  }

  private seedDevices(): void {
    const sceneGroups = new Map<string, DeviceDef[]>();
    for (const device of DEVICES) {
      const list = sceneGroups.get(device.scene) ?? [];
      list.push(device);
      sceneGroups.set(device.scene, list);
    }

    for (const scene of SCENES) {
      const list = sceneGroups.get(scene.id) ?? [];
      const cols = Math.max(2, Math.ceil(Math.sqrt(list.length)));
      const rows = Math.max(1, Math.ceil(list.length / cols));
      list.forEach((device, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = col / Math.max(1, cols - 1 || 1);
        const y = row / Math.max(1, rows - 1 || 1);
        this.devices.set(device.id, {
          endpointId: device.id,
          connected: false,
          status: "offline",
          summary: "离线",
          scene: device.scene,
          type: device.type,
          icon: device.icon,
          name: device.name,
          movable: Boolean(device.movable),
          x: Number.isFinite(x) ? x : 0.5,
          y: Number.isFinite(y) ? y : 0.5,
          targetX: Number.isFinite(x) ? x : 0.5,
          targetY: Number.isFinite(y) ? y : 0.5,
          attrs: {},
        });
      });
    }
  }

  getDevice(endpointId: string): DeviceRuntimeState | undefined {
    return this.devices.get(endpointId);
  }

  patchDevice(endpointId: string, patch: Partial<DeviceRuntimeState>): void {
    const current = this.devices.get(endpointId);
    if (!current) return;
    const next = { ...current, ...patch };
    this.devices.set(endpointId, next);
    this.emit("state", this.snapshot());
  }

  patchDeviceAttrs(endpointId: string, attrs: Record<string, unknown>, summary?: string, status?: string): void {
    const current = this.devices.get(endpointId);
    if (!current) return;
    const next: DeviceRuntimeState = {
      ...current,
      attrs: { ...current.attrs, ...attrs },
      ...(summary !== undefined ? { summary } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    this.devices.set(endpointId, next);
    this.emit("state", this.snapshot());
  }

  moveDevice(endpointId: string, targetX: number, targetY: number, summary?: string): void {
    const current = this.devices.get(endpointId);
    if (!current) return;
    this.devices.set(endpointId, {
      ...current,
      targetX,
      targetY,
      ...(summary ? { summary } : {}),
    });
    this.emit("state", this.snapshot());
  }

  appendLog(entry: Omit<LogEntry, "id" | "ts">): void {
    const log: LogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...entry,
    };
    this.logs.push(log);
    if (this.logs.length > 250) this.logs.splice(0, this.logs.length - 250);
    this.emit("log", log);
    this.emit("state", this.snapshot());
  }

  tickMotion(step = 0.03): void {
    let changed = false;
    for (const [id, device] of this.devices) {
      if (!device.movable) continue;
      const dx = device.targetX - device.x;
      const dy = device.targetY - device.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) continue;
      const move = Math.min(step, dist);
      changed = true;
      this.devices.set(id, {
        ...device,
        x: device.x + (dx / dist) * move,
        y: device.y + (dy / dist) * move,
      });
    }
    if (changed) this.emit("state", this.snapshot());
  }

  tickAmbient(): void {
    let changed = false;
    for (const [id, device] of this.devices) {
      let next = device;
      const attrs = { ...device.attrs };

      if (device.type === "washer" && device.status === "washing") {
        const progress = Math.min(100, Number(attrs.progress ?? 0) + 1);
        attrs.progress = progress;
        next = {
          ...next,
          attrs,
          summary: progress >= 100 ? "洗涤完成" : `洗涤中 ${progress}%`,
          status: progress >= 100 ? "idle" : "washing",
        };
        changed = true;
      }

      if (device.type === "charger" && Boolean(attrs.charging)) {
        const progress = Math.min(100, Number(attrs.progress ?? 12) + 1);
        attrs.progress = progress;
        next = {
          ...next,
          attrs,
          summary: progress >= 100 ? "充电完成" : `充电中 ${progress}%`,
          status: progress >= 100 ? "idle" : "charging",
        };
        if (progress >= 100) next.attrs = { ...attrs, charging: false, progress };
        changed = true;
      }

      if (device.type === "camera" && device.status === "alert" && Boolean(device.attrs.motion)) {
        const heat = Number(device.attrs.alertTicks ?? 0) + 1;
        next = {
          ...next,
          attrs: { ...attrs, alertTicks: heat, motion: heat < 16 },
          summary: heat < 16 ? "检测到运动" : "门口守护中",
          status: heat < 16 ? "alert" : "watching",
        };
        changed = true;
      }

      if (next !== device) {
        this.devices.set(id, next);
      }
    }
    if (changed) this.emit("state", this.snapshot());
  }

  resetAll(): void {
    this.devices.clear();
    this.logs = [];
    this.seedDevices();
    this.emit("state", this.snapshot());
  }

  snapshot(): WorldStateSnapshot {
    const devices = [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return {
      devices,
      logs: [...this.logs],
      scenes: SCENES,
      scenarios: SCENARIOS,
      connectedCount: devices.filter((device) => device.connected).length,
    };
  }
}
