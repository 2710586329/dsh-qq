import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readMessage } from './onebot/segment.js'

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

/** 群聊里把一条消息压成一行，进历史缓冲。 */
function historyLine(sender, text) {
  const name = sender?.card || sender?.nickname || String(sender?.user_id ?? '')
  return `[${name} (${sender?.user_id ?? ''})] ${text}`
}

/**
 * 入站：OneBot 消息事件 → agent.followup()。
 *
 * 触发规则全部走配置，插件自己不做「猜你还想聊」这种自作聪明的事。
 */
export function createInbound({ config, manager, logger }) {
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
    if (!info.text) return

    // 群聊：默认要 @ 才理
    if (isGroup && config.requireMention && !info.atMe) {
      logger.debug?.(`[dsh-qq] 群 ${peerId} 未 @，跳过`)
      return
    }

    const record = await manager.obtain({ scope, peerId, label })

    // 给互动工具留线索：戳谁、给哪条消息贴表情、撤回哪条
    record.lastSenderId = Number(event.user_id) || record.lastSenderId || null
    record.lastSenderName = senderName
    record.lastMessageId = Number(event.message_id) || record.lastMessageId || null
    record.lastMessageAt = Date.now()
    if (record.lastSenderName) record.label = label

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    if (isGroup) parts.push(historyLine(sender, info.text))
    else parts.push(info.text)

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

    logger.info?.(`[dsh-qq] ← ${label}: ${info.text.slice(0, 60)}`)

    // 先记历史（下一条能看到这一条），再投递
    if (isGroup) {
      record.history.push(historyLine(sender, info.text))
      const keep = Math.max(0, Number(config.historyLimit) || 0) * 2
      if (keep > 0 && record.history.length > keep) {
        record.history.splice(0, record.history.length - keep)
      }
    }

    manager.enqueue(record, async () => {
      try {
        record.agent.followup(message)
        await record.agent.whenIdle?.()
      } catch (err) {
        logger.warn?.(`[dsh-qq] 投递给 ${label} 失败:`, err)
      }
    })
  }
}
