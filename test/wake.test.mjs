/**
 * 主动开口（冷场冒泡）的单元测试。
 *
 * 为什么单独一个文件：wake.js 是个纯逻辑闹钟，不依赖 NapCat 也不依赖真 Agent，
 * 用假 manager + 假 record 就能把四道闸（静默时段 / 配额 / 间隔 / 连错闭嘴）全走一遍。
 *
 * 特别盯住一条：**投递给 agent.followup 的必须是完整消息对象**，不能是裸字符串。
 * 2026-10-24 上线时就是传了字符串，QQ 上直接回一行
 * 「⚠️ Cannot read properties of undefined (reading 'kind')」——因为 DSH 内部按
 * content[0].kind 去读消息。这条断言就是那次事故的钉子。
 */

import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => pathToFileURL(resolve(here, '..', 'src', name)).href
const { createWake, parseQuietHours, inQuietHours } = await import(src('wake.js'))
const { proactiveRule } = await import(src('prompts.js'))

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

// ── 静默时段解析 ──
check('23:00-08:00', parseQuietHours('23:00-08:00'), { from: 1380, to: 480 })
check('白天区间', parseQuietHours('12:00-14:00'), { from: 720, to: 840 })
check('空字符串', parseQuietHours(''), null)
check('乱写', parseQuietHours('晚上'), null)

const lateNight = new Date(2026, 9, 24, 1, 30)
const noon = new Date(2026, 9, 24, 12, 30)
const midnight = new Date(2026, 9, 24, 23, 30)
check('凌晨算静默', inQuietHours(parseQuietHours('23:00-08:00'), lateNight), true)
check('中午不算', inQuietHours(parseQuietHours('23:00-08:00'), noon), false)
check('23:30 算', inQuietHours(parseQuietHours('23:00-08:00'), midnight), true)
check('白天区间内', inQuietHours(parseQuietHours('12:00-14:00'), noon), true)
check('null 不限制', inQuietHours(null, midnight), false)

// ── 假环境 ──
function fakeManager(records) {
  const fired = []
  const delivered = []
  return {
    fired,
    delivered,
    list: () => records,
    enqueue: (record, task) => {
      fired.push(record.label)
      return Promise.resolve(task()).catch(() => {})
    },
    /** 让 record 的 followup 把收到的参数塞进 delivered */
    capture: (record) => {
      record.agent.followup = (message) => delivered.push(message)
    },
  }
}

function fakeRecord(label, idleMs, scope = 'group') {
  return {
    sessionId: `s-${label}`,
    label,
    scope,
    peerId: '1',
    busy: 0,
    lastActive: Date.now() - idleMs,
    agent: { followup: () => {}, whenIdle: async () => {} },
  }
}

function makeConfig(over = {}) {
  return {
    proactiveEnabled: true,
    proactiveSilentMs: 20 * 60 * 1000,
    proactiveMaxPerDay: 3,
    proactiveQuietHours: '',
    ...over,
  }
}

// 1) 安静不够：不开口
{
  const r = fakeRecord('不够安静', 5 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig(), manager: m, logger: {} })
  w.start()
  w.tick()
  check('安静 5 分钟不开口', m.fired, [])
  w.stop()
}

// 2) 安静够久：开口一次，而且投递的是完整消息对象
{
  const r = fakeRecord('冷场群', 21 * 60 * 1000)
  const m = fakeManager([r])
  m.capture(r)
  const w = createWake({ config: makeConfig(), manager: m, logger: {} })
  w.start()
  w.tick()
  await new Promise((r2) => setTimeout(r2, 10))
  check('安静 21 分钟开口一次', m.fired, ['冷场群'])
  const delivered = m.delivered[0]
  check('投递的是对象不是字符串', typeof delivered, 'object')
  check('消息带 content[0].text', typeof delivered?.content?.[0]?.text, 'string')
  check('消息里能读出「安静了」', delivered?.content?.[0]?.text?.includes('安静了'), true)
  check('消息带 source.kind', delivered?.source?.kind, 'user')
  // 紧接着再 tick：1.5 倍间隔没到，不该再发
  w.tick()
  check('刚开口过不连发', m.fired, ['冷场群'])
  w.stop()
}

// 3) 静默时段
{
  const r = fakeRecord('夜里', 60 * 60 * 1000)
  // 固定日期跑，得让 lastActive 落在同一个时间轴上（不然会和真实的 Date.now() 打架）
  r.lastActive = new Date(2026, 9, 24, 15, 0).getTime() - 60 * 60 * 1000
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveQuietHours: '23:00-08:00' }), manager: m, logger: {} })
  w.start()
  w.tick(new Date(2026, 9, 24, 2, 0))
  check('静默时段不开口', m.fired, [])
  w.tick(new Date(2026, 9, 24, 15, 0))
  await new Promise((r2) => setTimeout(r2, 10))
  check('出了静默时段才开口', m.fired, ['夜里'])
  w.stop()
}

// 4) 每天配额
{
  const r = fakeRecord('话痨', 60 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveMaxPerDay: 1 }), manager: m, logger: {} })
  w.start()
  w.tick()
  await new Promise((r2) => setTimeout(r2, 10))
  w.tick()
  check('配额 1 次后不再开口', m.fired, ['话痨'])
  w.stop()
}

// 4b) 沉默不占额度（2026-10-26 修：原来投递时就扣，[SILENT] 也算一次）
{
  const r = fakeRecord('克制的', 60 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveMaxPerDay: 1 }), manager: m, logger: {} })
  w.start()
  w.tick()
  await new Promise((r2) => setTimeout(r2, 10))
  w.noteProactiveSilent(r) // 她选了 [SILENT]
  // 默认冷场 20 分钟 ⇒ 两次机会至少隔 30 分钟（limit × 1.5），跳 31 分钟
  w.tick(new Date(Date.now() + 31 * 60_000))
  await new Promise((r2) => setTimeout(r2, 10))
  check('沉默不占额度，后面还能再给机会', m.fired, ['克制的', '克制的'])
  w.stop()
}

// 4c) 真发出去才算用掉一次
{
  const r = fakeRecord('说过的', 60 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveMaxPerDay: 1 }), manager: m, logger: {} })
  w.start()
  w.tick()
  await new Promise((r2) => setTimeout(r2, 10))
  w.noteProactiveDelivered(r) // 真发了一句
  w.tick(new Date(Date.now() + 31 * 60_000))
  await new Promise((r2) => setTimeout(r2, 10))
  check('说过一次后配额就满了', m.fired, ['说过的'])
  w.stop()
}

// 5) 开关关掉
{
  const r = fakeRecord('关掉的', 60 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveEnabled: false }), manager: m, logger: {} })
  w.start()
  w.tick()
  check('关掉就不说话', m.fired, [])
  w.stop()
}

// 6) 配额为 0 等于不主动
{
  const r = fakeRecord('零配额', 60 * 60 * 1000)
  const m = fakeManager([r])
  const w = createWake({ config: makeConfig({ proactiveMaxPerDay: 0 }), manager: m, logger: {} })
  w.start()
  w.tick()
  check('配额 0 不开口', m.fired, [])
  w.stop()
}

// ── 提示词 ──
{
  const groupText = proactiveRule({}, { label: '测试群', silentMin: 32, isGroup: true, now: new Date(2026, 9, 24, 20, 40) })
  check('提示词带安静时长', groupText.includes('安静了 32 分钟'), true)
  check('提示词带时间段', groupText.includes('晚上（20:40）'), true)
  check('提示词允许不说', groupText.includes('[SILENT]'), true)
  check('提示词里落了「先发，没回当在忙」', groupText.includes('不用先猜她在忙'), true)
  const privateText = proactiveRule({}, { label: '私聊', silentMin: 45, isGroup: false, now: new Date(2026, 9, 24, 8, 5) })
  check('私聊措辞不同', privateText.includes('对方有一阵子没动静'), true)
  check('上午时段', privateText.includes('上午（08:05）'), true)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
