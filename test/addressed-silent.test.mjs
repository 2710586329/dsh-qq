/**
 * 群里「@ 了也可以不回」的自测。
 *
 * 2026-10-27 姐姐定：老三在群里被 @ / 被引用 / 被点名的时候，
 * **看得见、回不回她定**——不再强制开口。
 * 私聊和补发（replay）不受影响，该回还得回。
 *
 * 跑法：node test/addressed-silent.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { mustReplyFor } from '../src/inbound.js'

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

console.log('群里被叫 · 是否必须回')

t('默认（开关关）：群里被 @ 必须回', () => {
  assert.equal(mustReplyFor({ isGroup: true, atMe: true }), true)
})

t('默认（开关关）：被叫名字点名也必须回', () => {
  assert.equal(mustReplyFor({ isGroup: true, addressedBy: 'name' }), true)
})

t('开关开：群里被 @ 可以沉默', () => {
  assert.equal(mustReplyFor({ isGroup: true, atMe: true, addressedMaySilent: true }), false)
})

t('开关开：被引用也可以沉默', () => {
  assert.equal(mustReplyFor({ isGroup: true, quotedMe: true, addressedMaySilent: true }), false)
})

t('开关开：被叫名字点名也可以沉默', () => {
  assert.equal(mustReplyFor({ isGroup: true, addressedBy: 'question', addressedMaySilent: true }), false)
})

t('开关开：私聊照样必须回', () => {
  assert.equal(mustReplyFor({ isGroup: false, addressedMaySilent: true }), true)
})

t('开关开：补发（replay）照样必须回', () => {
  assert.equal(mustReplyFor({ isGroup: true, isReplay: true, addressedMaySilent: true }), true)
})

t('群里没人叫它：本来就留出口（开关开或关都一样）', () => {
  assert.equal(mustReplyFor({ isGroup: true }), false)
  assert.equal(mustReplyFor({ isGroup: true, addressedMaySilent: true }), false)
})

console.log('\n接线检查')

t('inbound 调用处真的读了 config.addressedMaySilent', () => {
  const src = readFileSync(new URL('../src/inbound.js', import.meta.url), 'utf8')
  assert.match(src, /addressedMaySilent:\s*config\.addressedMaySilent/)
})

t('config.js 有这个键，且默认关', () => {
  const src = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  assert.match(src, /addressedMaySilent:\s*Schema\.boolean\(\)\s*\.default\(false\)/)
})

t('settings.js 热更新列表里有这个键', () => {
  const src = readFileSync(new URL('../src/settings.js', import.meta.url), 'utf8')
  assert.match(src, /'addressedMaySilent'/)
})

console.log(`\n${fail === 0 ? '全部通过 🎉' : '有失败'}  ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
