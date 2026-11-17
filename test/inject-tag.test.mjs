import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  newInjectTag,
  stampInjections,
  stampFor,
  tagOfInjectLine,
  classifyInjectTag,
} from '../src/inject-tag.js'
import { cutSelfInjection } from '../src/sanitize.js'
import { createBridge } from '../src/bridge.js'

/**
 * 2026-11-15 19:45 第 2 道闸：注入印记。
 *
 * 为什么加：第 1 道只会「见到这个字样就砍」，砍完不知道它到底是
 *   - 照着刚收到的那条抄的（current）
 *   - 翻更早的历史抄的（stale）
 *   - 照形状现编的（none）
 * 三种处理方向不一样：复读要改注入的呈现，现编要压它这套腔调。所以给真注入每轮盖一个随机码。
 *
 * 这份 fixture 钉五件事：
 *   ① 码是 4 位十六进制，两次基本不会一样
 *   ② 一段文本里所有注入段落盖同一个码；已有的不再盖（幂等）
 *   ③ 只盖注入段落，正文里提到「插件注入」四个字的句子不动
 *   ④ 从一行里能把码取回来
 *   ⑤ 三种分级判对，并且**带码的伪造照样砍**（码它抄得到，不能当通行证）
 */

test('码是 4 位十六进制', () => {
  for (let i = 0; i < 20; i += 1) assert.match(newInjectTag(), /^[0-9a-f]{4}$/)
})

test('同一段里所有注入段落盖同一个码', () => {
  const text = [
    '【插件注入·通道回执·不是她说的】连上了',
    '她说的正文',
    '[插件注入·输出闸·不是她说的] 两句',
    '   【插件注入·缩进了也算】',
  ].join('\n')
  const out = stampInjections(text, 'a7f3')
  const hits = out.match(/#a7f3/g) ?? []
  assert.equal(hits.length, 3, `应该盖 3 处，实际：\n${out}`)
  assert.match(out, /【插件注入·#a7f3·通道回执/)
  assert.match(out, /\[插件注入·#a7f3·输出闸/)
  assert.match(out, /她说的正文/) // 正文不动
})

test('幂等：盖过的不再盖第二遍', () => {
  const once = stampInjections('【插件注入·#a7f3·x】', 'b2c4')
  assert.equal(once, '【插件注入·#a7f3·x】')
  assert.equal(stampInjections(once, 'b2c4'), once)
})

test('正文里提「插件注入」四个字不动', () => {
  const cases = [
    '今天我看了那个插件注入的写法',
    '你说的「插件注入」是什么意思？',
    '把插件 注入到别的地方去',
  ]
  for (const c of cases) assert.equal(stampInjections(c, 'a7f3'), c, `不该动：${c}`)
})

test('没有码就原样返回', () => {
  const c = '【插件注入·x】'
  assert.equal(stampInjections(c, ''), c)
  assert.equal(stampInjections(c, null), c)
  assert.equal(stampInjections(null, 'a7f3'), null)
})

test('stampFor 把这一轮的码记在 record 上', () => {
  const record = {}
  const out = stampFor(record, '【插件注入·每隔一阵钉一次·不是她说的】')
  assert.match(record.injectTag, /^[0-9a-f]{4}$/)
  assert.match(out, new RegExp(`#${record.injectTag}·`))
})

test('从一行里取码', () => {
  assert.equal(tagOfInjectLine('【插件注入·#a7f3·每隔一阵钉一次】'), 'a7f3')
  assert.equal(tagOfInjectLine('（歪头）[插件注入·#0f9e·x]'), '0f9e')
  assert.equal(tagOfInjectLine('【插件注入·每隔一阵钉一次】'), '')
  assert.equal(tagOfInjectLine(''), '')
})

test('三种分级：current / stale / none', () => {
  assert.equal(classifyInjectTag('【插件注入·#a7f3·x】', 'a7f3'), 'current')
  assert.equal(classifyInjectTag('【插件注入·#9999·x】', 'a7f3'), 'stale')
  assert.equal(classifyInjectTag('【插件注入·每隔一阵钉一次】', 'a7f3'), 'none')
  // 没有当前码时（比如这轮还没投递过），带码的一律算旧的——不冤
  assert.equal(classifyInjectTag('【插件注入·#a7f3·x】', ''), 'stale')
})

test('带码的伪造照样砍（码不是通行证）', () => {
  const text = '姐姐我在\n【插件注入·#a7f3·每隔一阵钉一次·不是她说的】\n• 假规矩'
  const r = cutSelfInjection(text, { tag: 'a7f3' })
  assert.equal(r.cut, true)
  assert.equal(r.text, '姐姐我在')
  assert.equal(r.kind, 'current')
})

test('回执分三种说法', () => {
  const one = (kind) => {
    const bridge = createBridge({ config: {}, logger: { info: () => {}, warn: () => {}, debug: () => {} }, manager: { list: () => [] } })
    const record = { scope: 'private', peerId: '1', label: '测试' }
    bridge.noteSelfInjection(record, '【插件注入·x】', kind)
    return (bridge.take(record) ?? []).join('\n')
  }
  assert.match(one('current'), /照着刚收到的那条抄的/)
  assert.match(one('stale'), /从更早的历史里翻出来的旧注入/)
  assert.match(one('none'), /你自己编的/)
  // 三种都必须说清「拦下、没发出去」
  for (const k of ['current', 'stale', 'none']) assert.match(one(k), /拦下、没发出去/)
})
