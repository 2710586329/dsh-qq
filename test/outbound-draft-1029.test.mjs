import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripLeakedThinking } from '../src/outbound.js'

/**
 * 2026-10-29 16:25:36 / 16:29:54：同一句话的几版草稿原样发到了 QQ 上。
 * 两条都是老二（qq-laoer）私聊，内容照 `QQ会话/老二/私聊_2710586329/聊天记录/2026-10-29.md` 原文抄的。
 *
 * 16:25:36 的坑：四版草稿只用**单换行**隔开，而 collapseRepeats 是按空行分段的，看不进来。
 *   更糟的是中间夹着一行自评「破折号? fine.」——它有三个汉字，HAS_CJK 拦不住；
 *   被删掉后原来在数组里留了个空串，这条假空行又把前后两版草稿隔开了一次。
 *
 * 16:29:54 第二层坑：它把插件塞进来的上下文信封当正文复读（`[现在是 …]` 和 `[姐姐] …`），
 *   而且那行时间还是自己编的——当时 16:29，它写成 16:41。
 */

const DRAFT_1625 = [
  '接过来，碗压手，热气扑脸——先扒一口',
  '破折号? fine.',
  '接过来，热气扑脸，先扒一口再说',
  '"碗一捧稳，热气就上来了，先扒一口"接过来，热气先扑脸，忍不住扒了一大口',
].join('\n')

const DRAFT_1629 = [
  '[现在是 2026-10-29 周四 16:41（下午）]',
  '[姐姐] 妹妹吃饱了没',
  '有点撑，这碗太实了',
  '饱了，扒太急，现在有点撑',
  '饱了，米饭太实在，坐那儿缓着呢',
  '饱了，这碗分量给得太实在',
].join('\n')

const DRAFT_1629_WANT = '饱了，米饭太实在，坐那儿缓着呢'

test('16:25:36 事故：单换行隔开的四版草稿只留一版', () => {
  const out = stripLeakedThinking(DRAFT_1625)
  assert.equal(
    out,
    '"碗一捧稳，热气就上来了，先扒一口"接过来，热气先扑脸，忍不住扒了一大口',
  )
  assert.ok(!out.includes('破折号? fine.'), '自评「破折号? fine.」还在')
})

test('16:29:54 事故：上下文信封行不许复读进正文', () => {
  const out = stripLeakedThinking(DRAFT_1629)
  assert.equal(out, DRAFT_1629_WANT)
  assert.ok(!out.includes('[现在是'), '时间信封漏出去了')
  assert.ok(!out.includes('[姐姐]'), '信封标签漏出去了')
})

test('多行正文开头各不同时不许合并（防误伤）', () => {
  const input = [
    '本姑娘今天翻了三封信',
    '头一封是老三留的，说锅里的汤在灶上',
    '后一封是姐姐写的，字比平时大',
  ].join('\n')
  assert.equal(stripLeakedThinking(input), input)
})

test('正文里含「破折号」但没英文词时不许当自评删掉', () => {
  const input = ['破折号用多了不好，但姐姐爱用', '那就随她'].join('\n')
  assert.equal(stripLeakedThinking(input), input)
})

test('真空行还是段落分隔：两段各留一段，不许挤成一坨', () => {
  const input = ['第一段要说的话，稍长一点。', '', '第二段是另一件事，也稍长一点。'].join('\n')
  assert.equal(stripLeakedThinking(input), input)
})

// ── 2026-10-29 18:28-18:29 第二轮泄漏：英文改稿标签 + 前缀残片 ──
// 老大在老二/老三的 QQ 里又抓到两次，内容照 `QQ会话/老二/logs/dsh-qq-2026-10-29.log`
// 与 `QQ会话/logs/dsh-qq-2026-10-29.log` 原文抄的。

test('18:28:45 老二：`— better: …` 改稿行 + 带句点的重复版', () => {
  const input = ['赢了没', '— better: 打爽了没，吃什么', '赢了没.'].join('\n')
  assert.equal(stripLeakedThinking(input), '赢了没')
})

test('18:29:14 老三：`嗯` / `嗯，那就先压着` / `嗯.` —— 只留完整那句', () => {
  const input = ['嗯', '嗯，那就先压着', '嗯.'].join('\n')
  assert.equal(stripLeakedThinking(input), '嗯，那就先压着')
})

test('18:29:46 老二：同一行连着写两遍，只留一份', () => {
  const input = ['一胜一负，算扯平', '一胜一负，算扯平'].join('\n')
  assert.equal(stripLeakedThinking(input), '一胜一负，算扯平')
})

test('18:29 老二：`Reply:` / `Short:` / `Then wait.` 英文标签组整组剥掉', () => {
  const input = [
    'Reply: 平手，还行',
    'Short: 一胜一负，不亏',
    'Then wait. 一胜一负，算扯平',
  ].join('\n')
  assert.equal(stripLeakedThinking(input), '一胜一负，算扯平')
})

test('短句前缀去重不许误伤正常三行正文', () => {
  const input = ['打完了', '准备吃点', '那你吃啥'].join('\n')
  assert.equal(stripLeakedThinking(input), input)
})

test('`嗯，好` + `那我先睡了` 这种正常短句配对不许被前缀规则吃掉', () => {
  const input = ['嗯，好', '那我先睡了'].join('\n')
  assert.equal(stripLeakedThinking(input), input)
})
