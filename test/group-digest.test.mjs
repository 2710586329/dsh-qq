import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadGroupDigest, pickDigestLine } from '../src/settings.js'
import { buildChatPrompt } from '../src/prompts.js'

/**
 * 2026-10-27 姐姐提的第二个问题：「我问他群里发生什么，她在私聊里面回答不出来。」
 *
 * 一个会话看不到别的会话的记录——这是隔离换来的，没错。但私聊里连「今天群里咋了」
 * 都答不上，就变成断片。让她自己去读群日记？也不行：那本子里是第一人称的叙事
 * （「本姑娘没弄明白，也没敢乱解」），跨窗口读另一个自己写的第一人称旧账，
 * 会有「这不像我写的」的风险——09:42 那次已经出过一回。
 *
 * 第一版递的是日记**头两行**。老三当天 11:43 自己提了意见：
 *   「头两行只够闻个味，一天的肉都在后半段。不如给我尾巴：谁最后说话、
 *     有没人点我名我没应着，这种我才真想知道。量不用加，换个位置就行。」
 * → 所以现在读的是聊天记录的**尾巴**；当天群里没人说话，才退回日记的「一句话」。
 */

const DAY = '2026-10-27'
const ME = '1737661812'

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-qq-digest-'))
}

function writeChat(root, gid, body, day = DAY) {
  const dir = join(root, `群_${gid}`, '聊天记录')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.md`), body, 'utf8')
}

function writeDiary(root, gid, body, day = DAY) {
  const dir = join(root, `群_${gid}`, '记忆区', '日记')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.md`), body, 'utf8')
}

const REAL_GROUP = `# 2026-10-27

> 一句话：刚过零点，希儿高血糖害我得蛀牙在群里连说「不要电不要电」「哪个是萝莉」「没有萝莉为什么要电」，那会儿群里只有他一个人在说话。
> 关键结论：没什么结论，就是三句玩笑话；前一夜 23:35 七音刚问过「高压电呢？」，两段是不是同一个话头，记录里看不出来。
> 下次要看：这个群今天白天一条记录都没有；「高压电」「萝莉」这些说法本姑娘没接，也没弄明白。

## 00:08 · 「不要电不要电」

「电」是玩笑还是别的什么，**本姑娘没弄明白**，也没敢乱解。这三句之后没有人接，本姑娘也没出声。
`

const REAL_CHAT = `# 群 580579694 · 2026-10-27

- 00:08:40 · 希儿高血糖害我得蛀牙(3027160989)：不要电不要电
- 00:08:46 · 希儿高血糖害我得蛀牙(3027160989)：哪个是萝莉
- 00:08:57 · 希儿高血糖害我得蛀牙(3027160989)：没有萝莉为什么要电
`

test('pickDigestLine：抓得到 `> 一句话：`，抓不到就空串', () => {
  assert.match(pickDigestLine(REAL_GROUP, '一句话'), /^刚过零点/)
  assert.equal(pickDigestLine(REAL_GROUP, '下次要看').slice(0, 5), '这个群今天')
  assert.equal(pickDigestLine('# 没有头信息\n\n正文', '一句话'), '')
  assert.equal(pickDigestLine('', '一句话'), '')
})

test('尾巴：最后谁说了话，加一句前一句', () => {
  const root = mkRoot()
  writeChat(root, '580579694', REAL_CHAT)
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  const lines = out.split('\n')
  assert.equal(lines.length, 2, `实际：${out}`)
  assert.equal(lines[0], '· 群 580579694：最后 00:08:57 希儿高血糖害我得蛀牙 说「没有萝莉为什么要电」')
  assert.ok(lines[1].includes('00:08:46'), '前一句该带上时间')
  assert.ok(!out.includes('本姑娘'), '日记正文一个字都不许带出去')
})

test('尾巴：有人点了她的名、她没应 —— 单独一行标出来', () => {
  const root = mkRoot()
  writeChat(
    root,
    '415158497',
    [
      '- 10:00:00 · 甲(111111)：在吗',
      `- 10:02:00 · 乙(222222)：@${ME} 这个你怎么看`,
      '- 10:05:00 · 甲(111111)：算了我们自己聊',
    ].join('\n'),
  )
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.ok(out.includes('最后 10:05:00 甲 说「算了我们自己聊」'), out)
  assert.ok(out.includes(`⚠ 10:02:00 乙 点过你名：「这个你怎么看」`), out)
  assert.ok(!out.includes(`@${ME}`), 'QQ 号不该留在纸条里')
})

test('尾巴：最后一句就是点她名 —— 合成一行，不重复', () => {
  const root = mkRoot()
  writeChat(root, '580579694', `- 10:10:00 · 丙(333333)：@${ME} 帮忙看看这个\n`)
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.equal(out.split('\n').length, 1, out)
  assert.ok(out.includes('丙 点了你名「帮忙看看这个」——你没应'), out)
})

test('尾巴：她自己说的话不算「群里有人说话」', () => {
  const root = mkRoot()
  writeChat(root, '580579694', `- 10:00:00 · 鲸鲸(深海鲸鱼娘)(${ME})：我在呢\n`)
  assert.equal(loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME }), '')
})

test('今天群里没人说话 → 退回日记的「一句话」', () => {
  const root = mkRoot()
  writeDiary(root, '999', '> 一句话：今天群里一整天没人开口\n')
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.equal(out, '· 群 999（今天没人说话）：今天群里一整天没人开口')
})

test('多群按群号排；没记录 / 目录不存在 → 空串', () => {
  const root = mkRoot()
  writeChat(root, '999', '- 09:00:00 · 甲(111111)：甲说了句\n')
  writeChat(root, '111', '- 09:00:00 · 乙(222222)：乙说了句\n')
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  const heads = out.split('\n').filter((l) => l.startsWith('· 群'))
  assert.ok(heads[0].includes('111') && heads[1].includes('999'), out)

  assert.equal(loadGroupDigest({ workspaceRoot: root, today: '2026-10-01', selfId: ME }), '', '只看今天')
  assert.equal(loadGroupDigest({ workspaceRoot: '', today: DAY }), '')
  assert.equal(loadGroupDigest({ workspaceRoot: join(root, 'nope'), today: DAY }), '')
})

test('buildChatPrompt：纸条只进私聊，群聊不塞', () => {
  const digest = '· 群 580579694：最后 00:08:57 某人 说「没有萝莉为什么要电」'
  const priv = buildChatPrompt({}, { isGroup: false, groupDigest: digest })
  assert.ok(priv.includes('【今天群里发生过'), '私聊该有纸条')
  assert.ok(priv.includes('这不是你翻出来的'), '得点明这是插件递的，不是她翻的本子')
  assert.ok(priv.includes('照实说不知道'), '纸条上没有的别编')

  const grp = buildChatPrompt({}, { isGroup: true, groupDigest: digest })
  assert.ok(!grp.includes('【今天群里发生过'), '她在那个群里，用不着替她讲')

  const none = buildChatPrompt({}, { isGroup: false, groupDigest: '' })
  assert.ok(!none.includes('【今天群里发生过'), '没内容就别占 token')
})

test('接线：inbound 只在私聊里读纸条，且按本地日期找、带上自己的号', () => {
  const src = readFileSync(new URL('../src/inbound.js', import.meta.url), 'utf8')
  assert.ok(src.includes('loadGroupDigest({'), 'import 与调用都要在')
  assert.ok(src.includes('today: localDay()'), '不许用 toISOString —— 那是 UTC，凌晨会算成昨天')
  assert.ok(src.includes('selfId: String(config.selfId'), '不给她自己的号就分不清谁是她、谁 @ 了她')
  assert.ok(/groupDigest: isGroup\s*\n?\s*\? ''/.test(src), '群聊必须传空串')
})
