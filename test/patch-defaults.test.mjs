// 插件包里的 cordis.patch.yml 会盖住 src/config.js 的 schema 默认值（patch 后应用）。
// 只改一边 = 用户看到的行为和代码里的默认值对不上——
// 1.2.1 就是这么栽的：schema 的 wsUrl 改成空，patch 里还留着 3001，
// 于是「没配就不去连」这段永远走不到，用户照样满屏 ECONNREFUSED（issue #2 第三次实测）。
//
// 这条测试盯的就是「两处默认值必须一致」：patch 里出现的每个键，
// 值都要等于 `new ConfigSchema({})` 里那个键的默认值。改默认值忘了改另一边，这里先红。
//
// 跑法：node test/patch-defaults.test.mjs
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ConfigSchema } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const yml = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')

// 迷你 YAML 读取：只认本文件用到的那几种写法，不引依赖。
function readPatchConfig(text) {
  const out = new Map()
  let inConfig = false
  let listKey = null
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue
    if (/^\s*config:\s*$/.test(raw)) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    if (/^\s{0,7}\S/.test(raw)) break // 离开 config 段

    const listItem = raw.match(/^\s{10,}-\s+(.*)$/)
    if (listItem && listKey) {
      out.get(listKey).push(scalar(listItem[1]))
      continue
    }

    const kv = raw.match(/^\s{8}([A-Za-z_][\w]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, rest] = kv
    const value = rest.trim()
    if (value === '') {
      listKey = key
      out.set(key, [])
      continue
    }
    listKey = null
    if (value === '[]') out.set(key, [])
    else out.set(key, scalar(value))
  }
  return out
}

function scalar(v) {
  let s = v.trim()
  const hash = s.search(/\s#/)
  if (hash >= 0) s = s.slice(0, hash).trim()
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1)
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s === '[]') return []
  return s
}

const patch = readPatchConfig(yml)
const defaults = new ConfigSchema({})

assert.ok(patch.size >= 10, `① 得真读到 config 段（读到 ${patch.size} 个键，看着像解析坏了）`)

const drift = []
for (const [key, value] of patch) {
  if (!(key in defaults)) {
    drift.push(`${key}：patch 里有、schema 里没有（schema 会忽略它，用户以为配了其实没配）`)
    continue
  }
  const want = defaults[key]
  if (JSON.stringify(value) !== JSON.stringify(want)) {
    drift.push(`${key}：patch 写的是 ${JSON.stringify(value)}，schema 默认是 ${JSON.stringify(want)}`)
  }
}

console.log(`读到 ${patch.size} 个键：${[...patch.keys()].join(', ')}`)

// ② 单独把这次栽过的两个键钉死，报错信息更直白
assert.equal(patch.get('wsUrl'), '', '② patch 里的 wsUrl 必须留空——替用户填 3001，「没配就不连」就永远走不到')
assert.equal(
  patch.get('privateMode'),
  'allowlist',
  '③ patch 里的 privateMode 必须是 allowlist——patch 的值会盖住 schema，写 open 等于默认放行陌生人',
)

assert.deepEqual(drift, [], `④ patch 与 schema 默认值漂移了：\n  ${drift.join('\n  ')}`)

console.log('通过 4，失败 0')
