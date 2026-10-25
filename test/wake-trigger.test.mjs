/**
 * 群聊「非 @ 叫醒」判定 —— 自测。
 * 跑法：node test/wake-trigger.test.mjs
 */
import assert from 'node:assert/strict'
import {
  evaluateWakeTrigger,
  isDirectedAtAi,
  rollWakeProbability,
  isAddressedWake,
} from '../src/wake-trigger.js'

let pass = 0
let fail = 0
const cases = []

function check(name, fn) {
  cases.push([name, fn])
}

function eq(actual, expected) {
  assert.deepEqual(actual, expected)
}

const NAMES = ['鲸鲸', '大肥鱼', '鲸鱼娘', '鲸鲸的QQ']
const TRIGGERS = { nameMention: true, question: true, keywords: [] }

// ── 基本：@ 与引用 ──
check('@ 我 → atMention', () => {
  eq(evaluateWakeTrigger({ plainText: '在吗', atMe: true, quotedMe: false, names: NAMES, triggers: TRIGGERS }), 'atMention')
})

check('引用我 → atMention', () => {
  eq(evaluateWakeTrigger({ plainText: '这个怎么弄', atMe: false, quotedMe: true, names: NAMES, triggers: TRIGGERS }), 'atMention')
})

// ── 叫名字 ──
check('叫「大肥鱼」→ nameMention', () => {
  eq(
    evaluateWakeTrigger({ plainText: '大肥鱼，这白毛是谁', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'nameMention',
  )
})

check('叫「鲸鲸」→ nameMention', () => {
  eq(
    evaluateWakeTrigger({ plainText: '鲸鲸你觉得呢', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'nameMention',
  )
})

check('名字开关关掉就不认', () => {
  eq(
    evaluateWakeTrigger({
      plainText: '大肥鱼，这白毛是谁',
      atMe: false,
      quotedMe: false,
      names: NAMES,
      triggers: { nameMention: false, question: false, keywords: [] },
    }),
    null,
  )
})

check('单字名字不参与匹配（防误伤）', () => {
  eq(
    evaluateWakeTrigger({ plainText: '鲸好大', atMe: false, quotedMe: false, names: ['鲸'], triggers: TRIGGERS }),
    null,
  )
})

// ── 关键词 ──
check('中文关键词命中', () => {
  eq(
    evaluateWakeTrigger({
      plainText: '那个白毛角色是谁画的',
      atMe: false,
      quotedMe: false,
      names: NAMES,
      triggers: { ...TRIGGERS, keywords: ['白毛'] },
    }),
    'keyword:白毛',
  )
})

check('短英文关键词按词边界：DS 命中', () => {
  eq(
    evaluateWakeTrigger({
      plainText: 'DS 今天又降价了',
      atMe: false,
      quotedMe: false,
      names: NAMES,
      triggers: { ...TRIGGERS, keywords: ['ds'] },
    }),
    'keyword:ds',
  )
})

check('短英文关键词不误伤 ADS / BDSM / DSL', () => {
  for (const text of ['这 ADS 很有用', 'BDSM 是啥', '学 DSL 呢']) {
    eq(
      evaluateWakeTrigger({
        plainText: text,
        atMe: false,
        quotedMe: false,
        names: NAMES,
        triggers: { ...TRIGGERS, keywords: ['ds'] },
      }),
      null,
    )
  }
})

// ── 提问 ──
check('「你行不行」→ question', () => {
  eq(
    evaluateWakeTrigger({ plainText: '你行不行啊', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'question',
  )
})

check('「在不在」→ question（催人专用）', () => {
  eq(
    evaluateWakeTrigger({ plainText: '在不在', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'question',
  )
})

check('「理我」→ question', () => {
  eq(
    evaluateWakeTrigger({ plainText: '理我一下嘛', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'question',
  )
})

check('「deepseek 行不行」→ question', () => {
  eq(
    evaluateWakeTrigger({ plainText: 'deepseek 行不行啊', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'question',
  )
})

check('「你是真人吗」→ question', () => {
  eq(
    evaluateWakeTrigger({ plainText: '你是真人吗', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    'question',
  )
})

// ── 不该命中的 ──
check('纯闲聊不唤醒', () => {
  eq(
    evaluateWakeTrigger({ plainText: '今天天气不错', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    null,
  )
})

check('聊模型本身不算在问它', () => {
  eq(
    evaluateWakeTrigger({ plainText: 'GPT 便宜了不少', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }),
    null,
  )
})

check('提问开关关掉就不认', () => {
  eq(
    evaluateWakeTrigger({
      plainText: '你行不行啊',
      atMe: false,
      quotedMe: false,
      names: NAMES,
      triggers: { nameMention: true, question: false, keywords: [] },
    }),
    null,
  )
})

check('空文本不炸', () => {
  eq(evaluateWakeTrigger({ plainText: '', atMe: false, quotedMe: false, names: NAMES, triggers: TRIGGERS }), null)
  eq(evaluateWakeTrigger({}), null)
})

// ── isDirectedAtAi 单独 ──
check('isDirectedAtAi：催促句算', () => {
  eq(isDirectedAtAi('怎么不说话'), true)
  eq(isDirectedAtAi('别装死'), true)
})

check('isDirectedAtAi：普通陈述不算', () => {
  eq(isDirectedAtAi('我昨天去了趟超市'), false)
  eq(isDirectedAtAi('这个图挺好看的'), false)
})

// ── 概率 ──
check('概率 0 永远不掷中', () => {
  for (let i = 0; i < 50; i += 1) eq(rollWakeProbability(0), false)
})

check('概率 1 一定掷中', () => {
  eq(rollWakeProbability(1), true)
})

check('概率非法值当 0', () => {
  eq(rollWakeProbability(undefined), false)
  eq(rollWakeProbability('abc'), false)
  eq(rollWakeProbability(-1), false)
})

// ── 必回判定 ──
check('被叫名字/提问/关键词 → 必回', () => {
  eq(isAddressedWake('nameMention'), true)
  eq(isAddressedWake('question'), true)
  eq(isAddressedWake('keyword:白毛'), true)
  eq(isAddressedWake('atMention'), true)
})

check('概率唤醒 / null → 可沉默', () => {
  eq(isAddressedWake('probability'), false)
  eq(isAddressedWake(null), false)
  eq(isAddressedWake(undefined), false)
})

// ── 跑 ──
for (const [name, fn] of cases) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${err?.message || err}`)
  }
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail > 0) process.exitCode = 1
