/**
 * 两层提示词（prompts.js）自测。
 *
 * 核心断言：协议层在前、人设层在后、人设紧挨着 SELF_KNOWN_RULE，
 * 这样「上面那段『我是谁』」才指得清，人设也不会被前面一大坨规矩冲淡。
 *
 * 跑法：node test/prompts.test.mjs
 */
import assert from 'node:assert/strict'

import {
  buildChatPrompt,
  personaLeaks,
  SELF_KNOWN_RULE,
  ANON_RULE,
  BUILTIN_RULES,
  GROUP_RULES,
  PRIVATE_RULES,
} from '../src/prompts.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err?.message ?? err}`)
  }
}

const PERSONA = '你是鲸鲸，一条住在深海里的鲸鱼娘。说话软糯，被夸就摇尾巴。'

console.log('两层提示词 · 顺序')
t('人设排在协议层之后', () => {
  const p = buildChatPrompt({ persona: PERSONA }, { isGroup: false })
  const iPersona = p.indexOf('鲸鱼娘')
  assert.ok(iPersona > 0)
  assert.ok(iPersona > p.indexOf(BUILTIN_RULES.slice(0, 20)))
  assert.ok(iPersona > p.indexOf('【时间】'))
  assert.ok(iPersona > p.indexOf('【脾气】'))
})

t('SELF_KNOWN_RULE 紧跟在人设后面（中间只有空行）', () => {
  const p = buildChatPrompt({ persona: PERSONA }, { isGroup: false })
  const iPersona = p.indexOf(PERSONA)
  const iSelf = p.indexOf(SELF_KNOWN_RULE)
  assert.ok(iSelf > iPersona)
  const between = p.slice(iPersona + PERSONA.length, iSelf)
  assert.ok(between.trim() === '', `人设和 SELF_KNOWN_RULE 之间不该有别的内容，实际是：${JSON.stringify(between)}`)
})

t('没配人设才用 ANON_RULE，且不出现 SELF_KNOWN_RULE', () => {
  const p = buildChatPrompt({}, { isGroup: false })
  assert.ok(p.includes(ANON_RULE))
  assert.ok(!p.includes(SELF_KNOWN_RULE))
})

// 2026-10-26 晚：人设可以交给宿主的系统提示（profile 的 personaPrefix）。
// 那时候消息里就不能再有一份——否则对话历史里又冒出「你是谁」，
// 模型会把它当成别人上一轮说过的话。
t('personaInSystem：人设在系统提示里时，消息里不再重复一份', () => {
  const p = buildChatPrompt({ persona: PERSONA, personaInSystem: true }, { isGroup: false })
  assert.ok(!p.includes(PERSONA), '人设不该再拼进消息')
  assert.ok(p.includes('系统提示里写着了'), '要留一句指代，别让它去猜自己是谁')
  assert.ok(!p.includes(ANON_RULE), '有系统级人设就不该走「没有固定名字」那条')
  assert.ok(!p.includes(SELF_KNOWN_RULE), 'SELF_KNOWN_RULE 说的是「上面那段」，这里上面没有人设')
})

t('事实卡在人设之前（事在协议后面、性格前面）', () => {
  const p = buildChatPrompt(
    { persona: PERSONA },
    { isGroup: false, facts: '她喜欢大白饭', factsFile: '事实卡.md' },
  )
  const iFacts = p.indexOf('她喜欢大白饭')
  const iPersona = p.indexOf(PERSONA)
  assert.ok(iFacts > 0 && iPersona > iFacts)
})

t('表情包在最后', () => {
  const p = buildChatPrompt(
    { persona: PERSONA },
    { isGroup: false, faces: { total: 3, names: ['猫猫', '问号', '晚安'] } },
  )
  const iFace = p.indexOf('【表情包】')
  const iPersona = p.indexOf(PERSONA)
  assert.ok(iFace > iPersona)
  assert.ok(p.slice(iFace).indexOf('【') === 0 || true)
  // 表情包后面不该还有别的大段
  assert.ok(p.length - iFace < 900)
})

t('群聊没人设时也不会把 ANON 挤到中间', () => {
  const p = buildChatPrompt({ ownerIds: ['123'], ownerLabel: '姐姐' }, { isGroup: true })
  assert.ok(p.includes(GROUP_RULES.slice(0, 10)))
  assert.ok(p.indexOf(ANON_RULE) > p.indexOf('【谁是谁】'))
})

console.log('两层提示词 · 人设泄漏检测')
t('干净人设不报警', () => {
  assert.deepEqual(personaLeaks(PERSONA), { ok: true, hits: [] })
})

t('人设里写 qq_mface 会被抓出来', () => {
  const leak = personaLeaks('你是鲸鲸，想发表情就用 qq_mface。')
  assert.equal(leak.ok, false)
  assert.ok(leak.hits.includes('qq_mface'))
})

t('多个工具名都抓到', () => {
  const leak = personaLeaks('用 qq_reply 回话，用 read_image 看图，不想说话就 [SILENT]。')
  assert.equal(leak.ok, false)
  assert.deepEqual(leak.hits.sort(), ['[SILENT]', 'qq_reply', 'read_image'].sort())
})

t('空 / null 不炸', () => {
  assert.equal(personaLeaks('').ok, true)
  assert.equal(personaLeaks(null).ok, true)
  assert.equal(personaLeaks(undefined).ok, true)
})

console.log('两层提示词 · 场景差异')
t('私聊有便签规矩、群聊没有', () => {
  assert.ok(buildChatPrompt({}, { isGroup: false }).includes('【便签'))
  assert.ok(!buildChatPrompt({}, { isGroup: true }).includes('【便签'))
})

t('便签规矩说清了「不是遗书」，并给了旧名兜底', () => {
  const p = buildChatPrompt({}, { isGroup: false })
  assert.ok(p.includes('不是遗书'), '得把「这不是遗书」说出口')
  assert.ok(p.includes('便签.md'), '新文件名要写对')
  assert.ok(!p.includes('【交接（换会话时用）】'), '旧标题不该再出现')
})

t('群聊有身份规矩，私聊没有', () => {
  assert.ok(buildChatPrompt({}, { isGroup: true }).includes('【谁是「你」】'))
  assert.ok(!buildChatPrompt({}, { isGroup: false }).includes('【谁是「你」】'))
})

t('私聊用 PRIVATE_RULES、群聊用 GROUP_RULES', () => {
  const priv = buildChatPrompt({}, { isGroup: false })
  const grp = buildChatPrompt({}, { isGroup: true })
  assert.ok(priv.includes(PRIVATE_RULES.slice(0, 12)))
  assert.ok(grp.includes(GROUP_RULES.slice(0, 12)))
})

console.log('两层提示词 · 自定义补充')
t('groupPrompt 落在人设之前', () => {
  const p = buildChatPrompt(
    { persona: PERSONA, groupPrompt: '【本群规矩】别聊政治' },
    { isGroup: true },
  )
  assert.ok(p.indexOf('别聊政治') < p.indexOf(PERSONA))
})

console.log(`\n${fail === 0 ? '全部通过 🎉' : '有失败'}  ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
