/**
 * 给 agent 的「手」：在 QQ 里做点小动作。
 *
 * 这些工具只在 dsh-qq 的会话里才有意义，所以由插件自己注册；
 * 别的通道的同名工具不会冲突（统一 `qq_` 前缀）。
 *
 * 全部通过 `ctx.get('tools')` 注册，tools 服务不存在时安静跳过，
 * 不让插件因为缺服务而启动失败。
 */

import { pickFace, keepFace, facesCount } from './faces.js'

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

const FACE_DESC =
  '在 QQ 里发一个内置小表情（QQ 自带的黄脸表情），不是文字，也不是图片。' +
  'id 用 QQ 表情编号，常用：1 微笑、4 得意、14 白眼、101 嘘、178 捂脸、182 笑哭、212 裂开、264 流泪。'

const FILE_DESC =
  '把一个本地文件发到当前 QQ 对话里（对方能点开下载）。file 传电脑上的绝对路径，' +
  'name 可选，不填就用原文件名。只发确实存在的文件。'

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
    name: 'qq_face',
    description: FACE_DESC,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'QQ 内置表情编号，例如 "178"（捂脸）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        required: ['ok', 'id'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `发了个表情 ${value.id}` : `表情 ${value.id} 没发出去` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('qq_face: id 不能为空')
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        await client.call(action, {
          ...peerOf(record),
          message: [{ type: 'face', data: { id } }],
        })
        return { ok: true, id }
      } catch (err) {
        logger.warn?.(`qq_face 失败: ${err?.message ?? err}`)
        return { ok: false, id }
      }
    },
  })

  tools.register({
    name: 'qq_send_file',
    description: FILE_DESC,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送文件的绝对路径' },
        name: { type: 'string', description: '可选：对方看到的文件名' },
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
        { type: 'text', text: value.ok ? `文件已发到 ${value.target}` : `文件没发出去（${value.target}）` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('qq_send_file: file 不能为空')
      const name = String(args?.name ?? '').trim() || file.split(/[\\/]/).pop()
      try {
        if (record.scope === 'group') {
          await client.call('upload_group_file', {
            group_id: Number(record.peerId),
            file,
            name,
          })
        } else {
          await client.call('upload_private_file', {
            user_id: Number(record.peerId),
            file,
            name,
          })
        }
        return { ok: true, target: record.label }
      } catch (err) {
        logger.warn?.(`qq_send_file 失败: ${err?.message ?? err}`)
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

  tools.register({
    name: 'qq_reply',
    description:
      '引用某条消息再发一句话（QQ 的「回复」，气泡上会带一条原文引用）。' +
      '群聊里同时有好几个人说话、或者要接很久以前的那句话时用它，比直接说话清楚得多。' +
      'message_id 填对方那条消息的 id（入站消息里看到的「引用 xxx」里的 id，或你自己拿到的消息 id）。' +
      '不填 message_id 就退化成普通发送。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的正文' },
        message_id: { type: 'integer', description: '可选：要引用的那条消息 id' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'integer' },
          quoted: { type: 'integer' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `已发出（引用 ${value.quoted ?? '无'}）` : '发送失败' },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const text = String(args?.text ?? '')
      if (!text) throw new Error('qq_reply: text 不能为空')
      const quoted = Number(args?.message_id ?? record.lastMessageId ?? 0) || 0
      const segments = []
      if (quoted > 0) segments.push({ type: 'reply', data: { id: String(quoted) } })
      segments.push({ type: 'text', data: { text } })

      const isGroup = record.scope === 'group'
      const action = isGroup ? 'send_group_msg' : 'send_private_msg'
      const target = isGroup
        ? { group_id: Number(record.peerId) }
        : { user_id: Number(record.peerId) }
      try {
        const result = await client.call(action, { ...target, message: segments })
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) record.lastSentMessageId = sentId
        return { ok: true, messageId: sentId, quoted }
      } catch (err) {
        logger.warn?.(`qq_reply 失败: ${err?.message ?? err}`)
        return { ok: false, messageId: 0, quoted }
      }
    },
  })

  tools.register({
    name: 'qq_send',
    description:
      '发一条普通消息（不带引用）。' +
      '不填 to 就发给「当前正在跟你说话的人/群」；' +
      '填 to 可以主动发给别人，格式 `user:123456` 或 `group:987654`（群号）。' +
      '想接某句话用 qq_reply，只想说点什么用这个。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的正文' },
        to: { type: 'string', description: '可选：`user:<QQ号>` 或 `group:<群号>`；不填=当前会话' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'integer' },
          target: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `已发到 ${value.target}` : '发送失败' },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const text = String(args?.text ?? '')
      if (!text) throw new Error('qq_send: text 不能为空')

      // 解析目标：默认当前会话
      let action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      let target = record.scope === 'group'
        ? { group_id: Number(record.peerId) }
        : { user_id: Number(record.peerId) }
      let targetLabel = record.peerId

      const to = String(args?.to ?? '').trim()
      if (to) {
        const m = /^(user|group):(\d+)$/i.exec(to)
        if (!m) throw new Error('qq_send: to 格式要写成 user:123456 或 group:987654')
        const kind = m[1].toLowerCase()
        const id = Number(m[2])
        action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
        target = kind === 'group' ? { group_id: id } : { user_id: id }
        targetLabel = to
      }

      try {
        const result = await client.call(action, {
          ...target,
          message: [{ type: 'text', data: { text } }],
        })
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) record.lastSentMessageId = sentId
        return { ok: true, messageId: sentId, target: targetLabel }
      } catch (err) {
        logger.warn?.(`qq_send 失败: ${err?.message ?? err}`)
        return { ok: false, messageId: 0, target: targetLabel }
      }
    },
  })

  tools.register({
    name: 'qq_keep_face',
    description:
      '把一张本地图片收进「表情包收藏」，以后就能用 qq_mface 随机发出来。' +
      '⚠️ 有门槛：只在图片确实是「鲸鱼娘 / AI 娘化」这类带字梗图、表情包时才收。' +
      '普通照片、聊天截图、风景图、别人随手发的图 —— 一律不收。群里什么图都存会变成垃圾场。' +
      '收之前先 read_image 看一眼，确认是这类表情再收。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地图片的绝对路径' },
        summary: { type: 'string', description: '一句话概括这张表情的情绪，例如「捂脸」「吐泡泡」' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          added: { type: 'boolean' },
          total: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? value.added
              ? `收好了，现在一共 ${value.total} 个`
              : `这个之前就收过了，一共还是 ${value.total} 个`
            : `没收进去：${value.reason ?? '未知原因'}`,
        },
      ],
    },
    async execute(args) {
      const result = keepFace(config, { path: args?.path, summary: args?.summary })
      return result
    },
  })

  tools.register({
    name: 'qq_mface',
    description:
      '发一个 QQ「商城表情/表情包」（就是聊天框表情面板里那种大图表情，不是 emoji）。' +
      '不填 emoji_id 就从收藏里随机挑一个 —— 收藏是平时别人发表情包时自动攒下来的。' +
      '想指定某个，给 emoji_id 和 emoji_package_id（从收到的 mface 消息里拿得到）。' +
      '服务端不认这个 id 时，会自动改用官方 CDN 的图片地址兜底，不会报错。',
    parameters: {
      type: 'object',
      properties: {
        emoji_id: { type: 'string', description: '表情 id，例如 96e2cc34b1a4d3ee6b2b；留空则从收藏里随机挑' },
        emoji_package_id: { type: 'string', description: '表情包 id（可空，兜底 CDN 要用）' },
        key: { type: 'string', description: '有些版本需要 key，可空' },
        summary: { type: 'string', description: '想要的表情含义，例如「捂脸」；收藏里有匹配的会优先挑它' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          messageId: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `已发出（${value.mode}${value.reason ? ` · ${value.reason}` : ''}）`
            : `没发出去：${value.reason ?? '未知原因'}`,
        },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)

      // 没给 id 就从收藏里挑一个；收藏空着就直接说清楚，别硬发
      let face
      const explicit = String(args?.emoji_id ?? '').trim()
      if (explicit) {
        face = {
          kind: 'mface',
          emojiId: explicit,
          packageId: String(args?.emoji_package_id ?? '').trim(),
          key: String(args?.key ?? '').trim(),
          summary: String(args?.summary ?? '').trim() || '[表情]',
        }
      } else {
        face = pickFace(config, args?.summary)
        if (!face) {
          return {
            ok: false,
            mode: 'none',
            messageId: 0,
            reason: `收藏夹是空的（0 个）。等对方先发几个表情包，插件会自动攒起来；攒到之前先别发表情，或者说句话代替`,
          }
        }
      }

      const isGroup = record.scope === 'group'
      const action = isGroup ? 'send_group_msg' : 'send_private_msg'
      const target = isGroup
        ? { group_id: Number(record.peerId) }
        : { user_id: Number(record.peerId) }

      // 收藏里也可能是一张本地图片 —— 直接按图片发
      if (face.kind === 'image') {
        try {
          const result = await client.call(action, {
            ...target,
            message: [{ type: 'image', data: { file: face.path } }],
          })
          const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
          if (sentId > 0) {
            record.lastSentMessageId = sentId
            return { ok: true, mode: 'image', messageId: sentId, reason: face.summary || '' }
          }
        } catch (err) {
          logger.warn?.(`qq_mface 发收藏图片失败: ${err?.message ?? err}`)
        }
        return { ok: false, mode: 'none', messageId: 0, reason: `收藏的图片发不出去：${face.path}` }
      }

      const { emojiId, packageId, key } = face
      const summary = face.summary || '[表情]'

      // ① 先正经发 mface 段
      try {
        const seg = {
          type: 'mface',
          data: {
            emoji_id: emojiId,
            emoji_package_id: packageId || '1',
            key: key || emojiId,
            summary,
          },
        }
        const result = await client.call(action, { ...target, message: [seg] })
        const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
        if (sentId > 0) {
          record.lastSentMessageId = sentId
          return { ok: true, mode: 'mface', messageId: sentId }
        }
      } catch (err) {
        logger.debug?.(`qq_mface 直发失败，走 CDN 兜底: ${err?.message ?? err}`)
      }

      // ② 兜底：官方 CDN 的 raw300.gif
      if (packageId) {
        try {
          const url = `https://gxh.vip.qq.com/club/item/parcel/item/${packageId}/${emojiId}/raw300.gif`
          const result = await client.call(action, {
            ...target,
            message: [{ type: 'image', data: { file: url } }],
          })
          const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
          if (sentId > 0) {
            record.lastSentMessageId = sentId
            return { ok: true, mode: 'cdn', messageId: sentId }
          }
        } catch (err) {
          logger.warn?.(`qq_mface CDN 兜底也失败: ${err?.message ?? err}`)
        }
      }

      return {
        ok: false,
        mode: 'none',
        messageId: 0,
        reason: `这个表情发不出去（id ${packageId || '?'}/${emojiId}），CDN 兜底也没成功`,
      }
    },
  })

  logger.info?.(
    `QQ 互动工具已注册：qq_poke / qq_react / qq_like / qq_send_image / qq_send_file / qq_face / qq_mface / qq_reply / qq_send / qq_recall（表情包收藏 ${facesCount(config)} 个）`,
  )
}
