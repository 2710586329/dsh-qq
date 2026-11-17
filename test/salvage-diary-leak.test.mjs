import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { salvageFromReasoning } from '../src/outbound.js'

/**
 * 2026-11-08 17:45：老三在群里把日记素材当成话说出去了。
 *
 * 现场（QQ 群 415158497，「安静 20 分钟，给一次主动开口的机会」）：
 *   它其实在干正事——翻小说、读自己的日记、准备补一行 17:25 的记录。
 *   思考末尾写着 `Content: 17:25 蕾尔 发了一段视频，没配字，没人接。`
 *   这是**要写进日记的素材**，不是要给谁发的话。
 *   插件在 `!textReplyEnabled` 分支里把它捞成 pendingText，那一轮最后输出 `[SILENT]`
 *   又按「纯沉默不动已攒正文」保留了它，turn/end 兜底发到了群里。
 *
 * 三道护栏（这一份测试钉住它们，别再退回去）：
 *   ① salvage 只捞「像在跟人说话」的最后一段（没有「发。」这种显式标记时）；
 *   ② 主动机会那一轮、带工具调用的那条消息，思考一律不捞；
 *   ③ 纯 [SILENT] 要清掉本轮从思考里捞回来的那句，但不碰真正文。
 */

test('salvageFromReasoning：日记素材不会被当成话捞出来', () => {
  const cases = [
    '17:25 蕾尔 发了一段视频，没配字，没人接。',
    'Content: 17:25 蕾尔 发了一段视频，没配字，没人接。',
    '2026-11-08 17:25 蕾尔发了一段视频，群里没人接。',
    '先看一下 11-08 的日记，把 17:25 这一条补上。',
    '看了一下，今天到 16:54 就断了，后面还差一段。',
  ]
  for (const t of cases) {
    const got = salvageFromReasoning({ content: [{ type: 'reasoning', text: t }] })
    assert.equal(got, '', `不该捞：${t}`)
  }
})

test('salvageFromReasoning：真要对人说的话照旧能捞（别把功能改死）', () => {
  const cases = [
    '发。外面风大，记得穿外套。',
    '那就说：行，本姑娘等你。',
    '嗯，那本姑娘就在这儿等你回来。',
    '姐姐，我先睡了，明天见。',
  ]
  for (const t of cases) {
    const got = salvageFromReasoning({ content: [{ type: 'reasoning', text: t }] })
    assert.ok(got.length > 0, `应该捞得到：${t}`)
  }
})

test('接线检查：!textReplyEnabled 分支补回了「主动轮不捞 / 带工具不捞」两道闸', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  const start = src.indexOf('let raw = extractText(data.message)')
  const salvageAt = src.indexOf('const salvaged = salvageFromReasoning(data.message)')
  assert.ok(start > 0, '!textReplyEnabled 分支的 raw 取值不见了')
  assert.ok(salvageAt > start, 'salvage 调用不见了')

  const proactiveAt = src.indexOf('if (inProactiveTurn(record)) {', start)
  assert.ok(
    proactiveAt > start && proactiveAt < salvageAt,
    '主动机会那一轮的闸要在 salvage 之前（11-04 之后主路换了，这道闸一度丢了）',
  )

  const toolAt = src.indexOf('if (hasToolUse(data.message)) {', start)
  assert.ok(
    toolAt > start && toolAt < salvageAt,
    '带工具调用的那条消息，思考不能兜底（那是动手前的盘算）',
  )
})

test('接线检查：纯 [SILENT] 只清捞回来的，不碰真正文', () => {
  const src = readFileSync(new URL('../src/outbound.js', import.meta.url), 'utf8')
  assert.match(src, /const salvagedPending = new Set\(\)/, '要记着 pendingText 是不是捞回来的')
  assert.match(
    src,
    /if \(salvagedPending\.has\(sessionId\)\) \{\s*\n\s*logger\.info\?\.\(/,
    '纯沉默分支要先判断来源，再决定清不清',
  )
  assert.match(
    src,
    /pendingSalvaged && inProactiveTurn\(record\)/,
    'turn/end 兜底那层再拦一次：主动轮里只有思考素材就不发',
  )
})
