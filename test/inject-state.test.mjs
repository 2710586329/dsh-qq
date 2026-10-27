import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInjectState } from '../src/inject-state.js'

const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-inject-'))
  return { dir, file: join(dir, 'inject-state.json') }
}

test('没有账本 = 没注过', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createInjectState(file)
    assert.equal(s.has('sid-1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注过之后宿主重启，还记得（这条是这次的要害）', () => {
  const { dir, file } = tmpFile()
  try {
    const before = createInjectState(file)
    assert.equal(before.has('sid-1'), false)
    before.mark('sid-1')

    // 宿主重启 = 内存全没了，只剩这个文件
    const after = createInjectState(file)
    assert.equal(after.has('sid-1'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('换 sessionId 就得重新注入（换壳 / 新建会话不能被老账本误跳）', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createInjectState(file)
    s.mark('sid-旧')
    assert.equal(s.has('sid-旧'), true)
    assert.equal(s.has('sid-新'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一个 sessionId 只认一次 —— 会话键换代也不许再注一遍', () => {
  // 22:33 记在 @iso、22:38 记在 @iso#1，同一个 id 塞了两份人设，就是栽在这
  const { dir, file } = tmpFile()
  try {
    const s = createInjectState(file)
    s.mark('sid-r')
    assert.equal(s.has('sid-r'), true)
    // 不管外面再怎么换 key，查的都是 sessionId
    assert.equal(s.has('sid-r'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧格式账本（按会话键记）自动迁移成按 sessionId 记', () => {
  const { dir, file } = tmpFile()
  try {
    writeFileSync(
      file,
      JSON.stringify({
        'qq:1:private:2@iso': { sessionId: 'sid-r', at: '2026-10-26T14:33:00.889Z' },
        'qq:1:private:2@iso#1': { sessionId: 'sid-r', at: '2026-10-26T14:38:31.418Z' },
        'qq:1:private:3@iso': { sessionId: 'sid-other', at: '2026-10-26T15:00:00.000Z' },
      }),
      'utf8',
    )
    const s = createInjectState(file)
    assert.equal(s.has('sid-r'), true)
    assert.equal(s.has('sid-other'), true)
    // 两个键指向同一个 id → 迁移后只留一条
    assert.deepEqual(Object.keys(s.all()).sort(), ['sid-other', 'sid-r'])
    // 写回后就是新格式
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(disk['sid-r'])
    assert.equal(disk['sid-r'].sessionId, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forget 掉就重注', () => {
  const { dir, file } = tmpFile()
  try {
    const s = createInjectState(file)
    s.mark('sid-gen0')
    s.forget('sid-gen0')
    assert.equal(s.has('sid-gen0'), false)

    const restarted = createInjectState(file)
    assert.equal(restarted.has('sid-gen0'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账本文件坏了：当作没注过，不许炸', () => {
  const { dir, file } = tmpFile()
  try {
    writeFileSync(file, '{这不是 json', 'utf8')
    const warnings = []
    const s = createInjectState(file, { warn: (...a) => warnings.push(a.join(' ')) })
    assert.equal(s.has('sid'), false)
    assert.ok(warnings.length >= 1, '应该留一句告警')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不传路径（拿不到 dsh-qq 家目录）也不炸，只是不落盘', () => {
  const s = createInjectState('')
  assert.equal(s.has('v'), false)
  s.mark('v')
  assert.equal(s.has('v'), true)
  s.forget('v')
  assert.equal(s.has('v'), false)
})
