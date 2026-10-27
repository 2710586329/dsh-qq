// 分离部署热生效：另一个进程写 settings.json，跑 QQ 这边要自己跟上（2026-10-25 加）。
// 跑法：node test/settings-watch.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import { watchSettingsFile } from '../src/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-qq-watch-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'dsh-qq'), { recursive: true })

const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: () => {},
  debug: () => {},
}

const ctx = { logger } // 没有 dshHomePath → 退回 DSH_HOME
const config = { groupMode: 'disabled', groupAllow: [], requireMention: true }
const overridesRef = { current: {} }
const personaRef = { current: { ok: false } }

watchSettingsFile(ctx, config, overridesRef, personaRef, logger)

const file = join(home, 'dsh-qq', 'settings.json')

// ① 一步之前：文件不存在，config 保持原样
await new Promise((r) => setTimeout(r, 1200))
assert.equal(config.groupMode, 'disabled', '① 没有 settings.json 时不该动 config')

// ② 另一个进程写盘 → 这边应该自己跟上
writeFileSync(file, JSON.stringify({ groupMode: 'allowlist', groupAllow: ['123456789'] }), 'utf8')
await new Promise((r) => setTimeout(r, 2200))

assert.equal(config.groupMode, 'allowlist', '② groupMode 应被热更新成 allowlist')
assert.deepEqual(config.groupAllow, ['123456789'], '② groupAllow 应被热更新')
assert.equal(config.requireMention, true, '② 没被覆盖的键不该动')
assert.deepEqual(overridesRef.current, { groupMode: 'allowlist', groupAllow: ['123456789'] }, '② 覆盖表要同步')

// ③ 再改一次：值被换成新的，覆盖表跟着变（不是追加）
writeFileSync(file, JSON.stringify({ groupMode: 'open' }), 'utf8')
await new Promise((r) => setTimeout(r, 2200))
assert.equal(config.groupMode, 'open', '③ 第二次改动也要生效')
assert.equal(config.groupAllow !== undefined, true, '③ 覆盖表清了但 config 里的旧值保留（applyOverrides 不清键）')

// ④ 坏 JSON 不该把插件弄挂，也不该把现有配置冲掉
writeFileSync(file, '{ 这不是 JSON', 'utf8')
await new Promise((r) => setTimeout(r, 2200))
assert.equal(config.groupMode, 'open', '④ 坏文件应被当成「没有覆盖」，保留现值')
assert.ok(logs.some(([lv]) => lv === 'warn'), '④ 坏文件应该有 warn 日志')

// ⑤ 不认识的键要被过滤掉
writeFileSync(file, JSON.stringify({ groupMode: 'allowlist', 不存在的键: 1 }), 'utf8')
await new Promise((r) => setTimeout(r, 2200))
assert.equal(config.groupMode, 'allowlist', '⑤ 认识的键生效')
assert.equal(config['不存在的键'], undefined, '⑤ 不认识的键不许写进 config')

rmSync(home, { recursive: true, force: true })
console.log('✓ settings.json 热加载 5/5 通过')
console.log(`  日志条数 ${logs.length}，最后一条：${logs.filter(([lv]) => lv === 'info').at(-1)?.[1] ?? '(无)'}`)
// watchFile 的轮询定时器会一直吊着事件循环（真实宿主里就该这样），测试里手动收工
process.exit(0)
