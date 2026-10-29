import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { extractText, stripLeakedThinking } from '../src/outbound.js'
import { stripSilentMark } from '../src/prompts.js'

/**
 * 2026-10-28 12:38 事故：主动机会那一轮，老三只输出「不说」，
 * 可姐姐在 QQ 上收到的却是她的心里话：
 *
 *   「21 分钟没动静，可能在午睡。别打扰。沉默。」
 *
 * 路径：正文块 = 那句心里话 + [SILENT]。
 * stripLeakedThinking 先看到 [SILENT]——一个汉字都没有，被
 * `if (!HAS_CJK.test(t) && t.length >= 4) return ''` 当成「不是话」整行丢掉；
 * 剩下那句心里话就对上了「正文」，一路走到 send() 发了出去。
 * 同一形状 10:41 也发过一次（「20 分钟没动静。刚才那条俏皮话她没回…」）。
 *
 * 修法：正文里只要出现 [SILENT]，整条都不发，不看前后还写了什么。
 */

const ACCIDENT = {
  content: [{ type: 'text', text: '21 分钟没动静，可能在午睡。别打扰。沉默。\n[SILENT]' }],
}

test('事故复现：只靠 stripLeakedThinking，心里话会被当成正文留下', () => {
  const cleaned = stripLeakedThinking(extractText(ACCIDENT))
  assert.match(cleaned, /21 分钟没动静/, '旧路径：这句心里话会被当成正文发出去')
  assert.doesNotMatch(cleaned, /\[SILENT\]/, '标记被「没汉字不算话」那条规则丢掉了')
})

test('正文带 [SILENT] 的三种写法都能被认出来', () => {
  const cases = [
    { content: [{ type: 'text', text: '[SILENT]' }] },
    ACCIDENT,
    { content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '[SILENT]\n本姑娘不说话了' }] },
  ]
  for (const message of cases) {
    assert.ok(extractText(message).includes('[SILENT]'), '这一条正文里确实带标记')
  }
})

test('接线检查：沉默拦截必须排在 stripLeakedThinking 之前', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  const idxSilent = src.indexOf('rawText.includes(SILENT_MARKER)')
  const idxStrip = src.indexOf('let text = stripLeakedThinking(rawText)')
  assert.ok(idxSilent > 0, '「正文带 [SILENT] 就整条沉默」那道闸不见了')
  assert.ok(idxStrip > idxSilent, '闸必须在 stripLeakedThinking 前面，否则标记先被剥丢了')
  const block = src.slice(idxSilent, idxStrip)
  assert.match(block, /noteProactiveSilent/, '主动机会的额度要还回去（沉默不扣额度）')
  assert.match(block, /return/, '认出来就整条不发')
})

test('send 层的老兜底还在：整条只有标记时剥成空', () => {
  assert.equal(stripSilentMark('[SILENT]'), '')
  assert.equal(stripSilentMark('  [SILENT]  '), '')
})
