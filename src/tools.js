/**
 * 给 agent 的「手」：在 QQ 里做点小动作。
 *
 * 这些工具只在 dsh-qq 的会话里才有意义，所以由插件自己注册；
 * 别的通道的同名工具不会冲突（统一 `qq_` 前缀）。
 *
 * 全部通过 `ctx.get('tools')` 注册，tools 服务不存在时安静跳过，
 * 不让插件因为缺服务而启动失败。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { pickFace, keepFace, facesCount, faceSendState, markFaceSent, listFaces } from './faces.js'
import { appendFact, upsertGlossaryTerm } from './settings.js'
import { auditOutbound } from './audit.js'
import { lookupMeme } from './meme.js'
import { downloadImage } from './inbound.js'

/**
 * 工具直接发出去的文字也要过审计。
 * 命中就抛错——不静默吞掉：模型得知道自己这条没发出去，才好换个说法，
 * 否则它会以为已经说了，然后接着往下编。
 */
function assertOutboundText(config, logger, text) {
  if (config?.auditOutbound === false) return
  const verdict = auditOutbound(text, { extraPatterns: config?.auditExtraPatterns ?? [] })
  if (verdict.ok) return
  logger?.warn?.(`[dsh-qq] 工具外发被审计拦下（${verdict.kind}）：${verdict.hit}`)
  throw new Error(
    `这条没有发出去：内容里带了本机路径或凭据特征（${verdict.kind}）。换个说法再试。`,
  )
}

const POKE_DESC =
  '戳一戳当前对话里的对方（私聊戳好友，群聊戳那位发言的人）。用来提醒对方注意、' +
  '或者轻轻催一下，属于 QQ 特有的互动。不要连续戳超过两次。'

const REACT_DESC =
  '给当前对话里最新的一条消息贴上表情回应（QQ 的「表情表态」）。' +
  '表情 id 用 QQ 表情的数字编号，比如 1 是微笑、4 是得意、14 是白眼、178 是捂脸、' +
  '212 是裂开、264 是流泪。想表达态度又不想刷屏时用它。'

const IMAGES_DESC =
  '把某条 QQ 消息里的图片重新取回来看（按消息 id）。' +
  '消息正文里只会出现一个 `[图片]` 占位——那一刻没被叫醒、或者当时没顾上看，' +
  '事后用这个工具还能把那张图捞回来。' +
  '聊天流水里每行末尾有 `#msg=123456`，那就是这条消息的 id；不填 id 就是最近收到的这一条。' +
  '拿回来的是本机文件路径，接着用 read_image 打开就能看见。一次最多四张。'

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

/**
 * 夜里的读书问询轮：这一轮说什么都不往外走。
 *
 * 正文那条路由 index.js 的 send() 硬拦；工具这条路由这里拦 —— 不拦的话，
 * 它一句「我睡不着」用 qq_send 发出去，半夜就把姐姐手机震醒了。
 */
function assertQuiet(record) {
  if (record?.quietRound) {
    throw new Error('这一轮是夜里的读书问询，不往外发消息——想说什么等早上')
  }
}

function peerOf(record) {
  return record.scope === 'group'
    ? { group_id: Number(record.peerId) }
    : { user_id: Number(record.peerId) }
}

export function registerTools(ctx, { client, manager, config, logger, pin, wake, noteSelfSaid }) {
  const tools = ctx.get?.('tools')
  if (!tools?.register) {
    logger.info?.('tools 服务不可用，QQ 互动工具未注册（聊天本身不受影响）')
    return
  }

  /**
   * 工具发出去的东西也要记账（2026-10-27 姐姐让修的）。
   *
   * 以前只有正文走 send() 才写流水、进 history，用 qq_send / qq_reply 说的话等于「发出去就没了」：
   * 翻聊天记录缺一句，下一轮她自己也不知道自己说过。这里补上，顺带兑现主动开口的额度。
   */
  function noteToolSent(record, text) {
    const said = String(text ?? '').trim()
    if (!said) return
    try {
      wake?.noteProactiveDelivered?.(record)
      noteSelfSaid?.(record, said)
    } catch (err) {
      logger?.debug?.(`工具外发记账失败：${err?.message ?? err}`)
    }
  }

  tools.register({
    name: 'qq_facts',
    description:
      '读写自己的事实卡（跨压缩还记得的关键事实：姐姐怎么称呼、作息、禁忌、正在做的事）。' +
      '只有姐姐说「记一下」时才用 append 往当前会话那一节加一行；平时不用调 read——事实卡已经在你面前的提示里了。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'append'], description: 'read=看一眼现在的全文；append=加一行' },
        text: { type: 'string', description: 'append 时要记的那一行（短，一句话）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, file: { type: 'string' }, text: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `事实卡已更新：${String(value.text ?? '').slice(0, 60)}` : '事实卡没写成（看一眼日志）' },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = join(dirname(String(record.dir ?? '')), '事实卡.md')
      if (args?.action === 'read') {
        try {
          const { readFileSync } = await import('node:fs')
          return { ok: true, file, text: readFileSync(file, 'utf8') }
        } catch {
          return { ok: false, file, text: '' }
        }
      }
      if (args?.action !== 'append') throw new Error('qq_facts: action 只能是 read 或 append')
      try {
        appendFact(file, record.label, args?.text)
        return { ok: true, file, text: String(args?.text ?? '') }
      } catch (err) {
        logger.warn?.(`qq_facts 写入失败: ${err?.message ?? err}`)
        return { ok: false, file, text: String(args?.text ?? '') }
      }
    },
  })

  tools.register({
    name: 'qq_glossary',
    description:
      '往某个群的群词典里补一条「弄明白了的说法」。群里的黑话、缩写、谁是谁——弄懂了就记下来，下回不用重新问。' +
      '传群号就行，不用传路径：这只笔只有一个落点，写的就是那个群的 `记忆区/群词典.md`，别的地方写不了。' +
      '「待确认」里通常正等着你；填完这条，对上的那条待确认会自动清掉。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群号（纯数字），比如 123456789' },
        word: { type: 'string', description: '那个词 / 说法本身' },
        meaning: { type: 'string', description: '它的意思（一句话，用自己的话，别抄别人）' },
        who: { type: 'string', description: '从谁那儿听来的（可空）' },
      },
      required: ['group', 'word', 'meaning'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, file: { type: 'string' }, message: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `群词典已记下：${value.message}` : `没写成：${value.message}` },
      ],
    },
    async execute(args) {
      try {
        const { file } = upsertGlossaryTerm({
          workspaceRoot: String(config?.workspaceRoot ?? '').trim(),
          group: args?.group,
          word: args?.word,
          meaning: args?.meaning,
          who: args?.who,
        })
        return { ok: true, file, message: String(args?.word ?? '').trim() }
      } catch (err) {
        logger.warn?.(`qq_glossary 写入失败: ${err?.message ?? err}`)
        return { ok: false, file: '', message: String(err?.message ?? err) }
      }
    },
  })

  tools.register({
    name: 'qq_meme',
    description:
      '查一个网络梗 / 黑话 / 缩写的出处和用法。手边有一份 6668 条的梗词库快照（cnmeme.wiki，2026-10-26 建库），毫秒级。' +
      '看到不认识的词先查一次，别硬猜、别编出处；查到之后**先接梗、别科普**——照着「怎么用」随口用一句，只有对方明确问「这是什么梗」才讲一两句。' +
      '⚠️ 它只收网上的通用梗：群里的自造说法（「已取餐」这类）查不到，那些用 qq_glossary 记下来。查不到就说不认识。',
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string', description: '那个词本身（不用带标点；叠词像「杂鱼杂鱼」会自动折叠）' },
        full: { type: 'boolean', description: '要完整原文传 true；默认截断到 600 字，平常不用' },
      },
      required: ['word'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          title: { type: 'string' },
          text: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['found'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.found ? value.text : value.message || '（词库里没有这个词）' },
      ],
    },
    async execute(args) {
      try {
        const word = String(args?.word ?? '').trim()
        const r = await lookupMeme(word, { dbPath: config.memeDb || undefined, full: Boolean(args?.full) })
        if (!r.found) {
          return {
            found: false,
            title: '',
            text: '',
            message:
              `词库里没有「${word}」。它是网络通用梗的快照，群里的自造说法它没有 —— ` +
              '直接说不认识，别猜，也别把两个不相干的梗拼一起。',
          }
        }
        return { found: true, title: r.title, text: r.text, message: '' }
      } catch (err) {
        logger.warn?.(`qq_meme 查询失败: ${err?.message ?? err}`)
        return { found: false, title: '', text: '', message: `查不了：${err?.message ?? err}` }
      }
    },
  })

  tools.register({
    name: 'qq_pin',
    description:
      '你自己的便签（话头，不是待办清单）：聊长了容易忘「上回说到哪儿、哪句话还没接上」，就记在这上面。' +
      '记下来的会每轮自动出现在你面前（最多 5 条），不用你翻。' +
      'action：add=记一条，done=接上了划掉，drop=不要了删掉，list=看全文。done/drop 用序号（1 = 便签里第一行）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'done', 'drop', 'list'], description: '要做什么' },
        text: { type: 'string', description: 'add 时要记的那一句（短，说清是什么话头就行）' },
        index: { type: 'number', description: 'done/drop 的序号，从 1 开始' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          openCount: { type: 'number' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `便签：还有 ${Number(value.openCount ?? 0)} 条没接上` }]
          : [{ type: 'text', text: '便签没写成（看一眼日志）' }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = pin?.fileFor?.(record) ?? ''
      const action = String(args?.action ?? '')
      const countOpen = () => (pin?.list?.(record) ?? []).filter((l) => /^-\s*\[\s*\]/.test(l.trim())).length
      try {
        if (action === 'list') {
          return { ok: true, file, openCount: countOpen(), lines: pin?.list?.(record) ?? [] }
        }
        if (action === 'add') {
          const openCount = pin.add(record, args?.text)
          return { ok: true, file, openCount }
        }
        if (action === 'done' || action === 'drop') {
          const n = Number(args?.index)
          const hit = action === 'done' ? pin.done(record, n) : pin.drop(record, n)
          return { ok: Boolean(hit), file, openCount: countOpen() }
        }
        throw new Error(`qq_pin: 不认识的 action「${action}」`)
      } catch (err) {
        logger.warn?.(`qq_pin 失败: ${err?.message ?? err}`)
        return { ok: false, file, openCount: 0 }
      }
    },
  })

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
    name: 'qq_images',
    description: IMAGES_DESC,
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'integer',
          description: '可选：要看哪条消息里的图（流水里 `#msg=` 后面那串）。不填就是最近收到的这一条。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'integer' },
          paths: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
        required: ['ok', 'messageId', 'paths', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.paths.length
            ? `${value.message}：\n${value.paths.map((p) => `  ${p}`).join('\n')}\n（用 read_image 打开）`
            : value.message,
        },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = Number(args?.message_id ?? record.lastMessageId ?? 0)
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error('qq_images: 不知道要看哪条消息')
      }

      let data
      try {
        data = await client.call('get_msg', { message_id: messageId })
      } catch (err) {
        logger.warn?.(`qq_images 取消息失败: ${err?.message ?? err}`)
        return { ok: false, messageId, paths: [], message: `取不到这条消息：${err?.message ?? err}` }
      }

      const segs = Array.isArray(data?.message)
        ? data.message
        : Array.isArray(data?.data?.message)
          ? data.data.message
          : []
      const urls = []
      for (const seg of segs) {
        if (seg?.type !== 'image') continue
        const d = seg.data ?? {}
        const src = String(d.url ?? '') || String(d.file ?? '') || String(d.path ?? '')
        if (src) urls.push(src)
        if (urls.length >= 4) break
      }
      if (urls.length === 0) {
        return {
          ok: true,
          messageId,
          paths: [],
          message: '这条消息里没有图片（表情包和合并转发里的图不算在这一条里）',
        }
      }

      const cacheDir = record.dir
        ? join(record.dir, '图片缓存')
        : join(String(config?.cwd ?? '').trim() || process.cwd(), '图片缓存')
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      const maxMB = Number(config?.imageMaxMB) || 8
      const paths = (
        await Promise.all(urls.map((u) => downloadImage(u, cacheDir, maxMB)))
      ).filter(Boolean)

      if (paths.length === 0) {
        return { ok: false, messageId, paths: [], message: '图找到了但拿不下来（链接可能过期了）' }
      }
      return { ok: true, messageId, paths, message: `拿到 ${paths.length} 张图` }
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
        properties: { ok: { type: 'boolean' }, target: { type: 'string' }, reason: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok ? `图片已发到 ${value.target}` : `图片没发出去${value.reason ? `：${value.reason}` : ''}`,
        },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      assertQuiet(record)
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('qq_send_image: file 不能为空')
      // 图片也算「发图」，跟表情包共用同一个节奏闸
      const gate = faceSendState(config)
      if (!gate.allowed) return { ok: false, target: record.label, reason: gate.reason }
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        await client.call(action, {
          ...peerOf(record),
          message: [{ type: 'image', data: { file } }],
        })
        markFaceSent()
        noteToolSent(record, '[图片]')
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
      assertQuiet(record)
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('qq_face: id 不能为空')
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        await client.call(action, {
          ...peerOf(record),
          message: [{ type: 'face', data: { id } }],
        })
        noteToolSent(record, `[表情 ${id}]`)
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
        noteToolSent(record, `[文件] ${name}`)
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
      assertQuiet(record)
      const text = String(args?.text ?? '')
      if (!text) throw new Error('qq_reply: text 不能为空')
      assertOutboundText(config, logger, text)
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
        noteToolSent(record, text)
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
      assertQuiet(record)
      const text = String(args?.text ?? '')
      if (!text) throw new Error('qq_send: text 不能为空')
      assertOutboundText(config, logger, text)

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
        noteToolSent(record, text)
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
      '⚠️ 有门槛：只有跟配置里 faceCollectHint 描述的那类图（没配就是一类都不收）才值得收。' +
      '普通照片、聊天截图、风景图、别人随手发的图 —— 一律不收。群里什么图都存会变成垃圾场。' +
      '收之前先 read_image 看一眼，确认是这类表情再收。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地图片的绝对路径' },
        summary: {
          type: 'string',
          description:
            '给这张起的名字，以后靠它挑图。图上有大字就用那行字，越短越好（「哼！」「求求了…」「下次见！」）；' +
            '没字就一句话说清画面和情绪（「抱着白饭碗干饭」「抱着小人偶一脸问号」）。',
        },
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
    name: 'qq_faces',
    description:
      '看「表情包收藏」里都有哪些图（名字 + 数量）。挑图之前先看一眼，别凭印象猜名字。' +
      '可以带 keyword 过滤，例如「问号」会把名字里带「问号」的挑出来。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按名字里的字过滤，可空' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer' },
          matched: { type: 'integer' },
          names: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'total'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `一共 ${value.total} 张，匹配 ${value.matched} 张：${
                value.names?.length ? value.names.join('、') : '（没有名字对得上的）'
              }`
            : '收藏里一张图都没有',
        },
      ],
    },
    async execute(args) {
      const all = listFaces(config, 500)
      const kw = String(args?.keyword ?? '').trim()
      const names = all
        .map((f) => String(f.summary ?? '').trim())
        .filter((n) => n && (!kw || n.includes(kw)))
      return { ok: all.length > 0, total: all.length, matched: names.length, names: names.slice(0, 50) }
    },
  })

  tools.register({
    name: 'qq_mface',
    description:
      '发一张表情包（收藏里的图，或 QQ 商城表情）。' +
      '一般只写 summary —— 用收藏那张的名字，比如「抱着小人偶一脸问号」「哼！」「求求了」；' +
      '不知道有哪些名字就先调 qq_faces 看一眼，别瞎猜。不写 summary 就从收藏里随机挑一张。' +
      '也可以给 emoji_id + emoji_package_id 指定某个商城表情。' +
      '⚠️ 有节奏限制：两张之间至少隔一会儿、一小时有上限，超了会被直接拒绝。' +
      '表情是点缀，不是标点符号 —— 正经说话就好好说，别每句都配一张。',
    parameters: {
      type: 'object',
      properties: {
        emoji_id: { type: 'string', description: '表情 id（指定商城表情时才用），例如 96e2cc34b1a4d3ee6b2b' },
        emoji_package_id: { type: 'string', description: '表情包 id（可空，兜底 CDN 要用）' },
        key: { type: 'string', description: '有些版本需要 key，可空' },
        summary: { type: 'string', description: '要哪张：收藏那张的名字，例如「抱着小人偶一脸问号」；收藏里有对得上的就发它' },
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

      // 节奏闸：表情是点缀，不是标点符号（姐姐原话「不能频繁使用，偶尔用用」）
      const gate = faceSendState(config)
      if (!gate.allowed) {
        return { ok: false, mode: 'throttled', messageId: 0, reason: gate.reason }
      }

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
        if (!existsSync(face.path)) {
          return {
            ok: false,
            mode: 'none',
            messageId: 0,
            reason: `收藏的图片文件不见了：${face.path}（换一个吧，或者让主人重新收一张）`,
          }
        }
        try {
          const result = await client.call(action, {
            ...target,
            message: [{ type: 'image', data: { file: face.path } }],
          })
          const sentId = Number(result?.message_id ?? result?.data?.message_id ?? 0)
          if (sentId > 0) {
            record.lastSentMessageId = sentId
            markFaceSent()
            noteToolSent(record, `[表情包] ${face.summary || '图片'}`)
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
          markFaceSent()
          noteToolSent(record, `[表情包] ${summary}`)
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
            markFaceSent()
            noteToolSent(record, `[表情包] ${summary}`)
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

  // 2026-10-26 姐姐：「老三还是看不到群聊」。私聊和群是两个会话，私聊里确实看不见群里的字。
  // 前辈 qq-bridge 也是 group:id / private:id 分开的，它给的办法是「AI 想看就自己取」——
  // 所以这里不是把群聊硬塞进私聊，而是给一只「眼睛」：想看看群里刚才聊了什么，自己调。
  tools.register({
    name: 'qq_group_history',
    description:
      '读某个群最近聊了什么（从落盘的聊天记录里取原话，含别人说的话）。' +
      '私聊里被问「群里刚才在聊什么」、或者想接一句群里的旧话题时用它。' +
      '不传 group_id 就先列出有哪些群存着记录。只读，不会往群里发任何东西。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群号；不填就列出所有有记录的群（群号 + 最后一条）' },
        days: { type: 'integer', description: '往前看几天，默认 1，最多 7' },
        limit: { type: 'integer', description: '最多返回多少条，默认 40，最多 200' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          groups: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '（没有记录）') }],
    },
    async execute(args) {
      const root =
        String(config?.workspaceRoot ?? '').trim() ||
        join(String(config?.cwd ?? '').trim() || process.cwd(), '会话')

      // 往前 days 天，按时间升序
      const dayList = []
      const span = Math.min(Math.max(1, Number(args?.days) || 1), 7)
      for (let i = span - 1; i >= 0; i -= 1) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        dayList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
      }
      const wantLimit = Math.min(Math.max(1, Number(args?.limit) || 40), 200)

      let dirs = []
      try {
        dirs = readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith('群_'))
          .map((e) => e.name)
      } catch (err) {
        return { ok: false, text: `读不到 QQ 会话目录：${root}（${err?.message ?? err}）`, groups: [] }
      }

      const gid = String(args?.group_id ?? '').replace(/[^\d]/g, '')
      if (!gid) {
        if (!dirs.length) return { ok: true, text: '还没有任何群聊记录。', groups: [] }
        const groups = dirs.map((name) => {
          const id = name.slice(2)
          let last = ''
          for (const day of dayList) {
            const f = join(root, name, '聊天记录', `${day}.md`)
            if (!existsSync(f)) continue
            try {
              const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('- '))
              if (lines.length) last = `${day} · ${lines[lines.length - 1].replace(/^- /, '')}`
            } catch {
              /* 单天读失败就当没有 */
            }
          }
          return `${id}${last ? ` — 最后一条：${last}` : ' — 最近没有记录'}`
        })
        return { ok: true, text: `有记录的群：\n${groups.join('\n')}`, groups }
      }

      const name = `群_${gid}`
      if (!dirs.includes(name)) {
        return { ok: false, text: `没有群 ${gid} 的记录（没说过话，或群号不对）。有记录的是：${dirs.map((n) => n.slice(2)).join('、') || '（无）'}`, groups: [] }
      }

      const msgs = []
      for (const day of dayList) {
        const f = join(root, name, '聊天记录', `${day}.md`)
        if (!existsSync(f)) continue
        try {
          const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('- '))
          for (const line of lines) msgs.push(`${day} ${line.replace(/^- /, '')}`)
        } catch (err) {
          logger.warn?.(`qq_group_history 读 ${f} 失败: ${err?.message ?? err}`)
        }
      }
      if (!msgs.length) return { ok: true, text: `群 ${gid} 最近 ${span} 天没有记录。`, groups: [] }
      const tail = msgs.slice(-wantLimit)
      return { ok: true, text: `群 ${gid} 最近 ${tail.length} 条：\n${tail.join('\n')}`, groups: [] }
    },
  })

  logger.info?.(
    `QQ 互动工具已注册：qq_facts / qq_pin / qq_poke / qq_react / qq_like / qq_send_image / qq_send_file / qq_face / qq_mface / qq_faces / qq_reply / qq_send / qq_recall / qq_group_history（表情包收藏 ${facesCount(config)} 个）`,
  )
}
