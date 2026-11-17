/**
 * 第 2 道闸 · 注入印记（2026-11-15 19:45 建）
 *
 * 为什么要有这个文件：
 *   19:16 老三（QQ 侧）在正文里自己写了一段「【插件注入·每隔一阵钉一次·不是她说的】」——
 *   跟真注入一字不差，因为它就是照着历史里那几十条真注入抄的。
 *   第 1 道闸（sanitize.js 的 cutSelfInjection）只认「出现这个字样就砍」，够用，
 *   但砍完之后我们只知道「它编了」，不知道它是**复读历史**还是**现编**——
 *   这两件事的处理方式完全不同：复读要改注入的呈现，现编要压它这套腔调。
 *
 * 这个印记干两件事：
 *   ① 每轮真注入带一个 4 位随机码（`【插件注入·#a7f3·…】`）。
 *      历史里几十条注入，码各不相同——它抄哪一条都不是「这一轮」的。
 *   ② 输出侧据此分级：带当前码 / 带旧码 / 不带码。
 *
 * ⚠ 一点要记住的局限：模型能看到这个码（码就写在它收到的消息里），
 *   所以**这个印记不是用来「放行带码的输出」的**——带码的伪造照样砍。
 *   它的价值只在「分得清它是抄还是编」，以及让「注入长什么样」不再是一个固定的死形状。
 */

const TAG_LEN = 4
const TAG_CHARS = '0123456789abcdef'

/** 生成一个 4 位十六进制随机码。 */
export function newInjectTag() {
  let s = ''
  for (let i = 0; i < TAG_LEN; i += 1) s += TAG_CHARS[Math.floor(Math.random() * TAG_CHARS.length)]
  return s
}

// 行首（允许缩进、引用、列表符号）出现「【插件注入」或「[插件注入」，且后面**还没带码**。
// 用负向断言保证幂等：已经盖过章的段落不会被盖第二遍。
const STAMP_RE = /^([\t >*-]*)([【\[]\s*插件注入)(?!·#[0-9a-f]{4})/gm

/** 把一段投递文本里所有注入段落盖上同一个码。没有 tag 就原样返回。 */
export function stampInjections(text, tag) {
  if (!tag || typeof text !== 'string' || text.length === 0) return text
  return text.replace(STAMP_RE, (_m, lead, mark) => `${lead}${mark}·#${tag}`)
}

const TAG_IN_LINE_RE = /[【\[]\s*插件注入·#([0-9a-f]{4})/

/**
 * 投递前统一盖章：每轮一个新码，顺手记在 record 上（输出侧要用它判「抄的是不是这一条」）。
 * 四个投放点（inbound 收信 / wake 主动 / sleep 作息 / reading 夜读）都走它。
 */
export function stampFor(record, text) {
  const tag = newInjectTag()
  if (record && typeof record === 'object') record.injectTag = tag
  return stampInjections(text, tag)
}

/** 从一行注入里取码；没有就返回空串。 */
export function tagOfInjectLine(line) {
  const m = TAG_IN_LINE_RE.exec(String(line ?? ''))
  return m ? m[1] : ''
}

/**
 * 比对：这段伪造文本里的码，是不是「这一轮的真码」。
 *  - 'current' 带的是当前码  → 它抄的是刚收到的那条
 *  - 'stale'   带的是旧码    → 它翻的是历史
 *  - 'none'    压根没码      → 它按形状现编的
 */
export function classifyInjectTag(head, currentTag) {
  const got = tagOfInjectLine(head)
  if (!got) return 'none'
  if (currentTag && got === currentTag) return 'current'
  return 'stale'
}
