import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 2026-11-06 20:35 姐姐定：同一句话 5 秒内不再发第二遍。
 *
 * 现场（老大，18:45:51）：
 *   工具 qq_send    {"text":"误判成什么了，把本姑娘当成挂了？"}
 *   我              误判成什么了，把本姑娘当成挂了？      ← 同一句又写进正文
 *   工具 qq_send    {"text":"误判成什么了，把本姑娘当成挂了？"}   ← 1 秒后又发一次
 * 姐姐手机上就是两条一模一样的消息。
 *
 * 修法两条：① 工具描述里写明「发完正文别再重复」；② 工具口按 5 秒窗口去重。
 * 这里只做接线断言——真正的行为要走 e2e，别在这里假装跑通了。
 */

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'tools.js'), 'utf8')

// ① 描述里得有一句明话，否则模型只能靠猜
assert.ok(
  src.includes('这一轮的正文不要再重复它'),
  'qq_send 的 description 里应该写明「发完这句之后，这一轮的正文不要再重复它」',
)

// ② 工具口要有去重判断，且窗口是 5 秒
assert.ok(src.includes('const lastSend = record._lastSend'), 'qq_send 里应该读 record._lastSend')
assert.ok(
  src.includes('lastSend.text === text') && src.includes('< 5000'),
  '去重判据应该是「文本完全相同 且 5 秒内」',
)

// ③ 发成功之后要把这句记下来，否则下一次无从比对
assert.ok(
  src.includes('record._lastSend = { text, at: Date.now(), messageId: sentId }'),
  'qq_send 发送成功后应该记下这句话，供下一次比对',
)

// ④ 跳过时也要记一行日志，事后能查
assert.ok(
  src.includes('qq_send 同一句话 5 秒内重复，跳过'),
  '跳过重复发送时应该留一行日志',
)

console.log('✔ qq-send-dedup 通过 3，失败 0')
