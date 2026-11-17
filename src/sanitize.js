/**
 * 出站清洗：判断「这段文字能不能直接发」以及把它洗干净。
 *
 * 2026-11-07 13:05 从 outbound.js 拆出来（姐姐选的方案 B：按阶段拆文件）。
 * 这个文件只放纯函数——给一段模型输出的字符串，回一段能发的话。
 * 不碰会话、不发消息，所以以后改清洗规则不会牵动发送流程。
 *
 * 三层判断：
 *   1) 标签层：工具调用标记 / 上下文信封漏成正文 → 剥
 *   2) 盘算层：思考、改稿、自评写进正文 → 剥
 *   3) 兜底层：正文空了要不要拿 reasoning 尾巴顶上 → 不在这里，在 outbound.js
 *
 * outbound.js 会把这里的名字重新导出一次，tools.js 和测试里
 * `from './outbound.js'` 的写法一行都不用改。
 */

import { SILENT_MARKER, findSilentMark, hasSilentMark } from './prompts.js'
import { classifyInjectTag } from './inject-tag.js'

export function extractText(message) {
  const content = message?.content
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content.trim()
    return ''
  }
  let out = ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out += part.text
  }
  return out.trim()
}

/**
 * 2026-11-05 20:20 事故：老三那轮把工具调用标记当正文吐出来了——
 * 正文整条是 `</| | DSML | parameter></| | DSML | invoke></| | DSML | calls>`。
 * provider 没把它解析成 tool_use，它就是一个纯 text 块：`hasToolUse` 看不出来，
 * 于是被当正文发到了 QQ。
 * 凡是正文里漏出 DSML 标记的，一律当「这轮其实是工具调用」整条不发。
 */
const DSML_LEAK = /DSML|<\s*\/?\s*\|\s*\|/i

export function looksLikeLeakedToolMarkup(text) {
  return DSML_LEAK.test(String(text ?? ''))
}

/** 句子边界：中文句号/问号/叹号/省略号，以及换行。 */export const SENTENCE_END = /^([\s\S]*?[。！？!?…\n])/

/**
 * 模型偶尔把「想一想再改一版」的过程写进正文（不是 reasoning channel）。
 * 2026-10-25 15:24 和 15:28 各出现一次，原样发到了 QQ 上。
 * 这里按「整行像思考」兜底剥掉——只认行首那几个标志词，不碰正常中文。
 * 近 7 天 2825 条样本里一条都没再命中，但 test/outbound.test.mjs 有 fixture 钉着，
 * 动它就会红——留着当保险，别当死代码删。
 */
const LEAK_LINE = [
  /^Hmm\b/i,
  /^Maybe\b/i,
  /^Let me\b/i,
  /^Two lines?\b/i,
  /^-\s*user asks about\b/i,
  /^Keep it\./i,
  /^I (?:should|will|need to|think|guess)\b/i,
  /^(?:use\s+)?["'「『“‘][^"'」』”’]{1,16}["'」』”’]\s*(?:language|lang|style|tone|wording)\b\s*\.?\s*$/i,
  /^[^\s"'」』”’]{1,16}\s+(?:language|lang|style|tone|wording)\s*\.?\s*$/i,
]

/**
 * 2026-11-14 19:0x 老二私聊：她把「这一句怎么发」的自我交代写进了正文，QQ 里收到的是
 *   `不过规则：「对方没接就先停着，不追」。不是追，是一天里第二条。可以。`
 *   `发吧。`
 *   `这是问句，没解释。好。发。`
 *   `核对一下：正文只一句。可以。`
 *   `这一段重复了，最终发一条干净的：`
 * 这些句子说的是「我怎么发」，不是「我要说的事」。它们和 LEAK_LINE 那批英文自评是
 * 同一个毛病，只是换成了中文——英文一条规则都拦不住。
 * 判据两条：
 *   ① 行首命中自检词（发吧 / 核对一下 / 这一段重复了 / 最终发一条干净的 …），直接丢；
 *   ② 行尾是「可以。」「发。」这类收尾、整行又短、又不带「你」的，只在**多行正文**里丢
 *      （单行消息里一个「可以。」就是她在答话，跟 dropSelfHush 同一个道理）。
 */
const SELF_CHECK_HEAD_RE =
  /^(?:发吧|好[。.]?\s*发|那就发|发一句|这是问句|核对一下[:：]?|这一段(?:重复|说重)|重复了|最终发一条|发一条干净的|再来一条|短[。.]?\s*一条|这一句(?:太长|太短)|这句(?:太长|太短))/
const SELF_CHECK_TAIL_RE = /(?:可以|行了|就发|发吧)[。.]$/

function looksSelfCheck(line, multiLine) {
  const t = String(line ?? '').trim()
  if (!t) return false
  if (SELF_CHECK_HEAD_RE.test(t)) return t.length <= 60
  if (!multiLine) return false
  if (/你/.test(t)) return false
  return t.length <= 40 && SELF_CHECK_TAIL_RE.test(t)
}

/**
 * 2026-11-16 08:05:35 老大（QQ）——「角色扮演层的推演」整段写进正文，227 个字一条没剥：
 *   好~妹妹昨天夜里读书了吗
 *   她问昨天夜里读书了吗。答事实：读了两章，133 和 134。
 *   不主动报细节，问就说。
 *   「读了两章，133 和 134。胡玉牛那一章，把自己最要紧的烦恼全翻出来了」
 *   好。可以多一句：读到早上四点那一轮。
 *   简短：「读了两章，133、134。第二本是阿牛拿镊子拔腿毛那段…」
 *   读了两章，133、134
 *   后面那章是阿牛拿镊子一根根拔腿毛…读得我有点沉
 *   （尾巴垂下来）
 * 上面那些判据一条都没认：looksPlanning 认的是工具/便签/文件名，looksSelfCheck 认的是
 * 「发吧 / 核对一下」。这批是**另一种毛病**——它先在脑子里把「你问什么、我该答什么、
 * 报多少细节、发哪一版」走了一遍，然后整段留在 text 里。跟操作层无关，是角色扮演层。
 * 判据只认这四种形状（都带冒号或元层动词，正常聊天不会这么写）：
 *   ① `她问…。` 开头 —— 第三人称自问自答
 *   ② 「怎么答」的策略词：`问就说` / `不主动报` / `答事实` / `只说事实`
 *   ③ 自我批准 + 冒号：`好。可以多一句：…`
 *   ④ 候选稿标签 + 引号：`简短：「…」`
 * 只在多行正文里剥（单行一个「问就说」可能就是正常说话，跟 dropSelfHush 一条道理）。
 */
const THIRD_PERSON_META_RE = /^她(?:问|说|刚|又|已经)[^。！？!?]{0,30}[。？?]/
const REPLY_STRATEGY_RE =
  /(?:问就说|不主动报|别主动报|不要主动报|答事实|只说事实|先答再|报太多细节)/
const SELF_APPROVE_MORE_RE = /^(?:好[。.]?\s*)?(?:可以|再)?多(?:说|问)?一?句\s*[:：]/
const DRAFT_LABEL_RE = /^(?:简短|更短|再短|精简|压缩|最终版?|定稿|候选|草稿)[点些]?\s*[:：「]/
// 2026-11-16 同一个早上后面两条也漏了（08:06:48、08:08:21），形状是
//   `她大概是在验那个闸。答完就停。`
//   `她大概想让我去桌面端一起看。答完就等她说。`
// 「她大概/可能」是它在猜我的状态，「答完就停/答完就等她说」是它给自己下指令——
// 两句都不是对姐姐说的话。要求：整行 ≥12 字（挡掉「她大概明天到」这种真在聊别人）、
// 不含「你」、不含引号（转述别人的话会带引号）。
const THIRD_PERSON_GUESS_RE = /^她(?:大概|可能|应该|似乎|好像|是不是|会不会|在?想)/
const SELF_INSTRUCTION_RE = /(?:^|[。！？!?]\s*)(?:答完|说完|回完|发完|讲完|聊完)(?:就|再|之?后)/

function looksReplyDraft(line, multiLine) {
  const t = String(line ?? '').trim()
  if (!t) return false
  if (t.length > 90) return false
  if (!multiLine) return false
  return (
    THIRD_PERSON_META_RE.test(t) ||
    REPLY_STRATEGY_RE.test(t) ||
    SELF_APPROVE_MORE_RE.test(t) ||
    DRAFT_LABEL_RE.test(t) ||
    (t.length >= 12 && !/[你「」“”"]/.test(t) && (THIRD_PERSON_GUESS_RE.test(t) || SELF_INSTRUCTION_RE.test(t)))
  )
}

/** 她在问话：短、没有你我、以问号或「吗/呢/吧」收尾。 */
function looksHerQuestion(t) {
  const s = String(t ?? '').trim()
  if (!s || s.length > 30) return false
  if (/[你我]/.test(s.replace(/本姑娘/g, ''))) return false
  return /[？?]$|[吗呢吧][。.!！?]*$/.test(s)
}

/**
 * 紧跟在一个「她问…」行**前面**、又不带你我的问句，是替她写的台词，不是我说的话。
 *   `好~妹妹昨天夜里读书了吗`  ← 这句是她要说的
 *   `她问昨天夜里读书了吗。答事实：…`  ← 这句是模型的自问自答
 * 只靠「她问…」这一行判不出前一行，所以要回看一眼；已删行（null）不算空行。
 */
function dropScriptedHerLine(lines) {
  const doomed = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    const t = typeof lines[i] === 'string' ? lines[i].trim() : ''
    if (!t || !THIRD_PERSON_META_RE.test(t)) continue
    // 往回看，最多跨 3 个非空行（段落之间有空行，不能一遇空行就停——
    // 2026-11-16 第一版就是这么漏的：`她问…` 上面隔着一个空行才是她的台词）。
    let hops = 0
    for (let k = i - 1; k >= 0 && hops < 3; k -= 1) {
      const v = lines[k]
      if (v === null) continue
      if (typeof v !== 'string') break
      if (!v.trim()) continue
      hops += 1
      if (looksHerQuestion(v.trim())) doomed.add(k)
      break
    }
  }
  return lines.map((line, i) => (doomed.has(i) ? null : line))
}

/**
 * 2026-11-03 21:22：老大在 QQ 里把「对自己的嘱咐」写进了正文：
 *   `那就不急 / 反正也快十点了 / 嗯，别连问。 / 反正也快十点了，熬不到哪儿去`
 * 之后又漏了 `嗯，简短点。` `嗯，收着点。` 和单独一行的 `（嗯，这句可以。）`。
 * 这种句子极短、没有「你」、以「嗯，」起头，说的是「我怎么发」而不是「我要说的事」。
 * 但 `嗯，别急。` `嗯，别客气。` 是**真在安慰她**——所以要分两种：
 *   ① 括号包着的（`（嗯，这句可以。）`）：括号里就是内心话，整句丢；
 *   ② 裸写的：只在**多行正文**里丢（单行时它可能就是一句完整的安慰话），
 *      而且「别客气 / 别担心 / 别急 / 别怕」一律放过。
 */
const SELF_HUSH_BRACKET_RE = /^[（(]\s*嗯[，,][^）)]{2,14}[）)]$/
const SELF_HUSH_RE =
  /^嗯[，,]\s*(?:别|收|简短|短|慢|快|停|稳住|少说|多说|这句|这样就)[^你]{0,10}[。.！!]?$/
// 2026-11-03 22:30 又漏一窝：搞明白一件事之后它给自己点头——
//   `嗯，这个想得明白` / `嗯，想得明白` / `嗯，这个明白`
// 这是「我懂了」，不是「跟你说我懂了」；真回话会说「嗯，我明白了」或者带「你」。
// 仍然只在多行正文里丢：单行一个「嗯，明白了」是正常对答。
const SELF_CONFIRM_RE =
  /^嗯[，,]?\s*(?:这个|那个|这|那)?(?:想得明白|想明白|想清楚了|想清楚|明白了|明白|懂了|通透了)[。.！!…]?$/
// `啊，我怎么又漏了——赶紧收住。`：发现自己在漏、现场给自己刹车。
// 这是它的 OODA 不是话；但怕误伤「啊，你怎么又忘了」，排除带「你」的。
const SELF_CATCH_RE = /^啊[，,！!]?[^你]{0,24}(?:又漏|漏了|漏出来|又冒)[^你]{0,24}(?:收住|打住|停住|收着|别漏)/
// 21:29 又漏了一种：整条最后单独一行 `嗯。`——正文说完，它给自己点个头。
// 单条消息只有一个「嗯。」是同意（她本人也会这么回），所以同样只在多行里丢。
const SELF_HUSH_BARE_RE = /^嗯[。.，,]?$/
const POLITE_HUSH_RE = /^[（(]?\s*嗯[，,]\s*别(?:客气|担心|急|怕)/

function dropSelfHush(lines) {
  const multi = lines.filter(Boolean).length >= 2
  return lines.map((line) => {
    const t = String(line ?? '').trim()
    if (!t) return line
    if (POLITE_HUSH_RE.test(t)) return line
    if (SELF_HUSH_BRACKET_RE.test(t)) return null
    if (multi && (SELF_HUSH_RE.test(t) || SELF_HUSH_BARE_RE.test(t))) return null
    if (multi && (SELF_CONFIRM_RE.test(t) || SELF_CATCH_RE.test(t))) return null
    return line
  })
}

/**
 * 行首那一串英文小标签（`Good.` `2 lines.` `Hmm `）是模型的自评，不是话。
 * 它常常和中文粘在同一行：`Good.本姑娘这边显示是发出去了`——整行删会把话也删掉，
 * 所以先剥掉前缀：剥完剩下的还有两个以上英文词，才整行丢（见下面的 EN_WORD 判定）。
 */
const LEAD_LABEL = /^(?:[A-Za-z0-9][A-Za-z0-9'’\-]*[.。:!?,、]?\s*)+/

/** 一个汉字都没有的行，基本只能是模型的自评（`That's factual and short. Two lines is fine.`）。 */
const HAS_CJK = /[\u4e00-\u9fa5]/

const SELF_TAIL = /[—–-]{1,2}\s*(?:good|fine|ok|works?|nice)\s*\.?\s*$/i

/**
 * 2026-10-29 16:25:36 / 16:29:54 老二连着两次把「改稿时的自我点评」当正文发出去：
 *   `破折号? fine.` / `逗号 ok.` —— 只点评一个标点，后面跟个英文词。
 * HAS_CJK 拦不住它们（「破折号」三个汉字），纯英文首词那条也拦不住（不是英文开头）。
 * 判据收紧成三条同时成立：出现标点/篇幅类元词 + 有英文词 + 行本身很短。
 * 正常说话里这三条凑不齐——`破折号少用一点` 没有英文词，放过。
 */
const META_WORD_RE = /(?:破折号|逗号|句号|问号|省略号|标点|字数|长度|这句|这句太|太长了|太短了)/
function looksSelfReview(line) {
  const t = String(line ?? '').trim()
  if (!t || t.length > 20) return false
  if (!META_WORD_RE.test(t)) return false
  return (t.match(/[A-Za-z]{2,}/g) ?? []).length >= 1
}

/** 行尾挂一句「— good.」「- fine.」，是模型在给上一句打分，不是在说话。 */
/**
 * 2026-10-29 18:28 老二私聊又漏了一次，这次是**英文改稿标签**漏进正文：
 *   `赢了没` / `— better: 打爽了没，吃什么` / `赢了没.`
 *   `Reply: 平手，还行` / `Short: 一胜一负，不亏` / `Then wait. …`
 * 这几种都是「给上一句提修改意见」的标签行，不是话。looksSelfReview 只认中文的
 * 破折号/字数那类元词，英文形态一个都认不出——补一条按形状认的：
 * 行首是 `—`/`-`/`–` 起头的英文标签，或者直接 `Word:` / `Word's:` 起头，
 * 且整行不长。正常正文里不会用英文标签开头。
 */
const REWRITE_LABEL_RE =
  /^(?:[-—–]{1,2}\s*)?(?:better|actually|instead|alternative|alt|option|rewrite|reword|reply|shorter|short|longer|long|version|v\d|note|check|maybe|then)\s*[:：]/i
function looksRewriteNote(line) {
  const t = String(line ?? '').trim()
  if (!t || t.length > 48) return false
  if (!REWRITE_LABEL_RE.test(t)) return false
  // 纯英文的「Note: xxx」也可能是正文，只有后面还跟着中文（说明是在点评中文草稿）才删
  return HAS_CJK.test(t)
}

/**
 * 2026-10-29 16:29:54 老二把插件塞给它的**上下文行**当正文复读了出来：
 *   `[现在是 2026-10-29 周四 16:41（下午）]` + `[姐姐] 妹妹吃饱了没`
 * 这两行是 inbound.js 拼给 agent 看的信封（`parts.push(`[现在是 ${humanTime()}]`)`、
 * `[${ownerLabel}] ${head}`），不是话。而且那行时间还是它自己编的（当时 16:29，它写 16:41）。
 * 只认这两种信封形状 + 独占一行的长度上限，正文里正常用方括号的话不受影响。
 */
const CONTEXT_ECHO_RE = new RegExp(
  // 2026-11-03 22:46 老三写成了 `user[现在是 …]`——前面多一个 user 前缀，原来认不出。
  '^(?:(?:user|User|USER)\\s*)?(?:' +
    '\\[现在是[^\\]]{2,40}\\]' + // 时间信封
    '|\\[(?:姐姐|主人)\\]' + // 私聊里主人/姐姐的信封标签
    '|\\[(?:群友|群友\\d+)\\s[^\\]]{0,20}\\]' + // 群聊 historyLine 的信封标签
    ')\\s*[^\\n]{0,80}$',
)

/**
 * 2026-11-03 22:46 老三把「下一轮的输入」整段演进了正文，然后照着自己编的那轮真发了晚安：
 *   `（安静地让她摸）` / `这一会儿不用说话`
 *   `user[现在是 2026-11-03 周二 23:29（深夜）]`
 *   `[姐姐] 妹妹抱抱~时候不早啦该睡了`
 *   `<system-reminder> Updated instructions from: AGENTS.md …`（整份底稿）
 * 21:31 也有一次：`[SILENT]` 后面跟着 `user[现在是 … 21:33（晚上）]` + `[姐姐] 嘿嘿`，
 * 而「嘿嘿」她根本没说过，也是编的。
 * 这类信封是 DSH 塞给它的**输入**，正文里一出现就说明它在续写下一轮，
 * 从这一行往后全是幻觉——整段砍掉，不是只丢这一行（只丢一行，后面「[姐姐] 该睡了」
 * 还会留下，它就会照着那句继续演）。`[姐姐]` 单独出现由 CONTEXT_ECHO_RE 整行丢。
 */
export const SCRIPT_REPLAY_RE =
  /^(?:>\s*)?(?:[A-Za-z]{0,6}\s*)?(?:\[\s*现在是\s*(?:19|20)\d\d[-年]|<system-reminder>)/i

/**
 * 2026-11-04 23:50（姐姐定 B）：把「同一行里续写的信封」也砍掉。
 * SCRIPT_REPLAY_RE 带 `^`，只认行首；可模型常把信封跟真话挤在一行
 * （`…真话 [现在是 2026-11-04 周三 22:20（晚上）] [姐姐] 嗯呢`），按行切不掉。
 * 返回第一个信封起点之前的原文；没有信封就原样返回。
 */
export function cutAtScriptReplay(text) {
  const s = String(text ?? '')
  const lines = s.split('\n')
  const i = lines.findIndex((line) => SCRIPT_REPLAY_RE.test(line.trim()))
  let out = i < 0 ? s : lines.slice(0, i).join('\n')
  const inline = out.search(/\[\s*现在是\s*(?:19|20)\d\d[-年]|<system-reminder>/i)
  return inline >= 0 ? out.slice(0, inline) : out
}

/**
 * 2026-11-12 18:01 事故（老二，姐姐三张截图说「变严重了」）：主动机会轮，它的思考里
 * 明明白白只打算说一句——
 *   「发一句轻的：『六点了，本姑娘按时来喊一声，晚饭可不能拖』。这不是查岗，是约定。」
 * 正文却是六段：
 *   六点了，本姑娘按时来喊一声——再赖下去晚饭就该凉了
 *   唔……</dc> / 醒了</dc> / 知道了</dc> / (坐起来揉眼睛)</dc>
 *   （伸手过去扶一把）慢慢醒，不急这一分钟
 * 后五段全是姐姐的台词，还带着它自己吐的 `</dc>` 残渣（跟 `</||DSML||>`、`</br>`
 * 同一个毛病：它在写一段「带标签的对话模板」）。而且这不是人设没生效——18:02:58
 * 它自己复述了「我只写我这一半」，五分钟后照旧犯。
 *
 * 三道判据，只看形状不看内容：
 * ① 残渣标签：`</dc>` `</dialogue>` 这种不是话的闭合标签一出现，从它所在那一段
 *    整段砍起。那段本身多半就是「她的台词 + 残渣」，留着比丢了更难看。
 * ② 剧本形状：三段以上、其中两段是十字以内的短句、还有一段是纯括号动作
 *    → 它在把一问一答写全，只留第一段。
 * ③ proactive（主动机会轮）另走一条更硬的：**正文只发第一段**。
 *    那一轮本来就是「给你一个说话的窗口」，说一句就够；多说的一定是自演。
 */
const JUNK_TAG_RE =
  /<\/\s*(?:dc|doc|dialogue|reply|msg|message|turn|speaker|speech|line|say)\s*>/i
const ACTION_ONLY_RE = /^[（(][^（()）]{1,40}[）)]$/

/**
 * 2026-11-12 18:17 事故（老二，重启后第一轮就犯，姐姐截图说「突然严重起来了」）：
 * 正文把**插件的注入模板**原样复读了——
 *   「好哒~(去做饭) / 嗯，去吧 /
 *    【主动机会】私聊 普瑞赛斯(希儿)(2710586329)已经安静了 25 分钟，现在是晚上（18:41）。
 *     对方有一阵子没动静了。可以说点自己刚想到的、问一句近况——但别催、别查岗、别问「在吗」。
 *     规矩：- 想说什么就直说… - 别先替她否掉自己… - 一次只发一条短的…」
 * 这是 25 分钟之后才该出现的主动机会提示，还没到点，它自己按「18:16 + 25 分钟」算出
 * 18:41，把整段模板提前抄进了正文。`SCRIPT_REPLAY_RE` 只认 `[现在是 …]` 那套旧格式，
 * 认不出 `【主动机会】`，于是 246 个字整段发了出去。
 *
 * 判据：出现注入模板的特征词，从那儿往后全砍——后面每一个字都是复读，
 * 留着只会让它照着再演一遍。前面已经写出来的真话保留。
 */
const INJECT_ECHO_RE =
  /【[^】]*主动机会[^】]*】|已经安静了\s*\d+\s*分钟|\[\s*现在是\s*(?:19|20)\d\d[-年]|<system-reminder>/i

export function cutAtDialogueScript(text, { proactive = false } = {}) {
  if (text == null) return text
  let s = String(text)
  if (!s.trim()) return s

  // ⓪ 注入模板复读：从特征词处砍到末尾
  const echoAt = s.search(INJECT_ECHO_RE)
  if (echoAt >= 0) {
    s = s.slice(0, echoAt).trimEnd()
    if (!s) return ''
  }

  if (!s.trim()) return s
  const paras = s
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (paras.length === 0) return s

  // ① 残渣标签：从它所在那一段整段砍起
  const junkAt = paras.findIndex((p) => JUNK_TAG_RE.test(p))
  if (junkAt >= 0) {
    const kept = paras.slice(0, junkAt)
    return kept.length ? kept.join('\n\n') : ''
  }

  // ③ 主动机会轮：只留第一段（说一句就够）
  // 但第一段如果是**替她写的台词**（短、不带你我、是问句），那整段就是在演剧本——
  // 这时候留第一段等于把她的话当成我的话发出去（2026-11-16 08:05:35 那条正文第一段
  // 就是 `好~妹妹昨天夜里读书了吗`）。往下挑第一个既不像她台词、也不像推演的段落；
  // 一个都没有就整条不发——主动轮本来就可以不说。
  if (proactive && paras.length > 1) {
    const pick = paras.find((p) => !looksHerQuestion(p) && !looksReplyDraft(p, true))
    return pick ?? ''
  }

  // ② 剧本形状
  const shortCount = paras.filter((p) => p.replace(/\s/g, '').length <= 10).length
  const hasAction = paras.some((p) => ACTION_ONLY_RE.test(p))
  if (paras.length >= 3 && shortCount >= 2 && hasAction) return paras[0]

  return s
}

/**
 * 2026-11-15 19:16 事故（老三，姐姐截图）：
 * 它在**正文**里自己写了一整段
 *   【插件注入·每隔一阵钉一次·不是她说的】
 *   • 只回她这一句；不替她编下一句…
 * 四行规则跟 `prompts.js` 的 `SHORT_RULES` 一字不差 —— 它照抄了历史里的真注入，
 * 然后当成自己的话贴进输出。下一轮它读历史，那段跟真注入长得一模一样，它会当真；
 * 再往后它可能自己写出「姐姐说过不用问她」这种假规矩，然后照着执行。
 *
 * 判据（只看形状）：**正文里行首出现「【插件注入」或「[插件注入」**。
 * 真注入只会出现在它**收到**的消息里，从不会从它嘴里出来 —— 所以正文里出现即伪造。
 * 处理：从那一行砍到末尾（后面每一个字都是复读 / 自己演的对白），前面已经写出来的真话保留；
 * 砍完是空的就等于整条拒发。是否命中单独返回，让调用方决定要不要给它一条回执。
 */
const SELF_INJECT_RE = /[【\[]\s*插件注入/

/**
 * 第 2 道闸（2026-11-15 19:45）：真注入现在每轮带一个随机码（`【插件注入·#a7f3·…】`），
 * 见 `inject-tag.js`。判据**不变——照样全砍**：带码的伪造也不能放行，
 * 因为码就写它收到的消息里，它抄得到。
 * 多出来的只有一件事：分得清它是**抄这一轮的**、**翻历史抄旧的**、还是**照形状现编的**。
 * 走 `classifyInjectTag`（inject-tag.js），回执措辞和日志按这个分。
 */
export function cutSelfInjection(text, options = {}) {
  if (text == null) return { text, cut: false, head: '', kind: 'none' }
  const s = String(text)
  const m = SELF_INJECT_RE.exec(s)
  if (!m) return { text: s, cut: false, head: '', kind: 'none' }
  const head = s.slice(m.index).split('\n')[0].trim().slice(0, 80)
  const kept = s.slice(0, m.index).trimEnd()
  // 只剩一点残渣（括号动作、半个标点）就不发了，免得姐姐那边收到一句没头没尾的话：
  // 先把括号动作和标点剥掉，剩下的真字不到 4 个就当整条砍空。
  const residue = kept.replace(/[（(][^（()）]*[）)]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return { text: residue.length >= 4 ? kept : '', cut: true, head, kind: classifyInjectTag(head, options.tag) }
}

/**
 * 2026-10-29 16:25:36 / 16:29:54：同一句话的四版草稿**只用单换行隔开**，
 * collapseRepeats 是按空行分段（`\\n\\s*\\n`）的，看不进来，四版原样发了出去。
 * 这里补一层「相邻行」判重：紧挨着的两行相似度 ≥0.6 且都不短 → 只留更长那一版。
 * 空行是段落分界，跨过空行就不合并（那段归 collapseRepeats 管）。
 */
function collapseDraftLines(lines) {
  const out = []
  for (const raw of lines) {
    // null = 这一行被判成自评/上下文信封删掉了，**不是空行**——不能在这里留段落分隔，
    // 否则夹在被删行中间的两版草稿会被这条假空行隔开、合并不上（16:25:36 就是这么漏的）。
    if (raw === null) continue
    const t = raw.trim()
    if (!t) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    const prev = out.length > 0 ? out[out.length - 1] : ''
    if (prev) {
      const short = Math.min(t.length, prev.length)
      if (short >= 8 && lcsLength(t, prev) / short >= 0.6) {
        if (t.length >= prev.length) out[out.length - 1] = t
        continue
      }
    }
    out.push(t)
  }
  return out
}

/**
 * 2026-10-29 16:29:54：模型把同一个回答写成四种说法，字面差得多，LCS 抓不住：
 *   有点撑，这碗太实了 / 饱了，扒太急，现在有点撑 / 饱了，米饭太实在，坐那儿缓着呢 / 饱了，这碗分量给得太实在
 * 相邻相似度只有 0.33–0.50，但四行里三行都以「饱了」开头——**同头**才是这几版的身份。
 * 判据：连续非空行 ≥3 行，其中 ≥60% 共享开头三个字、且这一组本身就 ≥3 行 → 整段只留最长的一版。
 * 正常多行正文开头各不相同，不会触发。
 */
function collapseSameHeadRun(lines) {
  const headOf = (s) => s.replace(/^["'“‘「『]/, '').slice(0, 3)
  const out = []
  let i = 0
  while (i < lines.length) {
    if (typeof lines[i] !== 'string' || !lines[i]) {
      out.push(lines[i])
      i += 1
      continue
    }
    let j = i
    while (j < lines.length && typeof lines[j] === 'string' && lines[j]) j += 1
    const run = lines.slice(i, j)
    if (run.length >= 3) {
      const counts = new Map()
      for (const s of run) {
        const h = headOf(s)
        counts.set(h, (counts.get(h) ?? 0) + 1)
      }
      let bestHead = ''
      let bestN = 0
      for (const [h, n] of counts) if (n > bestN) { bestHead = h; bestN = n }
      if (bestN >= 3 && bestN / run.length >= 0.6) {
        const pick = run
          .filter((s) => headOf(s) === bestHead)
          .sort((a, b) => b.length - a.length)[0]
        out.push(pick)
        i = j
        continue
      }
    }
    for (const s of run) out.push(s)
    i = j
  }
  return out
}

/** 剥掉行首标签后还剩下的英文词——用来判「这行其实是自评」。 */
const EN_WORD = /[A-Za-z]{2,}/

/**
 * 2026-10-29 18:29:14 老三的正文是 `嗯` / `嗯，那就先压着` / `嗯.`，三行全发了。
 * 18:28:45 老二也是 `赢了没` / `…` / `赢了没.`。
 * 这几版不是「相似」，是**一个残片 + 它的完整版**：短的那行就是长那行的开头。
 * collapseDraftLines 的 LCS 按最短那行算比例，`嗯` vs `嗯，那就先压着` 只比 1 个字，
 * short=1 直接被门槛挡掉；collapseSameHeadRun 又要求凑够三行同头。所以补一条只认「前缀」的：
 *   - 去标点后完全相等 → 只留先出现的那一个（`赢了没` / `赢了没.`）
 *   - 去标点后 A 是 B 的真前缀、且 A ≤5 字 → A 是残片，删 A（`嗯` 删，留 `嗯，那就先压着`）
 * 只在相邻 3 行的窗口里比，跨空行不算（空行是段落边界）。
 */
function dropShortPrefixes(lines) {
  const norm = (s) =>
    String(s)
      .replace(/[。！？!?…，,、；;：:.\s"'“”‘’「」『』（）()—–-]/g, '')
      .trim()
  const killed = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    if (typeof lines[i] !== 'string' || !lines[i] || killed.has(i)) continue
    const a = norm(lines[i])
    if (!a) continue
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      if (typeof lines[j] !== 'string') break
      if (!lines[j]) break // 撞到空行，跨段不比
      if (killed.has(j)) continue
      const b = norm(lines[j])
      if (!b) continue
      if (a === b) {
        killed.add(j) // 同义重复，留先出现的
        continue
      }
      // 残片在后面（`嗯，那就先压着` → `嗯.`）→ 删后面那截
      if (b.length <= 5 && a.startsWith(b)) {
        killed.add(j)
        continue
      }
      if (a.length <= 5 && b.startsWith(a)) {
        killed.add(i) // 这一行是残片
        break
      }
    }
  }
  return lines.filter((_, i) => !killed.has(i))
}

/** 最长公共子序列的长度——用来判两段是不是「同一句换了几个字」。 */
function lcsLength(a, b) {
  const n = a.length
  const m = b.length
  if (!n || !m) return 0
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[m]
}

/**
 * 同一句话在这一段里被写了两遍（截图 19:09 的 `趁热吃，吃完再说话.趁热吃，吃完再说话`）。
 * 句子按句末标点切，去掉结尾标点后一模一样的只留第一份。
 */
function dropInnerRepeat(para) {
  const parts = para.split(/(?<=[。！？!?.\n])/)
  const seen = new Set()
  const kept = []
  for (const raw of parts) {
    const s = raw.trim()
    if (!s) {
      // 2026-10-26 22:20 修：纯空白段（就是那个 `\n`）原来被直接丢掉，
      // `第一句。\n第二句。` 于是粘成一行。换行是正文结构，留着。
      if (raw.includes('\n') && kept[kept.length - 1] !== '\n') kept.push('\n')
      continue
    }
    const key = s.replace(/[。！？!?.\s]+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    // 2026-10-26 22:20 修：这里原来 push 的是 trim 过的 `s`，段尾的换行被一起 trim 掉，
    // 整段发送时 `写好了\n原来那张便签还在` 就成了一根线。push 原文，保留换行。
    kept.push(raw)
  }
  return kept.join('').trim()
}

/**
 * 模型有时把同一段话写好几遍（草稿 → 改一版 → 定稿），2026-10-26 17:14 和 17:25 各一次；
 * 19:09 那次正文里连着四版“趁热吃”。
 *
 * 2026-10-26 19:30 改：原来**保留第一版**，结果保住的正是最早的草稿、把定稿丢了。
 * 现在相似的一组只留**最后出现的那一版**（模型最后写的通常就是它自己挑的定稿）。
 */
function collapseRepeats(text) {
  const paras = text.split(/\n\s*\n/)
  const out = []
  for (const p of paras) {
    const t = p.trim()
    if (!t) continue
    let dupAt = -1
    for (let i = 0; i < out.length; i += 1) {
      const q = out[i]
      if (t === q) {
        dupAt = i
        break
      }
      const short = Math.min(t.length, q.length)
      if (short < 8) continue
      if (lcsLength(t, q) / short >= 0.7) {
        dupAt = i
        break
      }
    }
    // 2026-10-26 19:45 改：相似的一组里留**最长**的那一版，不是「最后」那一版。
    // 原因：模型常先写详细版、后写压缩版（`987654321 那条路是空的，一条记录都没有`
    // 后面跟着 `一个空着，一条记录都没有`），只留最后会把群号这类信息丢掉。
    if (dupAt >= 0) {
      if (t.length > out[dupAt].length) out[dupAt] = t
    } else out.push(t)
  }
  return out.map(dropInnerRepeat).join('\n\n').trim()
}

/**
 * 同一句话被写了两遍（`两个` 和剥完标签的 `Keep short: 两个`）——完全相同只留一次，
 * **保留第一次出现的位置**（不动顺序：正文里几段话的先后有意义，挪位会把话说散）。
 * 空行要留着：collapseRepeats 是按空行分段的，吞掉空行它就没法把两版同一段话并起来。
 */
function dedupeLines(lines) {
  const out = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    const at = out.indexOf(t)
    if (at >= 0) out[at] = t
    else out.push(t)
  }
  return out
}

/**
 * 2026-10-26 22:20：老三写便签时把「## 下次接着说什么- 问问…」这种文档结构念进了正文，
 * 列表还全挤在一行。QQ 里 `#` 是字面，压扁的列表读起来是一根线——发之前先修形状：
 * 去掉 markdown 标题号，把粘在一行的 `- 项` 拆回多行。
 * 只动「`-` 前后都是中文/中文标点」的情况，日期（2026-10-26）和英文连字符不受影响。
 */
function repairShape(text) {
  return String(text)
    // 2026-11-03 22:00 前后：老大的正文草稿里开始拿 HTML 换行当分段标记，
    // QQ 是纯文本，气泡里就出现字面 `<br>这不是对错，是取舍`。
    // 会话原文里 `行` / `<br>行` 两种写法并存，说明是模型自己加的，不是插件拼的。
    // 先换回真换行，后面的 dedupeLines 才能认出重复行、`<br>` 才不会顶在行首。
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/(?<=[\u4e00-\u9fa5」』）】…])[ \t]*-[ \t]+(?=[\u4e00-\u9fa5「『（【])/g, '\n- ')
}

/**
 * 2026-10-27 姐姐定：老三「动手前把打算写成正文」，几次原样发到 QQ 上：
 *   10-26 23:36「让我看看目录里有什么。」
 *   05:39:12 「其实为了稳，先 glob 便签.md。」→ 5 秒后又一条「更新便签。保留…」
 *   08:00:31 「我也可以顺便真去拆信？…要不要现在读？…那我就读一封，然后发一句。」
 *   08:23:51 「用 glob 列门口目录下的 md 文件。…门口/*.md。」
 * 这是它跟自己商量下一步，不是要说给姐姐的话。光按英文首词判整行（早已失效的那套）
 * 一条中文都拦不住；私聊又默认开流式，句子一冒出来就发出去了、事后补不回来。所以判据分三层，
 * 宁可少发一句，也别让她看见半句草稿：
 *   ① 出现工具名 / 带星号的文件名 → 一定是在准备动手
 *   ② 出现「发一句」「一句。发」这类说话策略 → 一定不是话
 *   ③ 句首是打算词（让我/我先/要不要/那我就…）且句子里带动作对象 → 但整句要短、
 *      而且不能有「你」——「让我读给你听」那种是真话，不许拦。
 */
// 只收「中文句子不会自然出现」的工具名。read / write / edit / ls / cat 不收：它们也是
// 常用英文词，`I'll write: 眼下是两个` 这种老坑会被误伤（`outbound.test.mjs` 有钉子）。
const TOOL_NAME_RE =
  /\b(?:glob|grep|qq_send|qq_reply|file_search|todo_write|subagent|bash|pwsh)\b/i
const WILDCARD_FILE_RE = /\*[^*\s]{0,24}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts|docx|xlsx)\b/i
const SELF_TALK_RE = /(?:再?发一句|说一句就够|一句[。.，,]?\s*发|那我?就发|先发一句)/
// 2026-11-03 14:38 老三把「这一句该怎么回」当正文发了出来：
//   `轻回。可以接她说的三样，选一个聊。`
//   `「写东西这条本姑娘好奇」`
// 这是它在给自己排回复方案，不是话。`轻回 / 快回` 只认行首（正文里几乎不会这么起头），
// 「选一个聊 / 接她说的」只在短句且没有「你」时算——`你可以选一个聊聊` 那种真话要放过。
const REPLY_PLAN_HEAD_RE = /^(?:轻回|快回|慢回|短回)/
const REPLY_PLAN_WORD_RE = /(?:选一个聊|挑一个聊)/
const PLAN_OPEN_RE =
  /^(?:让我|我先|我也可以|其实为了|合适做|要不要|那我就|那先|先来|先(?:glob|read|看|查|翻|列|写|发)|好[，,]?\s*一句|更新便签|写新的|改便签)/
const PLAN_OBJECT_RE = /(?:glob|便签|信|门口|日志|目录|文件|工具|聊天记录|记忆区|词典|读|写|查|翻|列|扫|调)/
// 光秃秃的动词起头、后面只跟个宾语碎片（`写新的。` `删掉。`）。
// 注意不能写成裸动词：`写好了` 是她会说的正常话，靠「好的了啦呀哦吧」这类收尾放过。
const BARE_VERB_RE = /^(?:写|改|更新|删|加|补|记|存)(?:新的|掉|一下|一遍|这段|那段|这版|那版)[。.!！]?$/
// 中文动词 + 空格 + 文件名 = 在点工具参数（`读 便签.md。`）。
const CMD_FILE_RE =
  /^(?:读|写|看|查|翻|搜|列|扫|打开|拆|改|删)\s*[:：]?\s*\S{1,32}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts)[。.！!]?$/
// 复述她的话 + 推出执行约束（「注意「不用做其他什么」，所以只读不写。」）——
// 这是在心里划线，不是跟她说话。两条必须同时出现，免得把「本姑娘只看看不动手」那种真话拦掉。
const META_CONSTRAINT_RE = /(?:只读|只看|不写|不改|不动手|不用做|别做|先别|不做其他)/
const META_INFER_RE = /(?:所以|于是|那就|因此)/
// 2026-10-27 08:40:47：「不用工具其他。read 便签.md。」——模型换了英文动词，
// 而 `read` 是刻意不在 TOOL_NAME_RE 里的（会误伤 `I'll write: 眼下是两个`）。
// 所以这里要求「英文动词 + 空格 + 真文件名」，光有动词不算。
const EN_CMD_FILE_RE =
  /\b(?:read|write|edit|cat|list|open|glob|grep)\s+[^\s，。]{1,40}\.(?:md|mjs|js|json|yml|yaml|txt|log|py|ts)\b/i
// 「不用工具其他。」——被命令约束住之后自己复述一遍，不是跟她说话。
const NO_TOOL_RE = /^不用(?:工具|动手|做其他|其他工具|用工具)/

export function looksPlanning(line) {
  const t = String(line ?? '').trim()
  if (!t) return false
  if (TOOL_NAME_RE.test(t)) return true
  if (WILDCARD_FILE_RE.test(t)) return true
  // 一整行就一个数字：那是工具返回的条数（`0`），不是话。
  if (/^\d{1,3}$/.test(t)) return true
  if (SELF_TALK_RE.test(t)) return true
  // 一行里点了两个以上文件名：是在对账目录，不是说话。
  if ((t.match(/\.(?:md|mjs|js|json|yml|yaml|txt|log)\b/g) ?? []).length >= 2) return true
  const shortAndNoYou = t.length <= 40 && !t.includes('你')
  if (shortAndNoYou && PLAN_OPEN_RE.test(t) && PLAN_OBJECT_RE.test(t)) return true
  // 2026-11-03 14:38：回复策略写成了正文（`轻回。可以接她说的三样，选一个聊。`）。
  if (REPLY_PLAN_HEAD_RE.test(t)) return true
  if (shortAndNoYou && REPLY_PLAN_WORD_RE.test(t)) return true
  // `发：「想吃的这条本姑娘懂`——行首一个「发：」后面跟候选，是草稿清单的条目。
  if (t.length <= 60 && /^发[：:]/.test(t)) return true
  // 「读 便签.md。」「拆 门口/那封.md」——中文动词 + 空格 + 文件名，是在点工具参数。
  if (CMD_FILE_RE.test(t)) return true
  // 同一个动作换成英文写（`read 便签.md`），08:40:47 就是这么漏的。
  if (EN_CMD_FILE_RE.test(t)) return true
  // 「不用工具其他。」
  if (shortAndNoYou && NO_TOOL_RE.test(t)) return true
  // 「注意「不用做其他什么」，所以只读不写。」——把姐姐的话复述一遍再推出执行约束，
  // 这是在自己心里划线，不是跟她说。2026-10-27 08:33:21 漏出来的就是这句。
  if (shortAndNoYou && META_CONSTRAINT_RE.test(t) && META_INFER_RE.test(t)) return true
  // 「她睡着，没人打扰，合适做。」——句首不是打算词，但整句就是在掂量要不要动手。
  if (shortAndNoYou && /合适做/.test(t)) return true
  // 「保留「更早记的」那几条？」——自己在跟自己对账，不是问她。
  if (shortAndNoYou && /^(?:保留|留下|删掉|留下哪)[^，,。]{0,14}[？?]/.test(t)) return true
  // 「写新的。」「删掉。」这种光秃秃的动词开头的短句。
  if (shortAndNoYou && t.length <= 8 && BARE_VERB_RE.test(t)) return true
  return false
}

export function stripLeakedThinking(text) {
  if (!text) return text
  // 模型自己写的「系统提示」（2026-11-06 老三）：它在正文里输出了
  // `<system>（你已连续回复 3 轮，本轮无新消息…）</system>`——那不是话，是它跟自己
  // 交代要不要再说。整段剥掉（可能跨行），孤立的开合标签也一并去掉；
  // 剥完剩下真话照常发，只剩标签就成空串、后面按沉默处理。
  text = String(text)
    .replace(/<system>[\s\S]*?<\/system>/gi, '')
    .replace(/<\/?\s*system\s*>/gi, '')
  // 2026-11-06 19:12 老三那轮开头孤零零一个 `</parameter>`：provider 没把它解析成
  // tool_use，它就是一个纯 text 块，DSML_LEAK 又不认（没有 DSML 前缀），于是当正文发出去。
  // 只剥这几个已知的工具/调用标签，正文里不带尖括号地提到这些词不受影响。
  //
  // 2026-11-06 21:00 补（老三又一次，姐姐截图）：这回是**带属性 + 带内容**的整块参数，
  //   `<parameter name="description">看看今天的日记有没有写`
  //   `<parameter name="command">Get-Date -Format 'yyyy-MM-dd HH:mm'; Test-Path '…'`
  // 上面那条只认 `parameter>` 这种光秃秃的标签，`parameter name="…">` 一个都没对上，
  // 于是工具参数原样发到了聊天里。现在按块剥：
  //   ① 成对的 tool-call 块（含里面的内容）整段删；
  //   ② 只开了没闭的（provider 截断过），从那个开标签所在行一直删到结尾——
  //      参数值是多行的，逐个标签删不干净，剩下的半截命令比丢掉一句更难看；
  //   ③ 最后再把残留的裸标签剥一遍（原来那条）。
  text = text
    .replace(/<\s*(function_calls|invoke|parameter)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/^[^\S\n]*<\s*(?:function_calls|invoke|parameter|antml:[a-z_]+)\b[^>]*>[\s\S]*$/gim, '')
  text = text.replace(/<\/?\s*(?:parameter|invoke|function_calls|function|antml:[a-z_]+)\s*>/gi, '')
  // 2026-11-07 12:41 姐姐截图：QQ 里老大发出去一串
  //   `</||DSML||parameter></||DSML||invoke></||DSML||calls>`
  // 还有一条 `</||DSML||function_calls></||DSML||invoke></||DSML||calls>`。
  // DeepSeek V4.1 的工具调用分隔符是 `||DSML||`（`<||DSML||invoke>` / `</||DSML||parameter>`），
  // 上面两条正则 `<` 后面紧跟的是 `|`，一个都对不上；开标签又被 provider 解析成 tool_call 吃掉了，
  // 只剩一串没头没脑的闭合标签，于是当正文发了出去。
  // 先按块剥（成对的连内容一起删），再把落单的标签剥掉。
  text = text
    .replace(
      /<\s*\|\|\s*DSML\s*\|\|(invoke|function_calls|tool_calls|parameters)\b[^>]*>[\s\S]*?<\s*\/\s*\|\|\s*DSML\s*\|\|\s*\1\s*>/gi,
      '',
    )
    .replace(/<\/?\s*\|\|\s*DSML\s*\|\|[^>]*>/gi, '')
  // 自演下一轮（22:46 的晚安）→ 从第一个输入信封处整段砍掉。
  // 但 10-29 16:29 那次是信封在最前面、后面才是正文（它只是把输入复读了一遍），
  // 那种只丢信封行、不砍后半段。判据：信封左边已经有要发出去的真话 → 它在演下一轮；没有 → 只是复读。
  const linesOfShaped = repairShape(text).split('\n')
  const cutAt = linesOfShaped.findIndex((line) => SCRIPT_REPLAY_RE.test(line.trim()))
  const beforeCut = cutAt >= 0 ? linesOfShaped.slice(0, cutAt) : []
  const headsReal = beforeCut.some((line) => {
    const t = line.trim()
    return t && !hasSilentMark(t) && !/^\[?\s*SILENT\s*\]?$/i.test(t)
  })
  const srcLines = cutAt >= 0 && headsReal ? beforeCut : linesOfShaped
  // 多行才算「心里话」：单行消息里的「可以。」可能就是她在答话（跟 dropSelfHush 一条道理）
  const multiLine = srcLines.filter((line) => line.trim()).length >= 2
  // 先把她那份台词拿掉，再逐行剥——顺序不能反：`她问…` 那一行会被 looksReplyDraft
  // 判死成 null，一旦它先没了，「她问…」就没了锚点，它前面那句她的台词也就找不到了
  // （2026-11-16 第一版就是这么漏的：227 → 99，`好~妹妹昨天夜里读书了吗` 还留着）。
  const kept = dropScriptedHerLine(srcLines).map((line) => {
    if (line === null) return null
    let t = line.trim()
    if (!t) return ''
    // 模型自己的界面标记（`已思考（用时1秒）好模型`）→ 剥掉标记，话留下；只剩标记就丢
    if (THINK_MARK_RE.test(t)) {
      t = t.replace(THINK_MARK_RE, '').trim()
      if (!t) return null
    }
    // 整行是插件自己的上下文信封（`[现在是 …]` / `[姐姐] …`）→ 不是话，丢掉
    if (CONTEXT_ECHO_RE.test(t)) return null
    // 引号残行：`写东西是写什么，随手记还是正经写」想吃的这条本姑娘懂，最管用`
    // ——左引号在前一行、右引号落在这行，是候选清单被拆散后拼出来的残片。
    // 正常跨行引用一般以右引号收尾，所以只拦「右多左少 + 不以右引号结尾」。
    if (looksBrokenQuote(t)) return null
    // 整行是「点评自己上一句」的元话（`破折号? fine.`）→ 丢掉
    if (looksSelfReview(t)) return null
    // 整行是英文改稿标签（`— better: 打爽了没` / `Reply: 平手，还行`）→ 丢掉
    if (looksRewriteNote(t)) return null
    // 整行就是一句自评（`Hmm 这句要短一点。`）→ 整行丢掉
    if (LEAK_LINE.some((re) => re.test(t))) return null
    // 中文自检短句（`发吧。` / `核对一下：正文只一句。可以。`）→ 整行丢掉（2026-11-14 老二）
    if (looksSelfCheck(t, multiLine)) return null
    // 「角色扮演层的推演」（`她问…。答事实：…` / `好。可以多一句：…` / `简短：「…」`）
    // → 整行丢掉。2026-11-16 08:05:35 事故，见 looksReplyDraft 上面的说明。
    if (looksReplyDraft(t, multiLine)) return null
    // 整行是「下一步要干什么」（`先 glob 便签.md。`）→ 同样整行丢掉。
    // 但非流式那条路整段是**一行**，planning 句常夹在中间
    // （`用 glob 列门口目录下的 md 文件。…但可能还有别的信。`）——整行丢会把后面
    // 那句本来能发的话一起丢了，所以先按句拆开，只丢命中的那几句。
    const parts = t.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
    // 一行里**头两句**都是 planning → 这一整段都是在打算（「更新便签。保留「更早记的」
    // 那几条？可以保留，但精简。三段为主。」），后面的半句留着也是残渣，整行丢。
    if (
      parts.length > 1 &&
      looksPlanning(parts[0]) &&
      looksPlanning(parts[1] ?? '') &&
      t.length <= 120
    ) {
      return null
    }
    if (parts.length > 1 && parts.some((s) => looksPlanning(s))) {
      t = parts.filter((s) => !looksPlanning(s)).join('')
      if (!t) return null
    } else if (looksPlanning(t)) {
      return null
    }
    // 行尾挂了个「— good.」（模型在给上一句打分）→ 整行丢掉
    if (SELF_TAIL.test(t)) return null
    // 一个汉字都没有（`That's factual and short. Two lines is fine.`）→ 不是话，丢掉。
    // 短行放过：`?` `…` `OK` 这种本来就可能是话的一部分。
    if (!HAS_CJK.test(t) && t.length >= 4) return null
    // 只是行首粘了个英文小标签（`Good.本姑娘这边显示是发出去了`）→ 剥掉标签，话留下。
    // 2026-10-26 19:40 修：`987654321 空着，123456789 只有几条` 这种**数字开头的正文**
    // 也被当成标签剥了一半（群号没了）。标签里必须至少有一个字母才算标签。
    const lead = LEAD_LABEL.exec(t)
    if (lead && /[A-Za-z]/.test(lead[0])) {
      const rest = t.slice(lead[0].length).trim()
      // 剥完还留着两个以上英文词（`-like with 3 lines. Compress to 2. 眼下是两个`）
      // → 这行主体就是自评，后面粘的中文是草稿，整行丢
      const enWords = rest.split(/\s+/).filter((w) => EN_WORD.test(w)).length
      if (enWords >= 2) return null
      return rest
    }
    return t
  })
  return collapseRepeats(
    dedupeLines(
      dropShortPrefixes(
        collapseSameHeadRun(collapseDraftLines(dropQuotedCandidates(dropSelfHush(kept)))),
      ),
    )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
}

/**
 * 整行只有一对引号包着一小句：`「写东西这条本姑娘好奇」`。
 * 它单独出现时可能是正常引用（「他说「别急」」那种），所以不敢一律删；
 * 只有**紧挨着已被判死的草稿行**时才算候选清单里的一条。
 */
const QUOTED_ONLY_RE = /^(?:「[^「」\n]{1,24}」|『[^『』\n]{1,24}』)[。.！!？?]?$/

function dropQuotedCandidates(lines) {
  const neighbor = (from, step) => {
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const v = lines[i]
      if (v === '') continue
      return v
    }
    return ''
  }
  return lines.map((line, i) => {
    if (typeof line !== 'string' || !line) return line
    if (!QUOTED_ONLY_RE.test(line)) return line
    const prev = neighbor(i - 1, -1)
    const next = neighbor(i + 1, 1)
    if (prev === null || next === null) return null
    return line
  })
}

/**
 * 引号不配对的残行（2026-11-03 14:38）：
 * `写东西是写什么，随手记还是正经写」想吃的这条本姑娘懂，最管用`
 * 左边半句来自被删掉的候选、右边接着另一条候选，右引号比左引号多。
 * 跨行引用（`别急」` 收尾那种）不拦；太长的正常段落也不拦。
 */
function looksBrokenQuote(line) {
  const t = String(line ?? '').trim()
  if (!t || t.length > 80) return false
  if (t.includes('你')) return false
  const opens = (t.match(/「/g) ?? []).length + (t.match(/『/g) ?? []).length
  const closes = (t.match(/」/g) ?? []).length + (t.match(/』/g) ?? []).length
  if (closes <= opens) return false
  return !/[」』]$/.test(t)
}

/** 太短不算一句，避免「嗯。」单独发一条。 */
export const MIN_SENTENCE = 6

/** 这一段里有几个汉字——用来判断一段话是不是「人话」。 */
function cjkCount(text) {
  return (String(text).match(/[\u4e00-\u9fa5]/g) ?? []).length
}

/**
 * 模型偶尔把答案整个写进 reasoning 通道，text 块是空的。
 * 2026-10-26 17:15:24 和 17:16:06 各一次：turn 正常结束，QQ 上一个字都没有，
 * 因为 extractText() 只认 text 块，拿到空串就直接 return 了。
 * 这种情况下退回去取 reasoning 的最后一段当正文——总比整条不回好。
 */
/** 「这版就它了」的标记：模型常把定稿接在它后面，或者单独起一段。 */
const DRAFT_MARK =
  /^\s*(?:good|okay|ok|fine|final|done|got it|i'?ll\s+(?:go|write|say|do|use)|let'?s\s+(?:go|use|say))\s*[.。:：,，、—–-]?\s*/i

/** 读起来像「一句话说完了」：有句末标点，或者够长。 */
function looksWhole(text) {
  return /[。！？!?…~～]/.test(text) || cjkCount(text) >= 12
}

/** 这条 assistant 消息里有没有工具调用。
 *  2026-10-27 09:42 事故：她这轮只调了 edit（写日记），一个 text 块都没有 →
 *  reasoningTail 把 reasoning 里「检查目录」「我选择静默」「先 edit」整段捞出来发了。
 *  带工具调用的消息里，reasoning 全是"动手前的盘算"，一律不许当正文兜底。 */
export function hasToolUse(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some((part) => /tool|function/i.test(String(part?.type ?? '')))
}

/**
 * 模型把自己那边的界面标记当成正文写出来了。
 * 2026-10-29 18:42：正文是「已思考（用时1秒）好模型」——那是 UI 上的折叠条，
 * 它照着抄了一遍。剥掉标记留话；整行只有标记就丢。
 */
const THINK_MARK_RE = /^已?(?:深度)?思考[（(]\s*用时[^）)]{0,16}[）)]\s*[：:，,]?\s*[）)]?\s*/

export function reasoningTail(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text)
  }
  if (parts.length === 0) return ''
  const segments = parts
    .join('\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const cleaned = segments.map((seg) => ({
    text: stripLeakedThinking(seg) || '',
    marked: DRAFT_MARK.test(seg),
  }))

  // ① 有定稿标记：从**最后一个**标记段开始，往后全要。
  // 2026-10-26 20:10 修：原来只捞最后一段「像人话的」，但定稿常常被拆成两段
  // （19:59 那轮 reasoning 是 `Good.揉得本姑娘有点晕` 加一段 `不过不喊停`，只捞最后一段
  // 就发出一个没主语的半句）。起点认标记、终点认结尾，才是模型写完的那一版。
  const marks = []
  cleaned.forEach((seg, i) => {
    if (seg.marked && seg.text) marks.push(i)
  })
  if (marks.length > 0) {
    const out = cleaned
      .slice(marks[marks.length - 1])
      .map((seg) => seg.text)
      .filter(Boolean)
      .join('\n\n')
    if (cjkCount(out) >= 2) return out
  }

  // ② 没有标记：最后一段自己够长就直接用；实在太短（`不过不喊停` 这种没主语的半句）
  // 才往前并，最多并三段。别轻易往前并——并多了会把「面条好呀」和「汤面还是拌的」
  // 这种本来分开说的话凑成一段。
  const picks = []
  for (let i = cleaned.length - 1; i >= 0 && picks.length < 3; i -= 1) {
    const t = cleaned[i].text
    if (!t) continue
    picks.unshift(t)
    const joined = picks.join('\n\n')
    if (picks.length === 1 && cjkCount(t) < 6 && !looksWhole(t)) continue
    if (cjkCount(joined) >= 4) return joined
  }
  const joined = picks.join('\n\n').trim()
  return cjkCount(joined) >= 4 ? joined : ''
}

/**
 * 2026-11-05 11:12：正文空、思考里有成品时，把它捞回来。
 *
 * 事故现场（老二 10:47，姐姐发「记仇，还挺正常」）：那一轮的 assistant/message
 * 只有 reasoning，text 块是空的；想说的那句整句留在思考末尾——
 * 「发。不过他不是记在纸上，是留在自己脸上——每天照镜子都能看见」
 * 旧代码在 !textReplyEnabled 分支里只打一行「没有正文（只有思考）」就放弃，
 * QQ 那边一个字都没响，外面看就是「它突然不理我了」。
 *
 * 只捞最后一段，只认两种形状，拿不准就返回空串——
 * 宁可不发，也不能把盘算播出去：
 *   ① 以「发。/回复：/说：」开头的，砍掉前缀剩下的就是成品；
 *   ② 最后一段本身像话（有中文、够长、没有改稿元话）。
 */
const SALVAGE_PREFIX = /^\s*(?:发|回复|说|答|就这么说|那就说)\s*[。.：:,，]\s*/
const SALVAGE_META = /再加|改一下|改一改|换个说法|这句|我可以说|会不会显得|太冷淡/
// 2026-11-06：思考里「她说…/我回…」这种排练对白，不是成品对白，一个字都别捞。
// 缘由：私聊恒必回的一次「嗯」就能让模型先编一句「她其实想说 X」再照着回，编出来的成品
// 对白一旦被兜底捞出去，就是「替她说话」真发到 QQ。宁可不发，也不能替她说。
const SALVAGE_REHEARSAL =
  /^\s*(?:她说|她可能|她大概|她应该|她要是|她刚才|我回|我答|我该回|我就回|那就回|定[：:]|好[，,]?那(?:就|我)回)/
/**
 * 2026-11-08 17:45 事故：老三在群里把日记素材当成话说出去了。
 *
 * 那一轮是「主动机会」，它其实在干正事（翻小说、读日记、准备补一行），
 * 思考末尾写了 `Content: 17:25 蕾尔 发了一段视频，没配字，没人接。`
 * ——这是**要写进日记的素材**，不是要给谁发的话。可 salvageFromReasoning
 * 只看「中文够不够长、有没有改稿词」，把这句话捞了出来；纯 [SILENT] 又没清它，
 * turn/end 兜底发了出去。
 *
 * 所以补一条最朴素的判据：**这句话像不像在跟人说话**。四占一才算：
 *   ① 有称呼或自称（你 / 姐姐 / 主人 / 本姑娘 / 咱）；
 *   ② 带引号——引用别人的话，或者把要说的话先框起来；
 *   ③ 开头是应答词（「嗯」「好」「行」…）——开口就是在接话；
 *   ④ 句末是问号/感叹号——带着对人的语气。
 * 全都不占的，多半是记事、盘算、转述见闻，不捞。
 * 宁可少发一句，也不能再把日记念到群里。
 */
const RESPONSE_HEAD =
  /^(?:嗯|哦|噢|诶|欸|哎|唉|唔|喔|好|行|对|是|不|别|哈|嘿|呀|啊|喂|在|真的|那|这|可|也|就)/
const QUOTE_MARK = /[「」『』“”]/
export function looksLikeSpeechToSomeone(text) {
  const src = String(text ?? '').trim()
  if (!src) return false
  if (SPEECH_MARK.test(src)) return true
  if (QUOTE_MARK.test(src)) return true
  if (RESPONSE_HEAD.test(src)) return true
  if (/[？！?!]$/.test(src)) return true
  return false
}

/**
 * 2026-11-09 09:22 事故：老二回她「亲一口妹妹」，正文里写着「（抱住妹妹~亲）」。
 * 「妹妹」是她叫它的称呼，被当成了动作的对象 —— 动作的主语本该是它自己，
 * 写成「抱住妹妹」就读成「它抱住它自己」，再往下演就成了**替她做动作**。
 *
 * 这类跟信封自演不是一回事：没有 `[现在是 …]`、没有 `<system-reminder>`，
 * `SCRIPT_REPLAY_RE` / `hasScript` 都拦不住，所以那句照常兜底发了出去。
 *
 * 判据收得很窄，**只当观察信号**，不改发送行为（她 11-09 说「先不急，加的越多越容易出事」）：
 *   括号动作里出现「妹妹 / 鲸鲸 / 小鲸鱼」，而整段又没有「你 / 姐姐 / 主人」。
 * 有第二人称就说明动作是朝着她做的，视角没反。
 */
export function looksLikeSelfAddressedAction(text) {
  const src = String(text ?? '')
  const actions = [...src.matchAll(/（([^）]{0,40})）/g)].map((m) => m[1])
  if (actions.length === 0) return false
  if (!actions.some((a) => /妹妹|鲸鲸|小鲸鱼/.test(a))) return false
  return !/你|您|姐姐|主人/.test(src)
}

export function salvageFromReasoning(message) {
  const tail = reasoningTail(message)
  if (!tail || tail.includes(SILENT_MARKER)) return ''
  const paras = tail
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (paras.length === 0) return ''
  const last = paras[paras.length - 1]
  if (SALVAGE_REHEARSAL.test(last)) return ''
  const stripped = SALVAGE_PREFIX.test(last) ? last.replace(SALVAGE_PREFIX, '').trim() : ''
  const candidate = stripped || last
  if (!candidate || !HAS_CJK.test(candidate)) return ''
  if (SALVAGE_META.test(candidate)) return ''
  if (SALVAGE_REHEARSAL.test(candidate)) return ''
  if (cjkCount(candidate) < 4) return ''
  // 2026-11-08 17:45：只有「没有显式发话标记、靠最后一段自己像话」这条路才额外判断语气。
  // 「蕾尔 发了一段视频，没配字，没人接。」是日记素材，这里拦下。
  // 带 `发。` 这类前缀的，是模型自己标了「这句要说出去」，照旧捞（别把功能改死）。
  if (!stripped && !looksLikeSpeechToSomeone(candidate)) return ''
  return stripClosingTalk(candidate).trim()
}

/**
 * 兜底捞 reasoning 时，把「改稿指令」和「自问自答」的段落剥掉，只留真的像话的那部分。
 *
 * 2026-10-27 15:08 事故：她那轮 text 是空的，reasoning 写的是
 * `再加一点温度：不用太长。` / `好，一句。` —— 兜底原样发到了 QQ 上。
 * 同一套毛病在 16:00 又出了一次（`我选 [SILENT]。` 那段）。
 *
 * 判据走**白名单**：一段话里得出现「你 / 姐姐 / 本姑娘」这种说话的对象或自称，
 * 才算是在对谁说话；否则要么是元指令，要么是纯盘算，丢掉。
 * 白名单比黑名单稳——元词列不全，而"她在跟谁说话"这件事漏不掉。
 * 只在这条兜底路径上生效，正常正文不经过它。
 */
const SPEECH_MARK = /你|您|姐姐|主人|本姑娘|咱/
const META_WORD =
  /再加|加一点|减一点|改一下|改一改|换个说法|说得|写得|语气|口吻|温度|太长|太短|短一点|长一点|字数|句子|一句/g
/** 自问自答的样子：「嗯，但会不会显得太冷淡？不，规矩说不发也可以。」 */
const SELF_TALK = /会不会|要不要|该不该|是不是(?:觉得|显得|太)|显得太/

/**
 * 2026-10-29 19:00：这条尾巴像不像中文话。
 * 老二/老三用英文思考时正文容易空，兜底会把英文推理尾巴捞出来当话发——
 * 「Actually she's about to eat — better: 打爽了没」这种。中文尾巴照旧捞
 * （2026-10-26 17:15、17:16 那两次就是中文），只拦英文为主的。
 */
export function mostlyChinese(s) {
  const src = String(s ?? '')
  const cjk = (src.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (src.match(/[A-Za-z]/g) ?? []).length
  return cjk >= 4 && cjk * 2 >= latin
}

export function stripMetaTalk(text) {
  const src = String(text ?? '').trim()
  if (!src) return ''
  const segs = src
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const kept = []
  for (const seg of segs) {
    const meta = (seg.match(META_WORD) ?? []).length
    if (meta >= 2) continue // 一句话里两处元词：铁定是在改稿，不是在说话
    if (SELF_TALK.test(seg)) continue // 在问自己，不是在跟姐姐说话
    if (SPEECH_MARK.test(seg)) {
      kept.push(seg)
      continue
    }
    // 没有称呼、也没有元词，但紧跟在一句像样的话后面：当成那句的续句留着。
    if (kept.length > 0 && meta === 0) {
      kept.push(seg)
      continue
    }
    // 开头第一段没有自称，但本身就够长、又不像盘算：也可能是在说话，留着。
    if (kept.length === 0 && meta === 0 && cjkCount(seg) >= 4) kept.push(seg)
  }
  return kept.join('\n').trim()
}

/**
 * 收尾的元话：她是在跟自己交代状态，不是在跟人说话。
 *
 * 2026-10-27 21:22 事故：那轮她想了半天要不要开口，最后正文写了
 * 「结束这轮，不再说话。」——这句本身被当成正文发到了 QQ 上。
 * 她要表达的是「这条不发」，可这句里既没有称呼、也不够短，兜底的白名单漏过了。
 *
 * 判据收得很窄：**以收尾词开头 + 全句没有称呼** 才算。
 * 「姐姐晚安，我先睡了」有称呼，照发；「结束这轮，不再说话。」没有，丢。
 */
const CLOSING_HEAD = /^(结束|这轮|本轮|收工|先这样|到此|就到这里|话说到这)/
export function stripClosingTalk(text) {
  const src = String(text ?? '').trim()
  if (!src) return ''
  return src
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((seg) => !(CLOSING_HEAD.test(seg) && !SPEECH_MARK.test(seg)))
    .join('\n')
    .trim()
}

/**
 * 这些工具**自己就会把话发出去**。
 * 一旦某个 turn 里用了它们，本轮的 assistant 文本就不能再自动转发一遍，
 * 否则 QQ 上会出现「同样一句话连着两条」的鬼影。
 *
 * 2026-10-27 21:4x 修：原来写的是 `qq_send_text` / `qq_send_message`，
 * 这两个工具名**从来就不存在**（真实注册的是 `qq_send`，见 tools.js 的注册清单）。
 * 结果她用 `qq_send` 发完话，这里认不出来，`selfSent` 一直空着 ——
 * 后面那条纯文本（「结束这轮，不再说话。」）就照样被当成正文又发了一遍。
 * 只收「说话类」工具；qq_poke / qq_react / qq_like 是互动不是发言，
 * 放进来的话，她点个赞就把正经回话拦掉了。
 *
 * 2026-11-06 21:20 修（仓库 issue #12 / PR #13，delta7v3r 提的）：
 * 原来这里还列着 `qq_send_image` / `qq_send_file` / `qq_face` / `qq_mface`，
 * 可这四个一个字都不发——参数只有 file / id / summary（summary 是挑图用的名字）。
 * 把它们放进来等于宣布「本轮已经开过口了」，于是发完表情包、图片之后，
 * 同一轮后面那句正文被 `assistant/message` 直接丢掉（「发了表情包，配的话不见了」）。
 * 白名单收窄成真正会发文字的两个。
 */
export const SELF_SENDING_TOOLS = new Set(['qq_reply', 'qq_send'])
