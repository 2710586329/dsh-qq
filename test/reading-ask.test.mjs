import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chapterNo, maxChapterOf, nextChapterOf } from '../src/reading.js'
import { readingAskRule } from '../src/prompts.js'

/** 夜里的读书问询（2026-10-27 加）：钉住「读到哪 / 读完了没 / 能拒绝」这三件事。 */

// ── ① 章号解析 ──
assert.equal(chapterNo('第0003章-风起.md'), 3)
assert.equal(chapterNo('第 12 章 某某'), 12)
assert.equal(chapterNo('index.md'), 0)
assert.equal(chapterNo(''), 0)

// ── ② 书签里读「下次从哪接」 ──
const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-reading-'))
const bookmark = join(dir, '书签.md')
writeFileSync(
  bookmark,
  [
    '# 书签',
    '',
    '| 书 | 读到哪 | 哪天 | 下次从哪接 | 一句话心得 |',
    '| --- | --- | --- | --- | --- |',
    '| 网游之天下第一 | 第2章 | 2026-10-27 | 第0003章 | 柳云死得干脆 |',
    '| 另一本 | 第9章 | 2026-10-28 | 第0010章 | 还行 |',
    '',
  ].join('\n'),
  'utf8',
)
assert.equal(nextChapterOf(bookmark, '网游之天下第一'), 3, '应该认出「下次从哪接」那列')
assert.equal(nextChapterOf(bookmark, '另一本'), 10)
assert.equal(nextChapterOf(bookmark, '没这本'), 0)
assert.equal(nextChapterOf(join(dir, '没有.md'), '网游之天下第一'), 0, '文件不在就给 0，不能抛')
assert.equal(nextChapterOf(bookmark, ''), 0)

// 四列表（老二老三那边还是四列）也得认：「书 / 读到哪 / 哪天」固定在前三格，
// split('|') 之后 cells[4] 两种写法都是「下次从哪接」。
const fourCol = join(dir, '四列.md')
writeFileSync(
  fourCol,
  ['| 书 | 读到哪 | 读的那天 | 下次从哪接 |', '| --- | --- | --- | --- |', '| 网游之天下第一 | 第2章 | 2026-10-27 | 第0003章 |'].join('\n'),
  'utf8',
)
assert.equal(nextChapterOf(fourCol, '网游之天下第一'), 3, '四列旧书签也要读得出进度')

// 空白行（老三书签的初始形态）不该被当成一本书
const blankRow = join(dir, '空白.md')
writeFileSync(blankRow, ['| 书 | 读到哪 | 哪天 | 下次从哪接 |', '|---|---|---|---|', '| | | | |'].join('\n'), 'utf8')
assert.equal(nextChapterOf(blankRow, '网游之天下第一'), 0)

// ── ③ 章节目录里最大章号 ──
const chapters = join(dir, 'chapters')
mkdirSync(chapters)
for (const name of ['第0001章-内容简介.md', '第0002章-第1章 生死阵.md', '第0010章-尾声.md', 'index.md']) {
  writeFileSync(join(chapters, name), 'x', 'utf8')
}
assert.equal(maxChapterOf(chapters), 10)
assert.equal(maxChapterOf(join(dir, '没有这个目录')), 0, '目录不在就给 0')

// ── ④ 「读完了就别问」的判断 ──
const next = nextChapterOf(bookmark, '网游之天下第一') // 3
const max = maxChapterOf(chapters) // 10
assert.equal(next > max, false, '第 3 章 < 第 10 章，还得继续问')
assert.equal(11 > max, true, '下次要读第 11 章、全书只到 10 → 读完了')

// ── ⑤ 问询提示词：必须允许拒绝 ──
const rule = readingAskRule({}, { book: '网游之天下第一', next: 3, max: 10, clock: '03:00' })
assert.match(rule, /03:00/)
assert.match(rule, /网游之天下第一/)
assert.match(rule, /第 3 章/)
assert.match(rule, /第 10 章/)
assert.match(rule, /发不出去/, '得说明这一轮发不出去')
assert.match(rule, /不想读/, '得明确允许拒绝')
assert.match(rule, /不用回话/, '拒绝时不该逼它回应')

// 没有进度信息时不该硬塞「第 0 章」
const bare = readingAskRule({}, { book: '某书', clock: '02:00' })
assert.doesNotMatch(bare, /第 0 章/)

console.log('ok reading-ask')
