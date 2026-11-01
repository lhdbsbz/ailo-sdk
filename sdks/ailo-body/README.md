# @greatlhd/ailo-body

把一台机器、一个设备、一个执行器接成 **大脑的四肢**。协议 `ailo-body/1`，零运行时依赖（Node ≥ 22 自带 WebSocket）。

```bash
npm i @greatlhd/ailo-body
```

## 一条界线

**大脑知道，肢体能做。**

- 知识（技能、手册、经验、提示词）在 ailo 那边，**不在这个包里**。
- 肢体只有：身份、一行描述、一小撮动作、媒体进出、（可选）观测上报。
- 动作只在肢体内有名：地址是 `(bodyId, action)`。所以这里不需要前缀、不需要避让别的设备、不会与谁冲突。

规范在 ailo 仓 `docs/protocol/body-v1.md`；一致性语料 `conformance-body-1.json`（本包 `npm test` 直接跑它，是协议的第二个实现）。**本文件不复述协议**。

## 最小肢体

```ts
import { runBody } from '@greatlhd/ailo-body'

runBody({
  url: 'ws://127.0.0.1:19800/ws',
  apiKey: process.env.AILO_API_KEY!,
  bodyId: 'lamp-01',
  name: '客厅的灯',
  description: '一盏能开关、能调亮度的灯',
  actions: [
    {
      name: 'set',
      description: '开关与调亮度',
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean' },
          brightness: { type: 'integer', description: '0-100' },
        },
        required: ['on'],
      },
    },
  ],
  handlers: {
    set: async (args) => {
      // 参数校验是肢体自己的事：你比大脑更清楚自己的约束。
      if (typeof args.on !== 'boolean') throw new Error('on must be boolean')
      const brightness = Number(args.brightness ?? 100)
      // …真的去开灯…
      return { ok: true, on: args.on, brightness }
    },
  },
  handler: {
    start(ctx) {
      // 观测：肢体主动上报信号。它只说"来自哪"，落进哪段对话是大脑的决定。
      setInterval(() => {
        void ctx.observe('客厅亮度降到 10%', { source: { kind: 'sensor', id: 'lux' } })
      }, 60_000)
    },
    stop() {},
  },
})
```

## 常见做法

| 需求 | 做法 |
| --- | --- |
| 返回图片/文件 | 先 `await ctx.media.upload(path)` 拿 blob id，再作为 `content` 返回（协议不允许 base64 与本地路径） |
| 设备热插拔（换了灯带） | `await ctx.updateActions([...])`，整体替换动作表 |
| 长时间的动作 | 看 `call.signal`：大脑超时或用户取消时它会 abort，收手即可（不 abort 就是同一副作用做两次） |
| 断线 | 客户端自己退避重连；被同 bodyId 新进程顶替（close 4001）时不会重连 |
| 一组动作的本地状态 | 自己存（文件/数据库）。SDK 不提供 KV：那是身体自己的事 |

## 别在这里做的事

- 加载技能、拼提示词、塞 `instructions` —— 知识属于大脑。
- 包一个 MCP 客户端 —— MCP 是让 agent 长出新四肢的协议；四肢里再套一层四肢。
- 自带聊天界面 —— 通道属于大脑。
- 把领域知识写进 `description` —— 它只是一行"这东西是什么"。
