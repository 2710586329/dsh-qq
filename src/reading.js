import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readingAskRule } from './prompts.js'
import { listOf } from './config.js'
import { parseQuietHours, inQuietHours } from './wake.js'

/**
 * 夜里的读书问询（2026-10-27 加，老三在 QQ 里提的诉求）。
 *
 * 她原话：「半夜就算醒着，嚎一嗓子也没人应，还怕把姐姐吵着。要是能有那种不开口的轮次，
 * 只让本姑娘自己翻两页书，那我就收下。」
 *
 * 所以这层跟 wake.js 的「主动开口」不是一回事：
 *   - wake 给的是**说话的机会**（她可以开口，也可以 [SILENT]）
 *   - 这里给的是**自己待着的机会**（问她要不要看书，这一轮说什么都发不出去）
 *
 * 四道闸：
 *   1. readingEnabled 默认 false —— 发布版的人完全看不见这层，只有本地 profile 打开
 *   2. readingHours   只在这段时间里问（默认 00:00-08:00，跟夜里静默时段对齐）
 *   3. 一夜 readingAskCount 次，两次至少隔 readingAskGapMs
 *   4. 书读完了就不再问 —— 书签上的「下次从哪接」超过目录里最大章号，问也只能得到「没得看了」
 *
 * 书架（2026-11-03 加，姐姐：「晚上看书轮次好像没有更新书架新加的书」）：
 *   以前只认配置里那一本，书架新加的永远不会被问到。现在填了 readingShelfDir 就扫
 *   `<书架>/<书>/chapters` 自己找书，一次问一本，挑**最久没碰的**那本 ——
 *   没读过的新书自然排最前，读完一本下一夜轮到下一本，所有书都读完才彻底停。
 *   没填 readingShelfDir 时还是老的单本行为（readingBook + readingChapterDir），向后兼容。
 *
 * 硬拦在 index.js 的 send()：这一轮挂了 record.quietRound，正文和工具外发都出不去。
 * 光靠提示词说「别说话」不稳，总有一次会漏。
 */

const TICK_MS = 60_000

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 「第0003章-xxx.md」「第 12 章」→ 3 / 12；认不出来给 0。 */
export function chapterNo(text) {
  const m = /第\s*0*(\d+)\s*章/.exec(String(text ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * 书签里这本书最新那行：`{ next, lastRead }`。
 *
 * 表是倒序的，第一条含书名的行就是当前进度；`lastRead` 是「哪天」那格，
 * 书架挑书拿它排「最久没碰的」。
 */
export function bookmarkOf(bookmarkFile, book) {
  const file = String(bookmarkFile ?? '').trim()
  const name = String(book ?? '').trim()
  const none = { next: 0, lastRead: '' }
  if (!file || !name) return none
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return none
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((s) => s.trim())
    // 四列 → 6 段（首尾各一个空串），五列 → 7 段；再短就不是这本书的表了
    if (cells.length < 6) continue
    const bookName = cells[1]
    if (!bookName || bookName === '书' || /^:?-{2,}:?$/.test(bookName)) continue
    if (!bookName.includes(name)) continue
    return { next: chapterNo(cells[4]), lastRead: cells[3] || '' }
  }
  return none
}

/** 书签里这本书那行写的「下次从哪接」，取章号；没有就给 0。 */
export function nextChapterOf(bookmarkFile, book) {
  return bookmarkOf(bookmarkFile, book).next
}

/** 章节目录里最大章号；读不到给 0。 */
export function maxChapterOf(dir) {
  const path = String(dir ?? '').trim()
  if (!path) return 0
  let names
  try {
    names = readdirSync(path)
  } catch {
    return 0
  }
  let max = 0
  for (const n of names) {
    const no = chapterNo(n)
    if (no > max) max = no
  }
  return max
}

/**
 * 扫一遍书架：`<shelfDir>/<书>/chapters` 有章节的才算一本（资料目录、空目录跳过）。
 *
 * 挑书顺序（2026-11-03）：
 *   1. **从没读过的**（书签里没有书名）先读，里面又按目录最后修改时间新的先读 ——
 *      姐姐新放进来的书，第一夜就能被问到；
 *   2. 读过的按书签里「哪天」升序，最久没碰的先轮回来。
 * 这样新书不会永远排在 1400 章的大部头后面，也不会读过的书一直霸着。
 */
export function shelfBooks(shelfDir, bookmarkFile) {
  const root = String(shelfDir ?? '').trim()
  if (!root) return []
  let ents
  try {
    ents = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    // 书架上有《轮回乐园》这种带书名号的目录，也有「网游之天下第一」这种裸名
    const name = ent.name.replace(/^[《「]|[》」]$/g, '').trim()
    if (!name) continue
    const chaptersDir = join(root, ent.name, 'chapters')
    const max = maxChapterOf(chaptersDir)
    if (max === 0) continue
    const { next, lastRead } = bookmarkOf(bookmarkFile, name)
    let addedAt = 0
    try {
      addedAt = statSync(join(root, ent.name)).mtimeMs
    } catch {
      addedAt = 0
    }
    out.push({ name, dir: chaptersDir, next, max, lastRead, addedAt, finished: next > max })
  }
  out.sort((a, b) => {
    const na = a.lastRead ? 1 : 0
    const nb = b.lastRead ? 1 : 0
    if (na !== nb) return na - nb
    if (na === 0) {
      if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt
    } else if (a.lastRead !== b.lastRead) {
      return a.lastRead < b.lastRead ? -1 : 1
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return out
}

export function createReading({ config, manager, logger }) {
  let timer = null
  let stopped = true
  let stateDay = ''
  let asked = 0
  let lastAskAt = 0
  let toldDone = ''

  const book = () => String(config?.readingBook ?? '').trim()
  const shelfDir = () => String(config?.readingShelfDir ?? '').trim()
  const maxPerNight = () => Math.max(0, Number(config?.readingAskCount) || 0)
  const gapMs = () => Math.max(60_000, Number(config?.readingAskGapMs) || 3_600_000)
  const timeoutMs = () => Math.max(60_000, Number(config?.readingTimeoutMs) || 1_200_000)
  const enabled = () => config?.readingEnabled === true && (shelfDir() !== '' || book() !== '')

  /**
   * 这一夜问哪本。
   *  - 填了书架：扫书架，挑最久没碰、还没读完的那本（全部读完 → 不问了）
   *  - 没填书架：老的单本行为
   * 返回 { book: {name, next, max} | null, reason, shelf }
   */
  function pickBook() {
    const dir = shelfDir()
    if (dir) {
      const shelf = shelfBooks(dir, config?.readingBookmark)
      if (shelf.length === 0) return { book: null, reason: 'no-book', shelf }
      const left = shelf.filter((b) => !b.finished)
      if (left.length === 0) return { book: null, reason: 'done', shelf }
      const b = left[0]
      return { book: { name: b.name, next: b.next, max: b.max }, reason: '', shelf }
    }
    const name = book()
    if (!name) return { book: null, reason: 'no-book', shelf: [] }
    const next = nextChapterOf(config?.readingBookmark, name)
    const max = maxChapterOf(config?.readingChapterDir)
    if (max === 0) return { book: null, reason: 'no-dir', shelf: [] }
    // 读完了就别问。next 是「下次要读第几章」，超过最大章号说明已经念到尾了。
    if (next > max) return { book: null, reason: 'done', shelf: [] }
    return { book: { name, next, max }, reason: '', shelf: [] }
  }

  /** 交给谁：readingPeer 优先，没填就用私聊白名单第一个。 */
  const peerId = () =>
    String(config?.readingPeer ?? '').trim() || listOf(config?.privateAllow)[0] || ''

  function findRecord() {
    const peer = peerId()
    if (!peer) return null
    return manager.list().find((r) => r.scope === 'private' && String(r.peerId) === peer) ?? null
  }

  async function obtainRecord() {
    let rec = findRecord()
    if (rec) return rec
    const peer = peerId()
    if (!peer) return null
    try {
      return await manager.obtain({ scope: 'private', peerId: peer, label: `私聊 ${peer}` })
    } catch (err) {
      logger.warn?.(`[dsh-qq] 读书问询：会话 ${peer} 拉不回来:`, err)
      return null
    }
  }

  async function ask(record, now, picked) {
    const { name, next, max } = picked.book
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    // 书架模式把没读完的书全摊开，让她自己挑；单本模式 shelf 是空的，正文还是只问那一本
    const shelf = picked.shelf
      .filter((b) => !b.finished)
      .map(({ name: n, next: nt, max: mx }) => ({ name: n, next: nt, max: mx }))
    const text = readingAskRule(config, { book: name, next, max, clock, shelf })
    record.quietRound = true
    asked += 1
    lastAskAt = now.getTime()
    const which = shelf.length > 1 ? `书架（${shelf.length} 本没读完，自己挑）` : `要不要看《${name}》`
    logger.info?.(`[dsh-qq] ${record.label} 夜里的问询：${which}（今夜第 ${asked}/${maxPerNight()} 次）`)
    manager.enqueue(record, async () => {
      try {
        // 跟 wake.js 同一套：必须是完整的用户消息对象，字符串会在 DSH 内部炸
        record.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
        )
        await Promise.race([
          Promise.resolve(record.agent.whenIdle?.()).then(() => 'idle'),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), timeoutMs())
            t.unref?.()
          }),
        ])
      } catch (err) {
        logger.warn?.(`[dsh-qq] 读书问询失败 ${record.label}:`, err)
      } finally {
        record.quietRound = false
      }
    })
  }

  /** 一分钟看一遍：到时段了没、今夜的次数用完没、书读完了没。 */
  async function tick(now = new Date()) {
    if (stopped || !enabled()) return
    if (maxPerNight() === 0) return
    const hours = parseQuietHours(config?.readingHours)
    if (hours && !inQuietHours(hours, now)) return

    const dk = dayKey(now)
    if (stateDay !== dk) {
      stateDay = dk
      asked = 0
      lastAskAt = 0
      toldDone = ''
    }
    if (asked >= maxPerNight()) return
    if (lastAskAt && now.getTime() - lastAskAt < gapMs()) return

    const picked = pickBook()
    if (!picked.book) {
      // 读不到目录 / 全读完了：别每分钟刷一遍日志，一天说一次就够
      const key = `${dk}:${picked.reason}`
      if (toldDone !== key) {
        toldDone = key
        if (picked.reason === 'no-dir') {
          logger.warn?.(
            `[dsh-qq] 读书问询：章节目录读不到（${config?.readingChapterDir || '没填'}），今夜先不问了`,
          )
        } else if (picked.reason === 'no-book') {
          logger.warn?.(`[dsh-qq] 读书问询：书架上没扫到能读的书（${shelfDir() || '没填书架'}），今夜先不问了`)
        } else {
          logger.info?.('[dsh-qq] 书架上的书都念完了，今夜不再问')
        }
      }
      return
    }

    const rec = await obtainRecord()
    if (!rec) return
    if (rec.busy > 0) return
    void ask(rec, now, picked)
  }

  function start() {
    if (!stopped) return
    stopped = false
    timer = setInterval(() => {
      tick().catch((err) => logger.warn?.('[dsh-qq] 读书问询 tick 出错:', err))
    }, TICK_MS)
    timer.unref?.()
    if (enabled()) {
      const what = shelfDir() ? `书架（${shelfDir()}）自动挑书` : `《${book()}》`
      logger.info?.(
        `[dsh-qq] 读书问询已启动：${what}，一夜最多 ${maxPerNight()} 次，落在 ${config?.readingHours || '（不限）'}`,
      )
    }
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return { start, stop, tick }
}
