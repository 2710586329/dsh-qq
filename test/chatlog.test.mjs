import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendChatLog, CHATLOG_DIR, UNAUTHORIZED_LOG_DIR } from '../src/chatlog.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'chatlog-'))
}

// 测试里写入用的时间全是 2026-10-26，文件名也照这一天算 ——
// 原来用「今天」拼文件名，跨到 10-27 再跑就必然对不上（2026-10-27 实测四条全红）。
const day = '2026-10-26'

test('默认写进 聊天记录/<日期>.md，一行一条', async () => {
  const dir = tmp()
  const ok = await appendChatLog(dir, { who: '姐姐(1)', text: '在不在', time: new Date(2026, 9, 26, 21, 5, 9) })
  assert.equal(ok, true)

  const f = join(dir, CHATLOG_DIR, `${day}.md`)
  assert.ok(existsSync(f))
  const line = readFileSync(f, 'utf8').trim()
  assert.equal(line, '- 21:05:09 · 姐姐(1)：在不在')
})

test('多行压成一行，带 ⏎ 标记', async () => {
  const dir = tmp()
  await appendChatLog(dir, { who: 'a', text: '第一行\n\n第二行', time: new Date(2026, 9, 26, 1, 2, 3) })
  const body = readFileSync(join(dir, CHATLOG_DIR, `${day}.md`), 'utf8')
  assert.ok(body.includes('第一行 ⏎ 第二行'), '换行要压成 ⏎')
  assert.equal(body.split('\n').filter(Boolean).length, 1, '多行消息只占一行')
})

test('传 sub：白名单外的写进 聊天记录/_未开通/，不污染正常流水', async () => {
  const dir = tmp()
  const sub = join(CHATLOG_DIR, UNAUTHORIZED_LOG_DIR)
  await appendChatLog(dir, { who: '路人(9)', text: '群里的闲话', time: new Date(2026, 9, 26, 10, 0, 0) }, null, sub)

  assert.ok(existsSync(join(dir, sub, `${day}.md`)), '未开通的群要有留痕')
  assert.ok(!existsSync(join(dir, CHATLOG_DIR, `${day}.md`)), '正常流水里不该混进来')
})

test('追加不覆盖：同一天连写两条都在', async () => {
  const dir = tmp()
  await appendChatLog(dir, { who: 'a', text: '一', time: new Date(2026, 9, 26, 1, 0, 0) })
  await appendChatLog(dir, { who: 'b', text: '二', time: new Date(2026, 9, 26, 1, 0, 5) })
  const lines = readFileSync(join(dir, CHATLOG_DIR, `${day}.md`), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('没目录 / 没内容：静默返回 false，绝不抛错', async () => {
  assert.equal(await appendChatLog(null, { who: 'a', text: 'x' }), false)
  const dir = tmp()
  assert.equal(await appendChatLog(dir, { who: 'a', text: '   ' }), false)
})

test('写不进去只记日志不抛（目录被一个文件占住）', async () => {
  const dir = tmp()
  writeFileSync(join(dir, CHATLOG_DIR), '我不是目录')
  const logs = []
  const ok = await appendChatLog(dir, { who: 'a', text: 'x' }, { debug: (m) => logs.push(m) })
  assert.equal(ok, false)
  assert.equal(logs.length, 1, '失败要留一条 debug')
})
