import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOutbound, extractText, reasoningTail, stripLeakedThinking } from '../src/outbound.js'

/**
 * 2026-10-26 17:15:24 和 17:16:06，QQ 上一条回复都没有，但 turn 正常结束。
 * 原因：那两条 assistant/message 里只有 reasoning 块，没有 text 块，
 * extractText() 拿到空串就 return 了。这里的用例就是照那两条的真实内容写的。
 */

const REAL_REASONING_1716 = [
  { type: 'reasoning', text: 'Short agreement, add something specific.' },
  {
    type: 'reasoning',
    text: '"理是这个理，就是得练" — honest: 本姑娘还得练一阵，有时候不接心里会痒.',
  },
  { type: 'reasoning', text: '2 lines.理是这么个理' },
  { type: 'reasoning', text: '就是本姑娘还得练一阵，真安静着不说话，心里会有点痒' },
]

function makeHarness({ sent = [] } = {}) {
  const manager = { find: (id) => (id === 's1' ? { scope: 'private', sessionId: id } : undefined) }
  const config = { streamReply: false, streamMaxChunks: 0 }
  const logger = { info() {}, warn() {}, debug() {} }
  const wake = { noteOutbound() {} }
  const onSessionEvent = createOutbound({
    manager,
    config,
    logger,
    send: async (record, text) => {
      sent.push(text)
    },
    wake,
  })
  const fire = (message) =>
    onSessionEvent(
      { id: 's1' },
      { type: 'assistant/message', sessionId: 's1', data: { message } },
    )
  return { fire, sent }
}

test('extractText 只认 text 块——纯 reasoning 拿到空串', () => {
  assert.equal(extractText({ content: REAL_REASONING_1716 }), '')
})

test('reasoningTail：从纯 reasoning 里取最后一段像人话的', () => {
  const tail = reasoningTail({ content: REAL_REASONING_1716 })
  assert.equal(tail, '就是本姑娘还得练一阵，真安静着不说话，心里会有点痒')
})

test('reasoningTail：最后一段是英文就往前找', () => {
  const tail = reasoningTail({
    content: [
      { type: 'reasoning', text: 'Let me think about this.' },
      { type: 'reasoning', text: '那就等姐姐回来说吧！' },
      { type: 'reasoning', text: 'Good.' },
    ],
  })
  assert.equal(tail, '那就等姐姐回来说吧！')
})

test('reasoningTail：整段没有汉字就不硬凑', () => {
  assert.equal(reasoningTail({ content: [{ type: 'reasoning', text: 'OK. Fine. Done.' }] }), '')
})

test('reasoningTail：reasoning 里的思考标志行会被剥掉', () => {
  const tail = reasoningTail({
    content: [{ type: 'reasoning', text: 'Hmm 这句要短一点。\n\n本姑娘在的，姐姐慢慢说。' }],
  })
  assert.equal(tail, '本姑娘在的，姐姐慢慢说。')
  assert.equal(stripLeakedThinking('Hmm 这句要短一点。'), '')
})

test('只有 reasoning 的消息也要发出去（2026-10-26 那个坑）', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: REAL_REASONING_1716 })
  assert.deepEqual(sent, ['就是本姑娘还得练一阵，真安静着不说话，心里会有点痒'])
})

test('有 text 时照常发 text，不掺 reasoning', async () => {
  const { fire, sent } = makeHarness()
  await fire({
    content: [
      { type: 'reasoning', text: '内心的草稿，不该出现。' },
      { type: 'text', text: '理是这么个理。' },
    ],
  })
  assert.deepEqual(sent, ['理是这么个理。'])
})

test('text 和 reasoning 都空就真的不发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [] })
  await fire({ content: [{ type: 'reasoning', text: '' }] })
  assert.deepEqual(sent, [])
})

// ── 2026-10-26 17:25 姐姐看到的「人设串了」：行首英文标签 + 同一段发两遍 ──

test('行首粘着的英文标签要剥掉，话要留下', () => {
  assert.equal(
    stripLeakedThinking('Good.本姑娘这边显示是发出去了，看来是掉在半路'),
    '本姑娘这边显示是发出去了，看来是掉在半路',
  )
  assert.equal(stripLeakedThinking('2 lines.理是这么个理'), '理是这么个理')
  assert.equal(stripLeakedThinking('Hmm 这句要短一点。'), '') // 整行都是自评 → 删
})

test('同一段写两遍只留一遍（2026-10-26 17:14 / 17:25 都有）', () => {
  const once = '本姑娘这边显示是发出去了，看来是掉在半路。'
  const twice = stripLeakedThinking(
    [
      'Good.本姑娘这边显示是发出去了，看来是掉在半路。',
      '刚才说的是，理是这么个理，可本姑娘还得练一阵，真安静着不说话，心里会痒。',
      '本姑娘这边显示是发出去了，看来是掉在半路。',
      '刚才那句是——理是这么个理，可本姑娘还得练一阵，真安静着不说话，心里会痒。',
    ].join('\n\n'),
  )
  assert.ok(twice.startsWith(once), twice)
  assert.equal(twice.split('掉在半路').length - 1, 1, '第一段只该出现一次')
  assert.equal(twice.split('还得练一阵').length - 1, 1, '第二段只该出现一次')
})


test('流式已经发过几句，message 只补后面没发的（别整段重发）', async () => {
  const sent = []
  const manager = { find: () => ({ scope: 'private', sessionId: 's1' }) }
  const outbound = createOutbound({
    manager,
    config: { streamReply: true, streamMaxChunks: 2 },
    logger: { info() {}, warn() {}, debug() {} },
    send: async (_r, text) => sent.push(text),
    wake: { noteOutbound() {} },
  })
  const fire = (raw) => outbound({ id: 's1' }, { ...raw, sessionId: 's1' })

  const full = '本姑娘这边显示是发出去了。刚才那句是理是这么个理。可本姑娘还得练一阵。真安静着不说话心里会痒。'
  // 流式：两句（streamMaxChunks=2）
  for (const p of ['本姑娘这边显示是发出去了。', '刚才那句是理是这么个理。', '可本姑娘还得练一阵。', '真安静着不说话心里会痒。']) {
    await fire({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: p } } })
  }
  // 落定
  await fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: full }] } } })

  // 前两句各发一次，剩下两句合成一次补发——拼起来正好是全文，没有重复
  assert.equal(sent.length, 3)
  assert.equal(sent.join(''), full)
})
