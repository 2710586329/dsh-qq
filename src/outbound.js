/**
 * 出站：把 agent 跑出来的文字送回 QQ。
 *
 * 订阅的是宿主的 `session/event`，一次 turn 里可能收到多条：
 *   - assistant/chunk   : 增量文本（流式）
 *   - assistant/message : 一轮完整的助手消息
 *   - turn/end          : 本轮结束（带错误信息）
 * 其他类型（tool/call、tool/result）默认不发，除非配置里打开了 showToolResults。
 *
 * 流式策略（只对私聊开）：
 *   攒够一个完整句子就发一条，但一个 turn 里最多发 streamMaxChunks 条，
 *   超了就憋回去，等 assistant/message 落定时把剩下的整段发完。
 */

function pickSession(args) {
  if (args.length >= 2) return { session: args[0], raw: args[1] }
  const raw = args[0]
  return { session: raw?.session, raw }
}

import { markDoorRead } from './door.js'
import { SILENT_MARKER, findSilentMark, hasSilentMark } from './prompts.js'

/**
 * 从 `tool/call` 里捞 read 的文件路径。各家字段名不一样（`input` / `arguments` / `args`，
 * 里面又叫 `file_path` / `path` / `filePath`），宽松取；取不到就当没读。
 */
function readPathOf(data) {
  let args = data?.input ?? data?.arguments ?? data?.args ?? data?.params ?? null
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (!args || typeof args !== 'object') return ''
  return String(args.file_path ?? args.path ?? args.filePath ?? args.file ?? '').trim()
}

function sessionIdOf(session, raw) {
  const id =
    session?.header?.id ??
    session?.id ??
    raw?.sessionId ??
    raw?.session?.id ??
    raw?.session?.header?.id
  return id === undefined || id === null ? '' : String(id)
}

/** 从 assistant 消息里抠出纯文本。 */

import {
  extractText,
  looksLikeLeakedToolMarkup,
  cutAtScriptReplay,
  cutAtDialogueScript,
  looksPlanning,
  stripLeakedThinking,
  hasToolUse,
  reasoningTail,
  salvageFromReasoning,
  stripMetaTalk,
  stripClosingTalk,
  SELF_SENDING_TOOLS,
  SENTENCE_END,
  SCRIPT_REPLAY_RE,
  MIN_SENTENCE,
  mostlyChinese,
  looksLikeSelfAddressedAction,
} from './sanitize.js'

// 老名字继续从这里出去（tools.js 和 6 个测试文件都是这么 import 的）
export {
  extractText,
  looksLikeLeakedToolMarkup,
  cutAtScriptReplay,
  cutAtDialogueScript,
  looksPlanning,
  stripLeakedThinking,
  hasToolUse,
  reasoningTail,
  salvageFromReasoning,
  stripMetaTalk,
  stripClosingTalk,
  looksLikeSelfAddressedAction,
}


/**
 * 这一轮是不是「主动机会」（`wake.js` 的 `fire()` 投的 `【主动机会】`）。
 *
 * 2026-10-28 加。起因：08:30 / 09:00 / 09:48 三轮主动机会，正文是空的、
 * reasoning 里写着「就沉默。规则说发出去没人应，当她在忙。别再发。」
 * 之类的话，兜底把它们当正文播到了私聊里 —— 她心里盘算要不要开口，
 * 结果被当成开口说了。
 *
 * 语义上要分开：
 * - 别人来找她 → 正文空才要兜底（10-26 有两次人根本没收到话）；
 * - 主动给她机会 → 正文空就是她选择不说，兜底等于逼她开口，还把心里话播出去。
 *
 * 10 分钟窗口兜底：万一某轮没收尾，标记不至于一直挂着。
 */
function inProactiveTurn(record) {
  const at = Number(record?._proactiveAt || 0)
  return at > 0 && Date.now() - at < 10 * 60_000
}

export function createOutbound({ manager, config, logger, send, wake }) {
  const lastSent = new Map() // sessionId -> 上一条完整文本（去重用）
  const streamBuf = new Map() // sessionId -> 还没发出去的流式尾巴
  const streamCount = new Map() // sessionId -> 本轮已经流式发了几条
  // sessionId -> 已经流式消费掉的「原始字符数」。
  // 2026-10-26 19:40 修：原来用「句数」对账（`splitSentences(text).slice(already)`），
  // 但 text 是**清洗过**的全文、already 是**清洗前**发出去的句数——清洗删掉一行草稿，
  // 两边下标就差开了，往后错一行，会漏发一句或把发过的一句再发一遍。
  // 原文是增量的、只会往后长，所以记字符数永远不会错位。
  const streamConsumed = new Map()
  const selfSent = new Set() // sessionId -> 本轮是否已经用「会自己发送」的工具发过话了

  const streamMax = Number(config.streamMaxChunks ?? 3)
  const streamEnabled = config.streamReply !== false
  // 2026-11-04 14:45 姐姐定：正文不再自动发到 QQ，要说的话必须调 qq_send / qq_reply。
  // 这一条门是「砍掉正文直发」的总闸，关掉之后 outbound 里的过滤正则全部变成兜底。
  const textReplyEnabled = config.textReply === true
  /**
   * 2026-11-04 14:52 姐姐说「会忘记调用工具。老三已经出现了」——14:48 那三条消息它一句都没回，
   * 因为它把话写进了正文、没调工具。所以总闸不能是「一律不发」，得留一道**保守兜底**：
   * 这一轮既没调发送工具、也没调任何工具、也没写 [SILENT]，说明它就是想说话只是忘了调用，
   * 那一句话可以替它发——**但前提是那原文一个字都不用洗**。
   *
   * 判据：`stripLeakedThinking(raw) === raw.trim()`。只要清洗动过它（删行、换 `<br>`、砍信封、
   * 去掉 markdown 号），说明正文里有脏东西，整条不发。这样自演下一轮、`嗯，这个明白`、
   * 带信封的草稿全都拦在门外，只放「本来就是干净的一两句人话」过去。
   * 想彻底关掉兜底就把 textReplyFallback 设成 false。
   */
  const textReplyFallback = config.textReplyFallback !== false
  const pendingText = new Map() // sessionId -> 这一轮攒下的纯文本正文（等 turn/end 决定发不发）

/**
 * 2026-11-12 22:5x 姐姐问「怎么老三说这么多只发过来一句啊」。
 * 现场：老三 22:46 那轮边看图边说话，说了三句、中间夹着 read / read_image 三个工具调用，
 * turn/end 兜底时手里只剩最后一句。根子是这里原来是 `pendingText.set(sessionId, raw)`——
 * **覆盖**，不是追加。一轮里说几句，就只剩最后一句。
 *
 * 现在改成追加，段与段之间留一个空行（这就是她说话时的自然停顿，
 * 也是 cutAtDialogueScript 认的段落边界，剧本形状那道判据照样能砍）。
 * 单段超过 MAX_PENDING_CHARS 就不再往下攒——一轮攒一屏话已经够多了，
 * 再多发出去就是刷屏。
 */
const MAX_PENDING_CHARS = 600
function stashPending(sessionId, text) {
  const t = String(text || '').trim()
  if (!t) return
  const prev = (pendingText.get(sessionId) || '').trim()
  if (!prev) {
    pendingText.set(sessionId, t.length > MAX_PENDING_CHARS ? t.slice(0, MAX_PENDING_CHARS) : t)
    return
  }
  if (prev.length >= MAX_PENDING_CHARS) return
  const room = MAX_PENDING_CHARS - prev.length - 2
  if (room <= 0) return
  pendingText.set(sessionId, `${prev}\n\n${t.length > room ? t.slice(0, room) : t}`)
}
  // 2026-11-08 17:45 事故：pendingText 里这句是不是从思考里捞回来的。
  // 捞回来的不能享受「纯沉默不动已攒正文」的待遇——那不是她说的话，是思考里的素材。
  const salvagedPending = new Set()
  const turnTouchedTool = new Set() // sessionId -> 本轮调过工具（那就不是「忘发」，不兜底）

  /**
   * 一切往外发的文字都从这儿走。
   * 顺手告诉 wake「刚有活动」——不然主动说话那层会把「自己刚说完」也当成冷场。
   */
  async function emit(record, text) {
    try {
      await send(record, text)
    } finally {
      wake?.noteOutbound?.(record)
    }
  }

  function resetStream(sessionId) {
    streamBuf.delete(sessionId)
    streamCount.delete(sessionId)
    streamConsumed.delete(sessionId)
  }

  return async function onSessionEvent(...args) {
    const { session, raw } = pickSession(args)
    const sessionId = sessionIdOf(session, raw)
    if (!sessionId) return

    const record = manager.find(sessionId)
    if (!record) return

    const type = raw?.type ?? ''
    const data = raw?.data ?? {}

    // ── 流式：只在私聊开，群聊一口气发完更清爽 ──
    if (type === 'assistant/chunk') {
      // 流式也是正文直发的一种：总闸关着就一句都不冒。
      if (!textReplyEnabled || !streamEnabled || record.scope === 'group') return
      if (selfSent.has(sessionId)) return // 本轮走的是工具发送，别再流式插嘴
      const chunk = data.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return

      let buf = (streamBuf.get(sessionId) ?? '') + chunk.text
      let sent = streamCount.get(sessionId) ?? 0
      let consumed = streamConsumed.get(sessionId) ?? 0

      while (buf.length >= MIN_SENTENCE && sent < streamMax) {
        const match = SENTENCE_END.exec(buf)
        if (!match) break
        const sentence = match[1].trim()
        if (sentence.length < MIN_SENTENCE) break
        const clean = stripLeakedThinking(sentence)
        if (clean) await emit(record, clean)
        buf = buf.slice(match[0].length)
        consumed += match[0].length
        sent += 1
        streamCount.set(sessionId, sent)
      }

      streamBuf.set(sessionId, buf)
      streamConsumed.set(sessionId, consumed)
      return
    }

    if (type === 'assistant/message') {
      // 2026-11-04 14:45 姐姐定：正文直发整条关掉。
      // 以前这条分支是「模型不调工具就把正文当消息发」——所有漏话（`<br>`、`嗯，这个明白`、
      // 自演下一轮、伪造 system-reminder）都是从这条路出去的，过滤越加越厚。
      // 现在要说的话必须显式调 qq_send / qq_reply；不调 = 这轮不想说，正好也是允许的。
      // 想看旧行为把 textReply 设成 true。
      //
      // 但「忘了调工具」是真会发生的（14:48 老三连着三条没回），所以这里不直接扔掉：
      // 把这一轮的纯文本记下来，turn/end 时再看要不要兜底发（判据在 turn/end 里）。
      if (!textReplyEnabled) {
        resetStream(sessionId)
        if (selfSent.has(sessionId)) {
          pendingText.delete(sessionId) // 真用 qq_send / qq_reply 开口了，本轮不再兜底
          return
        }
        // 2026-11-07 22:46 修：这里原来还有 `|| hasToolUse(data.message)`，
        // 只要这条消息里出现任何工具调用，就把待发正文整条删掉。可 qq_pin / read / edit
        // 都不是「开口」的工具——正文和它们写在同一轮时，真正要说的那句就这么被吃了。
        // 现场：11-07 22:39 老大「翻了一章，里头有只蝴蝶…」整段消失，QQ 那边一条都没收到，
        // 它自己还在思考里反复问「正文是不是发出去了」。现在只认 SELF_SENDING_TOOLS，
        // 其余工具照常把正文留在 pendingText，由 turn/end 兜底发。
        let raw = extractText(data.message)
        let salvagedOnly = false
        if (!raw.trim()) {
          // 22:20 之前 20:20:22 那轮就是这样：整段话全写进 reasoning，text 块是空的，
          // 外面看着像「突然哑了」，日志里却一个字都没有。至少留一行。
          //
          // 2026-11-05 11:12 修：光留一行不够。老二 10:47 那轮把成品留在思考末尾
          // （详见 salvageFromReasoning 的注释），捞回来接着走下面的兜底流程。
          //
          // 2026-11-08 17:45 事故：11-04 关掉正文直发后新开的这条分支，漏搬了旧分支的两道闸。
          // 老三在群里那一轮既没想说话（最后输出 [SILENT]），又带着一个 edit，
          // 思考里那句日记素材还是被捞出来发了。两道闸补回来：
          //   ① 主动机会那一轮：正文空 = 她选择不说（旧分支在 325 行，11-04 之后主路换了）；
          //   ② 这条消息带工具调用：思考是动手前的盘算，不是话（旧分支 318 行的注释）。
          if (inProactiveTurn(record)) {
            logger.info?.(
              `[dsh-qq] ${record.label} 主动机会这一轮没写正文，按沉默处理（不捞思考）`,
            )
            wake?.noteProactiveSilent?.(record)
            return
          }
          if (hasToolUse(data.message)) {
            logger.info?.(`[dsh-qq] ${record.label} 这条消息带工具调用，思考不兜底`)
            return
          }
          const salvaged = salvageFromReasoning(data.message)
          if (salvaged) {
            logger.info?.(
              `[dsh-qq] ${record.label} 正文是空的，从思考末尾捞回一句（${salvaged.length} 字）`,
            )
            raw = salvaged
            salvagedOnly = true
          } else {
            logger.info?.(`[dsh-qq] ${record.label} assistant/message 没有正文（只有思考）`)
          }
        }
        // 2026-11-04 23:50 姐姐定（B）：[SILENT] 不能一刀切。
        // 22:20 那次正文是「好了，能写能读… [现在是 2026-11-04 周三 22:20（晚上）] [姐姐] 嗯呢 [SILENT] [现在是 2026-」
        // ——演过头，把下一轮的信封和标记一起写进了正文。旧的 `includes(SILENT)` 直接存空串，
        // 结果整轮不发、日志也不留，从外面看就是「突然哑了」。
        // 现在分三种：
        //   ① 标记前面混着自演信封 → 砍掉信封和标记后面，留下的真话照常兜底；
        //   ② 标记前面只是心里话（没有信封）→ 维持原判，整条按沉默（10-28 12:38 那条不变）；
        //   ③ 标记前面什么都没有 → 她就是在选沉默（只取消这一步，不动本轮已经攒下的正文）。
        const silentAt = findSilentMark(raw)
        if (silentAt < 0) {
          stashPending(sessionId, raw)
          if (salvagedOnly) salvagedPending.add(sessionId)
          else salvagedPending.delete(sessionId)
          return
        }
        const head = raw.slice(0, silentAt)
        const withoutReplay = cutAtScriptReplay(head).trim()
        // 2026-11-07 22:46 修：这一步只写了标记、前面一个字都没有（纯沉默），
        // 不该把本轮前面几步已经攒下的正文清掉——那样「先说话、再调工具、再写 [SILENT]」
        // 就会把说过的话一起抹了（11-07 22:39 就是这条 + 上面 hasToolUse 一起造成的）。
        //
        // 2026-11-08 17:45 事故：例外是「从思考里捞回来的」那句——它本来就不是她说的，
        // 纯沉默恰恰说明这一轮她选择不说，捞回来的素材必须跟着清掉，不能留到 turn/end。
        if (!withoutReplay) {
          if (salvagedPending.has(sessionId)) {
            logger.info?.(
              `[dsh-qq] ${record.label} 纯沉默，清掉本轮从思考里捞回的那句（不是她说的话）`,
            )
            pendingText.delete(sessionId)
            salvagedPending.delete(sessionId)
          }
          return
        }
        if (withoutReplay === head.trim()) {
          // 2026-11-11 16:05 姐姐问「老二回答了还要输出一个 SILENT」。现场：老二在私聊里写
          // 「那个下午就这么过了 [SILENT]」，走到这里被判「标记前面只是心里话」清成空串，
          // QQ 那边 11 分钟一个字都没收到（`QQ会话\老二\logs\dsh-qq-2026-11-11.log` 15:43:55 后无 →）。
          // 私聊恒必回（inbound.js:316），没给过沉默出口。所以：非主动的私聊里，
          // 标记前面的话就是她说的话，剥干净照发；主动轮与群聊仍按原判（10-28 12:38 那条不变）。
          const keptPrivate =
            record?.scope === 'private' && !inProactiveTurn(record)
              ? stripClosingTalk(stripLeakedThinking(withoutReplay)).trim()
              : ''
          if (keptPrivate) {
            logger.info?.(
              `[dsh-qq] ${record.label} 私聊正文带沉默标记，剥掉标记照发（留 ${keptPrivate.length} 字）`,
            )
            stashPending(sessionId, keptPrivate)
            salvagedPending.delete(sessionId)
            return
          }
          // 2026-11-12 22:5x：原来这里是 pendingText.set(sessionId, '')。
          // 但这一条只是「本条消息全是心里话」，不代表她这一轮前面说过的也不作数——
          // 抹了就会把攒着的真话一起吞掉（老三 22:46 那轮 3 句只发 1 句的第二个原因）。
          salvagedPending.delete(sessionId)
          return
        }
        const kept = stripClosingTalk(stripLeakedThinking(withoutReplay)).trim()
        if (!kept) {
          salvagedPending.delete(sessionId)
          return
        }
        logger.info?.(
          `[dsh-qq] ${record.label} 正文在 ${SILENT_MARKER} 前面还有真话，砍掉自演那截继续兜底（留 ${kept.length} 字）`,
        )
        stashPending(sessionId, kept)
        salvagedPending.delete(sessionId)
        return
      }
      // 本轮已经用 qq_reply 之类的工具把话发过了 → 不再重复转发
      if (selfSent.has(sessionId)) {
        resetStream(sessionId)
        return
      }
      // 2026-10-27 09:53 姐姐定，按老三自己的取舍办（原话：「工具轮本来就不该开口，
      // 那些『要不要现在读』『好，发』都是我自己的事，不出声正好」）：
      // **带工具调用的这条消息，整条不发**。判断只看结构，不看句子长得像不像人话。
      // 工具跑完模型还会再出一条纯文本消息，那才是正文；所以正文不会丢。
      // 前置条件：streamReply 必须关掉，否则流式早就把过场话一句句冒出去了。
      if (hasToolUse(data.message)) {
        resetStream(sessionId)
        return
      }
      // 2026-10-28 12:38 事故：主动机会那一轮，她的正文是「21 分钟没动静，可能在午睡。别打扰。沉默。」
      // 后面跟着 [SILENT]。stripLeakedThinking 先看到了 [SILENT]——它一个汉字都没有，
      // 被那句 `if (!HAS_CJK.test(t) && t.length >= 4) return ''` 当成「不是话」整行丢掉，
      // 剩下那句心里话反倒被当成正文发了出去。标记的语义是「这句是跟我自己说的」，
      // 只要它在，整条都不发——不看前后还写了什么，也不兜底、不扣额度。
      const rawText = extractText(data.message)
      // 2026-11-05 20:20 事故：工具调用标记漏成正文（DSML），整条不发。见 looksLikeLeakedToolMarkup。
      if (looksLikeLeakedToolMarkup(rawText)) {
        logger.info?.(`[dsh-qq] ${record.label} 正文漏出 DSML 工具标记，整条不发`)
        resetStream(sessionId)
        return
      }
      if (hasSilentMark(rawText)) {
        logger.info?.(`[dsh-qq] ${record.label} 正文带沉默标记，整条按沉默处理（不兜底）`)
        resetStream(sessionId)
        wake?.noteProactiveSilent?.(record)
        return
      }
      let text = stripLeakedThinking(rawText)
      // 2026-11-16 08:26 姐姐批（原话「嗯可以加上，毕竟确实不好判断」）：
      // 剥行以前是**静默**的——08:05 那条 227 字推演漏进正文以后，日志里只有兜底那句
      // 「清洗后 203/225 字」，看不出闸到底动没动手、剥掉了什么。出事时只能事后 dump 会话
      // 去比原文。这里补一行，只在「真删掉了非空行」或「字数掉了一半以上」时才记，
      // 免得 repairShape 换行之类的小修刷屏。
      {
        const beforeLines = rawText.split('\n').filter((l) => l.trim()).length
        const afterLines = text.split('\n').filter((l) => l.trim()).length
        if (afterLines < beforeLines || text.length * 2 < rawText.length) {
          logger.info?.(
            `[dsh-qq] ${record.label} 正文剥掉思考链 ${rawText.length}→${text.length} 字 / ${beforeLines}→${afterLines} 行: ${text.slice(0, 120).replace(/\s*\r?\n\s*/g, ' ⏎ ')}`,
          )
        }
      }
      // 2026-11-12 18:01（老二六段剧本）：把它替姐姐写的那一半砍掉。
      // 主动机会轮只留第一段；普通轮只在命中「残渣标签 / 剧本形状」时才砍。
      const beforeScript = text
      text = cutAtDialogueScript(text, { proactive: inProactiveTurn(record) })
      if (text !== beforeScript) {
        logger.info?.(
          `[dsh-qq] ${record.label} 正文替姐姐写了台词，砍到 ${text.length}/${beforeScript.length} 字: ${text.slice(0, 120).replace(/\s*\r?\n\s*/g, ' ⏎ ')}`,
        )
      }
      // 2026-10-27 21:4x：正常正文也过一遍收尾元话。
      // 以前只有「正文为空、兜底捞 reasoning」那条路才剥，所以
      // 「结束这轮，不再说话。」这种宣告句直接从正文流出去了。
      text = stripClosingTalk(text)
      // 2026-10-28 13:09 事故：主动机会那一轮，正文整句是
      // 「不过可以想到：她之前说困了眯一会儿。等她自己醒。沉默。」
      // 一个标记都没有，纯心里话写进了正文。主动轮本来就允许「不说」，
      // 凡是正文在向自己交代（沉默/别打扰/等她自己醒）的，一律当沉默——
      // 宁可少说一句，不许再漏一次。
      if (inProactiveTurn(record) && /沉默|别打扰|等她(自己)?醒|不追着|别催/.test(text)) {
        logger.info?.(`[dsh-qq] ${record.label} 主动机会这一轮正文是自我交代，按沉默处理`)
        resetStream(sessionId)
        wake?.noteProactiveSilent?.(record)
        return
      }
      // 模型偶尔把答案整个写进 reasoning，text 块是空的（2026-10-26 17:15、17:16 各一次：
      // turn 正常结束，QQ 那边一个字都没收到）。退回去取 reasoning 的尾段当正文。
      // 2026-10-27 09:42 起加护栏：带工具调用的消息不兜底（那是动手前的盘算，不是话）。
      // 2026-10-27 15:08 / 16:00 再加一层：兜底捞到的东西先过 stripMetaTalk，
      // 把「再加一点温度：不用太长。」这类改稿指令剥掉；剥空了就当这轮没话，不发。
      // 2026-10-28：主动机会那一轮不兜底 —— 正文空就是她选择不说。
      // 兜底的初衷是「怕丢话」，可主动机会本来就是「可以说，也可以不说」，
      // 硬兜底等于逼她开口，还把「就沉默。规则说发出去没人应，当她在忙」这种
      // 心里话当成话播了出去（08:30、09:00、09:48 三轮）。
      if (!text && !hasToolUse(data.message) && inProactiveTurn(record)) {
        logger.info?.(`[dsh-qq] ${record.label} 主动机会这一轮没写正文，按沉默处理（不兜底 reasoning）`)
        resetStream(sessionId)
        wake?.noteProactiveSilent?.(record)
        return
      }
      if (!text && !hasToolUse(data.message)) {
        const tailed = reasoningTail(data.message)
        if (hasSilentMark(tailed)) {
          // 2026-10-27 16:00 事故：她那轮 reasoning 是「嗯，但会不会显得太冷淡？不，规矩说不发也可以。」
          // 加「我选 [SILENT]。」——text 空，兜底把整段捞成正文，连标记一起发到了 QQ 上。
          // 带静默标记就当她自己选了潜水：交给 send 按沉默处理（不扣主动额度）。
          logger.info?.(`[dsh-qq] ${record.label} 兜底内容里带 ${SILENT_MARKER}，按沉默处理`)
          text = SILENT_MARKER
        } else {
          // 2026-10-27 15:08 事故：兜底捞出「再加一点温度：不用太长。／好，一句。」这种改稿指令。
          // 先剥掉元话语；剥空了就当这轮没话，不发。
          text = stripMetaTalk(tailed)
          // 2026-10-29 19:00：剥完还得是中文话。模型用英文思考时正文容易空，
          // 兜底顺手把英文推理尾巴当成话发出去（老二 18:42 那次就是桌面端只有思考、
          // QQ 却收到一条）。中文尾巴照旧捞——这条闸只拦英文为主的。
          if (text && !mostlyChinese(text)) {
            logger.info?.(`[dsh-qq] ${record.label} 兜底内容不是中文（模型在用英文思考），这轮不发`)
            text = ''
          }
        }
      }
      if (!text) return

      const already = streamCount.get(sessionId) ?? 0
      const consumed = streamConsumed.get(sessionId) ?? 0
      resetStream(sessionId)

      // 流式已经发出去过几句：只补后面没发的，别把发过的再发一遍。
      // 2026-10-26 19:40 改：按**已消费的原始字符数**切，不按句数切。原文增量生长、
      // 切掉的前缀是实打实的字符，清洗删行也不会让两边错位（见 streamConsumed 的注释）。
      if (already > 0) {
        const rawText = extractText(data.message)
        const rest = consumed > 0 ? stripLeakedThinking(rawText.slice(consumed)) : text
        if (rest) await emit(record, rest)
        lastSent.set(sessionId, text)
        return
      }

      // 没走流式：整套去重逻辑
      const previous = lastSent.get(sessionId) ?? ''
      if (text === previous) return
      if (previous.startsWith(text) && text.length < previous.length) return
      lastSent.set(sessionId, text)
      if (previous && text.startsWith(previous)) {
        const tail = text.slice(previous.length).trim()
        if (tail) await emit(record, tail)
        return
      }
      await emit(record, text)
      return
    }

    if (type === 'turn/end') {
      // ── 忘了调工具的兜底（2026-11-04 14:52 姐姐：「会忘记调用工具。老三已经出现了」）──
      // 只在三种条件同时成立时发：没调过任何工具（不是干活轮）、没自己发过（selfSent）、
      // 正文原文一个字都不用洗。清洗动过就说明里面有信封/草稿/自演，宁可不说。
      const pending = pendingText.get(sessionId)
      const pendingSalvaged = salvagedPending.has(sessionId)
      pendingText.delete(sessionId)
      salvagedPending.delete(sessionId)
      // 2026-11-04 15:00：`touched` 不再当门槛。它记的是「调过任何工具」，
      // 可老三最常见的模式恰恰是「qq_memo 读一段 → 说一句」——读文件被算成干活轮，
      // 于是「读完了…」整句被扣下，QQ 那边一条都不响（14:52 重启后 0 条 → 的现场）。
      // 真正该排掉的是「正文里全是盘算」，那由下面的 pristine 判定负责。
      turnTouchedTool.delete(sessionId)
      const sentByTool = selfSent.has(sessionId)
      if (!textReplyEnabled && textReplyFallback && pending && !sentByTool) {
        const clean = cutAtDialogueScript(stripClosingTalk(stripLeakedThinking(pending)), {
          proactive: inProactiveTurn(record),
        })
        // 2026-11-08 17:45 事故的最后一道闸：主动机会那一轮，从思考里捞回来的东西一律不发。
        // 正文是空的，说明她这一轮本来就没打算开口；捞回来的只是思考里的素材（那天是日记）。
        // 真正写进正文的话（pendingSalvaged=false）不受影响，11-07 那次「正文被吃」不会再犯。
        if (pendingSalvaged && inProactiveTurn(record)) {
          logger.info?.(
            `[dsh-qq] ${record.label} 主动机会这一轮只有思考素材，按沉默处理（不兜底）`,
          )
          wake?.noteProactiveSilent?.(record)
        } else {
          // 2026-11-04 15:03：不再要求「洗了等于没洗」。老三几乎每轮都在正文里先写
          // 「她夸我可爱…回一句软的」这种盘算，再写真话；要求原文一字不动，
          // 等于每轮都扣下（15:02:10 那轮就是「正文要清洗，按不发处理」）。
          // 现在按「洗过的结果」发——真正的雷（自演下一轮、伪造信封）单独判：带信封的整轮不发。
          const hasScript = pending.split('\n').some((line) => SCRIPT_REPLAY_RE.test(line.trim()))
          if (clean && !hasScript && !(data.reason?.kind === 'error')) {
            // 2026-11-09：日志只记字数，复盘时看不到那句话到底长什么样
            //（09:22「（抱住妹妹~亲）」在首行之后，日志里一个字都没有）。全文记到 300 字。
            logger.info?.(
              `[dsh-qq] ${record.label} 这一轮没调发送工具，兜底发出去（清洗后 ${clean.length}/${pending.trim().length} 字）: ${clean.slice(0, 300).replace(/\s*\r?\n\s*/g, ' ⏎ ')}`,
            )
            // 观察信号，不改行为：动作括号里拿「妹妹」这类自称当对象，多半是把视角写反了。
            // 攒够样本再决定要不要拦（她 11-09：「先不急，加的越多越容易出事」）。
            if (looksLikeSelfAddressedAction(clean)) {
              logger.warn?.(
                `[dsh-qq] ${record.label} 兜底内容里的动作拿自称当对象了，视角可能写反（先只记不计）`,
              )
            }
            await emit(record, clean)
          } else if (pending.trim()) {
            logger.info?.(
              `[dsh-qq] ${record.label} 这一轮没调发送工具，正文${hasScript ? '自演了下一轮' : '洗不出话'}，按不发处理`,
            )
          }
        }
      }

      lastSent.delete(sessionId)
      selfSent.delete(sessionId)
      // 2026-11-07 12:48：一轮最多发 3 条（闸在 index.js 的 send 里）。
      // 边界在这儿清——不然额度会一直累加，第二天她一句话都发不出来。
      record._turnSends = 0
      resetStream(sessionId)
      // 2026-10-28：主动机会的戳只在本轮有效，别让它跨轮残留
      if (record._proactiveAt) record._proactiveAt = 0
      const reason = data.reason
      if (reason?.kind === 'error') {
        const message =
          reason.error?.message || reason.failure?.message || reason.failure?.code || '处理时出错了'
        logger.warn?.(`[dsh-qq] ${record.label} 本轮出错: ${message}`)
        await emit(record, `⚠️ ${message}`)
      }
      return
    }

    if (type === 'tool/call') {
      const name = String(data.name ?? '')
      turnTouchedTool.add(sessionId) // 这一轮动过手，就不是「忘了调工具」，不兜底
      if (SELF_SENDING_TOOLS.has(name)) selfSent.add(sessionId)
      // 她 read 了门口的信 → 记一笔「这封拆过了」。
      // 2026-10-27 姐姐发现：她读过之后，下次提示还是「挂着 3 封没拆」——
      // 因为门口只数文件在不在，read 不会让文件消失。于是每轮都在骗她，还可能让她反复读同一封。
      if (/^read$/i.test(name)) {
        try {
          markDoorRead(config, readPathOf(data))
        } catch {
          // 记不上就算了：门口那行提示每轮都跑，不能因为这里出错整只鲸鲸不说话
        }
      }
      if (config.showToolResults) {
        await emit(record, `🔧 调用 ${name || 'tool'}`)
      }
      return
    }

    if (type === 'tool/result' && config.showToolResults) {
      const err = data.error
      if (err) await emit(record, `⚠️ 工具失败: ${err.message ?? err.code ?? err}`)
      return
    }
  }
}
