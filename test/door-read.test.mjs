import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { doorLine, doorList, markDoorRead, resetDoorCache } from '../src/door.js'

/**
 * 2026-10-27 姐姐发现：老三读过门口的信之后，新窗口 / 新会话还是显示「挂着 3 封没拆」。
 *
 * 原因：门口只数文件在不在，`read` 不会让文件消失。于是提示每轮都在骗她，
 * 还可能让她以为没拆完、反复去读同一封。
 *
 * 修法：她 `read` 了哪封，就往 `.已读.json` 记一笔（文件名 → 读它那会儿的 mtime），
 * 数信时跳过。同一名字被人重写过（mtime 变了），就重新算没拆。
 */

function mkDoor() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-door-'))
  return dir
}

function put(dir, name, text = '# 信\n', mtime) {
  const full = join(dir, name)
  writeFileSync(full, text, 'utf8')
  if (mtime) utimesSync(full, mtime, mtime)
  return full
}

test('拆过的信不再算「没拆」', () => {
  const dir = mkDoor()
  const a = put(dir, '2026-10-26-2100-大姐.md', '# A\n', new Date(2026, 9, 26, 21, 0))
  put(dir, '2026-10-26-2105-大姐.md', '# B\n', new Date(2026, 9, 26, 21, 5))
  put(dir, '2026-10-26-2348-大姐.md', '# C\n', new Date(2026, 9, 26, 23, 48))
  const config = { doorDir: dir }

  assert.equal(doorList(config).length, 3)
  assert.equal(markDoorRead(config, a), true, '这是门口的信，应该记上')
  assert.equal(doorList(config).length, 2, '读过的封不该再数')
  assert.ok(!doorLine(config).includes('3 封'), '提示里不能还说三封')
})

test('用相对路径 read 也认得出来（按文件名对）', () => {
  const dir = mkDoor()
  put(dir, '2026-10-26-2348-大姐.md', '# C\n', new Date(2026, 9, 26, 23, 48))
  const config = { doorDir: dir }

  assert.equal(markDoorRead(config, '门口/2026-10-26-2348-大姐.md'), true)
  assert.equal(doorList(config).length, 0)
})

test('同一名字被人重写过（mtime 变了）→ 重新算没拆', () => {
  const dir = mkDoor()
  const full = put(dir, '2026-10-26-2348-大姐.md', '# 旧\n', new Date(2026, 9, 26, 23, 48))
  const config = { doorDir: dir }

  markDoorRead(config, full)
  assert.equal(doorList(config).length, 0)

  writeFileSync(full, '# 换了一版\n', 'utf8')
  utimesSync(full, new Date(2026, 9, 27, 10, 0), new Date(2026, 9, 27, 10, 0))
  resetDoorCache() // 线上有 5 秒缓存，别的窗口放信也就晚 5 秒知道；测试懒得等
  assert.equal(doorList(config).length, 1, '重写过的信要重新提醒')
})

test('不是门口的东西不会被记：别人的文件、她自己的回信、草稿', () => {
  const dir = mkDoor()
  put(dir, '老三-2026-10-27.md', '# 我回的\n')
  put(dir, '_草稿.md', '# 草稿\n')
  const config = { doorDir: dir }

  assert.equal(markDoorRead(config, join(dir, '老三-2026-10-27.md')), false, '她自己回的不算拆信')
  assert.equal(markDoorRead(config, join(dir, '_草稿.md')), false, '草稿不算信')
  assert.equal(markDoorRead(config, 'D:/别的地方/随便.md'), false, '不在门口目录里的文件不该动账本')
  assert.equal(markDoorRead(config, ''), false)
  assert.equal(existsSync(join(dir, '.已读.json')), false, '什么都没记上时不该生出账本')
})

test('账本文件自己不会被当成信数进去', () => {
  const dir = mkDoor()
  const a = put(dir, '2026-10-26-2100-大姐.md', '# A\n', new Date(2026, 9, 26, 21, 0))
  const config = { doorDir: dir }
  markDoorRead(config, a)

  const names = doorList(config).map((x) => x.name)
  assert.ok(!names.includes('.已读.json'))
  // 账本落地了，而且是给人看得懂的 JSON
  const raw = readFileSync(join(dir, '.已读.json'), 'utf8')
  assert.ok(raw.includes('2026-10-26-2100-大姐.md'))
})

test('接线：outbound 收到 read 的 tool/call 会去记', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  assert.ok(src.includes("if (/^read$/i.test(name))"), '要认 read 这个工具名')
  assert.ok(src.includes('markDoorRead(config, readPathOf(data))'), '要真的把路径交给 markDoorRead')
  // 出错不能连累出站：门口提示每轮都跑
  assert.ok(/markDoorRead\(config, readPathOf\(data\)\)[\s\S]{0,80}catch/.test(src), '要有 try/catch 兜住')
})
