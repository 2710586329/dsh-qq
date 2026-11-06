import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isBareAck } from '../src/inbound.js'
import { salvageFromReasoning } from '../src/outbound.js'

/**
 * 2026-11-06：治「自我推演」。
 *
 * 病根不是模型坏了，是「私聊必回 + 只能靠想」挤出来的：她发一个「嗯」，也开一整轮；
 * 输入信息量太低，模型只好自己补一句「她其实想说什么」，再照着补出来的那句回。
 * 补出来的对白一旦被 salvage 兜底捞出去，就是替她说话、真发到 QQ。
 *
 * 两道护栏：
 *   ① 私聊短附和不开轮（没回合就没排练场）；
 *   ② salvage 不许捞「她说…我回…」这种排练对白。
 */

test('isBareAck：语气词认得出来，真话不误伤', () => {
  for (const t of ['嗯', '嗯嗯', '哦', '好', '好的', '行', '在', '呀', '哈哈', 'hhh', 'ok', 'OK', '对', '是的', '好哒', '嗯。', '好~'])
    assert.equal(isBareAck(t), true, `${t} 应该算短附和`)

  for (const t of ['在吗', '你好', '干嘛呢', '嗯你说', '姐姐', '那你说说', '算了', '', '   ', '？', '。。。'])
    assert.equal(isBareAck(t), false, `${t} 不该算短附和`)
})

test('salvageFromReasoning：排练对白一个字都不捞', () => {
  const rehearsals = [
    '她说嗯，我回：那本姑娘就不走了。',
    '她说「你不需要干活」，所以我回一句「明白了」。',
    '她可能是想让我别接话了。',
    '我回：好，那就不说了。',
    '定：不接，等她先开口。',
    '她说要不要撤，那就回撤吧。',
    '我答她一句就好。',
  ]
  for (const t of rehearsals) {
    assert.equal(salvageFromReasoning({ content: [{ type: 'reasoning', text: t }] }), '', `不该捞：${t}`)
  }
})

test('salvageFromReasoning：真成品对白照旧能捞（别把功能改死）', () => {
  const cases = [
    '发。那我先去忙了，饭好了叫我。',
    '那就说：行，本姑娘等你。',
    '发。外面风大，记得穿外套。',
  ]
  for (const t of cases) {
    const got = salvageFromReasoning({ content: [{ type: 'reasoning', text: t }] })
    assert.ok(got.length > 0, `应该捞得到：${t}`)
  }
})
