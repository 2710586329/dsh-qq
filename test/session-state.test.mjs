import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionState } from '../src/session-state.js'

const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-session-state-'))
  return { dir, file: join(dir, 'session-state.json') }
}

test('空账本：第 0 代，没有记下的 id', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createSessionState(file)
    assert.equal(s.gen('k'), 0)
    assert.equal(s.sessionId('k'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset 过了：重启后还是第 1 代（不许退回 reset 之前）', () => {
  const { dir, file } = tmpFile()
  try {
    const before = createSessionState(file)
    before.setGen('qq:1:private:2', 1)

    const after = createSessionState(file) // 宿主重启
    assert.equal(after.gen('qq:1:private:2'), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接着 reset：1 → 2，不是又回到 1', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createSessionState(file)
    s.setGen('k', 1)
    const restarted = createSessionState(file)
    // session.js 里是「内存优先、盘兜底」再 +1
    const next = (restarted.gen('k') || 0) + 1
    restarted.setGen('k', next)
    assert.equal(next, 2)
    assert.equal(createSessionState(file).gen('k'), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换过壳的 id 记得住，重启后接回同一个，不再开空壳', () => {
  const { dir, file } = tmpFile()
  try {
    const before = createSessionState(file)
    before.setSessionId('k#1', 'abc-rmvpcvfxr')

    const after = createSessionState(file)
    assert.equal(after.sessionId('k#1'), 'abc-rmvpcvfxr')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换代时 forgetSession 掉上一代，但代数还在', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createSessionState(file)
    s.setGen('k', 1)
    s.setSessionId('k#1', 'old-shell')
    s.forgetSession('k#1')
    assert.equal(s.sessionId('k#1'), '')
    assert.equal(s.gen('k'), 1)
    assert.equal(createSessionState(file).gen('k'), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账本坏了：重置为第 0 代，不炸', () => {
  const { dir, file } = tmpFile()
  try {
    writeFileSync(file, 'not json at all', 'utf8')
    const warnings = []
    const s = createSessionState(file, { warn: (...a) => warnings.push(a.join(' ')) })
    assert.equal(s.gen('k'), 0)
    assert.equal(s.sessionId('k'), '')
    assert.ok(warnings.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拿不到家目录（空路径）：内存里能用，就是不落盘', () => {
  const s = createSessionState('')
  s.setGen('k', 3)
  s.setSessionId('k#3', 'sid')
  assert.equal(s.gen('k'), 3)
  assert.equal(s.sessionId('k#3'), 'sid')
})
