/**
 * 时间不再铺成信封（2026-11-06 姐姐定，学 AstrBot 的上下文形状）。
 *
 * 原来每一条交给 agent 的正文都是两行：
 *   `[现在是 2026-11-06 周五 19:12（晚上）]`
 *   `[姐姐] 我觉得他会接天劫`
 * 模型看到输入永远长这样、自己的输出却是纯文本，于是把这套信封当成「说话该有的格式」，
 * 学着往正文里写——老三 19:12 那次就是照着自己编的下一轮，说了我根本没说过的话。
 *
 * 现在只在「隔了一阵」的时候用一句圆括号提一下，间隔短就一个字都不给。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { gapNote } from '../src/inbound.js'

const MIN = 60 * 1000

test('会话第一条：给一句现在几点，不带日期和星期', () => {
  const at = new Date(2026, 10, 6, 19, 12).getTime()
  const note = gapNote(null, at)
  assert.equal(note, '（这会儿是 19:12）')
  assert.ok(!note.includes('2026'), '不该带年份')
  assert.ok(!note.includes('周'), '不该带星期')
})

test('隔了不到十分钟：什么都不给（连着说话不盖章）', () => {
  const now = new Date(2026, 10, 6, 19, 12).getTime()
  assert.equal(gapNote(now - 3 * MIN, now), '')
  assert.equal(gapNote(now - 9 * MIN - 59 * 1000, now), '')
})

test('隔了半小时：说隔了多久', () => {
  const now = new Date(2026, 10, 6, 19, 12).getTime()
  assert.equal(gapNote(now - 45 * MIN, now), '（隔了 45 分钟）')
})

test('隔了几个小时：按小时说', () => {
  const now = new Date(2026, 10, 6, 19, 12).getTime()
  assert.equal(gapNote(now - 2 * 60 * MIN, now), '（隔了 2 个小时）')
})

test('隔了大半天：补一句现在几点', () => {
  const now = new Date(2026, 10, 6, 19, 12).getTime()
  assert.equal(gapNote(now - 6 * 60 * MIN, now), '（隔了大半天，这会儿是 19:12）')
})

test('跨了一天：说明是第二天，免得它把昨天当成刚才', () => {
  const now = new Date(2026, 10, 6, 9, 5).getTime()
  const prev = new Date(2026, 10, 5, 23, 40).getTime()
  assert.equal(gapNote(prev, now), '（隔了一天了，这会儿是 09:05）')
})

test('结果是圆括号，不是行首方括号 —— 方括号那种形状会被当成可续写的信封', () => {
  const now = new Date(2026, 10, 6, 19, 12).getTime()
  for (const prev of [null, now - 30 * MIN, now - 5 * 60 * MIN, now - 30 * 60 * MIN]) {
    const note = gapNote(prev, now)
    if (!note) continue
    assert.ok(note.startsWith('（'), `应该以圆括号开头：${note}`)
    assert.ok(!note.includes('[现在是'), `不该再出现 [现在是：${note}`)
  }
})
