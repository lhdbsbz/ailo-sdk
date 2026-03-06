# Ailo World Demo

一个意识，贯穿一个人生活里的所有空间与身体。

Ailo World Demo 是一个交互式可视化演示，模拟 28 个智能终端通过标准 Endpoint 协议接入 Ailo 意识体。每个设备拥有独立的 `endpointId`，通过 WebSocket 与 Ailo Gateway 建立真实连接，接收工具调用并执行状态变化。

## 核心理念

- **不是后台看板**，而是一个 2.5D 等距视角的智慧生活全景
- **每个设备一条连接**，不共享 `endpointId`，不模拟假数据
- **所有动作真实可视化**——灯亮环境变亮、窗帘开阳光透入、扫地机在房间里圆周运动、车辆启动后沿道路行驶

## 快速开始

```bash
# 在 ailo-sdk 根目录
npm install

# 启动 demo
cd packages/ailo-world-demo
npm run dev
```

启动后输入本地页面端口号（如 `19802`），浏览器打开 `http://localhost:19802`。

在页面顶部填写：
- **Ailo WS**：Ailo 后端的 WebSocket 地址（默认 `ws://localhost:19800/ws`）
- **API Key**：任意一个有效的 Endpoint API Key

点击「连接全部设备」即可一键接入所有 28 个终端。

## 7 大场景 × 28 个设备

| 场景 | 设备 |
|------|------|
| **家庭** | 扫地机器人、空气净化器、客厅灯、卧室灯、智能空调、智能门锁、智能摄像头、智能音箱、智能冰箱、智能洗衣机、智能窗帘 |
| **汽车** | 车载系统（引擎/导航/空调/音乐） |
| **公司** | 工位灯、办公空调、会议室智慧屏、割草机器人 |
| **酒店** | 酒店房间灯、酒店空调、酒店窗帘、酒店服务机器人 |
| **医院** | 导诊机器人、病房环境监测 |
| **城市** | 智慧路灯、智能充电桩、泳池机器人 |
| **工厂** | 巡检机器人、工业环境监测 |

另有 **智能手表** 绑定用户本人，跨场景跟随。

## 交互方式

### 鼠标直接操控
- **点击**任意设备精灵可切换开/关状态（灯、空调、窗帘、门锁、音箱等）
- **拖拽**可移动的设备（扫地机、割草机、巡检机器人、汽车等）到场景中的新位置
- **悬停**显示设备名称和当前状态气泡

### 时间线场景
顶部场景栏提供 8 个预设生活场景（清晨起床、出门通勤、到达公司、健康提醒、入住酒店、去医院、回家、深夜模式），点击即可向对应设备发送上下文消息，触发 Ailo 意识体的自主决策。

### 一键重置
右上角「一键重置」按钮可断开所有连接、清除所有状态，恢复到初始状态。

## 视觉效果

- **环境联动**：灯开→房间变亮，灯关→房间变暗；空调开→冷气特效；窗帘开→阳光透入；音箱播放→紫色氛围光
- **设备动画**：扫地机圆周清扫轨迹、净化器风扇转动、门锁脉动、摄像头警报闪烁、洗衣机抖动、车灯亮起
- **自动巡逻**：割草机、巡检机器人、导诊机器人、泳池机器人启动后会在场景中自动巡回移动

## 项目结构

```
src/
├── index.ts              # 入口，启动 HTTP/WS 服务器
├── config.ts             # 设备定义、场景定义、预设场景剧本
├── state-store.ts        # 全局设备运行时状态管理，事件驱动
├── device-hub.ts         # 设备连接编排，工具调用处理，自动巡逻逻辑
├── server.ts             # HTTP 静态服务 + REST API + WebSocket 广播
└── static/
    ├── index.html         # 单页入口
    ├── app.js             # 前端主模块，初始化和数据流
    ├── core/
    │   ├── api.js         # HTTP/WS 客户端封装
    │   └── storage.js     # 连接表单本地持久化
    ├── ui/
    │   ├── device-panel.js    # 右侧 Endpoint 列表
    │   ├── log-panel.js       # 实时日志面板
    │   ├── scenario-bar.js    # 时间线场景栏
    │   └── device-interact.js # 鼠标交互（点击/拖拽/悬停）
    ├── scenes/
    │   ├── world-stage.js       # 场景调度器
    │   ├── home-scene.js        # 家庭场景（客厅+卧室+玄关）
    │   └── secondary-scenes.js  # 其他 6 个场景
    ├── styles/
    │   ├── base.css             # 全局布局和组件
    │   ├── world-layout.css     # 场景网格和环境叠层
    │   ├── home-scene.css       # 家庭场景房间和家具
    │   ├── secondary-scenes.css # 其他场景元素
    │   ├── devices.css          # 设备精灵和动画
    │   └── panels.css           # 右侧面板和日志
    └── assets/
        └── scenes/              # AI 生成的等距场景底图（PNG）
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js + TypeScript，原生 HTTP/WS 服务器 |
| 设备通信 | `@lmcl/ailo-endpoint-sdk`（WebSocket Endpoint 协议） |
| 前端 | 原生 HTML/CSS/JS modules，无构建工具，无框架 |
| 场景渲染 | CSS Grid + 2.5D 等距透视 + AI 生成场景底图 |
| 动画 | CSS transitions + keyframes + JS 状态驱动 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 获取当前全局状态快照 |
| POST | `/api/connect` | 连接全部设备到 Ailo |
| POST | `/api/disconnect` | 断开全部设备 |
| POST | `/api/reset` | 一键重置所有状态 |
| POST | `/api/scenario/run` | 执行预设场景 |
| POST | `/api/device/action` | 手动触发设备工具调用 |
| WS | `/demo/ws` | 实时状态推送（snapshot + log） |

## 给投资人演示

1. 先启动 Ailo 后端（`ailo`），确保 WebSocket 服务在 `ws://localhost:19800/ws` 可用
2. 启动 World Demo（`npm run dev`），输入端口号
3. 在页面填入 API Key，点击「连接全部设备」
4. 等待右侧面板显示所有设备上线
5. 用鼠标点击设备演示手动控制
6. 点击顶部时间线场景（如「清晨起床」），观察 Ailo 如何自主调度多个设备协同响应
7. 强调：这里每一个圆点、每一个开关，都是一条真实的 Endpoint 连接——把模拟的替换成真实硬件，就是完整的产品
