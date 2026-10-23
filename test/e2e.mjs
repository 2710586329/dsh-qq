/**
 * 端到端自检：假 NapCat + 假宿主 ctx，把 dsh-qq 的整条链路跑一遍。
 *
 *   node test/e2e.mjs
 *
 * 覆盖：连接鉴权 → 私聊入站 → agent.followup → assistant/message 出站 →
 *       群聊入站 → requireMention 门槛 → 白名单拒绝。
 */
import assert from 'node:assert/strict'
import { startMockNapcat } from './mock-napcat.mjs'
import { apply, Config } from '../src/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 5000, interval = 50, what = '条件' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await fn()) return
    await sleep(interval)
  }
  throw new Error(`等待超时：${what}`)
}

/** 一个最小的假宿主：提供 agents 服务和事件总线。 */
function createFakeCtx() {
  const handlers = new Map()
  const created = []
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('没有历史会话')
    },
    create: async ({ sessionId }) => {
      const agent = {
        session: { id: sessionId, header: { id: sessionId } },
        received: [],
        followup(message) {
          this.received.push(message)
        },
        async whenIdle() {},
      }
      created.push(agent)
      return { agent, dispose: async () => {} }
    },
  }
  const ctx = {
    agents,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
      return () => handlers.get(name)?.delete(fn)
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args)
    },
  }
  return { ctx, created }
}

function textOf(message) {
  const parts = message?.content ?? []
  return parts.map((p) => (p?.type === 'text' ? p.text : '')).join('')
}

const PORT = 34567
const TOKEN = 'test-token-123'

const mock = await startMockNapcat({ port: PORT, token: TOKEN, selfId: 10001, selfName: '助手', quiet: true })
await mock.start()

const { ctx, created } = createFakeCtx()
const config = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  requireMention: true,
  groupMode: 'open',
  privateMode: 'open',
  splitDelayMs: 0,
})

apply(ctx, config)
await waitFor(() => mock.clientCount === 1, { what: '插件连上假 NapCat' })
console.log('✓ 连接与鉴权通过')

// —— 私聊 ——
mock.emitPrivateText({ userId: 69099923, nickname: '主人', text: '在吗在吗', messageId: 101 })
await waitFor(() => created.length === 1 && created[0].received.length === 1, { what: '私聊入站' })
const privateAgent = created[0]
assert.match(textOf(privateAgent.received[0]), /在吗在吗/, '私聊正文应该原样进 agent')
console.log('✓ 私聊入站 → agent.followup')

// 出站：模拟宿主抛一条 assistant/message
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的～' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_private_msg'), { what: '私聊出站' })
const sentPrivate = mock.calls.find((c) => c.action === 'send_private_msg')
assert.equal(Number(sentPrivate.params.user_id), 69099923)
assert.match(JSON.stringify(sentPrivate.params.message), /在的在的/)
console.log('✓ assistant/message → send_private_msg')

// 重复推同一条不应重复发
const before = mock.calls.filter((c) => c.action === 'send_private_msg').length
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '在的在的～' }] } },
})
await sleep(200)
assert.equal(
  mock.calls.filter((c) => c.action === 'send_private_msg').length,
  before,
  '同一条文本不应重复发送',
)
console.log('✓ 重复消息去重')

// —— 群聊：没 @ 不该触发 ——
mock.emitGroupText({ groupId: 88888, userId: 1, nickname: '路人', text: '今天吃什么', messageId: 201 })
await sleep(300)
assert.equal(created.length, 1, '没 @ 的群消息不应该创建会话')
console.log('✓ requireMention 挡住了没 @ 的群消息')

// —— 群聊：@ 了应该触发 ——
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 202,
  raw_message: '[CQ:at,qq=10001] 在不在',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 在不在' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await waitFor(() => created.length === 2 && created[1].received.length === 1, { what: '群聊入站' })
console.log('✓ @ 之后群聊入站')

const groupAgent = created[1]
ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg'), { what: '群聊出站' })
const sentGroup = mock.calls.find((c) => c.action === 'send_group_msg')
assert.equal(Number(sentGroup.params.group_id), 88888)
assert.ok(!JSON.stringify(sentGroup.params.message).includes('CQ:at'), '不该把 CQ 码原样发出去')
console.log('✓ assistant/message → send_group_msg（未泄漏 CQ 码）')

// —— 长文本切块 ——
const longText = '这是一段用来测试切块的长文字。'.repeat(80)
ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 9, message: { content: [{ type: 'text', text: longText }] } },
})
await sleep(400)
const groupSends = mock.calls.filter((c) => c.action === 'send_group_msg').length
assert.ok(groupSends >= 2, `长文本应该被切成多条发出去，实际 ${groupSends} 条`)
console.log(`✓ 长文本自动切块（${groupSends} 条）`)

// —— 白名单模式拦人 ——
const { ctx: ctx2, created: created2 } = createFakeCtx()
const config2 = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  privateMode: 'allowlist',
  privateAllow: ['69099923'],
  splitDelayMs: 0,
})
apply(ctx2, config2)
await waitFor(() => mock.clientCount === 2, { what: '第二个实例连上' })
mock.emitPrivateText({ userId: 42, nickname: '陌生人', text: '你好', messageId: 301 })
await sleep(300)
assert.equal(created2.length, 0, '白名单外的私聊应该被拦下')
mock.emitPrivateText({ userId: 69099923, nickname: '主人', text: '是我', messageId: 302 })
await waitFor(() => created2.length === 1, { what: '白名单内私聊放行' })
console.log('✓ 私聊白名单：陌生人拦下、主人放行')

await mock.close()
console.log('\n全部通过 🎉')
process.exit(0)
