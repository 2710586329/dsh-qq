/**
 * 出站：把 agent 跑出来的文字送回 QQ。
 *
 * 订阅的是宿主的 `session/event`，一次 turn 里可能收到多条：
 *   - assistant/message : 一轮完整的助手消息
 *   - turn/end          : 本轮结束（带错误信息）
 * 其他类型（tool/call、tool/result）默认不发，除非配置里打开了 showToolResults。
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

export function createOutbound({ manager, config, logger, send }) {
  const lastSent = new Map() // sessionId -> 上一条文本

  return async function onSessionEvent(...args) {
    const { session, raw } = pickSession(args)
    const sessionId = sessionIdOf(session, raw)
    if (!sessionId) return

    const record = manager.find(sessionId)
    if (!record) return

    const type = raw?.type ?? ''
    const data = raw?.data ?? {}

    if (type === 'assistant/message') {
      const text = extractText(data.message)
      if (!text) return
      // 同一条消息可能被重复推送，或者是上一段的前缀补全
      const previous = lastSent.get(sessionId) ?? ''
      if (text === previous) return
      if (previous.startsWith(text) && text.length < previous.length) return
      lastSent.set(sessionId, text)
      if (previous && text.startsWith(previous)) {
        // 增量补全：只发尾巴
        const tail = text.slice(previous.length).trim()
        if (tail) await send(record, tail)
        return
      }
      await send(record, text)
      return
    }

    if (type === 'turn/end') {
      lastSent.delete(sessionId)
      const reason = data.reason
      if (reason?.kind === 'error') {
        const message =
          reason.error?.message || reason.failure?.message || reason.failure?.code || '处理时出错了'
        logger.warn?.(`[dsh-qq] ${record.label} 本轮出错: ${message}`)
        await send(record, `⚠️ ${message}`)
      }
      return
    }

    if (type === 'tool/call' && config.showToolResults) {
      const name = data.name ?? 'tool'
      await send(record, `🔧 调用 ${name}`)
      return
    }

    if (type === 'tool/result' && config.showToolResults) {
      const err = data.error
      if (err) await send(record, `⚠️ 工具失败: ${err.message ?? err.code ?? err}`)
      return
    }
  }
}
