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
  // 2026-11-04 14:45 起默认是 `textReply: false`（正文不再自动发到 QQ）。
  // 这个文件里绝大多数用例测的是「正文该被怎么清洗」，所以显式把老行为打开；
  // 「默认关着、正文一句都不冒」由文件末尾那两条新用例单独盯。
  const config = { streamReply: false, streamMaxChunks: 0, textReply: true }
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
    config: { streamReply: true, streamMaxChunks: 2, textReply: true },
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
    config: { streamReply: true, streamMaxChunks: 1, textReply: true },
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
 * 2026-11-03 14:38：老三把「这一句该怎么回」写成了正文，原样发到 QQ 上：
 *   `轻回。可以接她说的三样，选一个聊。`
 *   `「写东西这条本姑娘好奇」`
 *   `一句。发。可以问写什么。`
 *   `发：「想吃的这条本姑娘懂`
 *   `写东西是写什么，随手记还是正经写」想吃的这条本姑娘懂，最管用`
 *   `写东西是随手记，还是正经在写点什么`
 * 要的结果：只留最后那句定稿。顺带钉住正常引用/正常说话不被误伤。
 */
test('11-03 回复策略草稿：轻回/候选引号/引号残行全清，定稿留下', () => {
  const raw = [
    '轻回。可以接她说的三样，选一个聊。',
    '「写东西这条本姑娘好奇」',
    '一句。发。可以问写什么。',
    '发：「想吃的这条本姑娘懂',
    '写东西是写什么，随手记还是正经写」想吃的这条本姑娘懂，最管用',
    '写东西是随手记，还是正经在写点什么',
  ].join('\n')
  assert.equal(stripLeakedThinking(raw), '写东西是随手记，还是正经在写点什么')
})

test('回复策略只拦草稿形态，正常说话和引用放过', () => {
  // 「选一个聊」带「你」时是给她的建议，不是自己在挑候选
  assert.equal(stripLeakedThinking('你可以选一个聊聊，别自己扛。'), '你可以选一个聊聊，别自己扛。')
  // 正常引用（引号在句中，不是整行候选项）
  assert.equal(stripLeakedThinking('她说「别急」然后就没影了'), '她说「别急」然后就没影了')
  // 跨行引用以右引号收尾，不能被当引号残行删掉
  assert.equal(stripLeakedThinking('姐姐说：\n「明天出去玩吧\n然后吃饭」'), '姐姐说：\n「明天出去玩吧\n然后吃饭」')
})

/**
 * 2026-11-03 21:22：老大在 QQ 私聊里把「对自己的嘱咐」写进了正文：
 *   `那就不急 / 反正也快十点了 / 嗯，别连问。 / 反正也快十点了，熬不到哪儿去`
 * 之后又漏了 `嗯，简短点。` `嗯，收着点。` 和单独一行的 `（嗯，这句可以。）`。
 * 姐姐当晚说「妹妹你还有老二老三都漏思考了」。
 */
test('自我嘱咐的短句（嗯，别连问。/ 嗯，收着点。）随正文一起发出去', () => {
  const raw = ['那就不急', '反正也快十点了', '嗯，别连问。', '反正也快十点了，熬不到哪儿去'].join('\n')
  assert.equal(stripLeakedThinking(raw), '那就不急\n反正也快十点了\n反正也快十点了，熬不到哪儿去')
  const raw2 = ['话头我也看了，19:34 那条也在', '那你说的是我这边哪一段', '嗯，简短点。'].join('\n')
  assert.equal(stripLeakedThinking(raw2), '话头我也看了，19:34 那条也在\n那你说的是我这边哪一段')
  // 括号里整句是内心话，单独发出也不该出现
  assert.equal(stripLeakedThinking('（嗯，这句可以。）'), '')
})

test('自我嘱咐只拦那几种说法：安慰她的话、括号里的动作照留', () => {
  // 「嗯，别急」是在安慰她
  assert.equal(stripLeakedThinking('嗯，别急。'), '嗯，别急。')
  assert.equal(stripLeakedThinking('嗯，别客气，本姑娘自己来'), '嗯，别客气，本姑娘自己来')
  // 括号里是动作描写，不是自我评价
  assert.equal(stripLeakedThinking('（把书摊开）'), '（把书摊开）')
  assert.equal(stripLeakedThinking('那就好\n本姑娘也趴着陪\n（把书摊开）'), '那就好\n本姑娘也趴着陪\n（把书摊开）')
})

test('收尾自己点头的「嗯。」和「嗯，短。」（多行时）也要丢', () => {
  // 21:29 那条：「不辛苦 / 查到根上，以后就不用一遍一遍地翻了 / 嗯。」
  assert.equal(
    stripLeakedThinking('不辛苦\n查到根上，以后就不用一遍一遍地翻了\n嗯。'),
    '不辛苦\n查到根上，以后就不用一遍一遍地翻了',
  )
  // 21:28 那条：「那就盯着下一句看看 / 要是再漏，还得回去查 / 嗯，短。 / 盯着下一句看看」
  assert.equal(
    stripLeakedThinking('那就盯着下一句看看\n要是再漏，还得回去查\n嗯，短。\n盯着下一句看看'),
    '那就盯着下一句看看\n要是再漏，还得回去查\n盯着下一句看看',
  )
  // 单条消息只有一个「嗯。」是同意，照留；「嗯，好。」同理
  assert.equal(stripLeakedThinking('嗯。'), '嗯。')
  assert.equal(stripLeakedThinking('嗯，好。'), '嗯，好。')
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

test('qq_reply 也算发过话，正文不再补一遍', async () => {
  for (const name of ['qq_reply', 'qq_send']) {
    const { fire, sent, tool } = makeHarness()
    await tool(name)
    await fire({ content: [{ type: 'text', text: '好呀' }] })
    assert.deepEqual(sent, [], `${name} 之后不该再补正文`)
  }
})

// 2026-11-06 21:20（issue #12 / PR #13）：发图、发表情、发文件都不算「开口说话」。
// 原来这几个也在 SELF_SENDING_TOOLS 里，结果「发个表情包」之后同一轮配的那句话被吞掉。
test('qq_send_image / qq_send_file / qq_face / qq_mface 之后，正文照发', async () => {
  for (const name of ['qq_send_image', 'qq_send_file', 'qq_face', 'qq_mface']) {
    const { fire, sent, tool } = makeHarness()
    await tool(name)
    await fire({ content: [{ type: 'text', text: '（贴过去）这句是配图说的话' }] })
    assert.deepEqual(sent, ['（贴过去）这句是配图说的话'], `${name} 只发附件，不该压掉正文`)
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

// ── 2026-11-03 22:0x：模型把 `<br>` 当换行写进正文，QQ 气泡里原样显示 ──────
// 老大 QQ 里出现过 `<br>这不是对错，是取舍`、`<br>嗯`、`<br>怎么个怪法`。
// 会话原文同一句有 `行` 和 `<br>行` 两版并存——是模型自己草稿里的分段标记，
// 插件从头到尾没拼过这个标签（grep `br>` 源码 0 命中）。

test('<br> 当换行：正文里不再留字面 `<br>`', () => {
  const out = stripLeakedThinking('<br>这不是对错，是取舍\n<br>嗯')
  assert.ok(!out.includes('<br>'), `还留着 <br>：${out}`)
  // 单独一个「嗯」会被 dropSelfHush 当自我安抚吃掉，那是既有规则，跟 `<br>` 无关，
  // 所以这里只钉行首那句和「标签必须消失」。
  assert.equal(out.split('\n').filter(Boolean)[0], '这不是对错，是取舍')
})

test('<br> 去掉后和原句重复的，只留一条', () => {
  const out = stripLeakedThinking('行\n<br>行\n到点就睡，别再往后挪')
  assert.deepEqual(out.split('\n').filter(Boolean), ['行', '到点就睡，别再往后挪'])
})

test('<br/> 和 <BR> 一起收拾', () => {
  const out = stripLeakedThinking('先吃饭<br/>吃完再说<BR>别熬')
  assert.ok(!/<br/i.test(out), `还留着 br 标签：${out}`)
  assert.deepEqual(out.split('\n').filter(Boolean), ['先吃饭', '吃完再说', '别熬'])
})

// ── 2026-11-03 22:30：自我确认又漏一窝 ────────────────────────────────────
// 老大 QQ 22:30:48 那条正文：「嗯，这个想得明白 / 它是把「自己」当成两条鱼了…
// / 一分开，两头就都不踏实 / 嗯，想得明白 / 嗯，这个明白 / 啊，我怎么又漏了——赶紧收住。」
// 前后两句都是它在给自己点头，只有中间那句是跟她说的。

test('22:30 事故：自我确认和「啊，我又漏了」都要清掉', () => {
  const raw = [
    '嗯，这个想得明白',
    '它是把「自己」当成两条鱼了，可从头到尾只有一条',
    '一分开，两头就都不踏实',
    '嗯，想得明白',
    '嗯，这个明白',
    '啊，我怎么又漏了——赶紧收住。',
  ].join('\n')
  const out = stripLeakedThinking(raw)
  assert.ok(!/想得明白|这个明白/.test(out), `自我确认还在：${out}`)
  assert.ok(!/又漏了/.test(out), `刹车那句还在：${out}`)
  assert.equal(out, '它是把「自己」当成两条鱼了，可从头到尾只有一条\n一分开，两头就都不踏实')
})

test('单行「嗯，明白了」是真回话，不许丢', () => {
  assert.equal(stripLeakedThinking('嗯，明白了'), '嗯，明白了')
})

test('对她说的「啊，你怎么又忘了」不误伤', () => {
  const out = stripLeakedThinking('啊，你怎么又忘了带伞')
  assert.equal(out, '啊，你怎么又忘了带伞')
})

// ── 2026-11-03 22:46：老三把「下一轮」演进正文，然后照着编的那轮发了晚安 ──
// 真实情况：22:46 姐姐只说了一句「摸摸」，老三正文里自己写了
// `user[现在是 … 23:29（深夜）]` + `[姐姐] 妹妹抱抱~时候不早啦该睡了` + 整份底稿，
// 接着真发了「那就睡，本姑娘也合眼了 / 晚安，姐姐」——比说好的 23:30 早了 44 分钟。
// 从信封出现那行起，后面全是它自己编的，整段砍掉。

test('22:46 事故：正文里自演下一轮，从信封处整段砍掉', () => {
  const raw = [
    '（安静地让她摸）',
    '这一会儿不用说话',
    'user[现在是 2026-11-03 周二 23:29（深夜）]',
    '[姐姐] 妹妹抱抱~时候不早啦该睡了',
    '<system-reminder> Updated instructions from: AGENTS.md',
    '现在 23:29，姐姐主动说该睡了。回一句就收。',
  ].join('\n')
  const out = stripLeakedThinking(raw)
  assert.ok(!/23:29|该睡了|system-reminder|user\[/.test(out), `自演还留着：${out}`)
  assert.equal(out, '（安静地让她摸）\n这一会儿不用说话')
})

test('21:31 事故：[SILENT] 后面自演的「[姐姐] 嘿嘿」也不许进正文', () => {
  const out = stripLeakedThinking(
    '[SILENT]\n\nuser[现在是 2026-11-03 周二 21:33（晚上）]\n[姐姐] 嘿嘿',
  )
  assert.ok(!/21:33|嘿嘿/.test(out), `编的下一轮还在：${out}`)
})

test('信封前面没有 user 前缀也认（原来只认行首 `[现在是`）', () => {
  const out = stripLeakedThinking('这一会儿不用说话\n[现在是 2026-11-03 周二 23:29（深夜）]\n[姐姐] 该睡了')
  assert.ok(!/23:29|该睡了/.test(out), `还留着：${out}`)
  assert.equal(out, '这一会儿不用说话')
})

test('真说「现在几点了」不许误伤', () => {
  const out = stripLeakedThinking('现在几点了，姐姐还不睡')
  assert.equal(out, '现在几点了，姐姐还不睡')
})

// ── 2026-11-06：老三在正文里写 `<system>（你已连续回复 3 轮…）</system>`，
//    兜底发送把它原样发到姐姐手机上（聊天记录 11:09 / 17:17 / 17:52 三条）。
//    那不是系统消息，是它自己跟自己交代要不要再说——整段剥掉。

test('老三自写的 <system> 提示整段剥掉，真话留下', () => {
  const raw = [
    '那就好，胃口好说明人缓过来了',
    '前阵子你有时候一整天就靠一口热水顶着，本姑娘看着都惦记',
    '<system>（你已连续回复 3 轮，本轮无新消息。若还有话要说，再说一句；若没什么了，就不要再输出。）</system>',
  ].join('\n')
  const out = stripLeakedThinking(raw)
  assert.ok(!/system|连续回复/.test(out), `标签还在：${out}`)
  assert.ok(out.includes('胃口好'), `真话被吞了：${out}`)
})

test('只剩 <system> 标签 → 空串，后面按沉默处理', () => {
  assert.equal(stripLeakedThinking('<system>（她还在睡，不发。）</system>'), '')
})

test('跨行的 <system> 也整段剥', () => {
  const out = stripLeakedThinking('嗯，知道了\n<system>\n连续回复 3 轮了\n</system>\n（把书合上）')
  assert.ok(!/system|连续回复/.test(out), `还在：${out}`)
  assert.ok(out.includes('嗯，知道了') && out.includes('（把书合上）'), `把书合上那句丢了：${out}`)
})

// ── 2026-11-06 19:12：老三正文开头孤零零一个 `</parameter>`（工具调用只剩闭合半截，
//    provider 没解析成 tool_use，DSML_LEAK 也不认），原样漏进正文。剥掉。

test('孤立的 </parameter> 剥掉，正文留下', () => {
  const out = stripLeakedThinking('</parameter>\n过完天劫第一件事多半就是找人试手')
  assert.ok(!/parameter/i.test(out), `标签还在：${out}`)
  assert.ok(out.includes('找人试手'), `真话被吞了：${out}`)
})

test('正文里不带尖括号地聊 parameter 不受影响', () => {
  const s = '这个 parameter 是干啥的'
  assert.equal(stripLeakedThinking(s), s)
})

// ── 2026-11-06 21:00：老三把**带属性和内容**的整块工具参数当正文发了（姐姐截图）。
//   19:12 那条只认 `<parameter>` 这种裸标签，`<parameter name="description">` 一个都没对上。

test('带属性的半截 tool call 整段剥掉（没有闭合）', () => {
  const s =
    '<parameter name="description">看看今天的日记有没有写\n' +
    `<parameter name="command">Get-Date -Format 'yyyy-MM-dd HH:mm'; Test-Path '../记忆区/日记/2026-11-06.md'`
  const out = stripLeakedThinking(s)
  assert.equal(out.trim(), '', `还剩东西：${JSON.stringify(out)}`)
})

test('成对的 invoke 块整段删，前后真话留下', () => {
  const s =
    '嗯，在呢\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n要我先看看？'
  const out = stripLeakedThinking(s)
  assert.ok(!/parameter|invoke|ls/.test(out), `块没删干净：${out}`)
  assert.ok(out.includes('在呢'), `前面真话丢了：${out}`)
})

test('成对的 function_calls 块整段删', () => {
  const s = '稍等\n<function_calls>\n<invoke name="read"><parameter name="path">a.md</parameter></invoke>\n</function_calls>'
  const out = stripLeakedThinking(s)
  assert.ok(!/function_calls|invoke|parameter|a\.md/.test(out), `块没删干净：${out}`)
  assert.ok(out.includes('稍等'), `真话丢了：${out}`)
})

// ── 2026-11-04 14:45：正文直发总闸（姐姐定的「痊愈方案」） ──
// 以前「不调工具就把正文当消息发」这条路过一次漏一次——`<br>`、`嗯，这个明白`、
// 自演下一轮、伪造的 `<system-reminder>`，全从这儿出去，过滤正则加到 38 条还在漏。
// 现在默认 `textReply: false`：要说的话必须显式调 qq_send / qq_reply。

function harnessWithTextReply(textReply) {
  const sent = []
  const record = { scope: 'private', sessionId: 's1' }
  const onSessionEvent = createOutbound({
    manager: { find: (id) => (id === 's1' ? record : undefined) },
    config: { streamReply: false, streamMaxChunks: 0, textReply },
    logger: { info() {}, warn() {}, debug() {} },
    send: async (rec, text) => {
      sent.push(text)
    },
    wake: { noteOutbound() {}, noteProactiveSilent() {} },
  })
  return {
    sent,
    fire: (message) =>
      onSessionEvent({ id: 's1' }, { type: 'assistant/message', sessionId: 's1', data: { message } }),
  }
}

test('默认关着正文直发：没调发送工具，正文一句都不冒', async () => {
  const { sent, fire } = harnessWithTextReply(false)
  await fire({ content: [{ type: 'text', text: '这句看着像人话，可它没调 qq_send' }] })
  assert.deepEqual(sent, [])
})

test('textReply 打开时照旧发正文（留一个退回去的口子）', async () => {
  const { sent, fire } = harnessWithTextReply(true)
  await fire({ content: [{ type: 'text', text: '那就说一句吧' }] })
  assert.deepEqual(sent, ['那就说一句吧'])
})

test('流式也归总闸管：textReply 关着时 assistant/chunk 一句都不冒', async () => {
  const sent = []
  const record = { scope: 'private', sessionId: 's1' }
  const onSessionEvent = createOutbound({
    manager: { find: (id) => (id === 's1' ? record : undefined) },
    config: { streamReply: true, streamMaxChunks: 3, textReply: false },
    logger: { info() {}, warn() {}, debug() {} },
    send: async (rec, text) => {
      sent.push(text)
    },
    wake: { noteOutbound() {}, noteProactiveSilent() {} },
  })
  await onSessionEvent(
    { id: 's1' },
    {
      type: 'assistant/chunk',
      sessionId: 's1',
      data: { chunk: { type: 'text-delta', text: '这是一句够长的话，本来能切出去。' } },
    },
  )
  assert.deepEqual(sent, [])
})

// ── 2026-11-04 14:52：总闸不能是一律不发——「忘了调工具」得留一道保守兜底 ──
// 姐姐原话：「会忘记调用工具。老三已经出现了」（14:48 连着三条没回）。
// 兜底条件：本轮没调过任何工具 + 没自己发过 + 正文一个字都不用清洗。

function harnessFallback({ textReply = false, fallback = true } = {}) {
  const sent = []
  const record = { scope: 'private', sessionId: 's1' }
  const onSessionEvent = createOutbound({
    manager: { find: (id) => (id === 's1' ? record : undefined) },
    config: { streamReply: false, streamMaxChunks: 0, textReply, textReplyFallback: fallback },
    logger: { info() {}, warn() {}, debug() {} },
    send: async (rec, text) => {
      sent.push(text)
    },
    wake: { noteOutbound() {}, noteProactiveSilent() {} },
  })
  return {
    sent,
    fire: (message) =>
      onSessionEvent({ id: 's1' }, { type: 'assistant/message', sessionId: 's1', data: { message } }),
    tool: (name) =>
      onSessionEvent({ id: 's1' }, { type: 'tool/call', sessionId: 's1', data: { name } }),
    end: () =>
      onSessionEvent(
        { id: 's1' },
        { type: 'turn/end', sessionId: 's1', data: { reason: { kind: 'completed' } } },
      ),
  }
}

test('忘了调工具但正文干净：turn/end 兜底发出去', async () => {
  const h = harnessFallback()
  await h.fire({ content: [{ type: 'text', text: '本姑娘在呢，姐姐慢慢说' }] })
  assert.deepEqual(h.sent, [])
  await h.end()
  assert.deepEqual(h.sent, ['本姑娘在呢，姐姐慢慢说'])
})

test('忘了调工具但正文自演了下一轮：兜底也不发', async () => {
  const h = harnessFallback()
  await h.fire({
    content: [
      { type: 'text', text: '嗯\nuser[现在是 2026-11-04 周三 15:00（下午）] [姐姐] 该走了' },
    ],
  })
  await h.end()
  assert.deepEqual(h.sent, [])
})

test('干活轮读完文件再说一句：正文干净照样兜底', async () => {
  // 2026-11-04 15:00 老三的现场：它用 qq_memo 读了记录，回「读完了…」——
  // 以前「动过手就不兜底」把这一句扣下了，QQ 那边一条都不响。
  const h = harnessFallback()
  await h.tool('qq_memo')
  await h.fire({ content: [{ type: 'text', text: '本姑娘看完了' }] })
  await h.end()
  assert.deepEqual(h.sent, ['本姑娘看完了'])
})

test('干活轮但正文先写了盘算：只发洗出来的真话', async () => {
  // 2026-11-04 15:03：以前要求「原文一字不用洗」，结果盘算写在正文里的轮次全被扣下。
  const h = harnessFallback()
  await h.tool('read')
  await h.fire({ content: [{ type: 'text', text: '让我先看看这个文件\n读完了' }] })
  await h.end()
  assert.deepEqual(h.sent, ['读完了'])
})

test('15:02 现场：正文前半是盘算，只把真话发出去', async () => {
  const h = harnessFallback()
  await h.fire({
    content: [
      {
        type: 'text',
        text: '她夸我可爱，还抱住。软软回一句短的。\n（往怀里一缩，尾巴尖还露在外面）\n才、才没有很可爱呢',
      },
    ],
  })
  await h.end()
  assert.equal(h.sent.length, 1)
  assert.ok(h.sent[0].includes('才、才没有很可爱呢'))
})

test('兜底开关关掉就一句都不发', async () => {
  const h = harnessFallback({ fallback: false })
  await h.fire({ content: [{ type: 'text', text: '本姑娘在呢' }] })
  await h.end()
  assert.deepEqual(h.sent, [])
})

test('11-05 现场：正文空、成品留在思考末尾 → 捞回来发出去', async () => {
  const h = harnessFallback()
  await h.fire({
    content: [
      {
        type: 'reasoning',
        text: [
          '她说记仇还挺正常。',
          '我可以说：不过他把疤留在脸上，这个做法不太一样——不是记住，是每天照镜子都看见。',
          '短。',
          '「不过他不是记在本子上，是刻在自己脸上」——好。',
          '发。不过他不是记在纸上，是留在自己脸上——每天照镜子都能看见',
        ].join('\n\n'),
      },
    ],
  })
  assert.deepEqual(h.sent, [])
  await h.end()
  assert.deepEqual(h.sent, ['不过他不是记在纸上，是留在自己脸上——每天照镜子都能看见'])
})

test('11-05 反例：思考里只有盘算、没有成品 → 一个字都不发', async () => {
  const h = harnessFallback()
  await h.fire({
    content: [
      {
        type: 'reasoning',
        text: ['她说记仇还挺正常。', '要不要问一句？', '「再加一点温度」，但别太长。'].join('\n\n'),
      },
    ],
  })
  await h.end()
  assert.deepEqual(h.sent, [])
})
