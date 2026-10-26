import assert from 'node:assert/strict'
import test from 'node:test'
import { createBridge, humanSpan } from '../src/bridge.js'

const quietLogger = { info() {}, warn() {} }

function makeManager(records = []) {
  return { list: () => records }
}

function makeRecord(label = '私聊 10001') {
  return { label, sessionId: `s-${label}`, bridgeNotes: [] }
}

test('发送失败：下一次投递带上「没送出去」+ 原文 + 原因', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })

  bridge.noteSendFailure(record, '姐姐在吗，刚才那件事我想了想', new Error('onebot 未连接（action=send_private_msg）'))

  const lines = bridge.take(record)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /没送出去/)
  assert.match(lines[0], /onebot 未连接/)
  assert.match(lines[1], /刚才那件事我想了想/)
  assert.match(lines[2], /不是对方不理你/)
  assert.match(lines[2], /一个字都没收到/)
})

test('取走即清空：同一件事不重复念叨', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })
  bridge.noteSendFailure(record, 'hi', new Error('boom'))
  assert.ok(bridge.take(record).length > 0)
  assert.deepEqual(bridge.take(record), [])
})

test('断线期间丢过话：恢复后告诉她断了多久、丢了几句', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })

  bridge.markDown()
  bridge.noteSendFailure(record, '第一句', new Error('未连接'))
  bridge.noteSendFailure(record, '第二句', new Error('未连接'))
  bridge.markUp()

  const lines = bridge.take(record)
  const all = lines.join('\n')
  assert.match(all, /连接断过/)
  assert.match(all, /你有 2 句话没能送出去/)
  assert.match(all, /「第一句」/)
  assert.match(all, /「第二句」/)
})

test('断线但没丢话：恢复后不打扰', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })

  bridge.markDown()
  bridge.markUp()

  assert.deepEqual(bridge.take(record), [])
})

test('没断过线也能收到单条失败的回执', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })
  assert.equal(bridge.isUp(), true)
  bridge.noteSendFailure(record, 'x', new Error('timeout'))
  const lines = bridge.take(record)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /你刚才那句话没送出去/)
  assert.match(lines[1], /「x」/)
})

test('失败太多只列前 4 句，并说明还有多少', () => {
  const record = makeRecord()
  const bridge = createBridge({ config: {}, logger: quietLogger, manager: makeManager([record]) })
  for (let i = 1; i <= 7; i += 1) bridge.noteSendFailure(record, `第${i}句`, new Error('未连接'))
  const lines = bridge.take(record)
  const body = lines.join('\n')
  assert.match(body, /你有 7 句话没能送出去/)
  assert.match(body, /第4句/)
  assert.doesNotMatch(body, /第5句/)
  assert.match(body, /还有 3 句没列出来/)
})

test('bridgeReceipt=false 全程静默', () => {
  const record = makeRecord()
  const bridge = createBridge({
    config: { bridgeReceipt: false },
    logger: quietLogger,
    manager: makeManager([record]),
  })
  bridge.markDown()
  bridge.noteSendFailure(record, 'x', new Error('boom'))
  bridge.markUp()
  assert.deepEqual(bridge.take(record), [])
})

test('humanSpan 说人话', () => {
  assert.equal(humanSpan(5_000), '5 秒')
  assert.equal(humanSpan(90_000), '2 分钟')
  assert.equal(humanSpan(3_600_000), '1 小时')
  assert.equal(humanSpan(5_400_000), '1 小时 30 分钟')
})
