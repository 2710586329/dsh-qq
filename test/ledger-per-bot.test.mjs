import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mineOnly, openLedger } from '../src/session.js'
import { createSessionState } from '../src/session-state.js'

/**
 * 2026-11-09：三个号共用一本 session-state.json 时，谁后写谁赢，别人的新记录被整份覆盖。
 * 09:53 老大「早上好」打两次就是这个 —— 老大换壳记下的新 id 被同时在启动的老二老三抹回去了。
 * 这几条盯的就是「一个号一本、迁的时候只拿自己那几条、迁完不再回头读老本」。
 */

const tmpDir = () => mkdtempSync(join(tmpdir(), 'qq-ledger-'))

const writeLegacy = (dir, body) => {
  const file = join(dir, 'session-state.json')
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

test('共用本迁出来只带本号那几条，老文件不动', () => {
  const dir = tmpDir()
  try {
    const legacy = writeLegacy(dir, {
      gens: {
        'qq:1447145595:private:2710586329@iso': 3,
        'qq:1737661812:private:2710586329@iso': 5,
      },
      sessions: {
        'qq:1447145595:private:2710586329@iso#3': 'laoda-rmw7rkfrw',
        'qq:1737661812:private:2710586329@iso#5': 'laosan-rmw7rjq01',
      },
      turns: { 'laoda-rmw7rkfrw': 39 },
    })

    const file = openLedger(dir, 'session-state', '1447145595', null, mineOnly)
    assert.equal(file, join(dir, 'session-state-1447145595.json'))

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(raw.sessions), ['qq:1447145595:private:2710586329@iso#3'])
    assert.deepEqual(Object.keys(raw.gens), ['qq:1447145595:private:2710586329@iso'])
    assert.equal(raw.turns['laoda-rmw7rkfrw'], 39, 'turns 按 sessionId 记，整份带走')

    assert.ok(existsSync(legacy), '老账本留着，不删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个号各写各的，谁也覆盖不到谁', () => {
  const dir = tmpDir()
  try {
    writeLegacy(dir, {
      gens: { 'qq:1:private:9': 2 },
      sessions: { 'qq:1:private:9': 'shell-a' },
      turns: {},
    })

    const f1 = openLedger(dir, 'session-state', '1', null, mineOnly)
    const f2 = openLedger(dir, 'session-state', '2', null, mineOnly)

    const two = createSessionState(f2)
    two.setSessionId('qq:2:private:9', 'shell-b') // 老二在写自己的本
    two.setGen('qq:2:private:9', 1)

    const back = createSessionState(f1) // 模拟老大重启，回头读自己的本
    assert.equal(back.sessionId('qq:1:private:9'), 'shell-a')
    assert.equal(back.gen('qq:1:private:9'), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('本号账本已经在了，就不再从老本迁（老本里后来写的东西不该回流）', () => {
  const dir = tmpDir()
  try {
    const legacy = writeLegacy(dir, {
      gens: {},
      sessions: { 'qq:1:private:9': 'old-shell' },
      turns: {},
    })
    const mine = join(dir, 'session-state-1.json')
    writeFileSync(mine, JSON.stringify({ gens: {}, sessions: { 'qq:1:private:9': 'new-shell' }, turns: {} }), 'utf8')

    openLedger(dir, 'session-state', '1', null, mineOnly)
    const raw = JSON.parse(readFileSync(mine, 'utf8'))
    assert.equal(raw.sessions['qq:1:private:9'], 'new-shell')

    assert.ok(existsSync(legacy))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有老本时不迁，本号账本从空开始', () => {
  const dir = tmpDir()
  try {
    const file = openLedger(dir, 'session-state', '7', null, mineOnly)
    assert.equal(file, join(dir, 'session-state-7.json'))
    assert.equal(existsSync(file), false, '没东西可迁就别凭空造文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
