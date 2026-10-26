/**
 * 出站：把 agent 跑出来的文字送回 QQ。
 *
 * 订阅的是宿主的 `session/event`，一次 turn 里可能收到多条：
 *   - assistant/chunk   : 增量文本（流式）
 *   - assistant/message : 一轮完整的助手消息
 *   - turn/end          : 本轮结束（带错误信息）
 * 其他类型（tool/call、tool/result）默认不发，除非配置里打开了 showToolResults。
 *
 * 流式策略（只对私聊开）：
 *   攒够一个完整句子就发一条，但一个 turn 里最多发 streamMaxChunks 条，
 *   超了就憋回去，等 assistant/message 落定时把剩下的整段发完。
 */

function pickSession(args) {
  if (args.length >= 2) return { session: args[0], raw: args[1] }
  const raw = args[0]
  return { session: raw?.session, raw }
}

function sessionIdOf(session, raw) {
  const id =
    session?.header?.id ??
    session?.id ??
    raw?.sessionId ??
    raw?.session?.id ??
    raw?.session?.header?.id
  return id === undefined || id === null ? '' : String(id)
}

/** 从 assistant 消息里抠出纯文本。 */
export function extractText(message) {
  const content = message?.content
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content.trim()
    return ''
  }
  let out = ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out += part.text
  }
  return out.trim()
}

/** 句子边界：中文句号/问号/叹号/省略号，以及换行。 */
const SENTENCE_END = /^([\s\S]*?[。！？!?…\n])/

/**
 * 模型偶尔把「想一想再改一版」的过程写进正文（不是 reasoning channel）。
 * 2026-10-25 15:24 和 15:28 各出现一次，原样发到了 QQ 上。
 * 这里按「整行像思考」兜底剥掉——只认行首那几个标志词，不碰正常中文。
 */
const LEAK_LINE = [
  /^Hmm\b/i,
  /^Maybe\b/i,
  /^Let me\b/i,
  /^Two lines?\b/i,
  /^-\s*user asks about\b/i,
  /^Keep it\./i,
  /^I (?:should|will|'ll|need to)\b/i,
]

/**
 * 行首那一串英文小标签（`Good.` `2 lines.` `Hmm `）是模型的自评，不是话。
 * 它常常和中文粘在同一行：`Good.本姑娘这边显示是发出去了`——整行删会把话也删掉，
 * 所以先剥掉前缀，再交给 LEAK_LINE 判整行。
 */
const LEAD_LABEL = /^(?:[A-Za-z0-9][A-Za-z0-9'’]*[.。:!?,、]?\s*)+/

/** 最长公共子序列的长度——用来判两段是不是「同一句换了几个字」。 */
function lcsLength(a, b) {
  const n = a.length
  const m = b.length
  if (!n || !m) return 0
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[m]
}

/**
 * 模型有时把同一段话写两遍（第二遍只改几个字），2026-10-26 17:14 和 17:25 各一次。
 * 按段落去重：跟已经收下的某段相似度 ≥70% 就丢掉。
 */
function collapseRepeats(text) {
  const paras = text.split(/\n\s*\n/)
  const out = []
  for (const p of paras) {
    const t = p.trim()
    if (!t) continue
    const dup = out.some((q) => {
      const short = Math.min(t.length, q.length)
      if (short < 8) return false
      return lcsLength(t, q) / short >= 0.7
    })
    if (!dup) out.push(t)
  }
  return out.join('\n\n').trim()
}

export function stripLeakedThinking(text) {
  if (!text) return text
  const kept = text.split('\n').map((line) => {
    let t = line.trim()
    if (!t) return ''
    // 整行就是一句自评（`Hmm 这句要短一点。`）→ 整行丢掉
    if (LEAK_LINE.some((re) => re.test(t))) return ''
    // 只是行首粘了个英文小标签（`Good.本姑娘这边显示是发出去了`）→ 剥掉标签，话留下
    const lead = LEAD_LABEL.exec(t)
    if (lead) {
      const rest = t.slice(lead[0].length).trim()
      return rest
    }
    return t
  })
  return collapseRepeats(kept.join('\n').replace(/\n{3,}/g, '\n\n').trim())
}

/** 太短不算一句，避免「嗯。」单独发一条。 */
const MIN_SENTENCE = 6

/** 按流式同样的边界把整段切成句子，用来算「哪几句已经发过了」。 */
function splitSentences(text) {
  const out = []
  let rest = String(text ?? '')
  while (rest) {
    const m = SENTENCE_END.exec(rest)
    if (!m) break
    out.push(m[1])
    rest = rest.slice(m[0].length)
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** 这一段里有几个汉字——用来判断一段话是不是「人话」。 */
function cjkCount(text) {
  return (String(text).match(/[\u4e00-\u9fa5]/g) ?? []).length
}

/**
 * 模型偶尔把答案整个写进 reasoning 通道，text 块是空的。
 * 2026-10-26 17:15:24 和 17:16:06 各一次：turn 正常结束，QQ 上一个字都没有，
 * 因为 extractText() 只认 text 块，拿到空串就直接 return 了。
 * 这种情况下退回去取 reasoning 的最后一段当正文——总比整条不回好。
 */
export function reasoningTail(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text)
  }
  if (parts.length === 0) return ''
  const paragraphs = parts
    .join('\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  // 从最后往前看三段，挑第一段像人话的（汉字够多）
  for (let i = paragraphs.length - 1; i >= 0 && i >= paragraphs.length - 3; i -= 1) {
    const clean = stripLeakedThinking(paragraphs[i])
    if (clean && cjkCount(clean) >= 4) return clean
  }
  return ''
}

/**
 * 这些工具**自己就会把话发出去**。
 * 一旦某个 turn 里用了它们，本轮的 assistant 文本就不能再自动转发一遍，
 * 否则 QQ 上会出现「同样一句话连着两条」的鬼影。
 */
const SELF_SENDING_TOOLS = new Set(['qq_reply', 'qq_send_text', 'qq_send_message'])

export function createOutbound({ manager, config, logger, send, wake }) {
  const lastSent = new Map() // sessionId -> 上一条完整文本（去重用）
  const streamBuf = new Map() // sessionId -> 还没发出去的流式尾巴
  const streamCount = new Map() // sessionId -> 本轮已经流式发了几条
  const selfSent = new Set() // sessionId -> 本轮是否已经用「会自己发送」的工具发过话了

  const streamMax = Number(config.streamMaxChunks ?? 3)
  const streamEnabled = config.streamReply !== false

  /**
   * 一切往外发的文字都从这儿走。
   * 顺手告诉 wake「刚有活动」——不然主动说话那层会把「自己刚说完」也当成冷场。
   */
  async function emit(record, text) {
    try {
      await send(record, text)
    } finally {
      wake?.noteOutbound?.(record)
    }
  }

  function resetStream(sessionId) {
    streamBuf.delete(sessionId)
    streamCount.delete(sessionId)
  }

  return async function onSessionEvent(...args) {
    const { session, raw } = pickSession(args)
    const sessionId = sessionIdOf(session, raw)
    if (!sessionId) return

    const record = manager.find(sessionId)
    if (!record) return

    const type = raw?.type ?? ''
    const data = raw?.data ?? {}

    // ── 流式：只在私聊开，群聊一口气发完更清爽 ──
    if (type === 'assistant/chunk') {
      if (!streamEnabled || record.scope === 'group') return
      if (selfSent.has(sessionId)) return // 本轮走的是工具发送，别再流式插嘴
      const chunk = data.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return

      let buf = (streamBuf.get(sessionId) ?? '') + chunk.text
      let sent = streamCount.get(sessionId) ?? 0

      while (buf.length >= MIN_SENTENCE && sent < streamMax) {
        const match = SENTENCE_END.exec(buf)
        if (!match) break
        const sentence = match[1].trim()
        if (sentence.length < MIN_SENTENCE) break
        const clean = stripLeakedThinking(sentence)
        if (clean) await emit(record, clean)
        buf = buf.slice(match[0].length)
        sent += 1
        streamCount.set(sessionId, sent)
      }

      streamBuf.set(sessionId, buf)
      return
    }

    if (type === 'assistant/message') {
      // 本轮已经用 qq_reply 之类的工具把话发过了 → 不再重复转发
      if (selfSent.has(sessionId)) {
        resetStream(sessionId)
        return
      }
      let text = stripLeakedThinking(extractText(data.message))
      // 模型偶尔把答案整个写进 reasoning，text 块是空的（2026-10-26 17:15、17:16 各一次：
      // turn 正常结束，QQ 那边一个字都没收到）。退回去取 reasoning 的尾段当正文。
      if (!text) text = reasoningTail(data.message)
      if (!text) return

      const already = streamCount.get(sessionId) ?? 0
      resetStream(sessionId)

      // 流式已经发出去过几句：只补后面没发的，别把发过的再发一遍
      // （2026-10-26 17:25 的窟窿：原来拿「没发出去的尾巴」去比，结果把前两句又发了一遍）
      if (already > 0) {
        const rest = splitSentences(text).slice(already).join('')
        if (rest) await emit(record, rest)
        lastSent.set(sessionId, text)
        return
      }

      // 没走流式：整套去重逻辑
      const previous = lastSent.get(sessionId) ?? ''
      if (text === previous) return
      if (previous.startsWith(text) && text.length < previous.length) return
      lastSent.set(sessionId, text)
      if (previous && text.startsWith(previous)) {
        const tail = text.slice(previous.length).trim()
        if (tail) await emit(record, tail)
        return
      }
      await emit(record, text)
      return
    }

    if (type === 'turn/end') {
      lastSent.delete(sessionId)
      selfSent.delete(sessionId)
      resetStream(sessionId)
      const reason = data.reason
      if (reason?.kind === 'error') {
        const message =
          reason.error?.message || reason.failure?.message || reason.failure?.code || '处理时出错了'
        logger.warn?.(`[dsh-qq] ${record.label} 本轮出错: ${message}`)
        await emit(record, `⚠️ ${message}`)
      }
      return
    }

    if (type === 'tool/call') {
      const name = String(data.name ?? '')
      if (SELF_SENDING_TOOLS.has(name)) selfSent.add(sessionId)
      if (config.showToolResults) {
        await emit(record, `🔧 调用 ${name || 'tool'}`)
      }
      return
    }

    if (type === 'tool/result' && config.showToolResults) {
      const err = data.error
      if (err) await emit(record, `⚠️ 工具失败: ${err.message ?? err.code ?? err}`)
      return
    }
  }
}
