import { test } from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeSelfAddressedAction } from '../src/outbound.js'

/**
 * 2026-11-09 09:22：老二回她「亲一口妹妹」，正文里写「（抱住妹妹~亲）」。
 *
 * 「妹妹」是她叫它的称呼，被摆到了动作的对象位 —— 动作的主语本该是它自己，
 * 写成「抱住妹妹」就成了它抱住它自己，再往下演就像**替她做动作**。
 * 这类没有信封、没有 `[现在是 …]`，`SCRIPT_REPLAY_RE` 拦不住，所以照常兜底发了出去。
 *
 * 现在只当**观察信号**（日志 warn），不改发送行为 —— 她 11-09 说「先不急，加的越多越容易出事」。
 * 这份 fixture 钉住「什么时候算命中、什么时候不许误伤」。
 */

test('动作拿「妹妹」当对象、又没有第二人称 → 命中', () => {
  const cases = [
    '（被亲得尾巴一颤，仰头回亲上去）（抱住妹妹~亲）',
    '（把妹妹搂进怀里）',
    '（摸摸妹妹的头）',
  ]
  for (const t of cases) {
    assert.equal(looksLikeSelfAddressedAction(t), true, `该命中：${t}`)
  }
})

test('正常动作和正常台词不许误伤', () => {
  const cases = [
    '（被亲得尾巴一颤，仰头回亲上去）',
    '早',
    '（把下巴搁在你肩上）',
    '（抱住你）',
    '（被姐姐揉了揉头，尾巴晃了两下）',
    '（妹妹在呢，姐姐不用急）', // 有第二人称，是在对她说话
    '尾巴在被子里晃了下',
  ]
  for (const t of cases) {
    assert.equal(looksLikeSelfAddressedAction(t), false, `不该命中：${t}`)
  }
})
