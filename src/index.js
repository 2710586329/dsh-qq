import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from './config.js'
import { OneBotClient } from './onebot/client.js'
import { textSegments } from './onebot/segment.js'
import { SessionManager } from './session.js'
import { createInbound } from './inbound.js'
import { createOutbound } from './outbound.js'
import { splitText, sleep } from './shared/chunk.js'
import { registerTools } from './tools.js'
import { ApprovalChannel } from './approval.js'
import { QuestionChannel } from './questions.js'

export const name = 'dsh-qq'
export const inject = ['agents']
export const Config = ConfigSchema

function makeLogger(ctx, config) {
  const base = ctx?.logger ?? console
  const prefix = '[dsh-qq]'
  // debug 开着时，额外落一份到 workspaceRoot（固定位置，不随启动目录漂移；
  // 没配 workspaceRoot 才退回进程 cwd），headless 宿主的控制台里不一定要得见
  const file = config?.debug ? join(config?.workspaceRoot ?? process.cwd(), 'dsh-qq-debug.log') : ''
  const fileLog = file
    ? (level, args) => {
        try {
          appendFileSync(
            file,
            `${new Date().toISOString()} [${level}] ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`,
          )
        } catch {
          /* 日志失败不影响主流程 */
        }
      }
    : null
  const wrap = (level) => (fn) => (...args) => {
    fileLog?.(level, args)
    return typeof fn === 'function' ? fn(prefix, ...args) : undefined
  }
  return {
    info: wrap('info')(base.info?.bind(base)),
    warn: wrap('warn')(base.warn?.bind(base)),
    error: wrap('error')(base.error?.bind(base)),
    debug: config?.debug ? wrap('debug')((base.debug ?? base.info)?.bind(base)) : () => {},
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 把 QQ（OneBot 11 / NapCat）当成 DSH 的一个前端：
 * 私聊 / 群聊各对应一个持久 Agent 会话，消息进来 followup，回复走 session/event 出去。
 */
export function apply(ctx, config) {
  const logger = makeLogger(ctx, config)
  const agents = ctx?.agents
  if (!agents) {
    logger.warn('宿主没有 agents 服务，dsh-qq 不启动')
    return
  }

  const client = new OneBotClient({
    url: config.wsUrl,
    token: config.accessToken,
    reconnectMs: config.reconnectMs,
    logger,
  })

  let selfId = String(config.selfId ?? '')
  const manager = new SessionManager({ agents, selfId, config, logger })
  manager.start()

  // 每个会话最近 60 秒的发消息时间戳 —— 防「回得太快」被风控
  const sentLog = new Map()

  function rateOk(key, limit) {
    const n = Number(limit) || 0
    if (n <= 0) return true // 0 = 关闭限流
    const now = Date.now()
    const arr = (sentLog.get(key) ?? []).filter((t) => now - t < 60_000)
    if (arr.length >= n) {
      sentLog.set(key, arr)
      return false
    }
    arr.push(now)
    sentLog.set(key, arr)
    return true
  }

  async function send(record, text) {
    const chunks = splitText(text, config.textChunkLimit)
    if (chunks.length === 0) return
    const isGroup = record.scope === 'group'
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const target = isGroup ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }
    const rateKey = `${record.scope}:${record.peerId}`

    for (let index = 0; index < chunks.length; index += 1) {
      // 限流优先于一切：宁可不回，也不要在被围攻时跟着刷屏
      if (!rateOk(rateKey, config.rateLimitPerMin)) {
        logger.warn(`[dsh-qq] ${record.label} 触到每分钟上限，本条不再发（剩 ${chunks.length - index} 段）`)
        break
      }
      try {
        const result = await client.call(action, { ...target, message: textSegments(chunks[index]) })
        // 记下自己发的消息 id，撤回工具要用
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) record.lastSentMessageId = sentId
        logger.info(`→ ${record.label}: ${chunks[index].slice(0, 60)}`)
      } catch (err) {
        logger.warn(`发送到 ${record.label} 失败:`, err?.message ?? err)
        break
      }
      if (index < chunks.length - 1) await sleep(config.splitDelayMs)
    }

    // 发完了，取消「正在输入」
    if (!isGroup) {
      client.call('set_input_status', { user_id: Number(record.peerId), event_type: 0 }, 5000).catch(() => {})
    }
  }

  const approval = new ApprovalChannel({ manager, config, logger, send })
  approval.install(ctx)

  const questions = new QuestionChannel({ manager, config, logger, send })
  questions.install(ctx)

  const inbound = createInbound({ config, manager, logger, client, send, approval, questions })
  const outbound = createOutbound({ manager, config, logger, send })

  const offSessionEvent = ctx.on('session/event', outbound)

  client.on('event', (event) => {
    inbound(event).catch((err) => logger.warn('处理入站消息失败:', err?.message ?? err))
  })

  client.on('open', async () => {
    logger.info(`已连接 ${config.wsUrl}`)
    if (selfId) return
    try {
      const info = await client.call('get_login_info', {}, 10_000)
      if (info?.user_id) {
        selfId = String(info.user_id)
        manager.selfId = selfId
        logger.info(`登录账号 ${info.nickname ?? ''} (${selfId})`)
      }
    } catch (err) {
      logger.warn('获取登录账号失败，请手动填 selfId:', err?.message ?? err)
    }
  })

  client.on('close', () => logger.warn('与 NapCat 断开，稍后自动重连'))
  client.on('error', (err) => logger.warn('连接错误:', err?.message ?? err))

  client.start()

  registerTools(ctx, { client, manager, config, logger })

  ctx.on('dispose', () => {
    try {
      offSessionEvent?.()
    } catch {
      /* ignore */
    }
    client.stop()
    manager.stop()
    approval.cancelAll()
    questions.cancelAll()
  })
}
