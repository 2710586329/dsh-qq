import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from './config.js'
import { OneBotClient } from './onebot/client.js'
import { textSegments } from './onebot/segment.js'
import { SessionManager } from './session.js'
import { createInbound, historyLine, pushHistory } from './inbound.js'
import { appendChatLog } from './chatlog.js'
import { SILENT_MARKER } from './prompts.js'
import { createOutbound } from './outbound.js'
import { createContextGuard } from './context-guard.js'
import { splitText, sleep } from './shared/chunk.js'
import { registerTools } from './tools.js'
import { ApprovalChannel } from './approval.js'
import { QuestionChannel } from './questions.js'
import {
  applyOverrides,
  installSettingsApi,
  loadOverrides,
  resolvePersonaFile,
} from './settings.js'

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
  // ⭐ 设置页存下来的覆盖**先于**其它一切生效：logger 的 debug 开关也吃这一层。
  //    这样「在设置里改人设 / 改记忆区路径」不用去碰 profile 的 cordis.patch.yml。
  const savedOverrides = loadOverrides(ctx)
  const appliedOverrides = applyOverrides(config, savedOverrides)
  const logger = makeLogger(ctx, config)
  if (appliedOverrides.length > 0) logger.info(`已应用设置页覆盖: ${appliedOverrides.join(', ')}`)
  // 设置页保存后要就地刷新这两份状态：persona 可能换了文件，覆盖表可能变了
  const overridesRef = { current: savedOverrides }
  const personaRef = { current: resolvePersonaFile(config, logger) }
  const agents = ctx?.agents

  // 设置页接口：**运行时注入** webServer，而不是写进顶层 `export const inject`。
  // 有网页服务的宿主（Desktop / Web GUI）才会回调进来；headless 的 qqbot 永远不回调，
  // 于是插件照常激活、QQ 照常在线。顶层声明的话，headless 会一直等 provider →
  // 整个插件不激活 → 机器人直接掉线（2026-10-24 踩过）。
  //
  // 注意：把**父 ctx** 传下去，只借注入回调拿到的 webServer 实例。
  // 路由的 effect 必须挂在父 ctx 上；挂在注入回调那个子 ctx 上，回调一结束就被收走
  // —— 现象是 api-state 写 ok=true、前端却一直 404（2026-10-24 第二次踩）。
  const mountSettingsApi = (extra = {}) => {
    // 测试桩 / 极简宿主可能没有 ctx.inject，这时候跳过就好，别让整个插件崩
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (sub) =>
      installSettingsApi({ ctx, webServer: sub.webServer, config, logger, ...extra }),
    )
  }

  // 只当「设置面板」用：桌面 / Web GUI 那份只提供这一页，不去连 NapCat。
  // 不然同一个 QQ 号在两处同时登录，消息会互相抢。
  if (config.uiOnly) {
    mountSettingsApi({ personaRef, overridesRef })
    logger.info('uiOnly：只提供设置页，不连接 NapCat')
    return
  }

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

  const lastSentAt = new Map() // 群聊里上一条发出去的毫秒时间，用来拉开间隔

  async function send(record, text) {
    // 「这次不接话」：模型只输出 [SILENT] 就当作它选择潜水 —— 不发、不进历史、不报错。
    // 出口只在「这条不一定是在叫它」时给（见 inbound.js 的 mustReply），
    // 被 @、被引用、私聊都不会走到这里。
    const trimmed = String(text ?? '').trim()
    if (trimmed === SILENT_MARKER) {
      logger.info(`[dsh-qq] ${record.label} 选择不接话（${SILENT_MARKER}）`)
      return
    }
    const chunks = splitText(text, config.textChunkLimit)
    if (chunks.length === 0) return
    const isGroup = record.scope === 'group'
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const target = isGroup ? { group_id: Number(record.peerId) } : { user_id: Number(record.peerId) }
    const rateKey = `${record.scope}:${record.peerId}`
    let sentAny = false

    // 群聊：两条回复之间拉开一点。一群人追着问的时候，
    // 连着往外吐最容易被人当成刷屏，也最容易被风控。
    const gapMs = record.scope === 'group' ? Math.max(0, Number(config.groupMinGapMs) || 0) : 0
    if (gapMs > 0) {
      const last = lastSentAt.get(rateKey) ?? 0
      const wait = last + gapMs - Date.now()
      if (wait > 0 && wait <= 30000) await sleep(wait)
    }
    lastSentAt.set(rateKey, Date.now())

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
        sentAny = true
        logger.info(`→ ${record.label}: ${chunks[index].slice(0, 60)}`)
      } catch (err) {
        logger.warn(`发送到 ${record.label} 失败:`, err?.message ?? err)
        break
      }
      if (index < chunks.length - 1) await sleep(config.splitDelayMs)
    }

    // 自己发出去的话也要进历史：不然下一轮它看不见「我说过什么」，
    // 群里口吻相近的别的机器人一开口，就会当成自己说的去道歉、去撤回。
    const said = trimmed
    if (sentAny && said) {
      const selfName = manager.selfName || '机器人'
      const entry = historyLine(null, said, { isSelf: true, selfName })
      pushHistory(record, entry, config.historyLimit)
      record.recent.push(entry)
      const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
      if (record.recent.length > recentKeep) record.recent.splice(0, record.recent.length - recentKeep)

      // 聊天流水：自己说的话也落盘，不然翻记录时只有对方在自言自语
      if (config.chatLog !== false) {
        const myId = manager.selfId || config.selfId || ''
        const who = myId ? `${selfName}(${myId})` : selfName
        appendChatLog(record.dir, { who, text: said }, logger).catch(() => {})
      }
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

  const contextGuard = createContextGuard({ manager, config, logger })
  const inbound = createInbound({ config, manager, logger, client, send, approval, questions, contextGuard })
  const outbound = createOutbound({ manager, config, logger, send })

  const offSessionEvent = ctx.on('session/event', outbound)
  const offGuardEvent = ctx.on('session/event', contextGuard.onSessionEvent)

  client.on('event', (event) => {
    inbound(event).catch((err) => logger.warn('处理入站消息失败:', err?.message ?? err))
  })

  client.on('open', async () => {
    logger.info(`已连接 ${config.wsUrl}`)
    try {
      // 就算配置里写死了 selfId，也要问一次昵称：历史行里「你（昵称）」得写对，
      // 不然它认不出哪个是自己发的。
      const info = await client.call('get_login_info', {}, 10_000)
      if (info?.user_id) {
        if (!selfId) {
          selfId = String(info.user_id)
          manager.selfId = selfId
        }
        if (info.nickname) manager.selfName = String(info.nickname)
        logger.info(`登录账号 ${info.nickname ?? ''} (${info.user_id})`)
      }
    } catch (err) {
      logger.warn('获取登录账号失败，请手动填 selfId:', err?.message ?? err)
    }
  })

  client.on('close', () => logger.warn('与 NapCat 断开，稍后自动重连'))
  client.on('error', (err) => logger.warn('连接错误:', err?.message ?? err))

  client.start()

  registerTools(ctx, { client, manager, config, logger })

  // ── 设置页接口：/api/dsh-qq/* ─────────────────────────────────────────────
  // DSH 设置界面里那一页（client.js）打的就是这几个口。
  mountSettingsApi({ client, manager, personaRef, overridesRef })


  ctx.on('dispose', () => {
    try {
      offSessionEvent?.()
      offGuardEvent?.()
    } catch {
      /* ignore */
    }
    client.stop()
    manager.stop()
    approval.cancelAll()
    questions.cancelAll()
  })
}
