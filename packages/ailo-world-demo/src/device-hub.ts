import {
  CAP_MESSAGE,
  CAP_TOOL_EXECUTE,
  EndpointClient,
  textPart,
  type ToolRequestPayload,
} from "@lmcl/ailo-endpoint-sdk";
import { DEVICES, SCENARIOS, type DeviceDef, type ScenarioDef } from "./config.js";
import { StateStore } from "./state-store.js";

type ConnectionConfig = {
  ailoWsUrl: string;
  apiKey: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class DeviceHub {
  private readonly store: StateStore;
  private readonly clients = new Map<string, EndpointClient>();
  private connectionConfig: ConnectionConfig | null = null;
  private motionTimer: NodeJS.Timeout | null = null;
  private cruiseTimers = new Map<string, NodeJS.Timeout>();
  private patrolTimers = new Map<string, NodeJS.Timeout>();

  constructor(store: StateStore) {
    this.store = store;
  }

  get connected(): boolean {
    return this.clients.size > 0;
  }

  async connectAll(ailoWsUrl: string, apiKey: string): Promise<void> {
    await this.disconnectAll();
    this.connectionConfig = { ailoWsUrl, apiKey };

    for (const device of DEVICES) {
      const client = new EndpointClient({
        url: ailoWsUrl,
        apiKey,
        endpointId: device.id,
        caps: [CAP_MESSAGE, CAP_TOOL_EXECUTE],
        tools: device.tools,
        instructions: this.buildInstructions(device),
      });

      client.onToolRequest(async (payload) => this.handleToolRequest(device, payload));
      client.onEvicted(() => {
        this.store.patchDevice(device.id, {
          connected: false,
          status: "evicted",
          summary: "被同 endpointId 新连接顶替",
        });
        this.store.appendLog({
          level: "error",
          endpointId: device.id,
          name: device.name,
          message: "连接被顶替，请检查 endpointId 是否重复",
        });
      });

      this.clients.set(device.id, client);
      try {
        await client.connect();
        this.seedVisualDefaults(device);
        this.store.patchDevice(device.id, {
          connected: true,
          status: "online",
          summary: "已连接",
        });
        this.store.appendLog({
          level: "info",
          endpointId: device.id,
          name: device.name,
          message: `已连接到 ${ailoWsUrl}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.patchDevice(device.id, {
          connected: false,
          status: "error",
          summary: `连接失败: ${message}`,
        });
        this.store.appendLog({
          level: "error",
          endpointId: device.id,
          name: device.name,
          message: `连接失败: ${message}`,
        });
      }
    }

    this.startMotionLoop();
  }

  async disconnectAll(): Promise<void> {
    for (const [endpointId, client] of this.clients) {
      client.close();
      this.store.patchDevice(endpointId, {
        connected: false,
        status: "offline",
        summary: "离线",
      });
    }
    this.clients.clear();
    for (const timer of this.patrolTimers.values()) clearInterval(timer);
    this.patrolTimers.clear();
    for (const timer of this.cruiseTimers.values()) clearInterval(timer);
    this.cruiseTimers.clear();
    if (this.motionTimer) {
      clearInterval(this.motionTimer);
      this.motionTimer = null;
    }
  }

  async resetAll(): Promise<void> {
    await this.disconnectAll();
    this.store.resetAll();
  }

  listScenarios(): ScenarioDef[] {
    return SCENARIOS;
  }

  async runScenario(scenarioId: string): Promise<void> {
    const scenario = SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario) throw new Error(`未知场景: ${scenarioId}`);

    this.store.appendLog({
      level: "info",
      endpointId: "scenario",
      name: "Scenario",
      message: `开始执行场景: ${scenario.label}`,
    });

    for (const message of scenario.messages) {
      await new Promise((resolve) => setTimeout(resolve, message.delayMs ?? 0));
      const client = this.clients.get(message.endpointId);
      const device = DEVICES.find((item) => item.id === message.endpointId);
      if (!client || !device) continue;
      await client.accept({
        content: [textPart(message.text)],
        contextTags: [
          { kind: "scene", value: device.scene, groupWith: true },
          { kind: "demo", value: scenario.id, groupWith: false },
        ],
        requiresResponse: true,
      });
      this.store.appendLog({
        level: "up",
        endpointId: device.id,
        name: device.name,
        message: message.text,
      });
    }
  }

  private buildInstructions(device: DeviceDef): string {
    return [
      `你是 Ailo World Demo 中的设备端点。`,
      `设备名称: ${device.name}`,
      `endpointId: ${device.id}`,
      `场景: ${device.scene}`,
      `你的职责是在收到工具调用时执行状态变化，并将结果返回。`,
      `这是演示环境，所有动作都要清晰、确定、可视化。`,
    ].join("\n");
  }

  private seedVisualDefaults(device: DeviceDef): void {
    switch (device.type) {
      case "light":
        this.store.patchDeviceAttrs(device.id, { brightness: 0, on: false }, "待命", "idle");
        break;
      case "curtain":
        this.store.patchDeviceAttrs(device.id, { position: 0 }, "已关闭", "idle");
        break;
      case "lock":
        this.store.patchDeviceAttrs(device.id, { locked: true }, "已锁定", "locked");
        break;
      case "speaker":
        this.store.patchDeviceAttrs(device.id, { playing: false, volume: 32 }, "待命", "idle");
        break;
      case "ac":
        this.store.patchDeviceAttrs(device.id, { on: false, temp: 24, mode: "auto" }, "待机 24°C", "idle");
        break;
      case "purifier":
        this.store.patchDeviceAttrs(device.id, { mode: "auto", pm25: 22 }, "自动净化", "running");
        break;
      case "camera":
        this.store.patchDeviceAttrs(device.id, { mode: "watch" }, "门口守护中", "watching");
        break;
      case "watch":
        this.store.patchDeviceAttrs(device.id, { heartRate: 72, steps: 3260 }, "心率 72", "tracking");
        break;
      case "fridge":
        this.store.patchDeviceAttrs(device.id, { inventoryCount: 5, temp: 4 }, "4°C · 食材充足", "running");
        break;
      case "washer":
        this.store.patchDeviceAttrs(device.id, { progress: 0 }, "待机", "idle");
        break;
      case "car":
        this.store.patchDeviceAttrs(device.id, { engine: false }, "停在车位", "idle");
        break;
      case "screen":
        this.store.patchDeviceAttrs(device.id, { meeting: false }, "待机", "idle");
        break;
      case "mower":
      case "poolRobot":
      case "patrolRobot":
      case "serviceRobot":
      case "guideRobot":
        this.store.patchDeviceAttrs(device.id, {}, "待命", "idle");
        break;
      case "streetlight":
        this.store.patchDeviceAttrs(device.id, { brightness: 60 }, "亮度 60%", "running");
        break;
      case "charger":
        this.store.patchDeviceAttrs(device.id, { charging: false }, "空闲", "idle");
        break;
      case "envMonitor":
        this.store.patchDeviceAttrs(device.id, {}, "监测中", "running");
        break;
      default:
        break;
    }
  }

  private startMotionLoop(): void {
    if (this.motionTimer) clearInterval(this.motionTimer);
    this.motionTimer = setInterval(() => {
      this.store.tickMotion(0.04);
      this.store.tickAmbient();
    }, 100);
  }

  private startCarCruise(endpointId: string): void {
    this.stopCarCruise(endpointId);
    const timer = setInterval(() => {
      const dev = this.store.getDevice(endpointId);
      if (!dev || !dev.attrs.engine) { this.stopCarCruise(endpointId); return; }
      this.store.moveDevice(endpointId, rnd(0.1, 0.9), rnd(0.1, 0.9), "行驶中");
    }, 3000);
    this.cruiseTimers.set(endpointId, timer);
  }

  private stopCarCruise(endpointId: string): void {
    const timer = this.cruiseTimers.get(endpointId);
    if (timer) { clearInterval(timer); this.cruiseTimers.delete(endpointId); }
  }

  private startCircularPatrol(endpointId: string, cx: number, cy: number, radius: number, periodMs: number, summary: string): void {
    this.stopPatrol(endpointId);
    let angle = Math.random() * Math.PI * 2;
    const step = (Math.PI * 2) / (periodMs / 800);
    const timer = setInterval(() => {
      const dev = this.store.getDevice(endpointId);
      if (!dev) { this.stopPatrol(endpointId); return; }
      angle += step;
      const x = clamp01(cx + Math.cos(angle) * radius);
      const y = clamp01(cy + Math.sin(angle) * radius);
      this.store.moveDevice(endpointId, x, y, summary);
    }, 800);
    this.patrolTimers.set(endpointId, timer);
  }

  private startRandomPatrol(endpointId: string, summary: string): void {
    this.stopPatrol(endpointId);
    const timer = setInterval(() => {
      const dev = this.store.getDevice(endpointId);
      if (!dev) { this.stopPatrol(endpointId); return; }
      this.store.moveDevice(endpointId, rnd(0.1, 0.9), rnd(0.1, 0.9), summary);
    }, 1800);
    this.patrolTimers.set(endpointId, timer);
  }

  private stopPatrol(endpointId: string): void {
    const timer = this.patrolTimers.get(endpointId);
    if (timer) { clearInterval(timer); this.patrolTimers.delete(endpointId); }
  }

  manualAction(endpointId: string, toolName: string, args: Record<string, unknown>): unknown {
    const device = DEVICES.find((d) => d.id === endpointId);
    if (!device) return { ok: false, error: "unknown device" };
    this.store.appendLog({
      level: "info",
      endpointId: device.id,
      name: device.name,
      message: `[手动] ${toolName} ${JSON.stringify(args)}`,
    });
    return this.applyTool(device, toolName, args);
  }

  private async handleToolRequest(device: DeviceDef, payload: ToolRequestPayload): Promise<unknown> {
    this.store.appendLog({
      level: "down",
      endpointId: device.id,
      name: device.name,
      message: `${payload.name} ${JSON.stringify(payload.args ?? {})}`,
    });
    return this.applyTool(device, payload.name, payload.args ?? {});
  }

  private applyTool(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "move" && device.movable) {
      const x = clamp01(Number(args.x));
      const y = clamp01(Number(args.y));
      this.store.moveDevice(device.id, x, y, "正在移动");
      return { ok: true, movedTo: { x, y } };
    }
    switch (device.type) {
      case "vacuum":
        return this.applyVacuum(device, toolName, args);
      case "purifier":
        return this.applyPurifier(device, toolName, args);
      case "light":
        return this.applyLight(device, toolName, args);
      case "ac":
        return this.applyAC(device, toolName, args);
      case "lock":
        return this.applyLock(device, toolName);
      case "camera":
        return this.applyCamera(device, toolName, args);
      case "speaker":
        return this.applySpeaker(device, toolName, args);
      case "fridge":
        return this.applyFridge(device, toolName, args);
      case "washer":
        return this.applyWasher(device, toolName, args);
      case "curtain":
        return this.applyCurtain(device, toolName, args);
      case "car":
        return this.applyCar(device, toolName, args);
      case "screen":
        return this.applyScreen(device, toolName, args);
      case "mower":
        return this.applyMower(device, toolName, args);
      case "serviceRobot":
        return this.applyServiceRobot(device, toolName, args);
      case "guideRobot":
        return this.applyGuideRobot(device, toolName, args);
      case "envMonitor":
        return this.applyEnvMonitor(device, toolName);
      case "streetlight":
        return this.applyStreetlight(device, toolName, args);
      case "charger":
        return this.applyCharger(device, toolName);
      case "poolRobot":
        return this.applyPoolRobot(device, toolName, args);
      case "patrolRobot":
        return this.applyPatrolRobot(device, toolName, args);
      case "watch":
        return this.applyWatch(device, toolName, args);
      default:
        return { ok: false, error: `unsupported device type: ${device.type}` };
    }
  }

  private randomMove(endpointId: string): { x: number; y: number } {
    const current = this.store.getDevice(endpointId);
    const baseX = current?.x ?? 0.5;
    const baseY = current?.y ?? 0.5;
    return {
      x: clamp01(baseX + rnd(-0.35, 0.35)),
      y: clamp01(baseY + rnd(-0.30, 0.30)),
    };
  }

  private applyVacuum(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "move") {
      const x = clamp01(Number(args.x));
      const y = clamp01(Number(args.y));
      this.store.moveDevice(device.id, x, y, "正在移动");
      this.store.patchDeviceAttrs(device.id, { battery: 92 }, "正在移动", "moving");
      return { ok: true, movedTo: { x, y } };
    }
    if (toolName === "clean") {
      const point = this.randomMove(device.id);
      this.store.moveDevice(device.id, point.x, point.y, "清扫中");
      this.store.patchDeviceAttrs(device.id, { cleaning: true, battery: 88 }, "清扫中", "cleaning");
      this.startCircularPatrol(device.id, 0.5, 0.5, 0.38, 5000, "清扫中");
      return { ok: true, status: "cleaning" };
    }
    if (toolName === "dock") {
      this.stopPatrol(device.id);
      this.store.patchDeviceAttrs(device.id, { cleaning: false, battery: 100 }, "已回充", "docked");
      return { ok: true, status: "docked" };
    }
    return { ok: true, status: this.store.getDevice(device.id)?.status ?? "unknown" };
  }

  private applyPurifier(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_mode") {
      const mode = String(args.mode ?? "auto");
      this.store.patchDeviceAttrs(device.id, { mode, pm25: 22 }, `模式 ${mode}`, "running");
      return { ok: true, mode };
    }
    return { pm25: 22, quality: "good" };
  }

  private applyLight(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_brightness") {
      const brightness = Number(args.brightness ?? 70);
      this.store.patchDeviceAttrs(device.id, { brightness, on: brightness > 0 }, `亮度 ${brightness}%`, "on");
      return { ok: true, brightness };
    }
    if (toolName === "set_color") {
      const color = String(args.color ?? "warm");
      this.store.patchDeviceAttrs(device.id, { color, on: true }, `颜色 ${color}`, "on");
      return { ok: true, color };
    }
    this.store.patchDeviceAttrs(device.id, { brightness: 0, on: false }, "已关闭", "off");
    return { ok: true, on: false };
  }

  private applyAC(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_temp") {
      const temp = Number(args.temp ?? 24);
      this.store.patchDeviceAttrs(device.id, { temp, on: true }, `${temp}°C`, "running");
      return { ok: true, temp };
    }
    if (toolName === "set_mode") {
      const mode = String(args.mode ?? "auto");
      this.store.patchDeviceAttrs(device.id, { mode, on: true }, `模式 ${mode}`, "running");
      return { ok: true, mode };
    }
    if (toolName === "turn_off") {
      this.store.patchDeviceAttrs(device.id, { on: false }, "已关闭", "off");
      return { ok: true, on: false };
    }
    const attrs = this.store.getDevice(device.id)?.attrs ?? {};
    return { temp: attrs.temp ?? 24, mode: attrs.mode ?? "auto" };
  }

  private applyLock(device: DeviceDef, toolName: string): unknown {
    const locked = toolName !== "unlock";
    this.store.patchDeviceAttrs(device.id, { locked }, locked ? "已锁定" : "已解锁", locked ? "locked" : "unlocked");
    return { ok: true, locked };
  }

  private applyCamera(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_mode") {
      const mode = String(args.mode ?? "watch");
      this.store.patchDeviceAttrs(device.id, { mode }, `模式 ${mode}`, "watching");
      return { ok: true, mode };
    }
    if (toolName === "detect_motion") {
      this.store.patchDeviceAttrs(device.id, { motion: true, alertTicks: 0 }, "检测到运动", "alert");
      return { ok: true, motion: true, area: "门口" };
    }
    return { ok: true, image: "captured" };
  }

  private applySpeaker(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "play") {
      const music = String(args.music ?? "轻音乐");
      this.store.patchDeviceAttrs(device.id, { playing: true, music }, `播放 ${music}`, "playing");
      return { ok: true, music };
    }
    if (toolName === "pause") {
      this.store.patchDeviceAttrs(device.id, { playing: false }, "已暂停", "paused");
      return { ok: true };
    }
    const volume = Number(args.volume ?? 50);
    this.store.patchDeviceAttrs(device.id, { volume }, `音量 ${volume}%`, "playing");
    return { ok: true, volume };
  }

  private applyFridge(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_temp") {
      const temp = Number(args.temp ?? 4);
      this.store.patchDeviceAttrs(device.id, { temp }, `${temp}°C`, "running");
      return { ok: true, temp };
    }
    const items = ["牛奶", "鸡蛋", "水果", "沙拉", "酸奶"];
    this.store.patchDeviceAttrs(device.id, { inventoryCount: items.length }, `${items.length} 种食材`, "running");
    return { items };
  }

  private applyWasher(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "start_wash") {
      const mode = String(args.mode ?? "standard");
      this.store.patchDeviceAttrs(device.id, { mode, progress: 5 }, `洗涤中 ${mode}`, "washing");
      return { ok: true, mode };
    }
    return { status: this.store.getDevice(device.id)?.status ?? "idle" };
  }

  private applyCurtain(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    let position = 100;
    if (toolName === "close") position = 0;
    if (toolName === "set_position") position = Number(args.position ?? 50);
    const status = position > 35 ? "open" : "idle";
    this.store.patchDeviceAttrs(device.id, { position }, `开合度 ${position}%`, status);
    return { ok: true, position };
  }

  private applyCar(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "start_engine") {
      this.store.patchDeviceAttrs(device.id, { engine: true }, "引擎已启动，行驶中", "running");
      this.store.moveDevice(device.id, rnd(0.15, 0.85), rnd(0.15, 0.85), "行驶中");
      this.startCarCruise(device.id);
      return { ok: true };
    }
    if (toolName === "stop_engine") {
      this.store.patchDeviceAttrs(device.id, { engine: false }, "引擎已关闭", "idle");
      this.stopCarCruise(device.id);
      return { ok: true };
    }
    if (toolName === "navigate") {
      const destination = String(args.destination ?? "目的地");
      this.store.patchDeviceAttrs(device.id, { destination, engine: true }, `导航至 ${destination}`, "navigating");
      this.store.moveDevice(device.id, rnd(0.1, 0.9), rnd(0.2, 0.8), `导航至 ${destination}`);
      return { ok: true, destination };
    }
    if (toolName === "play_music") {
      const music = String(args.music ?? "驾驶音乐");
      this.store.patchDeviceAttrs(device.id, { music }, `播放 ${music}`, "running");
      return { ok: true, music };
    }
    if (toolName === "set_ac") {
      const temp = Number(args.temp ?? 24);
      this.store.patchDeviceAttrs(device.id, { temp }, `车内 ${temp}°C`, "running");
      return { ok: true, temp };
    }
    const current = this.store.getDevice(device.id);
    return { x: current?.x ?? 0.5, y: current?.y ?? 0.5 };
  }

  private applyScreen(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "show_content") {
      const content = String(args.content ?? "内容");
      this.store.patchDeviceAttrs(device.id, { content }, `展示 ${content}`, "displaying");
      return { ok: true, content };
    }
    const status = toolName === "start_meeting" ? "会议中" : "会议结束";
    this.store.patchDeviceAttrs(device.id, { meeting: toolName === "start_meeting" }, status, toolName === "start_meeting" ? "meeting" : "idle");
    return { ok: true };
  }

  private applyMower(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "mow") {
      this.store.moveDevice(device.id, rnd(0.1, 0.9), rnd(0.1, 0.9), "割草中");
      this.store.patchDeviceAttrs(device.id, { mowing: true }, "割草中", "working");
      this.startRandomPatrol(device.id, "割草中");
      return { ok: true };
    }
    if (toolName === "set_area") {
      const area = String(args.area ?? "花园");
      this.store.patchDeviceAttrs(device.id, { area }, `区域 ${area}`, "working");
      return { ok: true, area };
    }
    this.stopPatrol(device.id);
    this.store.patchDeviceAttrs(device.id, { mowing: false }, "已停靠", "docked");
    return { ok: true };
  }

  private applyServiceRobot(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "deliver_item") {
      const item = String(args.item ?? "物品");
      const room = String(args.room ?? "房间");
      this.store.moveDevice(device.id, rnd(0.15, 0.85), rnd(0.15, 0.85), `配送 ${item}`);
      this.store.patchDeviceAttrs(device.id, { item, room }, `送 ${item} 到 ${room}`, "delivering");
      this.startRandomPatrol(device.id, `配送 ${item}`);
      return { ok: true, item, room };
    }
    const destination = String(args.destination ?? "目的地");
    this.store.moveDevice(device.id, rnd(0.15, 0.85), rnd(0.15, 0.85), `引导至 ${destination}`);
    this.store.patchDeviceAttrs(device.id, { destination }, `引导至 ${destination}`, "guiding");
    this.startRandomPatrol(device.id, `引导至 ${destination}`);
    return { ok: true, destination };
  }

  private applyGuideRobot(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "query_department") {
      return { department: String(args.query ?? "内科"), location: "一楼东侧" };
    }
    const department = String(args.department ?? "内科");
    this.store.moveDevice(device.id, rnd(0.2, 0.8), rnd(0.2, 0.8), `导诊至 ${department}`);
    this.store.patchDeviceAttrs(device.id, { department }, `导诊至 ${department}`, "guiding");
    this.startRandomPatrol(device.id, `导诊至 ${department}`);
    return { ok: true, department };
  }

  private applyEnvMonitor(device: DeviceDef, toolName: string): unknown {
    if (toolName === "get_temp") {
      const temp = 24 + Math.round(rnd(-3, 6));
      this.store.patchDeviceAttrs(device.id, { temp }, `温度 ${temp}°C`, "running");
      return { temp };
    }
    if (toolName === "get_humidity") {
      const humidity = 45 + Math.round(rnd(0, 20));
      this.store.patchDeviceAttrs(device.id, { humidity }, `湿度 ${humidity}%`, "running");
      return { humidity };
    }
    if (toolName === "get_air_quality") {
      const pm25 = 18 + Math.round(rnd(0, 20));
      this.store.patchDeviceAttrs(device.id, { pm25 }, `PM2.5: ${pm25}`, "running");
      return { pm25 };
    }
    if (toolName === "get_noise") {
      const noise = 58 + Math.round(rnd(0, 12));
      this.store.patchDeviceAttrs(device.id, { noise }, `噪声 ${noise}dB`, "running");
      return { noise };
    }
    const vibration = Number(rnd(0.1, 0.6).toFixed(2));
    this.store.patchDeviceAttrs(device.id, { vibration }, `振动 ${vibration}`, "running");
    return { vibration };
  }

  private applyStreetlight(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "set_brightness") {
      const brightness = Number(args.brightness ?? 80);
      this.store.patchDeviceAttrs(device.id, { brightness }, `亮度 ${brightness}%`, "running");
      return { ok: true, brightness };
    }
    return { status: "ok" };
  }

  private applyCharger(device: DeviceDef, toolName: string): unknown {
    if (toolName === "start_charge") {
      this.store.patchDeviceAttrs(device.id, { charging: true, progress: 12 }, "充电中 12%", "charging");
      return { ok: true };
    }
    if (toolName === "stop_charge") {
      this.store.patchDeviceAttrs(device.id, { charging: false }, "已停止充电", "idle");
      return { ok: true };
    }
    return { charging: Boolean(this.store.getDevice(device.id)?.attrs.charging) };
  }

  private applyPoolRobot(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "clean") {
      this.store.moveDevice(device.id, rnd(0.15, 0.85), rnd(0.15, 0.85), "泳池清扫中");
      this.store.patchDeviceAttrs(device.id, { cleaning: true }, "泳池清扫中", "cleaning");
      this.startCircularPatrol(device.id, 0.5, 0.5, 0.35, 4500, "泳池清扫中");
      return { ok: true };
    }
    if (toolName === "set_area") {
      const area = String(args.area ?? "池底");
      this.store.patchDeviceAttrs(device.id, { area }, `区域 ${area}`, "cleaning");
      return { ok: true, area };
    }
    this.stopPatrol(device.id);
    this.store.patchDeviceAttrs(device.id, { cleaning: false }, "已停靠", "docked");
    return { ok: true };
  }

  private applyPatrolRobot(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "patrol") {
      this.store.moveDevice(device.id, rnd(0.12, 0.88), rnd(0.12, 0.88), "巡检中");
      this.store.patchDeviceAttrs(device.id, { patrol: true }, "巡检中", "patrolling");
      this.startRandomPatrol(device.id, "巡检中");
      return { ok: true };
    }
    if (toolName === "report_anomaly") {
      const anomaly = String(args.anomaly ?? "未知异常");
      this.stopPatrol(device.id);
      this.store.patchDeviceAttrs(device.id, { anomaly }, `异常: ${anomaly}`, "alert");
      return { ok: true, anomaly };
    }
    this.stopPatrol(device.id);
    return { status: this.store.getDevice(device.id)?.status ?? "idle" };
  }

  private applyWatch(device: DeviceDef, toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "get_heart_rate") {
      const heartRate = Math.round(rnd(68, 108));
      this.store.patchDeviceAttrs(device.id, { heartRate }, `心率 ${heartRate}`, "tracking");
      return { heartRate };
    }
    if (toolName === "get_steps") {
      const steps = Math.round(rnd(2400, 9800));
      this.store.patchDeviceAttrs(device.id, { steps }, `${steps} 步`, "tracking");
      return { steps };
    }
    const message = String(args.message ?? "请注意休息");
    this.store.patchDeviceAttrs(device.id, { alert: message }, `提醒: ${message}`, "alert");
    return { ok: true, message };
  }
}
