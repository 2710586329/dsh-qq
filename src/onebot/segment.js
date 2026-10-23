/**
 * OneBot 11 消息段的解析与组装。
 *
 * NapCat 默认 `messagePostFormat: 'array'`，但我们两种都兜住：
 * 万一用户配成了字符串格式（带 CQ 码），也要能读。
 */

const CQ_RE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g
const CQ_UNESCAPE = [
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#44;', ','],
  ['&amp;', '&'],
]

function unescapeCQ(value) {
  let out = value
  for (const [from, to] of CQ_UNESCAPE) out = out.split(from).join(to)
  return out
}

/** 把 CQ 码字符串解析成消息段数组。 */
export function parseCQString(source) {
  const text = String(source ?? '')
  const segments = []
  let cursor = 0
  for (const match of text.matchAll(CQ_RE)) {
    if (match.index > cursor) {
      segments.push({ type: 'text', data: { text: text.slice(cursor, match.index) } })
    }
    const data = {}
    for (const pair of (match[2] || '').replace(/^,/, '').split(',')) {
      if (!pair) continue
      const at = pair.indexOf('=')
      if (at < 0) continue
      data[pair.slice(0, at)] = unescapeCQ(pair.slice(at + 1))
    }
    segments.push({ type: match[1], data })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: text.slice(cursor) } })
  return segments
}

/** 统一成消息段数组，无论上游给的是数组还是 CQ 码字符串。 */
export function toSegments(message) {
  if (Array.isArray(message)) return message
  if (typeof message === 'string') {
    // 不是 CQ 码的裸字符串，直接当文本
    if (!message.includes('[CQ:')) return [{ type: 'text', data: { text: message } }]
    return parseCQString(message)
  }
  if (message && typeof message === 'object' && Array.isArray(message.data)) return message.data
  return []
}

/**
 * 把入站消息读成「给人看的一句话 + 结构信息」。
 *
 * @param {unknown} message   OneBot 原始 message 字段
 * @param {{selfId: string, selfName?: string}} options
 */
export function readMessage(message, { selfId, selfName = '' } = {}) {
  const segments = toSegments(message)
  const self = String(selfId ?? '')

  let text = ''
  const images = []
  const files = []
  const atNames = []
  let atMe = false
  let atAll = false
  let replyId = null
  let poke = false

  for (const seg of segments) {
    const type = seg?.type
    const data = seg?.data ?? {}
    switch (type) {
      case 'text':
        text += data.text ?? ''
        break
      case 'at': {
        const qq = String(data.qq ?? '')
        if (qq === 'all') {
          atAll = true
          text += '@全体成员'
        } else if (qq === self) {
          atMe = true
          text += `@${selfName || '机器人'}`
        } else {
          text += `@${data.name || qq}`
          atNames.push(qq)
        }
        break
      }
      case 'image':
        images.push(data.url || data.file || '')
        text += '[图片]'
        break
      case 'face':
        text += `[表情${data.id ?? ''}]`
        break
      case 'mface':
        text += '[表情包]'
        break
      case 'record':
        text += '[语音]'
        break
      case 'video':
        text += '[视频]'
        break
      case 'file':
        files.push({ name: data.name || '', file: data.file || '', url: data.url || '' })
        text += `[文件 ${data.name || ''}]`
        break
      case 'reply':
        replyId = data.id === undefined ? null : String(data.id)
        break
      case 'forward':
        text += '[合并转发]'
        break
      case 'json':
      case 'xml':
        text += '[卡片消息]'
        break
      case 'poke':
        poke = true
        text += '[戳一戳]'
        break
      case 'dice':
        text += '[骰子]'
        break
      case 'rps':
        text += '[猜拳]'
        break
      case 'shake':
        text += '[窗口抖动]'
        break
      case 'location':
        text += '[位置]'
        break
      case 'music':
        text += '[音乐分享]'
        break
      default:
        if (type) text += `[${type}]`
        break
    }
  }

  return {
    text: text.trim(),
    images,
    files,
    atNames,
    atMe,
    atAll,
    replyId,
    poke,
  }
}

/** 文本 → 出站消息段。只做纯文本，图片之类交给工具层。 */
export function textSegments(text) {
  const value = String(text ?? '')
  return value ? [{ type: 'text', data: { text: value } }] : []
}
