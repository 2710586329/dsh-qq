import assert from 'node:assert/strict'
import { auditOutbound } from '../src/audit.js'

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

console.log('auditOutbound')

ok('正常中文聊天放行', () => {
  assert.deepEqual(auditOutbound('今晚月色真好，本姑娘想多吃一碗大白饭喵'), { ok: true })
})

ok('正常技术讨论放行（没有路径/密钥）', () => {
  assert.deepEqual(auditOutbound('这个 bug 是数组越界导致的，改成 < 就好了'), { ok: true })
})

ok('空文本放行', () => {
  assert.deepEqual(auditOutbound(''), { ok: true })
  assert.deepEqual(auditOutbound(null), { ok: true })
})

ok('Windows 路径拦下', () => {
  const v = auditOutbound('文件在 D:\\鲸鲸的专用文件\\本地记忆区\\日记')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'path')
})

ok('Windows 正斜杠路径也拦', () => {
  const v = auditOutbound('见 C:/Users/xier/AppData 下面')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'path')
})

ok('Unix 家目录拦下', () => {
  const v = auditOutbound('配置在 /home/deploy/.config/下面')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'path')
})

ok('file:// 链接拦下', () => {
  const v = auditOutbound('点这个 file:///C:/tmp/a.png')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'path')
})

ok('OpenAI 风格 key 拦下', () => {
  const v = auditOutbound('key 是 sk-abcdefghijklmnopqrstuvwx')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'credential')
})

ok('GitHub token 拦下', () => {
  const v = auditOutbound('用 ghp_abcdefghijklmnopqrstuvwxyz0123456789 拉')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'credential')
})

ok('Bearer 头拦下', () => {
  const v = auditOutbound('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'credential')
})

ok('password: value 拦下', () => {
  const v = auditOutbound('password: hunter2hunter2')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'credential')
})

ok('api_key = value 拦下（带空格）', () => {
  const v = auditOutbound('api_key = abcd1234efgh5678')
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'credential')
})

ok('单个盘符不算路径（少误杀）', () => {
  assert.deepEqual(auditOutbound('选 C: 盘还是 D: 盘'), { ok: true })
})

ok('额外正则命中', () => {
  const v = auditOutbound('内部编号 XY-998877', { extraPatterns: ['XY-\\d{6}'] })
  assert.equal(v.ok, false)
  assert.equal(v.kind, 'custom')
})

ok('配错的额外正则被跳过，不影响其他规则', () => {
  const v = auditOutbound('普通一句话', { extraPatterns: ['([unclosed'] })
  assert.deepEqual(v, { ok: true })
})

ok('命中时 hit 不返回整段原文（截断到 120）', () => {
  const long = `D:\\${'a'.repeat(400)}`
  const v = auditOutbound(long)
  assert.equal(v.ok, false)
  assert.ok(v.hit.length <= 120)
})

console.log(`\n${passed} 项全部通过`)
