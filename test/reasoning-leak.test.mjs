import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { hasToolUse, reasoningTail } from '../src/outbound.js'

/**
 * 2026-10-27 09:42 事故：姐姐把老三的思考链直接收到了 QQ 上。
 *
 * 那轮她只是调 edit 改日记，一个 text 块都没有；`reasoningTail()` 兜底逻辑
 * （原本救「模型把话全写在 reasoning 里、正文空」那种轮）就把 reasoning 里的
 * 盘算整段捞出来当正文发了：日志 09:42:36「检查目录。」/ 09:42:43「…所以只回 [SILENT]。先 edit。」
 *
 * 护栏：**带工具调用的 assistant 消息，不许 reasoning 兜底**。
 * 工具轮里的 reasoning 就是"动手前想的那套"，跟她说的话不是一回事。
 */

// 09:42 那轮真实的 reasoning 原文（贴图里的整段，一字未改）
const REAL_REASONING = [
  '日记已经记到今天 08:51 了。看来我自己（或之前的轮次）写过了？等等——这日记写到了 08:51，包括我刚才的话。是我自己写的？我没写过。可能是这个会话的某个自动过程……不过内容准确。',
  '也许这是「上一轮我在思考之外做的」？不，我没写过。可能是隐藏的记忆机制。',
  '不管。日记已到 08:51，我需要补 09:12、09:13、09:42 这几段？09:12 我发了关心，09:13 她回「这是你们的大事」。那值得补一小段。',
  '要不要补？规范：一天一篇，有新内容就记。加一小节 09:12–09:13。',
  '补一小段，然后不发声（这轮是主动机会，我选择静默，但做日记实事是可以的）。',
].join('\n\n')

test('hasToolUse：认得出工具块，不误伤 text / reasoning', () => {
  assert.equal(hasToolUse({ content: [{ type: 'text', text: '好' }, { type: 'tool_use', name: 'read' }] }), true)
  assert.equal(hasToolUse({ content: [{ type: 'tool-call', name: 'edit' }] }), true)
  assert.equal(hasToolUse({ content: [{ type: 'function_call' }] }), true)
  assert.equal(hasToolUse({ content: [{ type: 'text', text: '好' }] }), false)
  assert.equal(hasToolUse({ content: [{ type: 'reasoning', text: '想' }] }), false)
  assert.equal(hasToolUse({}), false)
  assert.equal(hasToolUse(null), false)
})

test('09:42 那轮的 reasoning 确实会被 reasoningTail 捞出来（这就是泄漏路径）', () => {
  const message = { content: [{ type: 'reasoning', text: REAL_REASONING }, { type: 'tool_use', name: 'edit' }] }
  const tail = reasoningTail(message)
  assert.ok(tail.length > 0, '兜底逻辑本来就会吐出内容——所以必须靠 hasToolUse 拦住')
  assert.match(tail, /静默|补一小段|日记/)
})

test('带工具调用的消息：有 reasoning、没 text —— 护栏必须挡住兜底', () => {
  const message = { content: [{ type: 'reasoning', text: REAL_REASONING }, { type: 'tool_use', name: 'edit' }] }
  // 复刻 outbound.js 里那行：if (!text && !hasToolUse(data.message)) text = reasoningTail(...)
  let text = ''
  if (!text && !hasToolUse(message)) text = reasoningTail(message)
  assert.equal(text, '', '带工具的轮次不该从 reasoning 里捞出任何正文')
})

test('不带工具的消息：还救得回来（别把上一轮的修复弄丢）', () => {
  const message = { content: [{ type: 'reasoning', text: 'Good. 揉得本姑娘有点晕\n\n不过不喊停' }] }
  let text = ''
  if (!text && !hasToolUse(message)) text = reasoningTail(message)
  assert.ok(text.includes('不过不喊停'), '真·把话写进 reasoning 的那种轮，仍然要兜底')
})

test('接线检查：outbound.js 的兜底那行必须带 hasToolUse 护栏', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  assert.match(src, /if \(!text && !hasToolUse\(data\.message\)\) text = reasoningTail\(data\.message\)/)
})

test('接线检查：带工具调用的 assistant/message 整条不发（09:53 结构性根治）', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  const idx = src.indexOf("if (type === 'assistant/message')")
  assert.ok(idx > 0)
  const branch = src.slice(idx, idx + 900)
  assert.match(branch, /if \(hasToolUse\(data\.message\)\) \{/, '带工具的那条消息要在发送前就被挡掉，而不是清洗文字')
  assert.ok(branch.indexOf('hasToolUse(data.message)') < branch.indexOf('text = stripLeakedThinking'), '拦住的位置必须在清洗/发送之前')
})
