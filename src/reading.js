import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readdirSync, readFileSync } from 'node:fs'
import { readingAskRule } from './prompts.js'
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
 * 书签里这本书那行写的「下次从哪接」，取章号；没有就给 0。
 *
 * 书签是 markdown 表。五列是现在的写法：| 书 | 读到哪 | 哪天 | 下次从哪接 | 一句话心得 |
 * 四列是老写法（没有心得那列）：| 书 | 读到哪 | 哪天 | 下次从哪接 |
 * 两种都认——因为「书 / 读到哪 / 哪天」固定在前三格，split('|') 之后 cells[4] 都是「下次从哪接」。
 */
export function nextChapterOf(bookmarkFile, book) {
  const file = String(bookmarkFile ?? '').trim()
  const name = String(book ?? '').trim()
  if (!file || !name) return 0
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((s) => s.trim())
    // 四列 → 6 段（首尾各一个空串），五列 → 7 段；再短就不是这本书的表了
    if (cells.length < 6) continue
    const bookName = cells[1]
    if (!bookName || bookName === '书' || /^:?-{2,}:?$/.test(bookName)) continue
    if (!bookName.includes(name)) continue
    return chapterNo(cells[4])
  }
  return 0
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

export function createReading({ config, manager, logger }) {
  let timer = null
  let stopped = true
  let stateDay = ''
  let asked = 0
  let lastAskAt = 0
  let toldDone = ''

  const book = () => String(config?.readingBook ?? '').trim()
  const maxPerNight = () => Math.max(0, Number(config?.readingAskCount) || 0)
  const gapMs = () => Math.max(60_000, Number(config?.readingAskGapMs) || 3_600_000)
  const timeoutMs = () => Math.max(60_000, Number(config?.readingTimeoutMs) || 1_200_000)
  const enabled = () => config?.readingEnabled === true && book() !== ''

  /** 交给谁：readingPeer 优先，没填就用私聊白名单第一个。 */
  const peerId = () =>
    String(config?.readingPeer ?? '').trim() || String(config?.privateAllow?.[0] ?? '').trim()

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

  async function ask(record, now) {
    const name = book()
    const next = nextChapterOf(config?.readingBookmark, name)
    const max = maxChapterOf(config?.readingChapterDir)
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const text = readingAskRule(config, { book: name, next, max, clock })
    record.quietRound = true
    asked += 1
    lastAskAt = now.getTime()
    logger.info?.(`[dsh-qq] ${record.label} 夜里的问询：要不要看会儿书（今夜第 ${asked}/${maxPerNight()} 次）`)
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

    const name = book()
    const next = nextChapterOf(config?.readingBookmark, name)
    const max = maxChapterOf(config?.readingChapterDir)
    if (max === 0) {
      // 章节目录读不到（路径没填 / 盘不在）：别每分钟刷一遍日志，一天说一次就够
      if (toldDone !== `${dk}:no-dir`) {
        toldDone = `${dk}:no-dir`
        logger.warn?.(`[dsh-qq] 读书问询：章节目录读不到（${config?.readingChapterDir || '没填'}），今夜先不问了`)
      }
      return
    }
    // 读完了就别问。next 是「下次要读第几章」，超过最大章号说明已经念到尾了。
    if (next > max) {
      if (toldDone !== dk) {
        toldDone = dk
        logger.info?.(`[dsh-qq] 《${name}》念完了（${Math.max(0, next - 1)}/${max}），今夜不再问`)
      }
      return
    }

    const rec = await obtainRecord()
    if (!rec) return
    if (rec.busy > 0) return
    void ask(rec, now)
  }

  function start() {
    if (!stopped) return
    stopped = false
    timer = setInterval(() => {
      tick().catch((err) => logger.warn?.('[dsh-qq] 读书问询 tick 出错:', err))
    }, TICK_MS)
    timer.unref?.()
    if (enabled()) {
      logger.info?.(
        `[dsh-qq] 读书问询已启动：《${book()}》一夜最多 ${maxPerNight()} 次，落在 ${config?.readingHours || '（不限）'}`,
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
