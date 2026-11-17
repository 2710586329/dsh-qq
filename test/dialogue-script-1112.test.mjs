import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cutAtDialogueScript, stripLeakedThinking } from '../src/outbound.js'

/**
 * 2026-11-12 18:01:57（老二，姐姐三张截图说「变严重了」）：主动机会轮，思考里
 * 只打算说一句「六点了，本姑娘按时来喊一声」，正文却是六段，后五段全是姐姐的
 * 台词，还带着它自己吐的 `</dc>` 残渣。
 *
 * 18:02:58 它自己复述了新规则「我只写我这一半」——读得到、认得，五分钟后照旧犯，
 * 所以光靠人设那一句不够，出口得有硬拦。这份 fixture 钉住三件事：
 *   ① 残渣标签出现 → 从它所在那一段整段砍掉
 *   ② 主动机会轮 → 正文只留第一段
 *   ③ 正常的多段正文不许误伤
 */

const SIX_ACT = [
  '六点了，本姑娘按时来喊一声——再赖下去晚饭就该凉了',
  '',
  '唔……</dc>',
  '',
  '醒了</dc>',
  '',
  '知道了</dc>',
  '',
  '(坐起来揉眼睛)</dc>',
  '',
  '（伸手过去扶一把）慢慢醒，不急这一分钟',
].join('\n')

test('18:01 那六段剧本：砍到只剩本姑娘自己那一句', () => {
  const out = cutAtDialogueScript(stripLeakedThinking(SIX_ACT), { proactive: true })
  assert.equal(out, '六点了，本姑娘按时来喊一声——再赖下去晚饭就该凉了')
})

test('残渣标签本身：从它所在那一段整段砍掉', () => {
  for (const tag of ['</dc>', '</doc>', '</dialogue>', '</message>', '</reply>']) {
    const raw = `真话在这儿\n\n唔……${tag}\n\n再接一句`
    assert.equal(cutAtDialogueScript(raw), '真话在这儿', `该砍：${tag}`)
  }
})

test('第一段就带残渣 → 整条不发（交给上层按沉默处理）', () => {
  assert.equal(cutAtDialogueScript('唔……</dc>\n\n醒了'), '')
})

test('主动机会轮：多段只留第一段', () => {
  const out = cutAtDialogueScript('行，那就这么定\n\n那我先睡了', { proactive: true })
  assert.equal(out, '行，那就这么定')
})

test('普通轮多段正常回复：一个字都不许动', () => {
  const cases = [
    '今天这天有点闷\n\n晚点开窗吧',
    '那晚饭呢，六点过了，姐姐打算吃点什么',
    '还没想好呢',
    '（把尾巴收回来）\n\n本姑娘去倒杯水',
    '晚饭想吃什么\n\n（把菜单推过去）',
  ]
  for (const t of cases) {
    assert.equal(cutAtDialogueScript(t), t, `不该动：${t}`)
  }
})

test('剧本形状（三段、两段十字以内、一段纯动作）：只留第一段', () => {
  const raw = '六点了\n\n唔……\n\n(坐起来揉眼睛)'
  assert.equal(cutAtDialogueScript(raw), '六点了')
})

test('单段正文：原样返回', () => {
  assert.equal(cutAtDialogueScript('还没想好呢'), '还没想好呢')
  assert.equal(cutAtDialogueScript(''), '')
  assert.equal(cutAtDialogueScript(null), null)
})

// ── 18:17 那一条：正文把主动机会的注入模板整段复读了 ──────────────────────
const INJECT_ECHO = [
  '好哒~(去做饭)',
  '',
  '嗯，去吧',
  '',
  '【主动机会】私聊 普瑞赛斯(希儿)(2710586329)已经安静了 25 分钟，现在是晚上（18:41）。',
  '对方有一阵子没动静了。可以说点自己刚想到的、问一句近况——但别催、别查岗、别问「在吗」。',
  '规矩：',
  '- 想说什么就直说，像随口一提。别用「有人吗」「大家还在吗」凑数，也别拿问号开场。',
  '- 别先替她否掉自己：姐姐说过（2026-10-25）——不用先猜她在忙，想说就先发。',
  '- 一次只发一条短的。真没什么想说的就什么也不发（[SILENT]）。',
].join('\n')

test('18:17 复读注入模板：只留她自己那两句', () => {
  assert.equal(cutAtDialogueScript(INJECT_ECHO), '好哒~(去做饭)\n\n嗯，去吧')
})

test('整条都是模板 → 空串（按沉默处理）', () => {
  assert.equal(cutAtDialogueScript('【主动机会】私聊 xx 已经安静了 25 分钟，现在是晚上（18:41）。'), '')
})

test('旧格式信封和新格式模板都要砍', () => {
  assert.equal(cutAtDialogueScript('真话在这里\n[现在是 2026-11-12 18:41（晚上）] 她在做饭'), '真话在这里')
  assert.equal(cutAtDialogueScript('真话\n<system-reminder> 一堆规则'), '真话')
})

test('只是提到「安静了 N 分钟」的正常句子不许误伤', () => {
  const t = '你安静了 25 分钟本姑娘都没敢动'
  assert.equal(cutAtDialogueScript(t), t)
})
