import type { ToolCapability } from "@greatlhd/ailo-endpoint-sdk";

export type SceneId =
  | "home"
  | "car"
  | "office"
  | "hotel"
  | "hospital"
  | "city"
  | "factory";

export type DeviceType =
  | "vacuum"
  | "purifier"
  | "light"
  | "ac"
  | "lock"
  | "camera"
  | "speaker"
  | "fridge"
  | "washer"
  | "curtain"
  | "car"
  | "screen"
  | "mower"
  | "serviceRobot"
  | "guideRobot"
  | "envMonitor"
  | "streetlight"
  | "charger"
  | "poolRobot"
  | "patrolRobot"
  | "watch";

export interface SceneDef {
  id: SceneId;
  label: string;
  color: string;
  accent: string;
}

export interface DeviceDef {
  id: string;
  name: string;
  icon: string;
  scene: SceneId;
  type: DeviceType;
  movable?: boolean;
  userLinked?: boolean;
  tools: ToolCapability[];
}

export interface ScenarioMessage {
  endpointId: string;
  text: string;
  delayMs?: number;
}

export interface ScenarioDef {
  id: string;
  label: string;
  description: string;
  messages: ScenarioMessage[];
}

const numParam = (name: string, min?: number, max?: number) => ({
  type: "object",
  properties: {
    [name]: {
      type: "number",
      ...(min !== undefined ? { minimum: min } : {}),
      ...(max !== undefined ? { maximum: max } : {}),
    },
  },
  required: [name],
});

const strParam = (name: string, enums?: string[]) => ({
  type: "object",
  properties: {
    [name]: enums ? { type: "string", enum: enums } : { type: "string" },
  },
  required: [name],
});

const tool = (name: string, description: string, parameters?: Record<string, unknown>): ToolCapability => ({
  name,
  description,
  ...(parameters ? { parameters } : {}),
});

export const SCENES: SceneDef[] = [
  { id: "home", label: "家庭", color: "#14281f", accent: "#10b981" },
  { id: "car", label: "汽车", color: "#152230", accent: "#3b82f6" },
  { id: "office", label: "公司", color: "#2b2514", accent: "#f59e0b" },
  { id: "hotel", label: "酒店", color: "#2a1627", accent: "#ec4899" },
  { id: "hospital", label: "医院", color: "#152728", accent: "#14b8a6" },
  { id: "city", label: "城市", color: "#17182b", accent: "#8b5cf6" },
  { id: "factory", label: "工厂", color: "#2a1d16", accent: "#f97316" },
];

export const DEVICES: DeviceDef[] = [
  { id: "home-vacuum", name: "扫地机器人", icon: "🤖", scene: "home", type: "vacuum", movable: true, tools: [
    tool("move", "移动到指定位置", { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }),
    tool("clean", "开始清扫"),
    tool("dock", "返回充电座"),
    tool("get_status", "获取状态"),
  ]},
  { id: "home-purifier", name: "空气净化器", icon: "🌬", scene: "home", type: "purifier", tools: [
    tool("set_mode", "设置模式", strParam("mode", ["auto", "sleep", "turbo"])),
    tool("get_air_quality", "获取空气质量"),
  ]},
  { id: "home-light-living", name: "客厅灯", icon: "💡", scene: "home", type: "light", tools: [
    tool("set_brightness", "设置亮度", numParam("brightness", 0, 100)),
    tool("set_color", "设置颜色", strParam("color")),
    tool("turn_off", "关灯"),
  ]},
  { id: "home-light-bedroom", name: "卧室灯", icon: "💡", scene: "home", type: "light", tools: [
    tool("set_brightness", "设置亮度", numParam("brightness", 0, 100)),
    tool("set_color", "设置颜色", strParam("color")),
    tool("turn_off", "关灯"),
  ]},
  { id: "home-ac", name: "智能空调", icon: "❄", scene: "home", type: "ac", tools: [
    tool("set_temp", "设置温度", numParam("temp", 16, 30)),
    tool("set_mode", "设置模式", strParam("mode", ["cool", "heat", "auto", "sleep"])),
    tool("turn_off", "关闭空调"),
    tool("get_temp", "获取温度"),
  ]},
  { id: "home-lock", name: "智能门锁", icon: "🔒", scene: "home", type: "lock", tools: [
    tool("lock", "上锁"),
    tool("unlock", "解锁"),
    tool("get_status", "获取状态"),
  ]},
  { id: "home-camera", name: "智能摄像头", icon: "📷", scene: "home", type: "camera", tools: [
    tool("capture", "拍摄画面"),
    tool("detect_motion", "检测运动"),
    tool("set_mode", "设置模式", strParam("mode", ["watch", "away", "off"])),
  ]},
  { id: "home-speaker", name: "智能音箱", icon: "🔊", scene: "home", type: "speaker", tools: [
    tool("play", "播放音频", strParam("music")),
    tool("pause", "暂停播放"),
    tool("set_volume", "设置音量", numParam("volume", 0, 100)),
  ]},
  { id: "home-fridge", name: "智能冰箱", icon: "🧊", scene: "home", type: "fridge", tools: [
    tool("get_inventory", "查看库存"),
    tool("set_temp", "设置温度", numParam("temp", -20, 10)),
  ]},
  { id: "home-washer", name: "智能洗衣机", icon: "👕", scene: "home", type: "washer", tools: [
    tool("start_wash", "开始洗衣", strParam("mode", ["standard", "quick", "gentle", "heavy"])),
    tool("get_status", "获取状态"),
  ]},
  { id: "home-curtain", name: "智能窗帘", icon: "🪟", scene: "home", type: "curtain", tools: [
    tool("open", "打开窗帘"),
    tool("close", "关闭窗帘"),
    tool("set_position", "设置开合度", numParam("position", 0, 100)),
  ]},
  { id: "car-system", name: "车载系统", icon: "🚗", scene: "car", type: "car", movable: true, userLinked: true, tools: [
    tool("start_engine", "启动引擎"),
    tool("stop_engine", "关闭引擎"),
    tool("set_ac", "设置空调", { type: "object", properties: { temp: { type: "number" }, mode: { type: "string" } } }),
    tool("play_music", "播放音乐", strParam("music")),
    tool("navigate", "开始导航", strParam("destination")),
    tool("get_location", "获取位置"),
  ]},
  { id: "office-light", name: "工位灯", icon: "💡", scene: "office", type: "light", tools: [
    tool("set_brightness", "设置亮度", numParam("brightness", 0, 100)),
    tool("turn_off", "关灯"),
  ]},
  { id: "office-ac", name: "办公空调", icon: "❄", scene: "office", type: "ac", tools: [
    tool("set_temp", "设置温度", numParam("temp", 16, 30)),
    tool("set_mode", "设置模式", strParam("mode", ["cool", "heat", "auto"])),
  ]},
  { id: "office-screen", name: "会议室智慧屏", icon: "🖥", scene: "office", type: "screen", tools: [
    tool("show_content", "展示内容", strParam("content")),
    tool("start_meeting", "开始会议"),
    tool("end_meeting", "结束会议"),
  ]},
  { id: "office-mower", name: "割草机器人", icon: "🌿", scene: "office", type: "mower", movable: true, tools: [
    tool("mow", "开始割草"),
    tool("set_area", "设置区域", strParam("area")),
    tool("dock", "返回停靠点"),
  ]},
  { id: "hotel-light", name: "酒店房间灯", icon: "💡", scene: "hotel", type: "light", tools: [
    tool("set_brightness", "设置亮度", numParam("brightness", 0, 100)),
    tool("set_color", "设置颜色", strParam("color")),
    tool("turn_off", "关灯"),
  ]},
  { id: "hotel-ac", name: "酒店空调", icon: "❄", scene: "hotel", type: "ac", tools: [
    tool("set_temp", "设置温度", numParam("temp", 16, 30)),
  ]},
  { id: "hotel-curtain", name: "酒店窗帘", icon: "🪟", scene: "hotel", type: "curtain", tools: [
    tool("open", "打开窗帘"),
    tool("close", "关闭窗帘"),
  ]},
  { id: "hotel-robot", name: "酒店服务机器人", icon: "🛎", scene: "hotel", type: "serviceRobot", movable: true, tools: [
    tool("deliver_item", "送物到房间", { type: "object", properties: { item: { type: "string" }, room: { type: "string" } }, required: ["item", "room"] }),
    tool("guide", "引导用户", strParam("destination")),
  ]},
  { id: "hospital-guide", name: "导诊机器人", icon: "🏥", scene: "hospital", type: "guideRobot", movable: true, tools: [
    tool("guide", "引导到科室", strParam("department")),
    tool("query_department", "查询科室", strParam("query")),
  ]},
  { id: "hospital-monitor", name: "病房环境监测", icon: "🌡", scene: "hospital", type: "envMonitor", tools: [
    tool("get_temp", "获取温度"),
    tool("get_humidity", "获取湿度"),
    tool("get_air_quality", "获取空气质量"),
  ]},
  { id: "city-streetlight", name: "智慧路灯", icon: "🏮", scene: "city", type: "streetlight", tools: [
    tool("set_brightness", "设置亮度", numParam("brightness", 0, 100)),
    tool("get_status", "获取状态"),
  ]},
  { id: "city-charger", name: "智能充电桩", icon: "⚡", scene: "city", type: "charger", tools: [
    tool("start_charge", "开始充电"),
    tool("stop_charge", "停止充电"),
    tool("get_status", "获取状态"),
  ]},
  { id: "city-pool-robot", name: "泳池机器人", icon: "🏊", scene: "city", type: "poolRobot", movable: true, tools: [
    tool("clean", "开始清扫"),
    tool("set_area", "设置区域", strParam("area")),
    tool("dock", "返回停靠点"),
  ]},
  { id: "factory-patrol", name: "巡检机器人", icon: "🔍", scene: "factory", type: "patrolRobot", movable: true, tools: [
    tool("patrol", "开始巡检"),
    tool("report_anomaly", "上报异常", strParam("anomaly")),
    tool("get_status", "获取状态"),
  ]},
  { id: "factory-monitor", name: "工业环境监测", icon: "📊", scene: "factory", type: "envMonitor", tools: [
    tool("get_temp", "获取温度"),
    tool("get_noise", "获取噪声"),
    tool("get_vibration", "获取振动"),
  ]},
  { id: "user-watch", name: "智能手表", icon: "⌚", scene: "home", type: "watch", movable: true, userLinked: true, tools: [
    tool("get_heart_rate", "获取心率"),
    tool("get_steps", "获取步数"),
    tool("alert", "发送提醒", strParam("message")),
  ]},
];

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "morning",
    label: "清晨起床",
    description: "用户醒来，家中设备开始感知早晨场景",
    messages: [
      { endpointId: "user-watch", text: "用户刚醒来，睡眠结束，当前心率 68，准备起床。", delayMs: 0 },
      { endpointId: "home-camera", text: "门口无人移动，室内开始有轻微活动。", delayMs: 400 },
      { endpointId: "home-purifier", text: "卧室空气质量良好，适合开启晨间模式。", delayMs: 800 },
    ],
  },
  {
    id: "commute-out",
    label: "出门通勤",
    description: "用户准备出门去公司",
    messages: [
      { endpointId: "user-watch", text: "用户已离家，正在前往公司，今天有重要会议。", delayMs: 0 },
      { endpointId: "home-lock", text: "门即将关闭，家庭进入外出状态。", delayMs: 300 },
      { endpointId: "car-system", text: "用户上车，准备导航到公司。", delayMs: 1000 },
    ],
  },
  {
    id: "office",
    label: "到达公司",
    description: "用户到达公司开始工作",
    messages: [
      { endpointId: "car-system", text: "车辆已到达公司停车位。", delayMs: 0 },
      { endpointId: "office-screen", text: "今天上午十点有项目例会。", delayMs: 500 },
      { endpointId: "office-ac", text: "办公室当前温度 27 度，略热。", delayMs: 900 },
    ],
  },
  {
    id: "health",
    label: "健康提醒",
    description: "手表检测到用户状态波动",
    messages: [
      { endpointId: "user-watch", text: "用户连续开会后心率升高到 104，压力偏高。", delayMs: 0 },
    ],
  },
  {
    id: "hotel",
    label: "入住酒店",
    description: "用户出差入住酒店",
    messages: [
      { endpointId: "hotel-robot", text: "用户刚到酒店大堂，准备办理入住。", delayMs: 0 },
      { endpointId: "hotel-ac", text: "房间当前温度 29 度，略热。", delayMs: 500 },
      { endpointId: "hotel-light", text: "用户偏好暖色灯光。", delayMs: 900 },
    ],
  },
  {
    id: "hospital",
    label: "去医院",
    description: "用户因身体不适到医院",
    messages: [
      { endpointId: "user-watch", text: "用户今天步数偏少且心率波动较大，感到不适。", delayMs: 0 },
      { endpointId: "hospital-guide", text: "门诊大厅到诊用户增多，需要导诊协助。", delayMs: 700 },
    ],
  },
  {
    id: "homecoming",
    label: "回家",
    description: "用户晚上回到家",
    messages: [
      { endpointId: "car-system", text: "用户即将到家，预计两分钟后到达。", delayMs: 0 },
      { endpointId: "home-camera", text: "门口检测到主人靠近。", delayMs: 1200 },
    ],
  },
  {
    id: "night",
    label: "深夜模式",
    description: "用户准备休息",
    messages: [
      { endpointId: "user-watch", text: "用户准备休息，当前时间较晚，适合进入夜间模式。", delayMs: 0 },
      { endpointId: "city-streetlight", text: "城市已进入深夜时段，路灯可以调暗。", delayMs: 600 },
    ],
  },
];

export function sceneMap(): Record<SceneId, SceneDef> {
  return Object.fromEntries(SCENES.map((scene) => [scene.id, scene])) as Record<SceneId, SceneDef>;
}
