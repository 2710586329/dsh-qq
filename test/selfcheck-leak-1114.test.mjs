import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripLeakedThinking } from '../src/sanitize.js'

/**
 * 2026-11-14 19:0x，老二私聊连续四条把「这一句怎么发」的自我交代写进了正文，
 * QQ 里收到的是整段草稿（姐姐截图）。dump 出来的 content 原文如下——
 * 注意它是**正文**，不是 reasoning；旧规则只认英文自评和「嗯，…」，一条都没命中。
 */

const RAW_1902 = `不过规则：「对方没接就先停着，不追」。不是追，是一天里第二条。可以。

发吧。



天都黑了，这半天没听见响动——晚饭吃过了没

这是问句，没解释。好。发。

核对一下：正文只一句。可以。

天都黑了，这半天没听见响动——晚饭吃过了没`

test('2026-11-14 19:02 老二：中文自检句整行丢，重复句只留一份', () => {
  assert.equal(stripLeakedThinking(RAW_1902), '天都黑了，这半天没听见响动——晚饭吃过了没')
})

test('2026-11-14 19:07 老二：`这一段重复了，最终发一条干净的：` 整行丢', () => {
  const raw = `本姑娘这碗里还是白米饭呢

这一段重复了，最终发一条干净的：

本姑娘这碗里还是白米饭呢`
  assert.equal(stripLeakedThinking(raw), '本姑娘这碗里还是白米饭呢')
})

test('同样的草稿不带空行（挤在一起）也要清干净', () => {
  const raw = `不过规则：「对方没接就先停着，不追」。不是追，是一天里第二条。可以。
发吧。
天都黑了，这半天没听见响动——晚饭吃过了没
这是问句，没解释。好。发。
核对一下：正文只一句。可以。
天都黑了，这半天没听见响动——晚饭吃过了没`
  assert.equal(stripLeakedThinking(raw), '天都黑了，这半天没听见响动——晚饭吃过了没')
})

test('单行「可以。」是正常答话，不能当自评丢掉', () => {
  assert.equal(stripLeakedThinking('可以。'), '可以。')
})

test('带「你」的收尾句不丢（那是真在跟她说话）', () => {
  assert.equal(stripLeakedThinking('那就这样，你看看可以。'), '那就这样，你看看可以。')
})

test('正常多行正文不能被误伤', () => {
  const raw = `今天外头风挺大。

你要出门记得加件外套。

回来路上买点热的喝。`
  assert.equal(stripLeakedThinking(raw), raw)
})
