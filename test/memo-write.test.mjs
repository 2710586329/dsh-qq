import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools } from '../src/tools.js'

/**
 * 2026-10-30 姐姐要的「打通记忆」。
 *
 * 病根：agent 自己的 write / edit 只落在它那一格的工作目录里（文件沙箱按会话
 * 工作目录算），`本地记忆区` 在外面，写了就是 denied —— 而 QQ 那边没有审批
 * 通道，连提权的框都弹不出来（她 10-29 23:46 的原话）。
 *
 * 解法：插件代笔。笔写在宿主进程里，直接碰文件系统。但笔必须窄 ——
 * 只认 .md/.txt、路径不许跳出记忆区。不靠它自觉，靠函数就写不了别处。
 */

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

/** 按真插件的方式注册一遍，把工具都收进 Map。 */
function boot(config) {
  const tools = new Map()
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined),
  }
  registerTools(ctx, {
    client: {},
    manager: {},
    config,
    logger: quiet,
    pin: {},
    wake: {},
    noteSelfSaid() {},
  })
  return tools
}

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-qq-memo-'))
}

test('没配 memoryRoot 就不注册这支笔', () => {
  const tools = boot({})
  assert.equal(tools.has('qq_memo'), false, '默认不该有')
  const tools2 = boot({ memoryRoot: '' })
  assert.equal(tools2.has('qq_memo'), false, '空串也不该有')
})

test('配了 memoryRoot：append 建文件、再 append 叠在后面', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')
  assert.ok(memo, '得有 qq_memo')

  const r1 = await memo.execute({ action: 'append', path: '今天.md', text: '## 07:20 · 第一段\n写了点东西' })
  assert.equal(r1.ok, true)
  assert.ok(existsSync(join(root, '今天.md')))

  const r2 = await memo.execute({ action: 'append', path: '今天.md', text: '第二段' })
  assert.equal(r2.ok, true)

  const text = readFileSync(join(root, '今天.md'), 'utf8')
  assert.ok(text.includes('第一段'))
  assert.ok(text.includes('第二段'))
  assert.ok(text.indexOf('第一段') < text.indexOf('第二段'), '后来的在后头')
  assert.ok(text.endsWith('\n'), 'append 要补一个换行，别把两段粘成一行')
})

test('子目录自动建（日记/…），read 能读回来，write 能整篇覆盖', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')

  const w = await memo.execute({ action: 'write', path: '日记/2026-10-30.md', text: '整篇' })
  assert.equal(w.ok, true)
  assert.equal(readFileSync(join(root, '日记', '2026-10-30.md'), 'utf8'), '整篇')

  const r = await memo.execute({ action: 'read', path: '日记/2026-10-30.md' })
  assert.equal(r.ok, true)
  assert.equal(r.message, '整篇')

  const w2 = await memo.execute({ action: 'write', path: '日记/2026-10-30.md', text: '换掉' })
  assert.equal(w2.ok, true)
  assert.equal(readFileSync(join(root, '日记', '2026-10-30.md'), 'utf8'), '换掉')
})

test('read 一个还没有的文件：不抛，返回 ok:false', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')
  const r = await memo.execute({ action: 'read', path: '日记/1999-01-01.md' })
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('还没有'))
})

test('路径跳不出记忆区（.. / 绝对路径都不行）', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')
  const outside = join(root, '..', '偷渡.md')
  for (const bad of ['../偷渡.md', '日记/../../偷渡.md', outside, '/etc/passwd.md']) {
    const r = await memo.execute({ action: 'append', path: bad, text: 'x' })
    assert.equal(r.ok, false, `「${bad}」不该写得出去`)
    assert.ok(/记忆区外面/.test(r.message), `「${bad}」的拒绝理由要说清: ${r.message}`)
    assert.equal(existsSync(join(root, '..', '偷渡.md')), false, '真的没写出去')
  }
})

test('只认 .md / .txt，别的后缀一律拒绝', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')
  for (const bad of ['脚本.mjs', '跑.cmd', '数据.json', '没有后缀']) {
    const r = await memo.execute({ action: 'write', path: bad, text: 'x' })
    assert.equal(r.ok, false, `「${bad}」不该被接受`)
    assert.ok(/md|txt/.test(r.message))
  }
  for (const good of ['a.md', 'b.txt', '子目录/c.MD']) {
    const r = await memo.execute({ action: 'write', path: good, text: 'x' })
    assert.equal(r.ok, true, `「${good}」应该能写`)
  }
})

test('空内容 / 空路径 / 乱给的 action 都要报错，别写一堆空文件', async () => {
  const root = mkRoot()
  const memo = boot({ memoryRoot: root }).get('qq_memo')
  assert.equal((await memo.execute({ action: 'append', path: 'a.md', text: '   ' })).ok, false)
  assert.equal((await memo.execute({ action: 'write', path: '', text: 'x' })).ok, false)
  assert.equal((await memo.execute({ action: '删掉', path: 'a.md', text: 'x' })).ok, false)
})

test('list 能看目录；根目录留空也行', async () => {
  const root = mkRoot()
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '今天.md'), 'x', 'utf8')
  const memo = boot({ memoryRoot: root }).get('qq_memo')

  const top = await memo.execute({ action: 'list' })
  assert.equal(top.ok, true)
  assert.ok(top.message.includes('今天.md'))
  assert.ok(top.message.includes('项目/'), '目录带斜杠，一眼分得出')

  const sub = await memo.execute({ action: 'list', path: '项目' })
  assert.equal(sub.ok, true)
})

test('三只共用一个 memoryRoot：谁写都落在同一份文件里', async () => {
  const root = mkRoot()
  const a = boot({ memoryRoot: root }).get('qq_memo')
  const b = boot({ memoryRoot: root }).get('qq_memo')
  await a.execute({ action: 'append', path: '今天.md', text: '老大写的' })
  await b.execute({ action: 'append', path: '今天.md', text: '老二写的' })
  const text = readFileSync(join(root, '今天.md'), 'utf8')
  assert.ok(text.includes('老大写的') && text.includes('老二写的'), '两份都在，没互相盖掉')
})
