/**
 * 给 agent 的「手」：在 QQ 里做点小动作。
 *
 * 这些工具只在 dsh-qq 的会话里才有意义，所以由插件自己注册；
 * 别的通道的同名工具不会冲突（统一 `qq_` 前缀）。
 *
 * 全部通过 `ctx.get('tools')` 注册，tools 服务不存在时安静跳过，
 * 不让插件因为缺服务而启动失败。
 */

const POKE_DESC =
  '戳一戳当前对话里的对方（私聊戳好友，群聊戳那位发言的人）。用来提醒对方注意、' +
  '或者轻轻催一下，属于 QQ 特有的互动。不要连续戳超过两次。'

const REACT_DESC =
  '给当前对话里最新的一条消息贴上表情回应（QQ 的「表情表态」）。' +
  '表情 id 用 QQ 表情的数字编号，比如 1 是微笑、4 是得意、14 是白眼、178 是捂脸、' +
  '212 是裂开、264 是流泪。想表达态度又不想刷屏时用它。'

const LIKE_DESC =
  '给对方的 QQ 名片点赞（就是资料页的那个赞）。每天每人最多 10 次，' +
  '一般是表达鼓励或者「我看到你了」。'

const IMAGE_DESC =
  '把本地的一张图片发到当前 QQ 对话里。file 传绝对路径或电脑上的文件名。' +
  '发之前确认文件确实存在，别传不存在的路径。'

const RECALL_DESC =
  '撤回自己在当前对话里刚发出的一条消息。QQ 只允许撤回两分钟内的消息，超过就会失败。'

/** 从工具执行上下文里找到对应的 QQ 会话记录。 */
function recordOf(manager, exec) {
  const session = exec?.agent?.session
  const id = session?.header?.id ?? session?.id
  if (id === undefined || id === null) return null
  return manager.find(String(id))
}

function needRecord(manager, exec) {
  const record = recordOf(manager, exec)
  if (!record) throw new Error('这个工具只能在 QQ 会话里用（找不到对应的 QQ 会话记录）')
  return record
}

function peerOf(record) {
  return record.scope === 'group'
    ? { group_id: Number(record.peerId) }
    : { user_id: Number(record.peerId) }
}

export function registerTools(ctx, { client, manager, config, logger }) {
  const tools = ctx.get?.('tools')
  if (!tools?.register) {
    logger.info?.('tools 服务不可用，QQ 互动工具未注册（聊天本身不受影响）')
    return
  }

  tools.register({
    name: 'qq_poke',
    description: POKE_DESC,
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'integer',
          description: '可选：群里要戳谁（不填就是当前发言的人）。私聊不用填。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `戳了戳 ${value.target}` : `没戳到 ${value.target}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const targetUser = Number(args?.user_id ?? record.lastSenderId ?? 0)
      if (!Number.isFinite(targetUser) || targetUser <= 0) {
        throw new Error('qq_poke: 不知道要戳谁（拿不到对方的 QQ 号）')
      }
      try {
        if (record.scope === 'group') {
          await client.call('group_poke', { group_id: Number(record.peerId), user_id: targetUser })
        } else {
          await client.call('friend_poke', { user_id: targetUser })
        }
        return { ok: true, target: String(targetUser) }
      } catch (err) {
        logger.warn?.(`qq_poke 失败: ${err?.message ?? err}`)
        return { ok: false, target: String(targetUser) }
      }
    },
  })

  tools.register({
    name: 'qq_react',
    description: REACT_DESC,
    parameters: {
      type: 'object',
      properties: {
        emoji_id: { type: 'string', description: 'QQ 表情编号，例如 "178"（捂脸）' },
        message_id: { type: 'integer', description: '可选：要表态的消息 id，默认最新一条' },
      },
      required: ['emoji_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' } },
        required: ['ok', 'messageId'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `给消息 ${value.messageId} 贴了表情` : '贴表情失败' },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = Number(args?.message_id ?? record.lastMessageId ?? 0)
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error('qq_react: 找不到可表态的消息')
      }
      try {
        await client.call('set_msg_emoji_like', {
          message_id: messageId,
          emoji_id: String(args.emoji_id),
          set: true,
        })
        return { ok: true, messageId }
      } catch (err) {
        logger.warn?.(`qq_react 失败: ${err?.message ?? err}`)
        return { ok: false, messageId }
      }
    },
  })

  tools.register({
    name: 'qq_like',
    description: LIKE_DESC,
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: '给谁点赞，不填就是当前对话的对方' },
        times: { type: 'integer', description: '点几次，1-10，默认 1' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `给 ${value.target} 点了赞` : `给 ${value.target} 点赞失败` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const target = Number(args?.user_id ?? record.lastSenderId ?? 0)
      const times = Math.min(Math.max(Number(args?.times ?? 1) || 1, 1), 10)
      if (!Number.isFinite(target) || target <= 0) {
        throw new Error('qq_like: 不知道给谁点赞')
      }
      try {
        await client.call('send_like', { user_id: target, times })
        return { ok: true, target: String(target) }
      } catch (err) {
        logger.warn?.(`qq_like 失败: ${err?.message ?? err}`)
        return { ok: false, target: String(target) }
      }
    },
  })

  tools.register({
    name: 'qq_send_image',
    description: IMAGE_DESC,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '图片的绝对路径，或 QQ 能识别的文件名' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `图片已发到 ${value.target}` : `图片没发出去` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('qq_send_image: file 不能为空')
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        await client.call(action, {
          ...peerOf(record),
          message: [{ type: 'image', data: { file } }],
        })
        return { ok: true, target: record.label }
      } catch (err) {
        logger.warn?.(`qq_send_image 失败: ${err?.message ?? err}`)
        return { ok: false, target: record.label }
      }
    },
  })

  tools.register({
    name: 'qq_recall',
    description: RECALL_DESC,
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'integer', description: '要撤回的消息 id，不填就是自己刚发的那条' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' } },
        required: ['ok', 'messageId'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `已撤回消息 ${value.messageId}` : '撤回失败（可能超过两分钟了）' },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = Number(args?.message_id ?? record.lastSentMessageId ?? 0)
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error('qq_recall: 找不到要撤回的消息')
      }
      try {
        await client.call('delete_msg', { message_id: messageId })
        return { ok: true, messageId }
      } catch (err) {
        logger.warn?.(`qq_recall 失败: ${err?.message ?? err}`)
        return { ok: false, messageId }
      }
    },
  })

  logger.info?.('QQ 互动工具已注册：qq_poke / qq_react / qq_like / qq_send_image / qq_recall')
}
