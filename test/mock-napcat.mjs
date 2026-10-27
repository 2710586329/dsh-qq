/**
 * 假 NapCat：一个只够跑通链路的 OneBot v11 WebSocket 服务端。
 *
 * 用途：在没装 NapCat、不碰真 QQ 的情况下验证 dsh-qq 的连接、鉴权、
 * 事件解析、API 调用（send_private_msg / send_group_msg / get_login_info）。
 *
 * 单独跑：
 *   node test/mock-napcat.mjs --port 3001 --token abc
 * 然后在标准输入敲一行 JSON 就当作 QQ 事件广播给所有客户端，例如：
 *   {"post_type":"message","message_type":"private","user_id":11001,"message":[{"type":"text","data":{"text":"在吗"}}],"sender":{"nickname":"朋友"}}
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

export function startMockNapcat({ port = 3001, token = '', selfId = 10001, selfName = '小满', quiet = false, quoted = {} } = {}) {
  const calls = []
  const clients = new Set()
  // message_id → { userId, nickname, text }：get_msg 要查的「被引用的原消息」。
  // 2026-10-24 加：dsh-qq 要靠引用判断「这条是不是在回我」，测试得能造出引用。
  const quoteStore = { ...quoted }
  const log = (...args) => {
    if (!quiet) console.error('[mock-napcat]', ...args)
  }

  const http = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server: http, path: '/' })

  wss.on('connection', (ws, req) => {
    const auth = req.headers.authorization ?? ''
    if (token && auth !== `Bearer ${token}`) {
      log('鉴权失败，拒绝连接:', auth)
      ws.close(1008, 'bad token')
      return
    }
    clients.add(ws)
    log('客户端已连接')

    ws.on('message', (buf) => {
      let payload
      try {
        payload = JSON.parse(buf.toString())
      } catch {
        log('收到非 JSON 报文')
        return
      }
      calls.push(payload)
      if (!quiet) log('API ←', payload.action, JSON.stringify(payload.params ?? {}).slice(0, 160))

      const data = respond(payload, { selfId, selfName, calls, quoteStore })
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data }))
    })

    ws.on('close', () => {
      clients.delete(ws)
      log('客户端断开')
    })
  })

  function respond(payload, ctx) {
    switch (payload.action) {
      case 'get_login_info':
        return { user_id: ctx.selfId, nickname: ctx.selfName }
      case 'send_private_msg':
      case 'send_group_msg':
      case 'send_msg':
        return { message_id: Math.floor(Math.random() * 1e6) }
      case 'get_msg': {
        const id = String(payload.params?.message_id ?? '')
        const q = ctx.quoteStore[id]
        if (!q) return null
        return {
          message_id: Number(id),
          sender: { user_id: q.userId, nickname: q.nickname ?? '某人' },
          message: q.message ?? [{ type: 'text', data: { text: q.text ?? '' } }],
        }
      }
      case 'set_input_status':
      case 'delete_msg':
      case 'set_msg_emoji_like':
      case 'send_like':
      case 'friend_poke':
      case 'group_poke':
        return {}
      default:
        return {}
    }
  }

  /** 广播一个 QQ 事件（就像 NapCat 收到消息后推给插件）。 */
  function emitEvent(event) {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify(event))
    }
    return clients.size
  }

  /** 只发一条私聊消息事件。 */
  function emitPrivateText({ userId, nickname = '测试用户', text, messageId = 1 }) {
    return emitEvent({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: selfId,
      user_id: userId,
      message_id: messageId,
      raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: userId, nickname },
    })
  }

  /** 只发一条群消息事件。 */
  function emitGroupText({ groupId, userId, nickname = '测试用户', text, messageId = 1, atSelf = false }) {
    const message = []
    // atSelf：先塞一个 @机器人 的段，正文照旧（用来模拟「@ 一下然后说话」）
    if (atSelf) {
      message.push({ type: 'at', data: { qq: String(selfId), name: selfName } })
    }
    message.push({ type: 'text', data: { text } })
    return emitEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: selfId,
      group_id: groupId,
      user_id: userId,
      message_id: messageId,
      raw_message: text,
      message,
      sender: { user_id: userId, nickname },
    })
  }

  return {
    calls,
    get clientCount() {
      return clients.size
    },
    /** 预置一条「被引用的原消息」，供 get_msg 查。 */
    setQuoted(id, info) {
      quoteStore[String(id)] = info
    },
    clearQuoted(id) {
      delete quoteStore[String(id)]
    },
    emitEvent,
    emitPrivateText,
    emitGroupText,
    async start() {
      await new Promise((resolve) => http.listen(port, '127.0.0.1', resolve))
      log(`监听 ws://127.0.0.1:${port}`)
      return this
    },
    async close() {
      for (const ws of clients) ws.close()
      clients.clear()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => http.close(resolve))
    },
  }
}

// 直接运行时：起服务 + 标准输入转发
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2)
  const get = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : fallback
  }
  const server = await startMockNapcat({
    port: Number(get('port', '3001')),
    token: get('token', ''),
  }).start()
  console.error('[mock-napcat] 标准输入一段 JSON 就广播一条事件；Ctrl+C 退出')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        const n = server.emitEvent(event)
        console.error(`[mock-napcat] 已广播给 ${n} 个客户端`)
      } catch (err) {
        console.error('[mock-napcat] JSON 解析失败:', err.message)
      }
    }
  })
}
