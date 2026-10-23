import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-qq 配置。
 *
 * 设计原则：
 *  - 所有跟「连谁、允许谁说话、放开到什么程度」有关的键，默认都是保守的；
 *  - provider / model / preset / cwd 一律留空跟随宿主，避免把某个人的环境写死。
 */
export const ConfigSchema = Schema.object({
  // ── 连接 ──
  wsUrl: Schema.string()
    .default('ws://127.0.0.1:3001')
    .description('NapCat（或其它 OneBot 11 实现）的正向 WebSocket 地址，例如 ws://127.0.0.1:3001'),
  accessToken: Schema.string()
    .default('')
    .description('与 NapCat 配置里一致的 access token，留空表示不鉴权（仅建议在本机回环场景）'),
  selfId: Schema.string()
    .default('')
    .description('机器人自己的 QQ 号。留空时启动会向 NapCat 查询 get_login_info'),
  reconnectMs: Schema.number()
    .default(5000)
    .description('断线重连间隔，单位毫秒'),

  // ── Agent ──
  provider: Schema.string().description('LLM provider 名称；留空跟随宿主默认'),
  model: Schema.string().description('模型名；留空跟随宿主默认'),
  preset: Schema.string().description('Agent preset id（例如 whale）；留空使用宿主默认组合'),
  cwd: Schema.string().description('Agent 工作目录；留空使用宿主默认'),
  directPrompt: Schema.string()
    .default('')
    .description('私聊场景追加的系统提示词'),
  groupPrompt: Schema.string()
    .default('')
    .description('群聊场景追加的系统提示词'),
  historyLimit: Schema.number()
    .default(20)
    .description('群聊时额外带入的最近消息条数（0 = 不带历史）'),

  // ── 触发策略 ──
  requireMention: Schema.boolean()
    .default(true)
    .description('群聊里是否必须 @ 机器人才回复'),
  replyToPrivate: Schema.boolean()
    .default(true)
    .description('是否响应私聊'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('open')
    .description('群聊访问控制：open 全部 / allowlist 仅白名单 / disabled 关闭群聊'),
  groupAllow: Schema.array(Schema.string())
    .default([])
    .description('groupMode=allowlist 时生效的群号列表'),
  privateMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('open')
    .description('私聊访问控制：open 全部 / allowlist 仅白名单 / disabled 关闭私聊'),
  privateAllow: Schema.array(Schema.string())
    .default([])
    .description('privateMode=allowlist 时生效的 QQ 号列表'),

  // ── 输出 ──
  textChunkLimit: Schema.number()
    .default(1500)
    .description('单条消息最大字数，超出会按段落/句号切成多条发'),
  showToolResults: Schema.boolean()
    .default(false)
    .description('是否把工具调用结果也发到 QQ（默认关闭，只发文字回复）'),
  splitDelayMs: Schema.number()
    .default(400)
    .description('分条发送之间的间隔，单位毫秒'),

  // ── 生命周期 ──
  sessionIdleTimeout: Schema.number()
    .default(1800000)
    .description('会话闲置多久后回收，单位毫秒（默认 30 分钟）'),
  debug: Schema.boolean()
    .default(false)
    .description('输出调试日志'),
})
