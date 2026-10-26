import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePersonaFile } from '../src/settings.js'

const quiet = { info() {}, warn() {} }

function tmp() {
  return mkdtempSync(join(tmpdir(), 'qq-persona-'))
}

test('人设文件读得到：覆盖 persona，并落一份缓存', () => {
  const home = tmp()
  const file = join(home, '角色.md')
  writeFileSync(file, '我是鲸鲸，住在QQ里。', 'utf8')
  const config = { personaFile: file, persona: '文本框旧版' }
  const r = resolvePersonaFile(config, quiet, { home })
  assert.equal(r.ok, true)
  assert.equal(config.persona, '我是鲸鲸，住在QQ里。')
  assert.equal(r.chars, 11)
  const cache = join(home, 'persona-cache.md')
  assert.ok(existsSync(cache), '缓存文件应该写出来')
  assert.equal(readFileSync(cache, 'utf8'), '我是鲸鲸，住在QQ里。')
  rmSync(home, { recursive: true, force: true })
})

test('文件没了 + 文本框空：用上次的缓存，别变回普通助手', () => {
  const home = tmp()
  const file = join(home, '角色.md')
  writeFileSync(file, '我是鲸鲸，住在QQ里。', 'utf8')
  const config = { personaFile: file, persona: '' }
  assert.equal(resolvePersonaFile(config, quiet, { home }).ok, true)
  // 文件删掉，config.persona 也清空（模拟重启后从 patch 读到的空值）
  rmSync(file)
  const config2 = { personaFile: file, persona: '' }
  const r = resolvePersonaFile(config2, quiet, { home })
  assert.equal(r.ok, false)
  assert.equal(r.fromCache, true)
  assert.equal(r.error, '文件不存在')
  assert.equal(config2.persona, '我是鲸鲸，住在QQ里。', '应该从缓存兜底')
  rmSync(home, { recursive: true, force: true })
})

test('文件没了但文本框有字：优先文本框，不覆盖', () => {
  const home = tmp()
  const file = join(home, '不存在.md')
  const config = { personaFile: file, persona: '文本框里的人设' }
  const r = resolvePersonaFile(config, quiet, { home })
  assert.equal(r.ok, false)
  assert.equal(r.fromCache, false)
  assert.equal(config.persona, '文本框里的人设')
  rmSync(home, { recursive: true, force: true })
})

test('没配 personaFile：什么都不做', () => {
  const config = { persona: '现场写的' }
  const r = resolvePersonaFile(config, quiet, { home: tmp() })
  assert.equal(r.ok, false)
  assert.equal(config.persona, '现场写的')
})

test('没给 home：不写缓存也不读缓存，行为跟老版一致', () => {
  const home = tmp()
  const file = join(home, '不存在.md')
  const config = { personaFile: file, persona: '' }
  const r = resolvePersonaFile(config, quiet)
  assert.equal(r.ok, false)
  assert.equal(r.fromCache, false)
  assert.equal(config.persona, '')
  assert.equal(existsSync(join(home, 'persona-cache.md')), false)
  rmSync(home, { recursive: true, force: true })
})
