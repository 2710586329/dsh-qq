/**
 * 上下文守卫：让 QQ 上的长会话不会「聊着聊着把自己是谁聊丢了」。
 *
 * 两件事：
 *  1) **压缩后补规矩**——DSH 自己在窗口快满时会把旧对话压成摘要（见 dsh-compaction-basic），
 *     但「聊天规矩」只在会话第一轮注入过一次，会跟着旧对话一起被卷进摘要里。这里监听
 *     `compaction/end`，把注入标记清掉（下一轮重新注入完整规矩），并立刻塞一张短卡提醒。
 *  2) **超限前主动换会话**——最近一次请求的 prompt token 超过窗口比例时，把最近聊天
 *     记进 `记忆区/压缩记忆/`，然后重置会话换个新 sessionId：上下文归零、token 成本
 *     降下来，新会话首轮会带上上一段聊天的尾巴（seed）接话。
 *
 * 全部由配置控制，contextGuard=false 时整块不生效。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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

function pad(n) {
  return String(n).padStart(2, '0')
}

function stampName(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}`
}

/**
 * @param {{ manager: object, config: object, logger: object }} deps
 */
export function createContextGuard({ manager, config, logger }) {
  const enabled = config.contextGuard !== false
  const swapRatio = Number(config.contextSwapRatio ?? 0.7)
  const minTokens = Number(config.contextSwapMinTokens ?? 200_000)
  const keep = Math.max(5, Number(config.contextMemoryKeep ?? 30))
  const ownerLabel = String(config.ownerLabel ?? '').trim() || '主人'

  /** 从持久事件里顺手更新「这个会话的压力」。 */
  function note(record, raw) {
    const type = raw?.type ?? ''
    const data = raw?.data ?? {}
    if (type === 'request/context') {
      const window = Number(data.contextWindow ?? 0)
      if (window > 0) record.contextWindow = window
      return
    }
    if (type === 'assistant/message') {
      const usage = data.usage
      if (!usage) return
      // prompt 大小 = 未命中缓存的输入 + 命中缓存的输入；output 是回复本身
      const prompt = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0)
      const total = prompt + Number(usage.outputTokens ?? 0)
      if (total > 0) {
        record.promptTokens = total
        record.promptAt = Date.now()
      }
    }
  }

  /** 压缩结束：规矩被卷进摘要了，下一轮补回来，并立刻提醒一句。 */
  function onCompacted(record) {
    record.chatPromptInjected = false
    record.compactedCount = (record.compactedCount ?? 0) + 1
    const isGroup = record.scope === 'group'
    const card = isGroup
      ? `[刚才的长对话被系统压缩成了摘要，细节可能变模糊了。这是 QQ 群 ${record.label}，回话短一点、别刷屏。]`
      : `[刚才的长对话被系统压缩成了摘要，细节可能变模糊了。对面是${ownerLabel}，按上面的设定接着说话。]`
    try {
      record.agent?.inject?.(
        createUserMessage({
          content: [{ type: 'text', text: card }],
          source: { kind: 'user' },
        }),
      )
    } catch (err) {
      logger.debug?.(`[dsh-qq] 压缩后注入记忆卡失败: ${err?.message ?? err}`)
    }
    logger.info?.(
      `[dsh-qq] ${record.label} 上下文被压缩（第 ${record.compactedCount} 次），下一轮重注入聊天规矩`,
    )
  }

  /** 把最近聊天落到这个会话自己的记忆区里，换会话后还能翻。 */
  async function writeMemory(record) {
    if (!record.dir) return ''
    const dir = join(record.dir, '记忆区', '压缩记忆')
    await mkdir(dir, { recursive: true })
    const now = new Date()
    const path = join(dir, `聊天记忆-${stampName(now)}.md`)
    const recent = record.recent?.slice(-keep) ?? []
    const body = [
      `# ${record.label} 聊天记忆`,
      '',
      `> 记于 ${now.toLocaleString('zh-CN')}；换新会话前留下最近 ${recent.length} 条。`,
      `> 上一段会话的请求 token 约 ${record.promptTokens ?? '?'} / 窗口 ${record.contextWindow ?? '?'}。`,
      '',
      '## 最近消息',
      '',
      ...(recent.length > 0 ? recent : ['（没有记录到最近消息）']),
      '',
    ].join('\n')
    await writeFile(path, body, 'utf8')
    return path
  }

  return {
    /** 挂到 `session/event` 上。 */
    onSessionEvent(...args) {
      if (!enabled) return
      const { session, raw } = pickSession(args)
      const sessionId = sessionIdOf(session, raw)
      if (!sessionId) return
      const record = manager.find(sessionId)
      if (!record) return
      note(record, raw)
      if (raw?.type === 'compaction/end') onCompacted(record)
    },

    /**
     * 新消息投递前调一次：压力过大就换新会话。
     * @returns {Promise<null|string[]>} null = 没换；数组 = 换了，把 seed 挂到新会话上
     */
    async maybeSwap(record) {
      if (!enabled || swapRatio <= 0) return null
      const window = Number(record.contextWindow ?? 0)
      const tokens = Number(record.promptTokens ?? 0)
      if (!window || !tokens) return null
      if (tokens < minTokens) return null
      if (tokens < window * swapRatio) return null
      if (record.busy > 0) return null // 正在跑就别动，下一轮再说

      const seed = (record.recent?.length ? record.recent : record.history ?? []).slice(-keep)
      let memoryPath = ''
      try {
        memoryPath = await writeMemory(record)
      } catch (err) {
        logger.warn?.(`[dsh-qq] 写聊天记忆失败（不影响换会话）: ${err?.message ?? err}`)
      }
      manager.reset(record)
      logger.info?.(
        `[dsh-qq] ${record.label} 上下文压力 ${tokens}/${window}（${Math.round((tokens / window) * 100)}%）已达阈值，换新会话${memoryPath ? `（旧聊天记在 ${memoryPath}）` : ''}`,
      )
      return seed
    },
  }
}
