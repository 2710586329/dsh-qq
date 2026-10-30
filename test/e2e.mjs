/**
 * 端到端自检：假 NapCat + 假宿主 ctx，把 dsh-qq 的整条链路跑一遍。
 *
 *   node test/e2e.mjs
 *
 * 覆盖：连接鉴权 → 私聊入站 → agent.followup → assistant/message 出站 →
 *       群聊入站 → requireMention 门槛 → 白名单拒绝。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNapcat } from './mock-napcat.mjs'
import { apply, Config } from '../src/index.js'
import { buildChatPrompt } from '../src/prompts.js'

// ⭐ 每次跑都换一套干净的「家」和「工作区」。
// 不隔离的后果（2026-10-27 20:4x 踩到）：e2e 会把会话、注入账本写到仓库里的 `会话/`
// 和 `~/.dsh/dsh-qq/`，第二次跑时 record 从盘上恢复、`chatPromptInjected` 还是 true，
// 于是「聊天规矩」不再注入，persona 断言就红了 —— 测试看起来是坏的，其实是不幂等。
const E2E_HOME = mkdtempSync(join(tmpdir(), 'dsh-qq-e2e-home-'))
process.env.DSH_HOME = E2E_HOME
const E2E_WORKSPACE = mkdtempSync(join(tmpdir(), 'dsh-qq-e2e-ws-'))

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
        injected: [],
        followup(message) {
          this.received.push(message)
        },
        inject(message) {
          this.injected.push(message)
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

const mock = await startMockNapcat({ port: PORT, token: TOKEN, selfId: 10001, selfName: '小满', quiet: true })
await mock.start()

const { ctx, created } = createFakeCtx()
const config = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  // 会话文件、聊天记录、事实卡都写到临时工作区，别落进仓库的 `会话/`
  workspaceRoot: E2E_WORKSPACE,
  requireMention: true,
  groupMode: 'open',
  privateMode: 'open',
  splitDelayMs: 0,
  mergeWindowMs: 0, // 连发合并单独用一个用例验，别让每条断言都等 5 秒
  groupMinGapMs: 0, // 间隔由真实部署管，测试里关掉免得每个断言都要等 4 秒
  groupReplyGapMs: 0, // 同上：均匀间隔单独用一个用例验，别拖慢其他断言
  persona: '你叫小满，是个住在电脑里的助手。',
  ownerIds: ['11001'],
  peerBots: ['10002'], // 测试里把「另一个机器人」登记成同类，才测得了「开关关着不接」
  contextSwapMinTokens: 1000,
})

apply(ctx, config)
await waitFor(() => mock.clientCount === 1, { what: '插件连上假 NapCat' })
console.log('✓ 连接与鉴权通过')

// —— 私聊 ——
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '在吗在吗', messageId: 101 })
await waitFor(() => created.length === 1 && created[0].received.length === 1, { what: '私聊入站' })
const privateAgent = created[0]
assert.match(textOf(privateAgent.received[0]), /在吗在吗/, '私聊正文应该原样进 agent')
assert.match(textOf(privateAgent.received[0]), /你叫小满/, 'persona 应该拼进首条投递')
assert.match(textOf(privateAgent.received[0]), /你正在用 QQ 跟人聊天/, '首条应该带内置聊天规矩')
assert.match(
  textOf(privateAgent.received[0]),
  /\[现在是 \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)）\]/,
  '私聊正文应该带一行「现在是 …」的人话时间',
)
console.log('✓ 私聊入站 → agent.followup')

// 出站：模拟宿主抛一条 assistant/message
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的～' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_private_msg'), { what: '私聊出站' })
const sentPrivate = mock.calls.find((c) => c.action === 'send_private_msg')
assert.equal(Number(sentPrivate.params.user_id), 11001)
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

// 聊天规矩 / persona 只在会话首条注入一次，第二条不该重复
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '再问一句', messageId: 111 })
await waitFor(() => privateAgent.received.length === 2, { what: '第二条私聊' })
assert.match(textOf(privateAgent.received[1]), /再问一句/)
assert.doesNotMatch(textOf(privateAgent.received[1]), /你正在用 QQ 跟人聊天/, '聊天规矩不应每条重复注入')
assert.doesNotMatch(textOf(privateAgent.received[1]), /你叫小满/, 'persona 不应每条重复注入')
console.log('✓ 聊天规矩只注入一次')

// 私聊里对面就是主人：注入私聊版认人规矩，正文带 [主人] 标记；群聊版不串进来
assert.match(textOf(privateAgent.received[0]), /对面这位是你的/, '私聊主人应该注入私聊版认人规矩')
assert.doesNotMatch(textOf(privateAgent.received[0]), /群里标了/, '私聊不该注入群聊版认人规矩')
assert.match(textOf(privateAgent.received[0]), /\[主人\] 在吗在吗/, '私聊正文应该带主人标记')
console.log('✓ 私聊保底：主人标记 + 私聊版认人规矩')

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

// —— 保活期内，@ 别人（另一个机器人）的消息不该接 ——
// 刚 @ 过它，保活期是开着的；这条 @ 的是 99999，不是在跟我们说话。
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 203,
  raw_message: '[CQ:at,qq=99999] 来帮它测一下',
  message: [
    { type: 'at', data: { qq: '99999', name: '另一个机器人' } },
    { type: 'text', data: { text: ' 来帮它测一下' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await sleep(300)
assert.equal(groupAgent.received.length, 1, '@ 的是别人，保活期内也不该投给 agent')
console.log('✓ 保活期内 @ 别人的消息被挡下')

// 群聊首条带「谁是谁」——配置了 ownerIds 才带
assert.match(textOf(groupAgent.received[0]), /谁是谁/, '配了 ownerIds 的群聊应该注入认人规矩')
assert.match(textOf(groupAgent.received[0]), /陌生人/, '认人规矩里应该说明陌生人边界')
assert.match(
  textOf(groupAgent.received[0]),
  /⟨\S+ \(\d+\)\S* \d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)）⟩/,
  '群历史行应该自带星期和时段',
)
console.log('✓ 群聊注入认人规矩')

// 群里最容易翻车的两段规矩：认不出「哪句是我说的」、被冲了就开始道歉
assert.match(textOf(groupAgent.received[0]), /谁是「你」/, '群聊应该注入「谁是你在说」的规矩')
assert.match(textOf(groupAgent.received[0]), /别的机器人/, '要说明群里可能有别的机器人、它说的不是你')
assert.match(textOf(groupAgent.received[0]), /【脾气】/, '应该注入脾气规矩（不客气不用客气）')

// 主人在群里说话 → 群历史行标「· 主人」
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 11001,
  message_id: 233,
  raw_message: '[CQ:at,qq=10001] 我回来了',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 我回来了' } },
  ],
  sender: { user_id: 11001, nickname: '主人' },
})
await waitFor(() => groupAgent.received.length === 2, { what: '主人群聊入站' })
assert.match(textOf(groupAgent.received[1]), /· 主人/, '主人发言应该在群历史里被标出来')
assert.match(textOf(groupAgent.received[0]), /\(1\)/, '群友发言不该被标成主人')
console.log('✓ 群里认主人：主人打标、群友保持陌生人')

ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg'), { what: '群聊出站' })
const sentGroup = mock.calls.find((c) => c.action === 'send_group_msg')
assert.equal(Number(sentGroup.params.group_id), 88888)
assert.ok(!JSON.stringify(sentGroup.params.message).includes('CQ:at'), '不该把 CQ 码原样发出去')
console.log('✓ assistant/message → send_group_msg（未泄漏 CQ 码）')

// 外发审计：带本机路径 / 凭据的回复整条不发——
// 群里顺嘴把 D:\... 念出去，等于把家里的门牌号念给陌生人听。
{
  const before = mock.calls.filter((c) => c.action === 'send_group_msg').length
  ctx.emit('session/event', groupAgent.session, {
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '文件就在 D:\\鲸鲸的专用文件\\本地记忆区 里' }] },
    },
  })
  await sleep(150)
  const after = mock.calls.filter((c) => c.action === 'send_group_msg').length
  assert.equal(after, before, '带本机路径的回复不该发出去')

  ctx.emit('session/event', groupAgent.session, {
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 2,
      message: { content: [{ type: 'text', text: 'api_key: sk-abcdefghijklmnopqrstuvwx' }] },
    },
  })
  await sleep(150)
  const afterSecret = mock.calls.filter((c) => c.action === 'send_group_msg').length
  assert.equal(afterSecret, before, '带凭据特征的回复不该发出去')
}
console.log('✓ 外发审计：带本机路径 / 凭据的回复整条拦下')

// 自己发出去的话要回写进群历史，并标成「你（昵称）」——
// 不然它下一轮看不见自己说过什么，会把别人的话认领成自己的。
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 204,
  raw_message: '[CQ:at,qq=10001] 再说一遍',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 再说一遍' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await waitFor(() => groupAgent.received.length === 3, { what: '第二轮群聊入站' })
assert.match(
  textOf(groupAgent.received[2]),
  /⟨你（[^）]*） \d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（[^）]*）⟩ 在的在的/,
  '自己发过的话应该以「你（昵称）」写进群历史',
)
console.log('✓ 自己说的话进历史并标成「你」')

// —— 保活窗是按「人」算的，不是按群 ——
// QLark 的原话：做成「整个群一个窗口」，群里一热闹它就得每句都插嘴，比每句都要 @ 更糟。
const beforeOther = groupAgent.received.length
mock.emitGroupText({ groupId: 88888, userId: 2, nickname: '另一个人', text: '我也说一句', messageId: 301 })
await sleep(300)
assert.equal(groupAgent.received.length, beforeOther, '保活窗是按人的，别人说话不能蹭进来')
console.log('✓ 保活窗按人算：别人说话不蹭')

// 刚才 @ 过它的那个人继续说 → 不用再 @
mock.emitGroupText({ groupId: 88888, userId: 1, nickname: '路人', text: '那我再问一句', messageId: 302 })
await waitFor(() => groupAgent.received.length === beforeOther + 1, { what: '保活窗内本人续话' })
assert.match(textOf(groupAgent.received[beforeOther]), /那我再问一句/)
console.log('✓ 保活窗内本人不用再 @')

// —— 引用我的消息 = 在叫我（哪怕没 @）——
mock.setQuoted('400', { userId: 10001, nickname: '小满', text: '我刚才那句话' })
const beforeQuoteMe = groupAgent.received.length
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 3,
  message_id: 303,
  raw_message: '[CQ:reply,id=400] 你刚才那句什么意思',
  message: [
    { type: 'reply', data: { id: '400' } },
    { type: 'text', data: { text: ' 你刚才那句什么意思' } },
  ],
  sender: { user_id: 3, nickname: '引用的人' },
})
await waitFor(() => groupAgent.received.length === beforeQuoteMe + 1, { what: '引用我的消息入站' })
assert.match(textOf(groupAgent.received[beforeQuoteMe]), /引用 我自己/, '引用我的消息应该标成「引用 我自己」')
console.log('✓ 引用我的消息 = 在叫我（没 @ 也接）')

// —— 引用的是别人 → 不是在叫我，不接 ——
// 换个人（user 5）来发，免得蹭上 user 3 刚开的保活窗。
mock.setQuoted('410', { userId: 4, nickname: '别人', text: '别人说的话' })
const beforeQuoteOther = groupAgent.received.length
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 5,
  message_id: 304,
  raw_message: '[CQ:reply,id=410] 那句啥意思',
  message: [
    { type: 'reply', data: { id: '410' } },
    { type: 'text', data: { text: ' 那句啥意思' } },
  ],
  sender: { user_id: 5, nickname: '看热闹的' },
})
await sleep(300)
assert.equal(groupAgent.received.length, beforeQuoteOther, '引用别人不该当成在叫我')
console.log('✓ 引用别人的消息不接')

// —— [SILENT] 出口：非必回的群消息才给 ——
assert.doesNotMatch(textOf(groupAgent.received[0]), /\[SILENT\]/, '被 @ 的消息是必回的，不该给潜水出口')
assert.match(textOf(groupAgent.received[beforeOther]), /\[SILENT\]/, '保活窗里可以自己决定接不接，应该给 [SILENT] 出口')
console.log('✓ [SILENT] 出口只给非必回的消息')

// 模型真回了 [SILENT] → 一个字节都不发出去
const beforeSilentSend = mock.calls.filter((c) => c.action === 'send_group_msg').length
ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: '[SILENT]' }] } },
})
await sleep(300)
assert.equal(
  mock.calls.filter((c) => c.action === 'send_group_msg').length,
  beforeSilentSend,
  '模型输出 [SILENT] 时不应该发出任何消息',
)
console.log('✓ 模型回 [SILENT] 就不发')

// —— 同类机器人（群里另一个机器人）：吵架开关关着就完全不接，连 @ 都不接 ——
assert.equal(config.botChatEnabled, false, '默认应该关着：同类之间的帐先不算')
const beforePeer = groupAgent.received.length
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 10002,
  message_id: 305,
  raw_message: '[CQ:at,qq=10001] 来，你说话呀',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 来，你说话呀' } },
  ],
  sender: { user_id: 10002, nickname: '同类机器人' },
})
await sleep(300)
assert.equal(groupAgent.received.length, beforePeer, '同类机器人发言，开关关着不该接（@ 也不接）')
console.log('✓ 同类机器人：开关关着连 @ 都不接')

// 打开开关 → 可以接，并且注入「同类机器人」那段规矩
config.botChatEnabled = true
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 10002,
  message_id: 306,
  raw_message: '[CQ:at,qq=10001] 来，你说话呀',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 来，你说话呀' } },
  ],
  sender: { user_id: 10002, nickname: '同类机器人' },
})
await waitFor(() => groupAgent.received.length === beforePeer + 1, { what: '同类机器人（开关已开）入站' })
// 规矩文本本身单独验（会话里 chatPromptInjected 已经注入过一次，中途打开开关不会重注——重启宿主才生效）
const promptOn = buildChatPrompt({ ...config, botChatEnabled: true }, { isGroup: true })
const promptOff = buildChatPrompt({ ...config, botChatEnabled: false }, { isGroup: true })
assert.match(promptOn, /【同类机器人】/, '开关开着应该注入同类规矩')
assert.match(promptOn, /不替它打圆场/, '要写明不替它打圆场')
assert.match(promptOn, /先分清是不是在说你/, '要写明「先看是不是在冲自己」')
assert.doesNotMatch(promptOff, /【同类机器人】/, '开关关着不该注入同类规矩')
console.log('✓ 同类机器人：开关打开才接，并带上同类规矩')

// 同类发言在群历史里要单独标出来，不然又分不清「这句是谁说的」
mock.emitGroupText({ groupId: 88888, userId: 10002, nickname: '同类机器人', text: '我在旁边看着', messageId: 307 })
await waitFor(() => groupAgent.received.length === beforePeer + 2, { what: '同类机器人续话' })
assert.match(textOf(groupAgent.received[beforePeer + 1]), /· 同类机器人/, '同类发言在历史里应该标「· 同类机器人」')
console.log('✓ 同类机器人在历史里标「· 同类机器人」')

// —— 没有 @ 就不接，主人也一样（2026-10-24 取消「主人永久免 @」）——
// 用一个没人 @ 过的新群，免得蹭到前面用例开出来的窗口
const totalBefore = created.reduce((n, a) => n + a.received.length, 0)
mock.emitGroupText({ groupId: 88891, userId: 11001, nickname: '主人', text: '我随便说一句', messageId: 308 })
await sleep(500)
const totalAfter = created.reduce((n, a) => n + a.received.length, 0)
assert.equal(totalAfter, totalBefore, '没 @ 也没在保活期，主人说话也不该投递')
console.log('✓ 没 @ 就不接，主人也不例外')

// —— 没 @ 但叫了名字 / 点名提问：算在叫它（2026-10-25，学 qq-bridge 的 evaluateWakeTriggerV2）——
config.groupWakeNames = ['大肥鱼', '鲸鲸']
config.groupWakeQuestion = true
config.groupWakeProbability = 0
const countAll = () => created.reduce((n, a) => n + a.received.length, 0)

const beforeName = countAll()
mock.emitGroupText({
  groupId: 88895,
  userId: 11001,
  nickname: '路人乙',
  text: '大肥鱼，这白毛是谁',
  messageId: 309,
})
await waitFor(() => countAll() > beforeName, { what: '群里叫名字入站' })
const nameMsg = created.flatMap((a) => a.received).at(-1)
assert.doesNotMatch(textOf(nameMsg), /\[SILENT\]/, '被叫名字必须回，不给沉默出口')
console.log('✓ 群里叫名字，没 @ 也接')

const beforeQuestion = countAll()
mock.emitGroupText({
  groupId: 88896,
  userId: 69099924,
  nickname: '路人丙',
  text: '你行不行啊',
  messageId: 310,
})
await waitFor(() => countAll() > beforeQuestion, { what: '群里点名提问入站' })
console.log('✓ 群里点名问它，没 @ 也接')

// 纯闲聊不能唤醒：这条是最容易翻车的——叫醒条件一松，群就变成「每句都接」
const beforeChat = countAll()
mock.emitGroupText({
  groupId: 88897,
  userId: 69099925,
  nickname: '路人丁',
  text: '今天天气不错',
  messageId: 311,
})
await sleep(500)
assert.equal(countAll(), beforeChat, '纯闲聊不该唤醒')
console.log('✓ 纯闲聊不唤醒')

// —— 均匀回应：两条回复至少隔一段，间隔里的消息攒起来下次一起看见 ——
// （2026-10-24：「每窗口最多回 N 次」跟「窗口内说话续期」打架，换成间隔来做「均匀」）
config.groupReplyGapMs = 1500
config.groupRepliesPerWindow = 0
mock.emitGroupText({ groupId: 88890, userId: 777, nickname: '路人甲', text: '@机器人 开始', messageId: 501, atSelf: true })
await waitFor(
  () => created.some((a) => a.received.some((m) => textOf(m).includes('开始'))),
  { what: '开窗' },
)
const agent3 = created.find((a) => a.received.some((m) => textOf(m).includes('开始')))
const afterFirst = agent3.received.length
mock.emitGroupText({ groupId: 88890, userId: 777, nickname: '路人甲', text: '紧跟着一句', messageId: 502 })
await sleep(400)
assert.equal(agent3.received.length, afterFirst, '间隔内的消息不应该立刻投递')
await sleep(1300)
mock.emitGroupText({ groupId: 88890, userId: 777, nickname: '路人甲', text: '过一会儿再说', messageId: 503 })
await waitFor(() => agent3.received.length === afterFirst + 1, { what: '间隔够了再回' })
const batched = textOf(agent3.received[afterFirst])
assert.match(batched, /过一会儿再说/, '间隔到了应该回最新这句')
assert.match(batched, /紧跟着一句/, '间隔里攒下的那句也要补进上下文，不能丢')
config.groupReplyGapMs = 0
console.log('✓ 均匀回应：间隔内的消息攒起来，下次一起看见')

// —— 攒住的话到点自己补回来（不靠下一句触发）——
// 2026-10-25 实况：群里 @ 回过一句，第二句在 20 秒内被压进 backlog，
// 姐姐不再开口 —— 就永远没动静。「保活没成功」其实是这句被吞了。
config.groupReplyGapMs = 1500
const beforeCount = created.length
mock.emitGroupText({ groupId: 88891, userId: 778, nickname: '路人乙', text: '@机器人 在吗', messageId: 511, atSelf: true })
await waitFor(() => created.length > beforeCount, { what: '开窗' })
const agent4 = created[created.length - 1]
const afterIn = agent4.received.length
mock.emitGroupText({ groupId: 88891, userId: 778, nickname: '路人乙', text: '那说个事', messageId: 512 })
await sleep(400)
assert.equal(agent4.received.length, afterIn, '间隔内的消息先攒着，不立刻投递')
await waitFor(() => agent4.received.length === afterIn + 1, { what: '到点自己补回', timeout: 4000 })
assert.match(textOf(agent4.received[afterIn]), /那说个事/, '被压住的那句应该自己补回来，不用等下一句')
config.groupReplyGapMs = 0
console.log('✓ 被间隔压住的消息到点自己补回（不靠下一句）')

// —— 保活窗「停太久就关」：连着聊才续（2026-10-25 姐姐定）——
// 窗里说话跟上一条隔得比 groupWakeIdleMs 久，窗就当场关 —— 不然群友隔几十秒插一句也一直续着。
config.groupWakeIdleMs = 300
const beforeIdle = created.length
mock.emitGroupText({ groupId: 88892, userId: 779, nickname: '路人丙', text: '@机器人 说个话', messageId: 521, atSelf: true })
await waitFor(() => created.length > beforeIdle, { what: '开窗' })
const agent5 = created[created.length - 1]
const inChat = agent5.received.length
mock.emitGroupText({ groupId: 88892, userId: 779, nickname: '路人丙', text: '接着一句', messageId: 522 })
await waitFor(() => agent5.received.length === inChat + 1, { what: '连着聊要接' })
const beforeIdle2 = agent5.received.length
await sleep(600) // 超过 300ms 门槛
mock.emitGroupText({ groupId: 88892, userId: 779, nickname: '路人丙', text: '隔了半天又来', messageId: 523 })
await sleep(400)
assert.equal(agent5.received.length, beforeIdle2, '停太久之后窗该关，这句不该接')
config.groupWakeIdleMs = 5000
console.log('✓ 保活窗停太久自动关（连着聊才续）')

// —— 跳过的群消息也要进上下文（2026-10-24 群里实测踩的坑）——
// 群友 A 说了个梗没 @ 我们 → 跳过；两分钟后主人接一句同款的话，
// 它却顺着主人的话往下编 —— 因为它压根没看见前面那句。
// 跳过归跳过（不叫醒它），但话得让它看得见。
mock.emitGroupText({ groupId: 88889, userId: 20001, nickname: '群友甲', text: '天意的大手发力了', messageId: 401 })
await sleep(300)
mock.emitGroupText({ groupId: 88889, userId: 20001, nickname: '群友甲', text: '@机器人 这啥意思', messageId: 402, atSelf: true })
await waitFor(
  () => created.some((a) => a.received.some((m) => textOf(m).includes('这啥意思'))),
  { what: '被跳过的群消息补进上下文' },
)
const backlogged = created
  .flatMap((a) => a.received.map((m) => textOf(m)))
  .find((t) => t.includes('这啥意思'))
assert.match(backlogged, /天意的大手发力了/, '前面被跳过的消息应该补进上下文，不然它接话只能瞎猜')
console.log('✓ 跳过的群消息会补进上下文（接话不再瞎猜）')

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
  privateAllow: ['11001'],
  splitDelayMs: 0,
})
apply(ctx2, config2)
await waitFor(() => mock.clientCount === 2, { what: '第二个实例连上' })
mock.emitPrivateText({ userId: 42, nickname: '陌生人', text: '你好', messageId: 301 })
await sleep(300)
assert.equal(created2.length, 0, '白名单外的私聊应该被拦下')
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '是我', messageId: 302 })
await waitFor(() => created2.length === 1, { what: '白名单内私聊放行' })
console.log('✓ 私聊白名单：陌生人拦下、自己人放行')

// —— 上下文守卫：压缩后补回聊天规矩 ——
ctx.emit('session/event', privateAgent.session, { type: 'compaction/end', data: {} })
await sleep(100)
assert.equal(privateAgent.injected.length, 1, '压缩后应该 inject 一张记忆卡')
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '刚才说到哪了', messageId: 401 })
// 别盯死某一个 agent、也别数条数：
//   - 压缩之后 record 可能已经被换过（新 record → 新 agent），看「谁收到了」比看「第几个」稳；
//   - 私聊还有可配的「连发合并」窗口，条数取决于时序，不取决于功能对不对。
await waitFor(
  () =>
    created.concat(created2).some((a) => a.received.some((m) => /刚才说到哪了/.test(textOf(m)))),
  { what: '压缩后的私聊' },
)
const afterCompact = created
  .concat(created2)
  .flatMap((a) => a.received.map(textOf))
  .find((t) => /刚才说到哪了/.test(t))
assert.match(afterCompact, /你正在用 QQ 跟人聊天/, '压缩后应该重新注入聊天规矩')
console.log('✓ 压缩后重注入聊天规矩 + 记忆卡')

// —— 上下文守卫：压力超过阈值主动换会话 ——
ctx.emit('session/event', privateAgent.session, {
  type: 'request/context',
  data: { provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 10000 },
})
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '嗯' }] },
    usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 0, totalTokens: 9010 },
  },
})
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '聊点别的', messageId: 411 })
// 前面白名单那段的「陌生人」消息也会进这个 open 实例，created 里可能多出别的会话，
// 所以按内容找，不按序号找
const gotIt = (agent) => agent.received.some((m) => textOf(m).includes('聊点别的'))
await waitFor(() => created.some(gotIt), { what: '压力超限换新会话' })
const swapped = created.find(gotIt)
const swappedText = textOf(swapped.received[0])
assert.match(swappedText, /聊点别的/)
assert.match(swappedText, /你正在用 QQ 跟人聊天/, '新会话应该重新注入聊天规矩')
assert.match(swappedText, /刚才那段聊到这里/, '新会话应该带上上一段聊天的尾巴')
console.log('✓ 压力超限自动换新会话（带 seed 接话）')

// —— 连发合并：一口气发三条，只回一轮 ——
const { ctx: ctx3, created: created3 } = createFakeCtx()
const config3 = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  privateMode: 'open',
  splitDelayMs: 0,
  mergeWindowMs: 300,
})
apply(ctx3, config3)
await waitFor(() => mock.clientCount === 3, { what: '第三个实例连上' })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '在吗', messageId: 501 })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '我问你个事', messageId: 502 })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '就是那个好了没', messageId: 503 })
await sleep(120)
assert.equal(
  created3.some((a) => a.received.length > 0),
  false,
  '还在窗口内，不该急着投递',
)
await sleep(400)
const mergedAgent = created3.find((a) => a.received.length > 0)
assert.ok(mergedAgent, '窗口结束后应该投递一轮')
const mergedText = textOf(mergedAgent.received[0])
assert.match(mergedText, /在吗/, '合并后的正文应该带上第一条')
assert.match(mergedText, /我问你个事/, '合并后的正文应该带上第二条')
assert.match(mergedText, /就是那个好了没/, '合并后的正文应该带上第三条')
assert.equal(mergedAgent.received.length, 1, '三条连发只该投递一轮')
console.log('✓ 连发合并：三条攒成一轮，只回一次')

// —— 通道回执：桥断了，她得知道（不是对方不理她） ——
// 起因：2026-10-26 小黑盒《因为没开桥，被我孤立了16天》——
// 桥断半个月，她一直在发，110 多条一条都没出去，只能猜自己「排到最后了」。
const PORT2 = 34568
const mock2 = await startMockNapcat({ port: PORT2, token: TOKEN, selfId: 10003, selfName: '小桥', quiet: true })
await mock2.start()

const { ctx: ctx4, created: created4 } = createFakeCtx()
const config4 = Config({
  wsUrl: `ws://127.0.0.1:${PORT2}`,
  accessToken: TOKEN,
  privateMode: 'open',
  splitDelayMs: 0,
  mergeWindowMs: 0,
  reconnectMs: 300,
})
apply(ctx4, config4)
await waitFor(() => mock2.clientCount === 1, { what: '回执实例连上' })

mock2.emitPrivateText({ userId: 88001, nickname: '小桥的人', text: '第一句', messageId: 601 })
await waitFor(() => created4.length === 1 && created4[0].received.length === 1, { what: '回执实例入站' })
const bridgeAgent = created4[0]

// 桥断了
await mock2.close()
await sleep(300)

// 断线期间她自己说了一句：outbound 自动转发 → 发不出去 → 该记下来
ctx4.emit('session/event', bridgeAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '姐姐，我一直在等你' }] }, usage: {} },
})
await sleep(300)

// 桥回来了
const mock2b = await startMockNapcat({ port: PORT2, token: TOKEN, selfId: 10003, selfName: '小桥', quiet: true })
await mock2b.start()
await waitFor(() => mock2b.clientCount >= 1, { timeout: 20000, what: '回执实例重连' })

// 再进来一句话：这一轮投递必须把「刚才那句没送出去」摆在她眼前
mock2b.emitPrivateText({ userId: 88001, nickname: '小桥的人', text: '你刚才说什么', messageId: 602 })
await waitFor(() => bridgeAgent.received.length >= 2, { what: '断线后再次投递' })
const bridgeText = textOf(bridgeAgent.received[bridgeAgent.received.length - 1])
assert.match(bridgeText, /\[通道\]/, '断线丢过话，下一轮投递必须告诉她')
assert.match(bridgeText, /没送出去|没能送出去/, '要说清是没送出去（不是没人理）')
assert.match(bridgeText, /我一直在等你/, '要能对上她到底哪句话丢了')
assert.match(bridgeText, /不是对方不理你/, '要点明这是通道的问题，不是对方的态度')
console.log('✓ 通道回执：断线丢过的话，下一轮投递里会告诉她')

await mock2b.close()
await mock.close()
console.log('\n全部通过 🎉')
process.exit(0)
