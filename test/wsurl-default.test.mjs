// 没配地址就别偷偷连（issue #2 第 1 条实测反馈，2026-10-27 修）。
//
// 旧行为：wsUrl 默认 `ws://127.0.0.1:3001`，于是「没配就 warn 一句」永远走不到，
// 空骨架照样去连 3001，用户看到的是满屏 ECONNREFUSED，还以为是自己配错了。
// 现在默认留空：不配就不连，日志里说清去哪填。
//
// 跑法：node test/wsurl-default.test.mjs
import assert from 'node:assert'
import { ConfigSchema } from '../src/config.js'

const empty = new ConfigSchema({})
assert.equal(empty.wsUrl, '', '① 没配 wsUrl 时必须留空——不许替用户套一个 3001')

const given = new ConfigSchema({ wsUrl: 'ws://127.0.0.1:3001' })
assert.equal(given.wsUrl, 'ws://127.0.0.1:3001', '② 用户填了就得原样认')

const blank = new ConfigSchema({ wsUrl: '   ' })
assert.equal(typeof blank.wsUrl, 'string', '③ 空白串不该被撑成别的类型（调用方自己 trim 后判空）')

console.log('通过 3，失败 0')
