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

/** 太短不算一句，避免「嗯。」单独发一条。 */
const MIN_SENTENCE = 6

/**
 * 这些工具**自己就会把话发出去**。
 * 一旦某个 turn 里用了它们，本轮的 assistant 文本就不能再自动转发一遍，
 * 否则 QQ 上会出现「同样一句话连着两条」的鬼影。
 */
const SELF_SENDING_TOOLS = new Set(['qq_reply', 'qq_send_text', 'qq_send_message'])

export function createOutbound({ manager, config, logger, send }) {
  const lastSent = new Map() // sessionId -> 上一条完整文本（去重用）
  const streamBuf = new Map() // sessionId -> 还没发出去的流式尾巴
  const streamCount = new Map() // sessionId -> 本轮已经流式发了几条
  const selfSent = new Set() // sessionId -> 本轮是否已经用「会自己发送」的工具发过话了

  const streamMax = Number(config.streamMaxChunks ?? 3)
  const streamEnabled = config.streamReply !== false

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
        await send(record, sentence)
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
      const text = extractText(data.message)
      if (!text) return

      const streamed = streamBuf.get(sessionId) ?? ''
      resetStream(sessionId)

      // 流式已经发出去过一段：只补没发的那部分
      if (streamed) {
        const tail = text.endsWith(streamed.trim())
          ? text.slice(0, text.length - streamed.trim().length).trim()
          : (text.startsWith(streamed.trim()) ? text.slice(streamed.trim().length).trim() : text)
        if (tail) await send(record, tail)
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
        if (tail) await send(record, tail)
        return
      }
      await send(record, text)
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
        await send(record, `⚠️ ${message}`)
      }
      return
    }

    if (type === 'tool/call') {
      const name = String(data.name ?? '')
      if (SELF_SENDING_TOOLS.has(name)) selfSent.add(sessionId)
      if (config.showToolResults) {
        await send(record, `🔧 调用 ${name || 'tool'}`)
      }
      return
    }

    if (type === 'tool/result' && config.showToolResults) {
      const err = data.error
      if (err) await send(record, `⚠️ 工具失败: ${err.message ?? err.code ?? err}`)
      return
    }
  }
}
