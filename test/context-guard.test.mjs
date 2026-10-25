/**
 * context-guard 自检脚本（不依赖测试框架）：
 *   node test/context-guard.test.mjs
 *
 * 覆盖：压力事件记账、压缩后补规矩、阈值以下不换、超阈值换会话 + 写记忆文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextGuard } from '../src/context-guard.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-guard-'))
const injected = []
const resetCalls = []
const record = {
  sessionId: 's1',
  key: 'k',
  scope: 'private',
  peerId: '10003',
  label: '私聊 主人(10003)',
  dir,
  recent: ['[主人] 晚上好', '[助手] 主人晚上好'],
  history: [],
  chatPromptInjected: true,
  busy: 0,
  agent: { inject: (message) => injected.push(message) },
}
const manager = {
  find: (id) => (id === 's1' ? record : null),
  reset: (r) => {
    resetCalls.push(r.sessionId)
    return true
  },
}
const config = {
  contextGuard: true,
  contextSwapRatio: 0.7,
  contextSwapMinTokens: 1000,
  contextMemoryKeep: 5,
  ownerLabel: '主人',
}
const logger = { info() {}, warn() {}, debug() {} }
const guard = createContextGuard({ manager, config, logger })

// 1) request/context 记窗口
guard.onSessionEvent({ header: { id: 's1' } }, { type: 'request/context', data: { contextWindow: 100000 } })
assert.equal(record.contextWindow, 100000)

// 2) assistant/message 记压力（prompt = input + cacheRead；**不含 output**）
//    设计上只看「下一轮要重新付钱的输入」：output 是这轮刚生成的，
//    下一轮不一定整段回灌，算进去会高估压力、提前换会话（见 context-guard.js:65-66）。
guard.onSessionEvent(
  { header: { id: 's1' } },
  { type: 'assistant/message', data: { usage: { inputTokens: 500, cacheReadTokens: 9500, outputTokens: 100 } } },
)
assert.equal(record.promptTokens, 10000)

// 3) 压缩结束：规矩标记重置 + 注入短卡
guard.onSessionEvent({ header: { id: 's1' } }, { type: 'compaction/end', data: {} })
assert.equal(record.chatPromptInjected, false)
assert.equal(injected.length, 1)
assert.match(injected[0].content[0].text, /压缩/)
assert.equal(record.compactedCount, 1)

// 4) 阈值以下：不换（测试 config 的 minTokens=1000，先压到 500）
record.promptTokens = 500
assert.equal(await guard.maybeSwap(record), null)

// 5) 超阈值：换会话，返回 seed
record.promptTokens = 80000
const seed = await guard.maybeSwap(record)
assert.ok(Array.isArray(seed), 'should return seed array')
assert.deepEqual(resetCalls, ['s1'])

// 6) 记忆文件落到 记忆区/压缩记忆/
const memoryDir = join(dir, '记忆区', '压缩记忆')
const files = await readdir(memoryDir)
assert.equal(files.length, 1)
assert.match(files[0], /^聊天记忆-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/)
const body = await readFile(join(memoryDir, files[0]), 'utf8')
assert.match(body, /私聊 主人/)
assert.match(body, /晚上好/)

// 7) busy 时不换
const record2 = { ...record, sessionId: 's2', busy: 1, promptTokens: 90000 }
const guard2 = createContextGuard({
  manager: { find: () => record2, reset: () => assert.fail('busy 时不应 reset') },
  config,
  logger,
})
assert.equal(await guard2.maybeSwap(record2), null)

console.log('context-guard: all checks passed')
