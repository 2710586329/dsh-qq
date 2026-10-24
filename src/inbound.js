import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readMessage } from './onebot/segment.js'
import { rememberFaces, facesCount } from './faces.js'
import { buildChatPrompt, faceCollectRule, IMAGE_RULES, QUOTE_DIRECTION_HINT, SILENT_HINT } from './prompts.js'
import { resolvePeerWorkspace } from './workspace.js'
import { appendChatLog } from './chatlog.js'
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 插件自带的 ASR 脚本；配置里没写 asrScript 时用它。 */
const DEFAULT_ASR_SCRIPT = fileURLToPath(new URL('../tools/asr.py', import.meta.url))

/**
 * 跑一次离线 ASR：python asr.py <wav> [model] → {ok, text}
 * 任何异常都吞掉返回空串，绝不让语音把主链路拖死。
 */
function runAsr(config, wavPath) {
  return new Promise((resolve) => {
    const py = config.asrPython || 'python'
    const script = config.asrScript || DEFAULT_ASR_SCRIPT
    if (!script) return resolve('')
    const model = String(config.asrModel ?? '').trim()
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    let child
    try {
      child = spawn(py, model ? [script, wavPath, model] : [script, wavPath], { windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish('')
    }, Number(config.asrTimeoutMs) || 60000)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const line = out.trim().split('\n').filter(Boolean).pop() || ''
        const json = JSON.parse(line)
        finish(json.ok ? String(json.text || '') : '')
      } catch {
        finish('')
      }
    })
  })
}

function allowPrivate(config, userId) {
  if (!config.replyToPrivate) return false
  if (config.privateMode === 'disabled') return false
  if (config.privateMode === 'allowlist') {
    return (config.privateAllow ?? []).map(String).includes(String(userId))
  }
  return true
}

function allowGroup(config, groupId) {
  if (config.groupMode === 'disabled') return false
  if (config.groupMode === 'allowlist') {
    return (config.groupAllow ?? []).map(String).includes(String(groupId))
  }
  return true
}

/**
 * 「@ 之后保活」：有人在群里 @ 过它一次之后，接下来一小段时间里不用每条都 @ 也能接话。
 * 真人在群里也是这样的——被点到名之后，后续那几句话自然会跟着说。
 *
 * 2026-10-24：窗口键从「群号」改成「群号 + 人」。原来按群记，只要有人 @ 一次，
 * 45 秒内群里任何人说话都算数——别人 @ 另一个人、或者跟别人聊天，它也会冲上去接。
 * QLark（src/qlark/chat/keepalive.py）把窗口键做成 (会话, 用户) 元组，注释写得很清楚：
 * 「别人说话既不能续期，也不能蹭用你的窗口」。咱们照抄这一条。
 *
 * 纯内存 Map，进程重启就清空，不落盘。
 */
const groupWakeUntil = new Map()

/** 每个保活窗口里已经回了几次（键同窗口：群:人）。
 *  用户 2026-10-24 转述群友的设计：「@ 之后保活一分钟，发消息刷新保活时间，
 *  群友在限定时间内均匀的拆成固定回几次」—— 光有窗口没有次数上限，就是一被点亮就
 *  每句都插嘴；次数上限让它「均匀地回应几次」而不是复读机。
 *  注意：这条和「窗口内说话续期」会打架（窗口一直续着、额度却固定），默认 0 = 不限。 */
const groupReplies = new Map()

/** 每个「群:人」上次回复的时间。用来做「均匀回应」：两条回复之间至少隔 groupReplyGapMs，
 *  间隔里来的消息不丢，攒进 backlog 等下一次一起看见 —— 比「一个窗口只准回 N 次」温和，
 *  也不会跟「窗口内说话续期」打架（用户 2026-10-24 发现的冲突）。 */
const groupLastReplyAt = new Map()

/** 距上次回复够不够久。0/负数 = 不限，永远够。 */
function gapReady(config, groupId, userId) {
  const gap = Number(config.groupReplyGapMs) || 0
  if (gap <= 0) return true
  const last = groupLastReplyAt.get(wakeKey(groupId, userId)) ?? 0
  return Date.now() - last >= gap
}

/** 这条消息是不是「同类」（群里另一个机器人）发的。
 *  两条判断：`sender.is_robot`（NapCat 对群机器人会带，但不是每只都带），
 *  以及配置里的 `peerBots` 名单（QQ 号）——名单最可靠，兜底。 */
function isPeerBot(config, senderId, event) {
  const id = String(senderId ?? '')
  if (!id) return false
  if ((config?.peerBots ?? []).map(String).includes(id)) return true
  return event?.sender?.is_robot === true
}

/** 保活窗口的键：群 + 人。别人 @ 我，不该给群里其他人开窗。 */
function wakeKey(groupId, userId) {
  return `${groupId}:${userId}`
}

function wakeAlive(groupId, userId) {
  const until = groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0
  return until > Date.now()
}

function refreshWake(config, groupId, userId) {
  const key = wakeKey(groupId, userId)
  const ms = Number(config.groupWakeMs) || 0
  if (ms <= 0) {
    groupWakeUntil.delete(key)
    groupReplies.delete(key)
    return
  }
  const now = Date.now()
  const isNewWindow = (groupWakeUntil.get(key) ?? 0) <= now
  if (isNewWindow) groupReplies.set(key, { startedAt: now, count: 0 })
  groupWakeUntil.set(key, now + ms)
  // 顺手清掉过期的，别让 Map 越攒越大
  if (groupWakeUntil.size > 200) {
    for (const [k, v] of groupWakeUntil) {
      if (v <= now) {
        groupWakeUntil.delete(k)
        groupReplies.delete(k)
      }
    }
  }
}

/** 这个窗口里还剩几次回复额度（0 = 不限）。用户 2026-10-24 转述群友方案：
 *  「@ 之后保活一分钟…群友在限定时间内均匀的拆成固定回几次」—— 别一被点亮就连珠炮。 */
function repliesLeft(config, groupId, userId) {
  const max = Number(config.groupRepliesPerWindow) || 0
  if (max <= 0) return Infinity
  const rs = groupReplies.get(wakeKey(groupId, userId))
  if (!rs) return max
  if ((groupWakeUntil.get(wakeKey(groupId, userId)) ?? 0) <= Date.now()) return max
  return Math.max(0, max - rs.count)
}

function countReply(groupId, userId) {
  const key = wakeKey(groupId, userId)
  const rs = groupReplies.get(key)
  if (rs) rs.count += 1
  else groupReplies.set(key, { startedAt: Date.now(), count: 1 })
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一天里的大概时段，用来说「下午/晚上」时不用模型自己换算。 */
function periodOf(hour) {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 人话时间（完整版）：2026-10-24 周六 13:05（下午）。
 *  直接给模型一句能照念的话，别让它拿 ISO 时间戳自己换算白天晚上。 */
function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 历史行里的短时间：10-24 周六 13:05（下午）。一条消息只占一行，别太长。 */
function historyTime(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 群聊里把一条消息压成一行，进历史缓冲。带时间 —— 模型才知道「隔了两小时才回」。
 *  sender 在 ownerIds 里时额外标上主人称呼，Agent 才分得清自己人和群友。
 *  isSelf=true 时写成「你（机器人名）」—— 自己发出去的话也必须进历史，
 *  否则它看不到自己说过什么，群里另一个口吻相近的机器人一说话，就会被认领成「我说的」。 */
export function historyLine(sender, text, { isOwner = false, ownerLabel = '主人', isSelf = false, selfName = '机器人', isBot = false } = {}) {
  if (isSelf) return `[你（${selfName || '机器人'}） ${historyTime()}] ${text}`
  const name = sender?.card || sender?.nickname || String(sender?.user_id ?? '')
  // 同类机器人单独标一下：不标的话，它跟群友的话在历史里长得一样，
  // 「这句是在跟我说，还是跟它说」就永远分不清（用户 2026-10-24 的原话）。
  const tag = isOwner ? ` · ${ownerLabel}` : isBot ? ' · 同类机器人' : ''
  return `[${name} (${sender?.user_id ?? ''})${tag} ${historyTime()}] ${text}`
}

/** 往会话历史里塞一条，顺手按 historyLimit 截断（留两倍余量给「我」和「别人」混排）。 */
export function pushHistory(record, entry, limit) {
  if (!record || !entry) return
  if (!Array.isArray(record.history)) record.history = []
  record.history.push(entry)
  const keep = Math.max(0, Number(limit) || 0) * 2
  if (keep > 0 && record.history.length > keep) {
    record.history.splice(0, record.history.length - keep)
  }
}

/**
 * 没叫我们的群消息也留个底，等下次真接的时候补进上下文。
 *
 * 2026-10-24 实况：群友 A 说了个梗，这句没 @ 我们 → 直接 return 掉；
 * 两分钟后群友 B 接了这个梗 → 它却顺着 B 那句话编，因为它根本不知道梗是谁说的、什么意思。
 * 跳过归跳过（不叫醒它），但这些话得让它看得见 —— 不然接话全靠猜。
 */
const groupBacklog = new Map()
const BACKLOG_MAX = 30

export function keepBacklog(groupId, entry) {
  if (!groupId || !entry) return
  const arr = groupBacklog.get(groupId) ?? []
  arr.push(entry)
  if (arr.length > BACKLOG_MAX) arr.splice(0, arr.length - BACKLOG_MAX)
  groupBacklog.set(groupId, arr)
}

/** 取走并清空：补进上下文一次就够，别每次都倒一遍陈年旧账。 */
export function drainBacklog(groupId) {
  const arr = groupBacklog.get(groupId) ?? []
  groupBacklog.delete(groupId)
  return arr
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

function guessExt(url, mime) {
  const byMime = EXT_BY_MIME[mime]
  if (byMime) return byMime
  const fromUrl = extname(new URL(url, 'http://x').pathname || '').toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(fromUrl) ? fromUrl : '.png'
}

/**
 * 下载一张图到本地缓存，返回绝对路径；失败返回 null。
 * 只接受 http(s) 和 base64:// 两种来源。
 */
async function downloadImage(url, cacheDir, maxMB) {
  try {
    if (!url) return null

    // base64:// 直接落盘
    if (url.startsWith('base64://')) {
      const buf = Buffer.from(url.slice('base64://'.length), 'base64')
      if (buf.length > maxMB * 1024 * 1024) return null
      const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
      await writeFile(p, buf)
      return p
    }

    if (!/^https?:\/\//i.test(url)) return null

    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxMB * 1024 * 1024) return null

    const ext = guessExt(url, res.headers.get('content-type') ?? '')
    const p = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    await writeFile(p, buf)
    return p
  } catch {
    return null
  }
}

/** 清掉缓存里太老的图，避免堆成垃圾场。 */
async function pruneCache(cacheDir, keepFiles = 200) {
  try {
    const names = (await readdir(cacheDir)).filter((n) => n.startsWith('qq-'))
    if (names.length <= keepFiles) return
    const stats = await Promise.all(
      names.slice(0, names.length - keepFiles).map(async (n) => {
        const p = join(cacheDir, n)
        try {
          const { stat } = await import('node:fs/promises')
          const s = await stat(p)
          return { p, mtime: s.mtimeMs }
        } catch {
          return null
        }
      }),
    )
    for (const item of stats.filter(Boolean).slice(0, 20)) {
      await unlink(item.p).catch(() => {})
    }
  } catch {
    /* 清缓存失败不影响主链路 */
  }
}

/**
 * 入站：OneBot 消息事件 → agent.followup()。
 *
 * 触发规则全部走配置，插件自己不做「猜你还想聊」这种自作聪明的事。
 */
export function createInbound({ config, manager, logger, client, send, approval, questions, contextGuard }) {
  // 没配 imageCacheDir 时落在工作目录下的「图片缓存」；每个会话再各占一层子目录（见下）
  const baseCacheDir =
    String(config.imageCacheDir ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '图片缓存')
  const maxMB = Number(config.imageMaxMB) || 8
  // 谁是主人：群聊里用 QQ 号打标，私聊不影响（私聊本来就在白名单里）
  const ownerIds = new Set((Array.isArray(config.ownerIds) ? config.ownerIds : []).map(String))
  const ownerLabel = String(config.ownerLabel ?? '').trim() || '主人'

  return async function onEvent(event) {
    if (event?.post_type !== 'message') return

    const selfId = String(event.self_id ?? manager.selfId ?? '')
    if (event.self_name) manager.selfName = String(event.self_name)
    if (event.user_id !== undefined && String(event.user_id) === selfId) return

    const isGroup = event.message_type === 'group'
    const scope = isGroup ? 'group' : 'private'
    const peerId = String(isGroup ? event.group_id : event.user_id)
    const sender = event.sender ?? {}
    const senderName = sender.card || sender.nickname || peerId
    const label = isGroup ? `群 ${peerId}` : `私聊 ${senderName}(${peerId})`
    const ownerInfo = { isOwner: ownerIds.has(String(event.user_id ?? '')), ownerLabel }
    const peerBot = isGroup && isPeerBot(config, event.user_id, event)
    if (peerBot) ownerInfo.isBot = true

    if (isGroup ? !allowGroup(config, peerId) : !allowPrivate(config, peerId)) {
      logger.debug?.(`[dsh-qq] 忽略未授权 ${label}`)
      return
    }

    const info = readMessage(event.message, { selfId, selfName: event.self_name ?? '机器人' })

    // 聊天流水：跳过的消息也先记下来——「它怎么突然接不上话」全靠这段回查。
    // 只落盘、不参与投递，写失败也不影响聊天。
    if (config.chatLog !== false) {
      const logDir = resolvePeerWorkspace(config, scope, peerId)
      const who = `${senderName}(${event.user_id})`
      appendChatLog(logDir, { who, text: info.text || '[图片]' }, logger).catch(() => {})
    }

    // 纯图 / 纯语音 / 纯文件 / 纯表情包（没有文字）也要处理
    if (
      !info.text &&
      info.images.length === 0 &&
      info.records.length === 0 &&
      info.files.length === 0 &&
      info.mfaces.length === 0
    ) {
      return
    }

    const senderId = String(event.user_id ?? '')

    // ── 引用：先查一次「这句在接谁的话」。
    // 一次 get_msg 同时干两件事：判断这条是不是在跟我说话（下面），以及给正文加引用提示（再下面）。
    // 只有真带引用才发请求，群里引用不常见，不会拖慢平时。
    let quoteInfo = null
    if (info.replyId && client) {
      try {
        const quoted = await client.call('get_msg', { message_id: Number(info.replyId) }, 8000)
        const quotedUserId = String(quoted?.sender?.user_id ?? '')
        const quotedName =
          quoted?.sender?.card || quoted?.sender?.nickname || quotedUserId || '某人'
        const quotedInfo = readMessage(quoted?.message, {
          selfId,
          selfName: event.self_name ?? '机器人',
        })
        quoteInfo = {
          userId: quotedUserId,
          name: quotedName,
          text: (quotedInfo.text || '[非文字内容]').replace(/\s+/g, ' ').slice(0, 80),
          ok: true,
        }
      } catch (err) {
        logger.debug?.(`[dsh-qq] 取引用原文失败: ${err?.message || err}`)
        // 取不到就当没有引用：不知道该接谁的话，宁可不接，也别猜。
        quoteInfo = { userId: '', name: '', text: '', ok: false }
      }
    }
    // 引用的是我自己 → 等于在叫我（qq-bridge 的 quoteTargetIsSelf）
    const quotedMe = Boolean(quoteInfo?.ok && quoteInfo.userId && quoteInfo.userId === selfId)

    // 同类机器人（群里另一个机器人）：开关关着就完全不接，连 @ 也不接。
    // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
    // 关着的时候它说什么都跟我们无关 —— 同类之间的帐先不算。
    if (peerBot && !config.botChatEnabled) {
      logger.debug?.(`[dsh-qq] 群 ${peerId} 是同类机器人发言，「和同类聊天」没开，跳过`)
      // 不接它的话，但它说了什么得留下 —— 下次真接的时候，得知道它刚讲过什么。
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      return
    }

    // 群聊：默认要 @ 才理；@ 过一次之后有一小段「保活期」，不用再 @
    if (isGroup && config.requireMention && !info.atMe) {
      // 没 @ 我、却 @ 了别人（包括群里另一个机器人）：那明显不是跟我说话，
      // 保活期也不算 —— 否则别人一句「@ 那个谁 来帮我测一下」它也会冲上去接。
      if (info.atNames.length > 0) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} @ 的是别人，跳过`)
        keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
        return
      }
      // 保活窗口只认「当初 @ 我的那个人」：别人说话既不能续期、也不能蹭用。
      // 2026-10-24 取消了「主人永久免 @」—— 试完反馈「只回我确实看着怪」：
      // 群友要 @ 才理，主人却随时都接，一是不公平，二是「唤醒一次后超时也没停」。
      // 现在主人也走窗口，只是窗口是 60 秒（群友提的方案），窗口内说话照样续期。
      if (!quotedMe && !wakeAlive(peerId, senderId)) {
        logger.debug?.(`[dsh-qq] 群 ${peerId} 未 @ 且不在保活期，跳过`)
        // 这句没叫我们，但它是上下文的一部分：下一句很可能就在接它。
        keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
        return
      }
      if (quotedMe) logger.debug?.(`[dsh-qq] 群 ${peerId} 引用了我，按叫我处理`)
    }
    // 窗口续期（QLark 的 touch()）：@ 我、引用我、或者本来就在窗口里接着说话，都续上。
    // 但只有窗口的「正主」能续 —— 别人说话不续期也不蹭用，这条一松就变成群里谁说话都接。
    if (isGroup && (info.atMe || quotedMe || wakeAlive(peerId, senderId))) {
      refreshWake(config, peerId, senderId)
    }

    // 均匀回应：距上次回复太近就先攒着（消息进 backlog，下次一起看见），别连珠炮。
    if (isGroup && !gapReady(config, peerId, senderId)) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 距上次回复不到 ${config.groupReplyGapMs}ms，先攒着`,
      )
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      return
    }

    // 窗口内回复额度（可选，默认 0 = 不限；和「续期」一起用要注意，别设太小）
    if (isGroup && repliesLeft(config, peerId, senderId) <= 0) {
      logger.debug?.(
        `[dsh-qq] 群 ${peerId} 这个保活窗口已经回过 ${config.groupRepliesPerWindow} 次，先歇着`,
      )
      keepBacklog(peerId, historyLine(sender, info.text || '[图片]', ownerInfo))
      return
    }

    let record = await manager.obtain({ scope, peerId, label })

    // 这个会话自己的缓存目录（隔离模式下一会话一目录；关掉隔离就共用 baseCacheDir）
    const cacheDir = record.dir ? join(record.dir, '图片缓存') : baseCacheDir

    // ── 先看这句是不是在回答一条待审批的请求；是的话就吃掉，不投给 Agent ──
    const rawText = (info.text || '').trim()
    if (rawText && approval?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化审批回复 ${label}`)
      return
    }

    // ── 再看是不是在回答一条待答的问题 ──
    if (rawText && questions?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化问答回复 ${label}`)
      return
    }

    // ── 斜杠命令不打搅 Agent（全角斜杠「／」、前后空格都认）──
    const cmd = rawText.toLowerCase().replace(/[／]/g, '/').trim()
    if (cmd === '/reset' || cmd === '#reset' || cmd === '/new' || cmd === '#new') {
      const ok = manager.reset(record)
      logger.info?.(`[dsh-qq] 收到 /reset（${label}），reset=${ok}`)
      await send(record, '好，之前聊的我不记得了。重新来过吧。')
      return
    }
    if (cmd === '/status' || cmd === '#status') {
      await send(
        record,
        [
          `会话：${record.label}`,
          `id：${record.sessionId}`,
          `群历史：${record.history.length} 条`,
          `我这边：${record.busy > 0 ? '还在忙' : '空闲'}`,
        ].join('\n'),
      )
      return
    }
    if (cmd === '/cwd' || cmd === '#cwd') {
      await send(
        record,
        [`id：${record.sessionId}`, `目录：${record.dir || '(未隔离，仍用公共 cwd)'}`, `群历史：${record.history.length} 条`].join(
          '\n',
        ),
      )
      return
    }
    if (cmd === '/help' || cmd === '#help') {
      await send(
        record,
        [
          '能用的命令：',
          '/reset 清空上下文重新开始',
          '/status 看看当前会话',
          '/cwd 看这个会话的目录',
          '/help 就是这份说明',
        ].join('\n'),
      )
      return
    }

    // 给互动工具留线索：戳谁、给哪条消息贴表情、撤回哪条
    record.lastSenderId = Number(event.user_id) || record.lastSenderId || null
    record.lastSenderName = senderName
    record.lastMessageId = Number(event.message_id) || record.lastMessageId || null
    record.lastMessageAt = Date.now()
    if (record.lastSenderName) record.label = label

    // ── 图片：下载到本地，把路径交给 agent ──
    let imagePaths = []
    if (info.images.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      imagePaths = (await Promise.all(info.images.slice(0, 4).map((u) => downloadImage(u, cacheDir, maxMB)))).filter(Boolean)
      if (imagePaths.length > 0) pruneCache(cacheDir)
      else logger.warn?.(`[dsh-qq] 图片下载失败（${info.images.length} 张）`)
    }

    // ── 文件：下载到本地，把路径交给 agent ──
    let filePaths = []
    if (info.files.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      for (const f of info.files.slice(0, 3)) {
        const src = f.url || f.file || ''
        if (!src) continue
        const p = await downloadImage(src, cacheDir, 64)
        if (p) filePaths.push({ path: p, name: f.name || p.split(/[\\/]/).pop() })
      }
      if (filePaths.length === 0) logger.warn?.(`[dsh-qq] 文件下载失败（${info.files.length} 个）`)
    }

    // ── 语音：转 wav → 本地 vosk 离线识别 ──
    let voiceTexts = []
    if (info.records.length > 0) {
      if (!config.asrEnabled) {
        voiceTexts.push('[语音]')
      } else {
        for (const rec of info.records.slice(0, 2)) {
          const file = rec.file || rec.path || ''
          if (!file) {
            voiceTexts.push('[语音，但拿不到文件]')
            continue
          }
          try {
            const res = await client.call('get_record', { file, out_format: 'wav' }, 20000)
            let wavPath = ''
            if (res?.file && /^[A-Za-z]:[\\/]/.test(String(res.file))) {
              wavPath = String(res.file)
            } else if (res?.base64) {
              await mkdir(cacheDir, { recursive: true }).catch(() => {})
              wavPath = join(cacheDir, `voice-${Date.now()}.wav`)
              await writeFile(wavPath, Buffer.from(String(res.base64), 'base64'))
            } else if (res?.url) {
              wavPath = (await downloadImage(String(res.url), cacheDir, 32)) || ''
            }
            if (!wavPath) {
              voiceTexts.push('[语音，转码失败]')
              continue
            }
            const text = await runAsr(config, wavPath)
            voiceTexts.push(text ? `[语音转文字] ${text}` : '[语音，没听清]')
          } catch (err) {
            logger.warn?.(`[dsh-qq] 语音识别失败: ${err?.message || err}`)
            voiceTexts.push('[语音，识别失败]')
          }
        }
      }
    }

    // ── 引用提示：让 agent 知道这句话在接谁的话（被引用的原文上面已经查过了，这里不再请求）──
    let quoteLine = ''
    if (info.replyId && config.quoteReply && client) {
      if (!quoteInfo || !quoteInfo.ok) {
        quoteLine = '[引用了一条消息，但没查到原文]'
      } else if (quoteInfo.userId === selfId) {
        quoteLine = `[引用 我自己：${quoteInfo.text}]`
      } else {
        quoteLine = `[引用 ${quoteInfo.name} (${quoteInfo.userId})：${quoteInfo.text}]`
      }
    }

    // ── 上下文压力太大就先换新会话：把最近聊天记进记忆区，新会话带 seed 接话 ──
    if (contextGuard) {
      const seed = await contextGuard.maybeSwap(record)
      if (seed) {
        const prev = record
        record = await manager.obtain({ scope, peerId, label })
        record.swapSeed = seed.length > 0 ? seed : null
        // 工具靠这些字段认「给谁回、撤回哪条」，换会话不能丢
        record.lastSenderId = prev.lastSenderId ?? null
        record.lastSenderName = prev.lastSenderName ?? null
        record.lastMessageId = prev.lastMessageId ?? null
        record.lastMessageAt = prev.lastMessageAt ?? null
      }
    }

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    // 当前时间：每条消息都带在最前面，跟着正文走 —— 会话压缩、历史被裁掉，这行也不会丢
    parts.push(`[现在是 ${humanTime()}]`)
    if (quoteLine) {
      parts.push(quoteLine, QUOTE_DIRECTION_HINT)
    }
    let head = info.text || ''
    if (isGroup) head = historyLine(sender, info.text || '[图片]', ownerInfo)
    else if (ownerInfo.isOwner && head) head = `[${ownerLabel}] ${head}`
    if (head) parts.push(head)

    // 群聊里没被 @、也不是引用着我的：给一个「可以不接」的出口。
    // 私聊、被 @、被引用回复这三种情况必须回，就不给出口 —— 该说话的时候别装死。
    const mustReply = !isGroup || info.atMe || quotedMe
    if (!mustReply) parts.push(SILENT_HINT)

    if (imagePaths.length > 0) {
      parts.push(
        `[用户发了 ${imagePaths.length} 张图片，已存到本机，可以直接用 read_image 打开：]`,
        ...imagePaths.map((p) => `  ${p}`),
        IMAGE_RULES,
      )
      const hint = faceCollectRule(config)
      if (hint) parts.push(hint)
    } else if (info.images.length > 0) {
      parts.push('[用户发了图片，但没能下载下来]')
    }

    if (voiceTexts.length > 0) parts.push(...voiceTexts)

    if (info.mfaces.length > 0) {
      // 顺手把表情包的身份证存进收藏夹，以后 qq_mface 就能拿来用
      const added = rememberFaces(config, info.mfaces)
      const total = facesCount(config)
      parts.push(
        '[对方发来表情包。表情包是说话的语气，不是让你鉴赏的画面——顺着这个情绪接话就好，不要描述图里画了什么，也不要问"这是谁"。]',
      )
      if (added > 0) parts.push(`[已顺手收进表情包收藏，现在一共 ${total} 个；想发就用 qq_mface，不填 id 会从收藏里随机挑一个。]`)
    }

    if (filePaths.length > 0) {
      parts.push(
        `[用户发了 ${filePaths.length} 个文件，已存到本机：]`,
        ...filePaths.map((f) => `  ${f.name} -> ${f.path}`),
      )
    }

    // 之前跳过的群消息补进来（只说给它听，不叫醒它）：
    // 这一句是在接前一句，不补的话它只能凭空接。
    if (isGroup) {
      const backlog = drainBacklog(peerId)
      for (const line of backlog) pushHistory(record, line, config.historyLimit)
    }

    if (isGroup && config.historyLimit > 0 && record.history.length > 0) {
      const recent = record.history.slice(-config.historyLimit)
      parts.unshift(
        '[群聊最近消息]',
        ...recent.map((line) => line),
        '[群聊最近消息结束]',
      )
    }

    // 聊天规矩（内置中性版 + 可选 persona + directPrompt/groupPrompt）只在本会话第一次投递时
    // 注入一次，别每条都重复占 token；会话被回收或 /reset 后会重新注入一遍。
    if (!record.chatPromptInjected) {
      const chatPrompt = buildChatPrompt(config, { isGroup, isOwner: ownerInfo.isOwner })
      if (chatPrompt) parts.unshift(chatPrompt, '')
      // 主动换过会话：把上一段聊天的尾巴放最前面，让它知道刚聊到哪
      if (Array.isArray(record.swapSeed) && record.swapSeed.length > 0) {
        parts.unshift(
          '[上一段聊天（换新会话前留下的最后几条，用来接话；不用逐条回应）]',
          ...record.swapSeed,
          '[上一段聊天结束]',
          '',
        )
      }
      record.swapSeed = null
      record.chatPromptInjected = true
    }

    const body = parts.join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    })

    logger.info?.(`[dsh-qq] ← ${label}: ${(info.text || '[图片]').slice(0, 60)}`)

    // 先记历史（下一条能看到这一条），再投递
    const historyEntry = historyLine(sender, info.text || '[图片]', ownerInfo)
    if (isGroup) pushHistory(record, historyEntry, config.historyLimit)
    // 记一笔「这个窗口回过一次」，额度用完就停（见上面 repliesLeft）
    if (isGroup) {
      countReply(peerId, senderId)
      groupLastReplyAt.set(wakeKey(peerId, senderId), Date.now())
    }
    // 私聊也留一份最近聊天：换会话时靠它给新会话接话
    record.recent.push(historyEntry)
    const recentKeep = Math.max(80, (Number(config.contextMemoryKeep) || 30) * 3)
    if (record.recent.length > recentKeep) {
      record.recent.splice(0, record.recent.length - recentKeep)
    }

    const maxTurnMs = Number(config.maxTurnMs) || 600000
    const startedAt = Date.now()

    manager.enqueue(record, async () => {
      let timer = null
      try {
        // 私聊回一句「正在输入」，让对方知道这边在敲字（群聊没有这个概念，跳过）
        if (!isGroup && client) {
          client.call('set_input_status', { user_id: Number(peerId), event_type: 1 }, 5000).catch(() => {})
        }
        record.agent.followup(message)

        const outcome = await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), maxTurnMs)
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })

        if (outcome === 'timeout') {
          // 只放开队列，不打断 Agent —— 它跑完的回复照样会从 outbound 发出去
          const seconds = Math.round((Date.now() - startedAt) / 1000)
          logger.warn(`[dsh-qq] ${label} 本轮已跑 ${seconds}s 仍未结束，先放开队列`)
          if (typeof send === 'function') {
            await send(
              record,
              `（这轮我还在弄，已经跑了 ${seconds} 秒，你先忙别的，好了我叫你）`,
            ).catch(() => {})
          }
        }
      } catch (err) {
        logger.warn?.(`[dsh-qq] 投递给 ${label} 失败:`, err)
      }
    })
  }
}
