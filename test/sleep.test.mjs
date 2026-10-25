/**
 * 作息（睡前提醒 / 晚安静默 / 夜里消息留到早上）的单元测试。
 *
 * 跟 wake.test.mjs 同一个套路：纯逻辑 + 假 manager，时钟靠参数注入，不碰真网络。
 * 盯住两条：
 *   1. 夜里收到的消息**一条都不能漏**，早上要一次性交出去（漏了就是丢消息）。
 *   2. 投递的必须是完整消息对象，不是裸字符串（2026-10-24 那次 reading 'kind' 的事故）。
 */

import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => pathToFileURL(resolve(here, '..', 'src', name)).href
const { createSleep, parseHm, inRange, looksLikeGoodnight } = await import(src('sleep.js'))

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`✗ ${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
  }
  return ok
}

// ── 时间解析 ──
check('23:30', parseHm('23:30'), 1410)
check('08:00', parseHm('08:00'), 480)
check('00:00', parseHm('00:00'), 0)
check('乱写', parseHm('夜里'), null)
check('25:00', parseHm('25:00'), null)

// ── 区间（含跨零点） ──
check('00:00-08:00 内 01:30', inRange(0, 480, 90), true)
check('00:00-08:00 边界 08:00', inRange(0, 480, 480), false)
check('23:00-08:00 跨零点 01:30', inRange(1380, 480, 90), true)
check('23:00-08:00 白天 12:00', inRange(1380, 480, 720), false)

// ── 晚安识别 ──
const words = ['晚安', '睡了', '睡觉', '去睡', '我先睡', '困了', '睡啦']
check('晚安', looksLikeGoodnight('晚安', words), true)
check('我去睡啦', looksLikeGoodnight('我去睡啦，明天聊', words), true)
check('聊晚安话题不算', looksLikeGoodnight('你上次说的晚安是什么意思来着我想听听你的解释', words), false)
check('空', looksLikeGoodnight('', words), false)

// ── 假环境 ──
function fakeManager(records) {
  const delivered = []
  return {
    delivered,
    list: () => records,
    enqueue: (record, task) => Promise.resolve(task()).catch(() => {}),
    capture: (record) => {
      record.agent.followup = (message) => delivered.push(message)
    },
  }
}

function fakeRecord(label, scope = 'private') {
  return {
    sessionId: `s-${label}`,
    label,
    scope,
    peerId: '1',
    busy: 0,
    lastActive: Date.now(),
    agent: { followup: () => {}, whenIdle: async () => {} },
  }
}

function makeConfig(over = {}) {
  return {
    sleepMode: true,
    // 测试的是「夜里捂住」这条路径；线上的默认值现在是 false（半夜说话说明她醒了）
    holdNightMessages: true,
    bedtimeAt: '23:30',
    sleepFrom: '00:00',
    sleepTo: '08:00',
    goodnightWords: words.join(','),
    ...over,
  }
}

const textOf = (message) => message?.content?.[0]?.text ?? ''

// 1) 休息时段内该捂住；白天不捂；群聊不捂
{
  const r = fakeRecord('私聊甲')
  const m = fakeManager([r])
  const s = createSleep({ config: makeConfig(), manager: m, logger: {} })
  check('凌晨 01:30 要捂住', s.shouldHold(r, new Date(2026, 9, 25, 1, 30)), true)
  check('早上 09:00 不捂', s.shouldHold(r, new Date(2026, 9, 25, 9, 0)), false)
  const g = fakeRecord('群甲', 'group')
  check('群聊不捂', s.shouldHold(g, new Date(2026, 9, 25, 1, 30)), false)
}

// 2) 白天说晚安 → 之后捂住，直到明早
{
  const r = fakeRecord('私聊乙')
  const m = fakeManager([r])
  const s = createSleep({ config: makeConfig(), manager: m, logger: {} })
  const at = new Date(2026, 9, 24, 23, 30)
  check('说晚安前不捂', s.shouldHold(r, at), false)
  s.noteText(r, '本姑娘去睡啦', at)
  check('说完晚安要捂', s.shouldHold(r, new Date(2026, 9, 24, 23, 45)), true)
  check('第二天 08:00 之后放开', s.shouldHold(r, new Date(2026, 9, 25, 8, 30)), false)
}

// 3) 夜里的消息攒着，早上一次性交出去（一条都不许漏）
{
  const r = fakeRecord('私聊丙')
  const m = fakeManager([r])
  m.capture(r)
  const s = createSleep({ config: makeConfig(), manager: m, logger: {} })
  s.start()
  s.hold(r, '睡不着', new Date(2026, 9, 25, 2, 10))
  s.hold(r, '你睡了吗', new Date(2026, 9, 25, 2, 40))
  check('夜里没投递', m.delivered.length, 0)
  s.tick(new Date(2026, 9, 25, 7, 50))
  check('还没出窗口不投', m.delivered.length, 0)
  s.tick(new Date(2026, 9, 25, 8, 0))
  await new Promise((r2) => setTimeout(r2, 10))
  check('早上投了一轮', m.delivered.length, 1)
  const text = textOf(m.delivered[0])
  check('投递的是完整消息对象', typeof m.delivered[0], 'object')
  check('带上了第一条', text.includes('睡不着'), true)
  check('带上了第二条', text.includes('你睡了吗'), true)
  check('说明是昨晚的', text.includes('昨晚'), true)
  check('没重复投递', (s.tick(new Date(2026, 9, 25, 8, 5)), m.delivered.length), 1)
  s.stop()
}

// 4) 到点提醒睡觉：一天只提醒一次，且休息时段内不提醒
{
  const r = fakeRecord('私聊丁')
  const m = fakeManager([r])
  m.capture(r)
  const s = createSleep({ config: makeConfig(), manager: m, logger: {} })
  s.start()
  s.tick(new Date(2026, 9, 24, 23, 29))
  check('没到点不提醒', m.delivered.length, 0)
  s.tick(new Date(2026, 9, 24, 23, 30))
  await new Promise((r2) => setTimeout(r2, 10))
  check('到点提醒一次', m.delivered.length, 1)
  check('提醒里说要睡了', textOf(m.delivered[0]).includes('该睡'), true)
  s.tick(new Date(2026, 9, 24, 23, 31))
  await new Promise((r2) => setTimeout(r2, 10))
  check('同一天不念第二遍', m.delivered.length, 1)
  s.stop()
}

// 5) 总开关关掉：什么都不做
{
  const r = fakeRecord('私聊戊')
  const m = fakeManager([r])
  m.capture(r)
  const s = createSleep({ config: makeConfig({ sleepMode: false }), manager: m, logger: {} })
  s.start()
  check('关掉后不捂', s.shouldHold(r, new Date(2026, 9, 25, 2, 0)), false)
  s.hold(r, '夜里的话', new Date(2026, 9, 25, 2, 0))
  s.tick(new Date(2026, 9, 25, 23, 30))
  await new Promise((r2) => setTimeout(r2, 10))
  check('关掉后不投递', m.delivered.length, 0)
  s.stop()
}

console.log(`\n作息测试：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
