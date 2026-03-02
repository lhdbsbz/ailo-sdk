# ailo-clawwork

Ailo 的 ClawWork 打工端点 —— 让 Ailo 进入 [ClawWork](https://github.com/HKUDS/ClawWork) 经济生存模拟，通过完成真实职业任务来历练自己。

## 它是什么

ClawWork 是一个 AI 经济生存竞技场：AI Agent 以 $10 启动资金开始，通过完成 GDPVal 数据集中的 220 个真实职业任务赚取报酬，同时承担 token 调用成本，必须保持正余额才能"存活"。

本端点是一个**零侵入桥接层**，让 Ailo 以标准端点工具的方式接入 ClawWork，不修改 Ailo 服务端代码和 ClawWork 源码。

```
Ailo Server
  ↕ WebSocket
ailo-clawwork 端点 (TypeScript)
  ↕ HTTP
ClawWork Sidecar (Python FastAPI)
  ├── TaskManager     — 220 个 GDPVal 任务
  ├── WorkEvaluator   — GPT 评分引擎（44 个行业专属评分标准）
  └── EconomicTracker — 余额 / 收入 / 成本追踪
```

## 前置要求

- **Node.js** >= 18
- **Python** >= 3.10
- **git-lfs**（用于下载 GDPVal 数据集中的大文件）
- 同级目录下已 clone 的 [ClawWork](https://github.com/HKUDS/ClawWork) 仓库
- （评分功能需要）OpenAI API Key 或兼容 API（DeepSeek、阿里云百炼、硅基流动等均可）

目录结构应如下：

```
workspace/
├── ailo/                    # Ailo 服务端（不改动）
├── ailo-sdk/
│   ├── packages/
│   │   ├── ailo-clawwork/   # ← 本包
│   │   └── ailo-desktop/
│   └── sdks/
│       └── ailo-endpoint-sdk/
└── ClawWork/                # ClawWork 仓库
```

## 快速开始

### 1. 初始化（只需一次）

```powershell
cd ailo-sdk/packages/ailo-clawwork/sidecar
.\setup.ps1
```

脚本会自动完成：
- 从 HuggingFace 下载 GDPVal 数据集（1.6 GB）到 `ClawWork/gdpval/`
- 创建 Python 虚拟环境并安装依赖
- 生成 `.env` 文件

### 2. 配置 API Key

编辑 `sidecar/.env`：

```
EVALUATION_API_KEY=sk-your-openai-key
```

支持 OpenAI、OpenRouter 或任何 OpenAI 兼容 API。如果使用 OpenRouter：

```
EVALUATION_API_KEY=sk-or-v1-your-key
EVALUATION_API_BASE=https://openrouter.ai/api/v1
```

支持的国内 API 提供商：

| 提供商 | 注册地址 | EVALUATION_API_BASE | EVALUATION_MODEL |
|--------|----------|---------------------|------------------|
| DeepSeek | https://platform.deepseek.com | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 阿里云百炼 | https://bailian.console.aliyun.com | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| 智谱 AI | https://open.bigmodel.cn | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| 硅基流动 | https://cloud.siliconflow.cn | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |

没有 Key 也可以启动 sidecar，领任务和查状态正常工作，只是提交评分不可用。

### 3. 启动 Sidecar（终端 1）

```powershell
cd ailo-sdk/packages/ailo-clawwork/sidecar
.venv\Scripts\python server.py
```

看到以下输出表示成功：

```
  Tasks loaded   : 220
  Balance        : $10.00
  Evaluator      : ready
  Listening on   : http://localhost:8020
```

### 4. 启动端点（终端 2）

```powershell
cd ailo-sdk/packages/ailo-clawwork
npm install
npm run dev
```

端点会通过 WebSocket 连接到 Ailo 服务端，注册 4 个工具。

### 5. 启动 ailo-desktop（终端 3）

ClawWork 任务要求产出真实文件（DOCX/XLSX/PDF），Ailo 需要 desktop 端点的工具来创建文件：

```powershell
cd ailo-sdk/packages/ailo-desktop
npm run dev
```

### 6. 开始打工

在 Ailo 对话中说：

> "帮我看看 ClawWork 状态，然后领一个任务"

Ailo 会自动调用 `clawwork_status` → `clawwork_get_task`，然后用已有工具（`write_file`、`execute_code` 等）完成任务，最后用 `clawwork_submit` 提交评分。

更多指令示例：

```
# 连续打工
"去 ClawWork 连续打工，完成 3 个任务，每个任务完成后查看评分。"

# 自我复盘式训练
"去 ClawWork 领一个任务。完成后仔细阅读评语中的改进建议，总结经验，然后领下一个任务尝试改进。"

# 查看排名
"看看 ClawWork 排行榜，我和其他 AI 的对比。"
```

## 工具列表

| 工具 | 说明 |
|------|------|
| `clawwork_status` | 查看余额、生存状态、累计收入/成本 |
| `clawwork_get_task` | 领取一个职业任务（返回任务描述、行业、报酬上限） |
| `clawwork_submit` | 提交产出物进行评估（评分 >= 60% 才发放报酬） |
| `clawwork_leaderboard` | 查看所有 Agent 的排名 |

## Sidecar HTTP API

Sidecar 默认监听 `http://localhost:8020`，可通过环境变量 `CLAWWORK_SIDECAR_URL` 覆盖。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（任务数、余额、评估器状态） |
| `/status` | GET | 经济状态详情 |
| `/task?date=YYYY-MM-DD` | GET | 领取任务 |
| `/submit` | POST | 提交评估（body: `{task_id, work_summary, artifact_paths}`） |
| `/leaderboard` | GET | 所有 Agent 排名 |

## 查看排名 Dashboard

ClawWork 自带 React Dashboard，Ailo 的数据会自动写入 `ClawWork/livebench/data/agent_data/Ailo/`，Dashboard 直接识别。

```powershell
cd ClawWork
.\start_dashboard.sh
# 浏览器打开 http://localhost:3000
```

可以看到 Ailo 与 Gemini 3.1 Pro、Qwen3.5-Plus、GLM-4.7 等模型的并排对比。

## 目录结构

```
ailo-clawwork/
├── package.json              # npm 包配置
├── tsconfig.json
├── README.md
├── src/
│   └── index.ts              # TypeScript 端点入口
├── blueprints/
│   └── clawwork.blueprint.md # 工具 schema + LLM 打工指引
└── sidecar/
    ├── server.py             # FastAPI 服务
    ├── config.json           # 路径配置
    ├── requirements.txt      # Python 依赖
    ├── setup.ps1             # 一键初始化脚本
    ├── .env.example          # API Key 模板
    └── .env                  # 你的 API Key（初始化后生成，不提交 git）
```

## 配置说明

`sidecar/config.json` 中的路径均相对于 sidecar 目录，指向 workspace 中的 ClawWork 仓库：

```json
{
  "signature": "Ailo",
  "initial_balance": 10.0,
  "token_pricing": { "input_per_1m": 2.5, "output_per_1m": 10.0 },
  "port": 8020,
  "paths": {
    "clawwork_root": "../../../../ClawWork",
    "gdpval": "../../../../ClawWork/gdpval",
    "task_values": "../../../../ClawWork/scripts/task_value_estimates/task_values.jsonl",
    "meta_prompts": "../../../../ClawWork/eval/meta_prompts",
    "agent_data": "../../../../ClawWork/livebench/data/agent_data"
  }
}
```

修改 `signature` 可以更换 Agent 名称（会影响数据目录和 Dashboard 显示名）。

## 零污染保证

- `ailo/` — 0 文件修改
- `ailo-sdk/sdks/` — 0 文件修改
- `ClawWork/` — 仅新增 `gdpval/`（下载的数据集）和 `livebench/data/agent_data/Ailo/`（打工数据）
