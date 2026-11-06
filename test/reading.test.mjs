import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bookmarkOf, createReading, nextChapterOf, shelfBooks } from '../src/reading.js'
import { readingAskRule } from '../src/prompts.js'

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-qq-reading-'))
}

function bookmarkText(lines) {
  return [
    '# 书签',
    '',
    '| 书 | 读到哪 | 哪天 | 下次从哪接 | 一句话心得 |',
    '|---|---|---|---|---|',
    ...lines,
  ].join('\n')
}

function makeChapters(bookDir, count) {
  const dir = join(bookDir, 'chapters')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= count; i += 1) {
    writeFileSync(join(dir, `第${String(i).padStart(4, '0')}章-测试.md`), '正文')
  }
  return dir
}

test('bookmarkOf：多本书各取自己最新那行', () => {
  const root = makeTmp()
  try {
    const file = join(root, '书签.md')
    writeFileSync(
      file,
      bookmarkText([
        '| 药娘的天空 | 第3章（3/684 章，读完） | 2026-11-04 02:10 | 第4章 出走 | 好 |',
        '| 网游之天下第一 | 第70章 你猜（70/1432 章，读完） | 2026-11-03 14:36 | 第71章（chapters 第0072章） | 好 |',
        '| 网游之天下第一 | 第69章 杀人交易（69/1432 章，读完） | 2026-11-03 14:05 | 第70章 你猜 | 好 |',
      ]),
    )
    assert.deepEqual(bookmarkOf(file, '药娘的天空'), { next: 4, lastRead: '2026-11-04 02:10' })
    assert.deepEqual(bookmarkOf(file, '网游之天下第一'), {
      next: 71,
      lastRead: '2026-11-03 14:36',
    })
    assert.equal(nextChapterOf(file, '网游之天下第一'), 71)
    assert.deepEqual(bookmarkOf(file, '没这本'), { next: 0, lastRead: '' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shelfBooks：只认有 chapters 的目录，没读过的排最前，书名带书名号也认', () => {
  const root = makeTmp()
  try {
    makeChapters(join(root, '网游之天下第一'), 3)
    makeChapters(join(root, '《药娘的天空》'), 5)
    mkdirSync(join(root, '资料夹'))
    mkdirSync(join(root, '空书'))
    const file = join(root, '书签.md')
    writeFileSync(
      file,
      bookmarkText([
        '| 网游之天下第一 | 第3章（3/3 章，读完） | 2026-11-03 14:36 | 第4章 | 尾 |',
      ]),
    )

    const books = shelfBooks(root, file)
    assert.deepEqual(
      books.map((b) => b.name),
      ['药娘的天空', '网游之天下第一'],
    )
    const newBook = books[0]
    assert.equal(newBook.max, 5)
    assert.equal(newBook.next, 0)
    assert.equal(newBook.finished, false)
    const oldBook = books[1]
    assert.equal(oldBook.next, 4)
    assert.equal(oldBook.max, 3)
    assert.equal(oldBook.finished, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readingAskRule：书架模式把没读完的书全摊开，自己挑', () => {
  const text = readingAskRule(
    {},
    {
      clock: '02:00',
      shelf: [
        { name: '药娘的天空', next: 0, max: 684 },
        { name: '网游之天下第一', next: 71, max: 1433 },
      ],
    },
  )
  assert.match(text, /书架上这几本还没读完/)
  assert.match(text, /《药娘的天空》：还没开过，全书到第 684 章/)
  assert.match(text, /《网游之天下第一》：读到第 71 章，全书到第 1433 章/)
  assert.match(text, /自己挑/)
  assert.doesNotMatch(text, /柜上还有/)
})

test('readingAskRule：单本模式还是只问那一本', () => {
  const text = readingAskRule({}, { book: '药娘的天空', next: 0, max: 684, clock: '02:00' })
  assert.match(text, /书架上有本《药娘的天空》/)
  assert.match(text, /还没开过，全书到第 684 章/)
})

test('tick：扫书架后问的是新加、还没读过的那本，且这一轮是静默轮', async () => {
  const root = makeTmp()
  try {
    makeChapters(join(root, '网游之天下第一'), 3)
    makeChapters(join(root, '《药娘的天空》'), 5)
    const file = join(root, '书签.md')
    writeFileSync(
      file,
      bookmarkText([
        '| 网游之天下第一 | 第2章（2/3 章，读完） | 2026-11-03 14:36 | 第3章 | 好 |',
      ]),
    )

    const sent = []
    const rec = {
      label: '私聊 2710586329',
      scope: 'private',
      peerId: '2710586329',
      busy: 0,
      quietRound: false,
      agent: {
        followup(msg) {
          sent.push(msg)
        },
        whenIdle: async () => {},
      },
    }
    const manager = {
      list: () => [rec],
      obtain: async () => rec,
      enqueue: (r, fn) => {
        void fn()
      },
    }
    const config = {
      readingEnabled: true,
      readingAskCount: 2,
      readingAskGapMs: 60000,
      readingShelfDir: root,
      readingBookmark: file,
      readingPeer: '2710586329',
    }
    const reading = createReading({ config, manager, logger: {} })
    reading.start()
    try {
      await reading.tick(new Date('2026-11-04T02:00:00'))
    } finally {
      reading.stop()
    }

    assert.equal(sent.length, 1)
    const text = sent[0].content.map((b) => b.text).join('\n')
    assert.match(text, /书架上这几本还没读完/)
    assert.match(text, /《药娘的天空》：还没开过，全书到第 5 章/)
    assert.match(text, /《网游之天下第一》：读到第 3 章，全书到第 3 章/)
    // 问询轮是静默轮，跑完要复位，不然这个会话之后一直都发不出话
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(rec.quietRound, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tick：书架上的书全读完了就不问', async () => {
  const root = makeTmp()
  try {
    makeChapters(join(root, '网游之天下第一'), 3)
    const file = join(root, '书签.md')
    writeFileSync(
      file,
      bookmarkText([
        '| 网游之天下第一 | 第3章（3/3 章，读完） | 2026-11-03 14:36 | 第4章 | 尾 |',
      ]),
    )
    const sent = []
    const rec = {
      label: '私聊 2710586329',
      scope: 'private',
      peerId: '2710586329',
      busy: 0,
      quietRound: false,
      agent: { followup: (m) => sent.push(m), whenIdle: async () => {} },
    }
    const manager = {
      list: () => [rec],
      obtain: async () => rec,
      enqueue: (r, fn) => {
        void fn()
      },
    }
    const reading = createReading({
      config: {
        readingEnabled: true,
        readingAskCount: 2,
        readingShelfDir: root,
        readingBookmark: file,
        readingPeer: '2710586329',
      },
      manager,
      logger: {},
    })
    reading.start()
    try {
      await reading.tick(new Date('2026-11-04T02:00:00'))
    } finally {
      reading.stop()
    }
    assert.equal(sent.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
