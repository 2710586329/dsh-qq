// 私聊默认放行是个真口子：任何人加了这个 QQ 号发一句，就能指挥跑在本机的 agent
// （读文件、跑命令都算）。PR #9370 的评论点了这一条，2026-10-27 改默认为 allowlist。
//
// 这里钉两件事：
//   ① 默认 privateMode 是 allowlist——不许悄悄回到 open
//   ② 白名单空着时，判定逻辑必须「谁都不放行」（不是「空名单 = 不限」那种反直觉写法）
//
// 跑法：node test/private-gate.test.mjs
import assert from 'node:assert'
import { ConfigSchema } from '../src/config.js'

const empty = new ConfigSchema({})
assert.equal(empty.privateMode, 'allowlist', '① 默认必须是 allowlist——陌生人私聊不许进来')
assert.deepEqual(empty.privateAllow, [], '② 默认白名单是空的')

// 复刻 inbound.js 的 allowPrivate 判定（它是模块内部函数，不导出；这里只验语义）
function allows(mode, allow, userId) {
  if (mode === 'disabled') return false
  if (mode === 'allowlist') return (allow ?? []).map(String).includes(String(userId))
  return true
}

assert.equal(allows(empty.privateMode, empty.privateAllow, '123456789'), false, '③ 默认配置下陌生人私聊必须被拒')
assert.equal(allows('allowlist', [], '123456789'), false, '④ 空白名单 = 全拒，不是全放')

const open = new ConfigSchema({ privateMode: 'open' })
assert.equal(allows(open.privateMode, [], '123456789'), true, '⑤ 显式写 open 的用户照旧全放——不替他们改配置')

const listed = new ConfigSchema({ privateMode: 'allowlist', privateAllow: ['123456789'] })
assert.equal(allows(listed.privateMode, listed.privateAllow, '123456789'), true, '⑥ 白名单里的人能进')
assert.equal(allows(listed.privateMode, listed.privateAllow, '987654321'), false, '⑦ 名单外的人进不来')

console.log('通过 7，失败 0')
