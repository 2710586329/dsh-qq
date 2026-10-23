import { ConfigSchema } from './config.js'
import { OneBotClient } from './onebot/client.js'
import { textSegments } from './onebot/segment.js'
import { SessionManager } from './session.js'
import { createInbound } from './inbound.js'
import { createOutbound } from './outbound.js'
import { splitText, sleep } from './shared/chunk.js'
import { registerTools } from './tools.js'

export const name = 'dsh-qq'
export const inject = ['agents']
export const Config = ConfigSchema

function makeLogger(ctx, config) {
  const base = ctx?.logger ?? console
  const prefix = '[dsh-qq]'
  const wrap = (fn) =>
    typeof fn === 'function' ? (...args) => fn(prefix, ...args) : () => {}
  return {
    info: wrap(base.info?.bind(base)),
    warn: wrap(base.warn?.bind(base)),
    error: wrap(base.error?.bind(base)),
    debug: config?.debug ? wrap((base.debug ?? base.info)?.bind(base)) : () => {},
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

  async function send(record, text) {
    const chunks = splitText(text, config.textChunkLimit)
    if (chunks.length === 0) return
    const isGroup = record.scope === 'group'
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const target = isGroup ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }

    for (let index = 0; index < chunks.length; index += 1) {
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
  }

  const inbound = createInbound({ config, manager, logger })
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
  })
}
