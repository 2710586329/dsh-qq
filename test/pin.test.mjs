import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPin, pinFileFor } from '../src/pin.js'

const mk = () => mkdtempSync(join(tmpdir(), 'pin-'))
const rec = (dir) => ({ dir, label: '私聊 测试', scope: 'private', peerId: '10001' })
const withDir = (fn) => {
  const dir = mk()
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('pinFileFor：落在会话目录里的 话头.md，没有 dir 时返回空串', () => {
  withDir((dir) => {
    assert.equal(pinFileFor(rec(dir)), join(dir, '话头.md'))
    assert.equal(pinFileFor({}), '')
  })
})

test('空便签：view 返回 []，一点不占位置', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    assert.deepEqual(pin.view(rec(dir)), [])
  })
})

test('add 一条：view 里有抬头和内容，文件真的写出来了', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    const openCount = pin.add(rec(dir), '姐姐说的「会话一直保持」是什么，还没查')
    assert.equal(openCount, 1)
    assert.ok(existsSync(join(dir, '话头.md')))
    const view = pin.view(rec(dir))
    assert.ok(view[0].includes('[话头]'))
    assert.ok(view.some((line) => line.includes('会话一直保持')))
  })
})

test('超过 5 条：只列前 5 条，末尾提示还有几条', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    for (let i = 1; i <= 7; i += 1) pin.add(rec(dir), `话头${i}`)
    const view = pin.view(rec(dir))
    assert.equal(view.filter((line) => line.startsWith('· ')).length, 5)
    assert.ok(view.some((line) => line.includes('还有 2 条没列')))
  })
})

test('done 划掉后不再出现在 view 里', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    pin.add(rec(dir), '甲')
    pin.add(rec(dir), '乙')
    assert.equal(pin.done(rec(dir), 1), true)
    const view = pin.view(rec(dir))
    assert.ok(!view.some((line) => line.includes('甲')))
    assert.ok(view.some((line) => line.includes('乙')))
    assert.equal(pin.done(rec(dir), 9), false, '越界序号应当返回 false')
  })
})

test('drop 直接删掉，不算「接上了」', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    pin.add(rec(dir), '要删的')
    assert.equal(pin.drop(rec(dir), 1), true)
    assert.deepEqual(pin.view(rec(dir)), [])
    assert.equal(pin.drop(rec(dir), 1), false)
  })
})

test('手工写进已完成条目：不进 view，但 list 里还在', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    pin.add(rec(dir), '做完了的')
    pin.done(rec(dir), 1)
    pin.add(rec(dir), '还没做的')
    const view = pin.view(rec(dir))
    assert.ok(!view.some((line) => line.includes('做完了的')))
    assert.ok(view.some((line) => line.includes('还没做的')))
    assert.ok(pin.list(rec(dir)).some((line) => line.includes('做完了的')))
  })
})

test('开关关掉：view 恒为空，add 直接抛错', () => {
  withDir((dir) => {
    const pin = createPin({ config: { pinEnabled: false } })
    assert.throws(() => pin.add(rec(dir), '不该写进去'))
    assert.deepEqual(pin.view(rec(dir)), [])
  })
})

test('add 空内容要拦住；超长只截 60 字进 view', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    assert.throws(() => pin.add(rec(dir), '   '))
    pin.add(rec(dir), 'x'.repeat(200))
    const bullet = pin.view(rec(dir)).find((line) => line.startsWith('· '))
    assert.ok(bullet.length <= 62, `截断后应当 ≤62 字符，实际 ${bullet.length}`)
  })
})

test('文件被写坏（没有 - [ ] 行）时 view 不炸也不乱带', () => {
  withDir((dir) => {
    const pin = createPin({ config: {} })
    writeFileSync(join(dir, '话头.md'), '# 随手记\n\n随便写点什么\n', 'utf8')
    assert.deepEqual(pin.view(rec(dir)), [])
  })
})
