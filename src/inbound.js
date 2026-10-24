import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readMessage } from './onebot/segment.js'
import { rememberFaces, facesCount } from './faces.js'
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 跑一次离线 ASR：python asr.py <wav> → {ok, text}
 * 任何异常都吞掉返回空串，绝不让语音把主链路拖死。
 */
function runAsr(config, wavPath) {
  return new Promise((resolve) => {
    const py = config.asrPython || 'python'
    const script = config.asrScript || ''
    if (!script) return resolve('')
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    let child
    try {
      child = spawn(py, [script, wavPath], { windowsHide: true })
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
 * 「@ 之后保活」：她在群里 @ 过一次之后，接下来一小段时间里不用每条都 @ 也能接话。
 * 真人在群里也是这样的——被点到名之后，后续那几句话自然会跟着说。
 * 纯内存 Map，进程重启就清空，不落盘。
 */
const groupWakeUntil = new Map()

function wakeAlive(groupId) {
  const until = groupWakeUntil.get(String(groupId)) ?? 0
  return until > Date.now()
}

function refreshWake(config, groupId) {
  const ms = Number(config.groupWakeMs) || 0
  if (ms <= 0) {
    groupWakeUntil.delete(String(groupId))
    return
  }
  groupWakeUntil.set(String(groupId), Date.now() + ms)
  // 顺手清掉过期的，别让 Map 越攒越大
  if (groupWakeUntil.size > 200) {
    const now = Date.now()
    for (const [k, v] of groupWakeUntil) {
      if (v <= now) groupWakeUntil.delete(k)
    }
  }
}

/** 群聊里把一条消息压成一行，进历史缓冲。带时间 —— 模型才知道「隔了两小时才回」。 */
function historyLine(sender, text) {
  const name = sender?.card || sender?.nickname || String(sender?.user_id ?? '')
  const d = new Date()
  const time = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `[${name} (${sender?.user_id ?? ''}) ${time}] ${text}`
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
export function createInbound({ config, manager, logger, client, send, approval, questions }) {
  // 没配 imageCacheDir 时落在工作目录下的「图片缓存」；每个会话再各占一层子目录（见下）
  const baseCacheDir =
    String(config.imageCacheDir ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '图片缓存')
  const maxMB = Number(config.imageMaxMB) || 8

  return async function onEvent(event) {
    if (event?.post_type !== 'message') return

    const selfId = String(event.self_id ?? manager.selfId ?? '')
    if (event.user_id !== undefined && String(event.user_id) === selfId) return

    const isGroup = event.message_type === 'group'
    const scope = isGroup ? 'group' : 'private'
    const peerId = String(isGroup ? event.group_id : event.user_id)
    const sender = event.sender ?? {}
    const senderName = sender.card || sender.nickname || peerId
    const label = isGroup ? `群 ${peerId}` : `私聊 ${senderName}(${peerId})`

    if (isGroup ? !allowGroup(config, peerId) : !allowPrivate(config, peerId)) {
      logger.debug?.(`[dsh-qq] 忽略未授权 ${label}`)
      return
    }

    const info = readMessage(event.message, { selfId, selfName: event.self_name ?? '机器人' })

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

    // 群聊：默认要 @ 才理；@ 过一次之后有一小段「保活期」，不用再 @
    if (isGroup && config.requireMention && !info.atMe && !wakeAlive(peerId)) {
      logger.debug?.(`[dsh-qq] 群 ${peerId} 未 @ 且不在保活期，跳过`)
      return
    }
    if (isGroup && info.atMe) refreshWake(config, peerId)

    const record = await manager.obtain({ scope, peerId, label })

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
      await send(record, '好，之前聊的我不记得了。重新来过吧，主人。')
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

    // ── 引用：查出被引用的原文，让 agent 知道这句话在接谁的话 ──
    let quoteLine = ''
    if (info.replyId && config.quoteReply && client) {
      try {
        const quoted = await client.call('get_msg', { message_id: Number(info.replyId) }, 8000)
        const quotedInfo = readMessage(quoted?.message, { selfId, selfName: event.self_name ?? '机器人' })
        const quotedUserId = String(quoted?.sender?.user_id ?? '')
        const quotedName =
          quoted?.sender?.card || quoted?.sender?.nickname || quotedUserId || '某人'
        const quotedText = (quotedInfo.text || '[非文字内容]').replace(/\s+/g, ' ').slice(0, 80)
        quoteLine =
          quotedUserId === selfId
            ? `[引用 我自己：${quotedText}]`
            : `[引用 ${quotedName} (${quotedUserId})：${quotedText}]`
      } catch (err) {
        logger.debug?.(`[dsh-qq] 取引用原文失败: ${err?.message || err}`)
        quoteLine = '[引用了一条消息，但没查到原文]'
      }
    }

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    if (quoteLine) parts.push(quoteLine)
    const head = isGroup ? historyLine(sender, info.text || '[图片]') : (info.text || '')
    if (head) parts.push(head)

    if (imagePaths.length > 0) {
      parts.push(
        `[用户发了 ${imagePaths.length} 张图片，已存到本机，可以直接用 read_image 打开：]`,
        ...imagePaths.map((p) => `  ${p}`),
        '[图片规矩：先看清楚是什么再说话。只有「鲸鱼娘 / AI 娘化」这类表情包才值得收藏——觉得以后还想发，就用 qq_keep_face 收进收藏；照片、截图、风景、别人随手发的图一律不收，也不要去描述图里画了什么。]',
      )
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

    if (isGroup && config.historyLimit > 0 && record.history.length > 0) {
      const recent = record.history.slice(-config.historyLimit)
      parts.unshift(
        '[群聊最近消息]',
        ...recent.map((line) => line),
        '[群聊最近消息结束]',
      )
    }

    const extra = isGroup ? config.groupPrompt : config.directPrompt
    if (extra) parts.unshift(extra, '')

    const body = parts.join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    })

    logger.info?.(`[dsh-qq] ← ${label}: ${(info.text || '[图片]').slice(0, 60)}`)

    // 先记历史（下一条能看到这一条），再投递
    if (isGroup) {
      record.history.push(historyLine(sender, info.text || '[图片]'))
      const keep = Math.max(0, Number(config.historyLimit) || 0) * 2
      if (keep > 0 && record.history.length > keep) {
        record.history.splice(0, record.history.length - keep)
      }
    }

    const maxTurnMs = Number(config.maxTurnMs) || 600000
    const startedAt = Date.now()

    manager.enqueue(record, async () => {
      let timer = null
      try {
        // 私聊回一句「正在输入」，让她知道助手在敲字（群聊没有这个概念，跳过）
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
