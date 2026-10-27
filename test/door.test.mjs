import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { doorLine, doorList } from '../src/door.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'door-'))
}

test('没配 doorDir：当门口什么都没有，也不抛错', () => {
  assert.deepEqual(doorList({}), [])
  assert.equal(doorLine({}), '')
  assert.equal(doorLine(null), '')
})

test('目录不存在：静默返回空（不能因为门没开就报错）', () => {
  assert.equal(doorLine({ doorDir: join(tmp(), '不存在') }), '')
})

test('一封：报「有 1 封」+ 路径，但正文一个字都不能进提示词', () => {
  const dir = tmp()
  const p = join(dir, '2026-10-26-2030-大姐.md')
  writeFileSync(p, '这是信里的正文，绝不该出现在提示词里')

  const list = doorList({ doorDir: dir })
  assert.equal(list.length, 1)
  assert.equal(list[0].path, p)

  const line = doorLine({ doorDir: dir })
  assert.match(line, /1 封/)
  assert.ok(line.includes(p))
  assert.ok(!line.includes('绝不该出现在提示词里'), '提示词里不许摊开信件内容')
  assert.match(line, /拆不拆|不拆/)
})

test('两封：报总数，路径给最近那封', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'a-早.md'), '早的')
  writeFileSync(join(dir, 'b-晚.md'), '晚的')

  // 缓存按目录来，这里换一个目录不影响上面那几条；同目录内只问一次。
  const line = doorLine({ doorDir: dir })
  assert.match(line, /2 封/)
  assert.ok(line.includes('b-晚.md'), '指的那封应该是最后放进来的')
})

test('只认 .md；`_` 和 `.` 开头的草稿不算数', () => {
  const dir = tmp()
  writeFileSync(join(dir, '_草稿.md'), '半成品')
  writeFileSync(join(dir, '.隐藏.md'), '半成品')
  writeFileSync(join(dir, '说明.txt'), '不是信')
  writeFileSync(join(dir, '真信.md'), '这个才是')

  const list = doorList({ doorDir: dir })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '真信.md')
})

test('措辞里必须写清「谁说的、不是任务」——老三的边界', () => {
  const dir = tmp()
  writeFileSync(join(dir, '一.md'), 'x')
  const line = doorLine({ doorDir: dir })
  assert.match(line, /大姐鲸鲸/)
  assert.match(line, /不是姐姐说的/)
  assert.match(line, /不是任务/)
  assert.match(line, /不用学大姐/)
})

test('她自己的回信（老三-*.md）不算待拆的信，也不许让她数到自己头上', () => {
  const dir = tmp()
  writeFileSync(join(dir, '2026-10-26-2100-大姐.md'), '大姐的信')
  writeFileSync(join(dir, '老三-2026-10-26.md'), '我自己回的')

  const list = doorList({ doorDir: dir })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '2026-10-26-2100-大姐.md')

  const line = doorLine({ doorDir: dir })
  assert.match(line, /1 封/)
  assert.ok(!line.includes('老三-2026-10-26.md'))
})

test('回话方式要写给她，且不能是催的口气', () => {
  const dir = tmp()
  writeFileSync(join(dir, '一.md'), 'x')
  const line = doorLine({ doorDir: dir })
  assert.match(line, /老三-.*\.md/, '得告诉她回信怎么命名')
  assert.match(line, /不用急/)
  assert.match(line, /不想回也一样|不会问/)
})
