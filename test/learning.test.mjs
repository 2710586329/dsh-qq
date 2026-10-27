/**
 * 群词典（learning.js）自测。
 * 跑法：node test/learning.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseChatLog, findStuck, appendPending, scanOnce, coreOf, STUCK_WORDS } from '../src/learning.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err?.message ?? err}`)
  }
}

const SELF = '1737661812'
const LOG = `- 22:27:03 · 甲(20001)：汽水是老夫（）
- 22:27:44 · 水仙女人鱼(1737661812)：认不出
- 22:28:01 · 水仙女人鱼(1737661812)：好啊
- 22:31:00 · 路人甲(10001)：大肥鱼，这白毛是谁
- 22:31:05 · 水仙女人鱼(1737661812)：啥意思呀
`

console.log('群词典 · 解析')
t('parseChatLog 解析出 5 条', () => {
  const rows = parseChatLog(LOG, SELF)
  assert.equal(rows.length, 5)
  assert.equal(rows[0].name, '甲')
  assert.equal(rows[1].self, true)
  assert.equal(rows[1].text, '认不出')
})

t('空输入不炸', () => {
  assert.deepEqual(parseChatLog('', SELF), [])
  assert.deepEqual(parseChatLog(null, SELF), [])
})

console.log('群词典 · 找卡壳点')
t('找到 2 处卡壳（认不出 / 啥意思）', () => {
  const hits = findStuck(parseChatLog(LOG, SELF))
  assert.equal(hits.length, 2)
  assert.equal(hits[0].trigger.text, '汽水是老夫（）')
  assert.equal(hits[1].trigger.text, '大肥鱼，这白毛是谁')
  assert.equal(hits[1].word, '啥意思')
})

t('正常回复不误报', () => {
  const ok = `- 22:00:00 · 某甲(111)：今天吃什么
- 22:00:05 · 水仙女人鱼(1737661812)：吃大白饭喵～
`
  assert.deepEqual(findStuck(parseChatLog(ok, SELF)), [])
})

t('自己连着发多条，往上找非自己的那条', () => {
  const log = `- 22:00:00 · 某甲(111)：黑话测试
- 22:00:05 · 水仙女人鱼(1737661812)：嗯
- 22:00:06 · 水仙女人鱼(1737661812)：没看懂
`
  const hits = findStuck(parseChatLog(log, SELF))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].trigger.text, '黑话测试')
})

t('只是叫人（@ + 称呼）不算触发', () => {
  const log = `- 22:42:06 · 甲(20001)：@机器人 大肥鱼
- 22:42:10 · 水仙女人鱼(1737661812)：认不出
`
  assert.deepEqual(findStuck(parseChatLog(log, SELF)), [])
})

t('coreOf 去掉 @ 和开头标点', () => {
  assert.equal(coreOf('@机器人 大肥鱼'), '大肥鱼')
  assert.equal(coreOf('，这白毛是谁'), '这白毛是谁')
  assert.equal(coreOf('大肥鱼，这白毛是谁'), '大肥鱼，这白毛是谁')
})

console.log('群词典 · 写文件')
t('第一次写会建头部 + 待确认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-'))
  const file = join(dir, '记忆区', '群词典.md')
  const hits = findStuck(parseChatLog(LOG, SELF))
  const n = appendPending(file, hits)
  assert.equal(n, 2)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('# 群词典'))
  assert.ok(text.includes('## 待确认'))
  assert.ok(text.includes('汽水是老夫（）'))
  assert.ok(text.includes('↳ 22:27:44 鲸鲸回「认不出」'))
})

t('重复扫不重复加', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-'))
  const file = join(dir, '记忆区', '群词典.md')
  const hits = findStuck(parseChatLog(LOG, SELF))
  appendPending(file, hits)
  const n2 = appendPending(file, hits)
  assert.equal(n2, 0)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.split('汽水是老夫（）').length - 1, 1)
})

t('新条目插在待确认节里，不动已确认表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-'))
  const file = join(dir, '记忆区', '群词典.md')
  mkdirSync(join(dir, '记忆区'), { recursive: true })
  writeFileSync(
    file,
    `# 群词典\n\n## 待确认\n\n- [ ] 旧条目：旧的\n\n## 已确认\n\n| 词 | 意思 |\n|---|---|\n| 大白饭 | 饭 |\n`,
    'utf8'
  )
  appendPending(file, findStuck(parseChatLog(LOG, SELF)))
  const text = readFileSync(file, 'utf8')
  const pendingAt = text.indexOf('## 待确认')
  const confirmedAt = text.indexOf('## 已确认')
  assert.ok(pendingAt >= 0 && confirmedAt > pendingAt)
  const block = text.slice(pendingAt, confirmedAt)
  assert.ok(block.includes('汽水是老夫（）'))
  assert.ok(block.includes('旧条目'))
  assert.ok(text.includes('| 大白饭 | 饭 |'))
})

console.log('群词典 · 扫会话目录')
t('scanOnce 找到群目录里的卡壳点', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqroot-'))
  const gdir = join(root, '群_123456789', '聊天记录')
  mkdirSync(gdir, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(join(gdir, `${today}.md`), LOG, 'utf8')
  const n = scanOnce({ workspaceRoot: root, selfId: SELF, today })
  assert.equal(n, 2)
  const file = join(root, '群_123456789', '记忆区', '群词典.md')
  assert.ok(existsSync(file))
  assert.ok(readFileSync(file, 'utf8').includes('大肥鱼，这白毛是谁'))
})

t('目录不存在返回 0 不炸', () => {
  assert.equal(scanOnce({ workspaceRoot: join(tmpdir(), 'nope-' + Date.now()), selfId: SELF }), 0)
  assert.equal(scanOnce({}), 0)
})

t('卡壳词表非空', () => {
  assert.ok(STUCK_WORDS.length >= 5)
})

console.log(`\n${fail === 0 ? '全部通过 🎉' : '有失败'}  ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
