import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session.js'
import { deriveSessionId, sessionKey } from '../src/shared/session-id.js'

const tmpHome = () => mkdtempSync(join(tmpdir(), 'qq-session-reset-'))

/**
 * fake 宿主：`onDisk` 就是「磁盘上躺着哪些会话」。
 * resume 命中它才算接回；create 才写进它 —— 跟真 DSH 一样。
 */
function makeManager(home, workdir, onDisk) {
  const created = []
  const agents = {
    get: () => null,
    resume: async ({ resumeSessionId }) => {
      if (!onDisk.has(resumeSessionId)) throw new Error('没有历史')
      return { agent: { followup() {} }, dispose() {} }
    },
    create: async ({ sessionId }) => {
      created.push(sessionId)
      onDisk.add(sessionId)
      return { agent: { followup() {} }, dispose() {} }
    },
  }
  const config = { cwd: workdir, isolateByPeer: false }
  const manager = new SessionManager({ agents, selfId: '10001', config, logger: {}, home })
  return { manager, created }
}

test('第 0 代：用 hash 推出来的 id（跟老历史对齐）', async () => {
  const home = tmpHome()
  const workdir = tmpHome()
  try {
    const onDisk = new Set()
    const { manager, created } = makeManager(home, workdir, onDisk)
    const scope = 'private'
    const peerId = '2710586329'
    const baseKey = sessionKey('10001', scope, peerId)
    const rec = await manager.obtain({ scope, peerId, label: '私聊' })
    assert.equal(created.length, 1)
    assert.equal(rec.sessionId, deriveSessionId(baseKey))
    manager.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('reset 到第 1 代：不许再接回 hash 撞出来的旧壳', async () => {
  const home = tmpHome()
  const workdir = tmpHome()
  try {
    const onDisk = new Set()
    const { manager, created } = makeManager(home, workdir, onDisk)
    const scope = 'private'
    const peerId = '2710586329'
    const first = await manager.obtain({ scope, peerId, label: '私聊' })

    // 2026-11-03 22:41 那次事故的形状：reset 一代之后，hash 算出来的 id 在磁盘上早就被建过。
    const baseKey = sessionKey('10001', scope, peerId)
    const collision = deriveSessionId(`${baseKey}#1`)
    onDisk.add(collision) // 11-02 08:53 建的那个旧壳

    manager.reset(first)
    const second = await manager.obtain({ scope, peerId, label: '私聊' })
    assert.equal(created.length, 2)
    assert.notEqual(second.sessionId, collision, '不能接回旧壳')
    assert.ok(second.sessionId.startsWith(collision), '新 id 还是从这一代的 hash 派生，只是带随机尾巴')
    manager.stop()

    // 重启之后（内存空了、账本还在）：接回刚才那个新 id，别再新开
    const again = makeManager(home, workdir, onDisk)
    const third = await again.manager.obtain({ scope, peerId, label: '私聊' })
    assert.equal(third.sessionId, second.sessionId)
    assert.equal(again.created.length, 0, '账本有记录就该 resume 命中，不再建新的')
    again.manager.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('账本里记过这一代用的 id：照账本接回，不被随机尾巴顶掉', async () => {
  const home = tmpHome()
  const workdir = tmpHome()
  try {
    const onDisk = new Set()
    const { manager } = makeManager(home, workdir, onDisk)
    const scope = 'private'
    const peerId = '42'
    const first = await manager.obtain({ scope, peerId, label: '私聊' })
    manager.reset(first)
    const second = await manager.obtain({ scope, peerId, label: '私聊' })
    manager.stop()

    const again = makeManager(home, workdir, onDisk)
    const third = await again.manager.obtain({ scope, peerId, label: '私聊' })
    assert.equal(third.sessionId, second.sessionId)
    assert.equal(again.created.length, 0)
    again.manager.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})
