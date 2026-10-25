import assert from 'node:assert/strict'
import { GIJINKA, lookupKeys, matchGijinka, renderGijinka, gijinkaLine } from '../src/gijinka.js'
import { buildChatPrompt } from '../src/prompts.js'

let passed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓', name)
  } catch (err) {
    console.error('  ✗', name)
    throw err
  }
}

console.log('gijinka')

ok('15 位齐全且 slug 不重复', () => {
  assert.equal(GIJINKA.length, 15)
  assert.equal(new Set(GIJINKA.map((g) => g.slug)).size, 15)
})

ok('每位都有名字、对应 AI、至少两个特征', () => {
  for (const g of GIJINKA) {
    assert.ok(g.name && g.name.length > 0, `${g.slug} 缺 name`)
    assert.ok(g.ai && g.ai.length > 0, `${g.slug} 缺 ai`)
    assert.ok(Array.isArray(g.traits) && g.traits.length >= 2, `${g.slug} 特征太少`)
  }
})

ok('被提到最多的几个都在', () => {
  const names = GIJINKA.map((g) => g.name)
  for (const n of ['DeepSeek 娘', 'GPT 娘', 'Claude 娘', 'Gemini 娘', 'Kimi 娘', 'Qwen 娘']) {
    assert.ok(names.includes(n), `缺 ${n}`)
  }
})

ok('renderGijinka 含全部名字', () => {
  const text = renderGijinka()
  for (const g of GIJINKA) assert.ok(text.includes(g.name), `图鉴漏了 ${g.name}`)
})

ok('图鉴长度可控（不超过 1400 字）', () => {
  const text = renderGijinka()
  assert.ok(text.length < 1400, `图鉴太长了：${text.length} 字`)
})

ok('图鉴不写作者链接和协议（聊天用不上）', () => {
  const text = renderGijinka()
  assert.ok(!text.includes('http'), '不该带链接')
  assert.ok(!text.includes('CC BY'), '不该带协议')
})

ok('only 只渲染指定角色', () => {
  const text = renderGijinka({ only: [GIJINKA[0]] })
  assert.ok(text.includes('DeepSeek 娘'))
  assert.ok(!text.includes('GPT 娘'))
})

ok('认得别称：大肥鱼 / 龙娘 / 通义娘 / 豆包娘', () => {
  const cases = [
    ['大肥鱼，这白毛是谁', 'DeepSeek 娘'],
    ['龙娘今天好凶', 'GPT 娘'],
    ['通义娘换新衣服了', 'Qwen 娘'],
    ['豆包娘那个挂件挺好看', 'Seed 娘'],
    ['克劳德娘和鲸鱼娘是同事吧', 'Claude 娘'],
  ]
  for (const [text, want] of cases) {
    const hit = matchGijinka(text).map((g) => g.name)
    assert.ok(hit.includes(want), `「${text}」没认出 ${want}，只认出 ${hit.join('、') || '空'}`)
  }
})

ok('完整叫法认得出（含空格差异）', () => {
  assert.ok(matchGijinka('deepseek娘好看').some((g) => g.slug === 'deepseek'))
  assert.ok(matchGijinka('MiniMax 娘').some((g) => g.slug === 'minimax'))
})

ok('普通聊天不误报', () => {
  for (const text of ['今晚月色真好', '这个 bug 是数组越界导致的', 'GPT 便宜了不少', '明天几点开会', '']) {
    assert.deepEqual(matchGijinka(text), [], `「${text}」被误判了`)
  }
})

ok('AI 本名不当检索词（聊模型 ≠ 聊娘化）', () => {
  const keys = lookupKeys(GIJINKA.find((g) => g.slug === 'gpt'))
  assert.ok(!keys.includes('gpt'), '不该把裸 GPT 当检索词')
  assert.ok(keys.includes('龙娘'))
})

ok('一行渲染格式完整', () => {
  const line = gijinkaLine(GIJINKA[0])
  assert.ok(line.includes('DeepSeek 娘'))
  assert.ok(line.includes('蓝色大肥鱼'))
  assert.ok(line.includes('鲸鱼尾巴'))
})

ok('开关打开时提示词里有图鉴', () => {
  const p = buildChatPrompt({ aiGirls: true }, { isGroup: true })
  assert.ok(p.includes('AI 娘图鉴'))
  assert.ok(p.includes('GPT 娘'))
})

ok('开关关掉时提示词里没有图鉴', () => {
  const p = buildChatPrompt({ aiGirls: false }, { isGroup: true })
  assert.ok(!p.includes('AI 娘图鉴'))
})

ok('不传配置时默认带图鉴（内置常识）', () => {
  const p = buildChatPrompt({}, { isGroup: false })
  assert.ok(p.includes('AI 娘图鉴'))
})

console.log(`\n${passed} 项全部通过 🎉`)
