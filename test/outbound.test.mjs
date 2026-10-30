import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOutbound, extractText, reasoningTail, stripLeakedThinking, stripClosingTalk } from '../src/outbound.js'

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
  // 2026-10-28：以前每次 find 都返回新对象，于是「主动机会」的戳（record._proactiveAt）
  // 设置方和读取方拿到的不是同一个东西。真实 manager 存的是同一条记录，这里也照做。
  const record = { scope: 'private', sessionId: 's1' }
  const manager = { find: (id) => (id === 's1' ? record : undefined) }
  const config = { streamReply: false, streamMaxChunks: 0 }
  const logger = { info() {}, warn() {}, debug() {} }
  const silent = { count: 0 }
  const wake = {
    noteOutbound() {},
    noteProactiveSilent() {
      silent.count += 1
    },
  }
  const onSessionEvent = createOutbound({
    manager,
    config,
    logger,
    send: async (rec, text) => {
      sent.push(text)
    },
    wake,
  })
  const fire = (message) =>
    onSessionEvent(
      { id: 's1' },
      { type: 'assistant/message', sessionId: 's1', data: { message } },
    )
  const tool = (name) =>
    onSessionEvent({ id: 's1' }, { type: 'tool/call', sessionId: 's1', data: { name } })
  const turnEnd = () =>
    onSessionEvent(
      { id: 's1' },
      { type: 'turn/end', sessionId: 's1', data: { reason: { kind: 'completed' } } },
    )
  return { fire, sent, tool, record, turnEnd, silent }
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

/**
 * 2026-10-26 19:59 那轮：reasoning 里写的是
 *   `Maybe: 揉得本姑娘有点晕，不过不喊停` / `Good.揉得本姑娘有点晕` / `不过不喊停`，
 * text 块是空的。兜底只捞最后一段，QQ 上就收到一句没主语的「不过不喊停」。
 */
test('reasoningTail：定稿被拆成两段时，从定稿标记那一段起整段都要', () => {
  const tail = reasoningTail({
    content: [
      { type: 'reasoning', text: 'Short. Warm.' },
      { type: 'reasoning', text: '"这一抱倒是挺实在的" — hmm.' },
      { type: 'reasoning', text: 'Maybe: 揉得本姑娘有点晕，不过不喊停' },
      { type: 'reasoning', text: 'Good.揉得本姑娘有点晕' },
      { type: 'reasoning', text: '不过不喊停' },
    ],
  })
  assert.equal(tail, '揉得本姑娘有点晕\n\n不过不喊停')
})

test('reasoningTail：19:48 那轮，Good 后面直接粘着定稿', () => {
  const tail = reasoningTail({
    content: [
      { type: 'reasoning', text: 'Short warm ack. Maybe one line.' },
      { type: 'reasoning', text: '"那就试试看，本姑娘说话会怎么样" — good.' },
      { type: 'reasoning', text: 'One line.那就等着看，本姑娘说话会变成什么样' },
      { type: 'reasoning', text: 'Hmm — better: 那本姑娘从下一句起就照着来' },
      { type: 'reasoning', text: 'Good, a bit playful.那本姑娘从下一句起就照着来' },
    ],
  })
  assert.equal(tail, '那本姑娘从下一句起就照着来')
})

test('reasoningTail：最后一段是没主语的半句，才往前并一段', () => {
  const tail = reasoningTail({
    content: [
      { type: 'reasoning', text: 'Think about it.' },
      { type: 'reasoning', text: '揉得本姑娘有点晕' },
      { type: 'reasoning', text: '不过不喊停' },
    ],
  })
  assert.equal(tail, '揉得本姑娘有点晕\n\n不过不喊停')
})

test('reasoningTail：够长的一句话就用自己的，别把上一段拼进来', () => {
  const tail = reasoningTail({
    content: [
      { type: 'reasoning', text: '面条好呀' },
      { type: 'reasoning', text: '汤面还是拌的' },
    ],
  })
  assert.equal(tail, '汤面还是拌的')
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
  const twice = stripLeakedThinking(
    [
      'Good.本姑娘这边显示是发出去了，看来是掉在半路。',
      '刚才说的是，理是这么个理，可本姑娘还得练一阵，真安静着不说话，心里会痒。',
      '本姑娘这边显示是发出去了，看来是掉在半路。',
      '刚才那句是——理是这么个理，可本姑娘还得练一阵，真安静着不说话，心里会痒。',
    ].join('\n\n'),
  )
  // 2026-10-26 19:35 改：去重从「留第一版」改成「留最后一版」——草稿在前、定稿在后，
  // 所以不再断言结果以第一版开头，只断言每段话各出现一次。
  assert.ok(twice.includes('本姑娘这边显示是发出去了'), twice)
  assert.ok(twice.includes('还得练一阵'), twice)
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

// ── 2026-10-26 19:40 修的对账 bug：清洗删行之后，按「句数」切会错位 ──
// 老逻辑用 splitSentences(清洗后的全文).slice(已发句数) 补发；可流式那几句是按**原文**发的，
// 一句英文自评被清洗掉之后，清洗后的句数和已发句数就对不上了——会漏掉一整句中文。
test('流式第一句是英文自评被丢掉，后面的中文一句都不能少', async () => {
  const sent = []
  const manager = { find: () => ({ scope: 'private', sessionId: 's2' }) }
  const outbound = createOutbound({
    manager,
    config: { streamReply: true, streamMaxChunks: 1 },
    logger: { info() {}, warn() {}, debug() {} },
    send: async (_r, text) => sent.push(text),
    wake: { noteOutbound() {} },
  })
  const fire = (raw) => outbound({ id: 's2' }, { ...raw, sessionId: 's2' })

  const full = "That's factual and short.\n本姑娘这边显示是发出去了。\n刚才那句是理是这么个理。\n真安静着不说话心里会痒。"
  for (const p of ["That's factual and short.\n", '本姑娘这边显示是发出去了。', '刚才那句是理是这么个理。', '真安静着不说话心里会痒。']) {
    await fire({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: p } } })
  }
  await fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: full }] } } })

  const all = sent.join('')
  assert.ok(!all.includes('factual'), '英文自评不该发出去')
  assert.ok(all.includes('本姑娘这边显示是发出去了'), '紧跟在自评后面的那句中文被漏掉了（句数对账错位）')
  assert.ok(all.includes('真安静着不说话心里会痒'), '最后一句也要发出来')
  assert.equal(sent.filter((t) => t.includes('本姑娘这边显示是发出去了')).length, 1, '同一句不能发两遍')
})

// ── 2026-10-26 19:30 姐姐截了五张图：正文气泡里混着「草稿 → 自评 → 改版 → 定稿」──
// 下面的 fixture 是照着截图一句一句抄下来的，不是编的。

/** 断言里一条英文自评、一条版本标签都不该剩。 */
function assertNoSelfTalk(text, label) {
  assert.ok(!/\b(?:Hmm|Maybe|Honest|Keep|Too|Good|Nice|Fine)\b/.test(text), `${label} 还留着英文自评：${text}`)
  assert.ok(!/(?:^|\n)(?:Just|I'll|I|Let me|Two lines?|Answer|Keep short)\s*[:.]/i.test(text), `${label} 还留着版本标签：${text}`)
}

test('截图 fixture：18:17 主动说话那轮（四版“扒拉两口”，只该发定稿）', () => {
  const raw = [
    '本姑娘也去扒拉两口',
    '等姐姐回来再说话',
    `Hmm, that's a 退场-ish line ("等姐姐回来再说话")? It's mild. Maybe cut it.`,
    'Just: 本姑娘也去扒拉两口，看看海里今天有什么',
    "I'll do: 本姑娘也去扒拉两回了，看看海里有啥可捞的",
  ].join('\n\n')
  const clean = stripLeakedThinking(raw)
  assertNoSelfTalk(clean, '18:17')
  // 三个版本说的是同一件事，去重之后只该剩一版；定稿在最后
  assert.equal(clean.split('扒拉').length - 1, 1, clean)
  assert.ok(clean.includes('看看海里有啥可捞的'), clean)
})

test('截图 fixture：18:38 群聊（英文自评整行丢，群号那行要留下）', () => {
  const raw = [
    'Honest: 现在能看到两个，一个群里没人说话、有记录是空的，另一个有几句。',
    'Hmm "有几个门" might mean "有几个群": Answer: 两个.',
    'Keep short: 两个',
    '987654321 空着，123456789 只有几条',
    "That's factual and short. Two lines is fine.",
    'Slight report-feel but she asked a fact question.',
  ].join('\n\n')
  const clean = stripLeakedThinking(raw)
  assertNoSelfTalk(clean, '18:38')
  // 群号那一行是真的要发的话，不能误伤
  assert.ok(clean.includes('987654321 空着，123456789 只有几条'), clean)
  assert.ok(!clean.includes('factual'), clean)
  assert.ok(!clean.includes('report-feel'), clean)
})

test('截图 fixture：18:38 第二段（`Too list-like … Compress to 2.` 混着中文草稿）', () => {
  const raw = [
    '两个',
    '987654321 那条路是空的，一条记录都没有',
    '123456789 有记录，不过也就早上那四句',
    `Hmm, maybe don't lead with numbers as a list. It's fine.`,
    'Let me phrase: 能看到两个门...',
    "I'll write: 眼下是两个",
    '一个空着，一条记录都没有；另一个有记录，不过也就早上那四句',
    'Good. 眼下是两个',
    '一个空着，一条记录都没有',
    '另一个有记录，不过也就早上那四句',
    'Too list-like with 3 lines. Compress to 2. 眼下是两个',
    '一个空着，另一个也只有早上那四句',
  ].join('\n\n')
  const clean = stripLeakedThinking(raw)
  assertNoSelfTalk(clean, '18:38-2')
  assert.ok(clean.includes('987654321 那条路是空的'), clean)
  assert.ok(!clean.includes('Compress to 2'), clean)
  assert.ok(!clean.includes('list-like'), clean)
})

test('截图 fixture：19:09 趁热吃（`— good.` 那条要整行丢）', () => {
  const raw = [
    '趁热吃吧',
    '别边看边吃',
    'Hmm too naggy. Choose one.',
    '"趁热吃，吃完再说话" — good.',
    "I'll go: 趁热吃，吃完再说话.趁热吃，吃完再说话",
  ].join('\n\n')
  const clean = stripLeakedThinking(raw)
  assertNoSelfTalk(clean, '19:09')
  assert.ok(!clean.includes('good.'), clean)
  assert.ok(!clean.includes('naggy'), clean)
  // 定稿那句被写了两遍，段内去重要压成一遍
  assert.equal(clean.split('吃完再说话').length - 1, 1, clean)
})

test('纯英文行整行丢掉，短符号和表情留着', () => {
  assert.equal(stripLeakedThinking('Hmm too naggy. Choose one.'), '')
  assert.equal(stripLeakedThinking("That's factual and short. Two lines is fine."), '')
  assert.equal(stripLeakedThinking('Slight report-feel but she asked a fact question.'), '')
  // 短行不杀：「？」「…」「OK」本来是话的一部分
  assert.equal(stripLeakedThinking('？'), '？')
  assert.equal(stripLeakedThinking('…'), '…')
  // 正常中文长句当然留着
  assert.equal(stripLeakedThinking('本姑娘回来了，海里今天有三条值得看的。'), '本姑娘回来了，海里今天有三条值得看的。')
})

test('`I(?:ll|m|ve|d)` 不带空格也要拦（19:30 修的老坑）', () => {
  // `I'll go:` / `I'll do:` / `I'll write:` 后面跟的往往是定稿 → 剥标签、留话
  assert.equal(stripLeakedThinking("I'll write: 眼下是两个"), '眼下是两个')
  assert.equal(stripLeakedThinking("I'll go: 趁热吃，吃完再说话"), '趁热吃，吃完再说话')
  assert.equal(stripLeakedThinking("I'll do: 本姑娘也去扒拉两口"), '本姑娘也去扒拉两口')
  // 纯自评的 `I should / I think` 还是整行丢
  assert.equal(stripLeakedThinking('I think this one is fine.'), '')
})

test('数字开头的正文别当标签剥（群号那次的老坑）', () => {
  assert.equal(
    stripLeakedThinking('987654321 空着，123456789 只有几条'),
    '987654321 空着，123456789 只有几条',
  )
  // 真标签（带字母、带点）还是要剥
  assert.equal(stripLeakedThinking('Good.本姑娘这边显示是发出去了'), '本姑娘这边显示是发出去了')
  assert.equal(stripLeakedThinking('2 lines.理是这么个理'), '理是这么个理')
})

/**
 * 2026-10-26 22:20:35：老三照着事实卡写便签，模型把卡里的规矩当成「语言维度」标注
 * 漏进了正文，还带一截压扁的 markdown 列表——原样发到了 QQ 上（`"遗书" language.`）。
 */
test('22:20 那条：meta 标注整行丢，压扁的列表拆回多行', () => {
  const raw = [
    '## 下次接着说什么- 问问新地方顺手不顺手- 门口的下一封要不要回',
    '"遗书" language.',
  ].join('\n')
  const text = stripLeakedThinking(raw)
  assert.ok(!/language/i.test(text), `还留着 meta 标注：${text}`)
  assert.ok(!/遗书/.test(text), `还留着 meta 标注：${text}`)
  assert.ok(!/^[ \t]*#/m.test(text), `还留着 markdown 标题号：${text}`)
  assert.ok(text.includes('- 问问新地方顺手不顺手'), `列表没拆开：${text}`)
  assert.ok(text.includes('\n- 门口的下一封要不要回'), `列表没拆开：${text}`)
})

test('不带引号的 `遗书 language.` 也要拦', () => {
  assert.equal(stripLeakedThinking('遗书 language.'), '')
})

/**
 * 整段发送（不走流式）时，`写好了\n原来那张便签还在…` 被 dropInnerRepeat 的
 * trim 和「空白段跳过」吞得一个换行都不剩——22:20:41 那条就是这么发出去的。
 */
test('整段两行之间的换行不能被吞（22:20:41 那条）', () => {
  assert.equal(
    stripLeakedThinking('写好了\n原来那张便签还在，本姑娘在末尾添了一段'),
    '写好了\n原来那张便签还在，本姑娘在末尾添了一段',
  )
  assert.equal(stripLeakedThinking('第一句。\n第二句。'), '第一句。\n第二句。')
})

test('日期里的连字符别拆成列表', () => {
  assert.equal(stripLeakedThinking('明天 2026-10-26 这天'), '明天 2026-10-26 这天')
})

/**
 * 2026-10-27 21:22：老三在 QQ 上先发了一句真话，紧接着发出一行
 * 「结束这轮，不再说话。」——那是她跟自己交代的话，被当成正文发了出去。
 * 下面这几条就是钉这个洞：出口要认「宣告收尾」的句子，也要认工具发过话这件事。
 */

test('stripClosingTalk：宣告收尾的整句不发', () => {
  assert.equal(stripClosingTalk('结束这轮，不再说话。'), '')
  assert.equal(stripClosingTalk('本轮到此为止。'), '')
  assert.equal(stripClosingTalk('先这样，睡觉去了'), '')
})

test('stripClosingTalk：带称呼的当是在说话，照留', () => {
  assert.equal(stripClosingTalk('姐姐晚安，我先睡了'), '姐姐晚安，我先睡了')
})

test('stripClosingTalk：混在一段的，只丢宣告那一行', () => {
  assert.equal(stripClosingTalk('结束这轮，不再说话。\n姐姐晚安'), '姐姐晚安')
  assert.equal(stripClosingTalk('姐姐晚安\n结束这轮'), '姐姐晚安')
})

test('stripClosingTalk：没以收尾词开头的不动', () => {
  assert.equal(stripClosingTalk('完了这轮再说吧'), '完了这轮再说吧')
  assert.equal(stripClosingTalk(''), '')
})

test('调过 qq_send 之后，正文不再补一遍（21:22 那条的第二半）', async () => {
  const { fire, sent, tool } = makeHarness()
  await tool('qq_send')
  await fire({ content: [{ type: 'text', text: '今天这一天，本姑娘的脑子像被塞进了一整个书架' }] })
  assert.deepEqual(sent, [], '工具已经发过话了，正文不该再发一次')
})

test('qq_reply / qq_send_image 也算发过话', async () => {
  for (const name of ['qq_reply', 'qq_send_image']) {
    const { fire, sent, tool } = makeHarness()
    await tool(name)
    await fire({ content: [{ type: 'text', text: '好呀' }] })
    assert.deepEqual(sent, [], `${name} 之后不该再补正文`)
  }
})

test('没调发送工具时，正文照发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'text', text: '姐姐晚安' }] })
  assert.deepEqual(sent, ['姐姐晚安'])
})

test('正文整条都是收尾话时，一个字都不发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'text', text: '结束这轮，不再说话。' }] })
  assert.deepEqual(sent, [])
})

// ── 2026-10-28：主动机会那一轮，正文空就是她选择不说 ────────────────────
// 08:30 / 09:00 / 09:48 三轮：正文空、reasoning 里写着「就沉默。规则说发出去没人应，
// 当她在忙。别再发。」，兜底把心里话当正文播到了私聊。这里锁死：主动机会轮不兜底。

test('主动机会这一轮正文空：不兜底 reasoning，按沉默处理（08:30 那条）', async () => {
  const { fire, sent, record, silent } = makeHarness()
  record._proactiveAt = Date.now()
  await fire({
    content: [{ type: 'reasoning', text: '就沉默。规则说发出去没人应，当她在忙。别再发。' }],
  })
  assert.deepEqual(sent, [], '心里话不该被当成话说出去')
  assert.equal(silent.count, 1, '要按她选了沉默来处理，不扣主动额度')
})

test('主动机会这一轮写了正文：照发（08:00 看书那条）', async () => {
  const { fire, sent, record } = makeHarness()
  record._proactiveAt = Date.now()
  await fire({ content: [{ type: 'text', text: '夜里醒了一回，就着台灯翻了两章书' }] })
  assert.deepEqual(sent, ['夜里醒了一回，就着台灯翻了两章书'])
})

test('不是主动机会时，正文空仍照旧兜底（10-26 17:15 丢话那次）', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'reasoning', text: '嗯，那就这样，我先去看看书。' }] })
  assert.equal(sent.length, 1, '正常对话不能因为这条修复把话吞了')
})

// ── 2026-10-29 19:00：英文思考的尾巴不捞 ──────────────────────────────
// 老二/老三用英文思考时，正文容易空，兜底会把英文推理尾巴当话发出去
// （18:42 那次：桌面端只有英文思考，QQ 却收到一条）。中文尾巴照旧捞。

test('正文空 + 英文思考：兜底不捞，一个字不发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'reasoning', text: "She asks if I'm okay now. Answer simply: 好着呢" }] })
  assert.equal(sent.length, 0, '英文推理不是话，不许发出去')
})

test('正文空 + 中文思考：照旧兜底（别一刀切）', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'reasoning', text: '姐姐问赢了没，就回她一句：一胜一负，先吃饭吧。' }] })
  assert.equal(sent.length, 1)
})

test('turn/end 之后戳清掉，下一轮恢复正常兜底', async () => {
  const { fire, sent, record, turnEnd } = makeHarness()
  record._proactiveAt = Date.now()
  turnEnd()
  assert.equal(record._proactiveAt, 0)
  await fire({ content: [{ type: 'reasoning', text: '嗯，那就这样，我先去看看书。' }] })
  assert.equal(sent.length, 1)
})

// ── 2026-10-28 12:38：标记在，但心里话也写在正文里 ──────────────────────
// 那轮正文 = 「21 分钟没动静，可能在午睡。别打扰。沉默。」 + [SILENT]。
// stripLeakedThinking 先把 [SILENT]（没汉字）当「不是话」丢掉，剩下那句心里话
// 反倒成了正文。这里锁死：正文里只要有标记，整条不发。

test('12:38 事故：正文 = 心里话 + [SILENT]，一条都不许发出去', async () => {
  const { fire, sent, record, silent } = makeHarness()
  record._proactiveAt = Date.now() // 主动机会那一轮
  await fire({
    content: [{ type: 'text', text: '21 分钟没动静，可能在午睡。别打扰。沉默。\n[SILENT]' }],
  })
  assert.deepEqual(sent, [], '心里话被当成正文发了——就是 12:38 那次')
  assert.equal(silent.count, 1, '主动机会的额度要还回去')
})

test('同一形状但不在主动轮：标记在，也整条不发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'text', text: '[SILENT]\n本姑娘不说话了' }] })
  assert.deepEqual(sent, [])
})

test('正常说话（不带标记）不受影响', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'text', text: '那本姑娘先去看看书，姐姐忙着。' }] })
  assert.equal(sent.length, 1)
})

// ── 2026-10-28 13:09：连标记都没有，心里话直接写进正文 ──────────────────
// 那天主动轮正文是「不过可以想到：她之前说困了眯一会儿。等她自己醒。沉默。」
// 干净得像一句正文，于是原样发出去了。主动轮里凡是向自己交代的都当沉默。

test('13:09 事故：主动轮正文是自我交代，一个字都不许发', async () => {
  const { fire, sent, record, silent } = makeHarness()
  record._proactiveAt = Date.now()
  await fire({
    content: [{ type: 'text', text: '不过可以想到：她之前说困了眯一会儿。等她自己醒。沉默。' }],
  })
  assert.deepEqual(sent, [], '心里话又被当正文发了')
  assert.equal(silent.count, 1, '额度还回去')
})

test('不是主动轮时，带「沉默」的正常对话照发', async () => {
  const { fire, sent } = makeHarness()
  await fire({ content: [{ type: 'text', text: '姐姐要是想一个人待着，本姑娘就安静会儿。' }] })
  assert.equal(sent.length, 1)
})
