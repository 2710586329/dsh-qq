/**
 * 客户端半端自检的单元测试（issue #2 第 1 条）。
 *
 * 钉住两条只有插件自己查得到的错误：
 *   ① client.js 的 `__ModuleLoader__.load({ id })` 必须等于 package.json.name
 *      ——不符时宿主静默跳过整条 client bundle，设置页里没有 QQ；
 *   ② dsh.client.inject 为空。
 *
 * 另外钉住「骨架 settings.json」的说明键 `//` 不会被当成覆盖项
 * （否则第一次启动就把 cordis.patch.yml 配好的连接盖成空）。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = (name) => pathToFileURL(resolve(root, 'src', name)).href
const { inspectBundle, parseClientId } = await import(src('client-selfcheck.js'))
const { sanitizeOverrides } = await import(src('settings.js'))

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`✗ ${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
  }
}

const realPkg = readFileSync(resolve(root, 'package.json'), 'utf8')
const realClient = readFileSync(resolve(root, 'client.js'), 'utf8')

// ① 解析 id
check('真实 client.js 能解析出 id', parseClientId(realClient), 'dsh-qq-onebot')
check('没有 load 时解析结果是 null', parseClientId('const x = 1'), null)
check('带换行和空格的写法也能解析', parseClientId(`window.__ModuleLoader__.load( {\n  id:\n    'dsh-qq',\n} )`), 'dsh-qq')

// ② 真实包应当自检通过
{
  const r = inspectBundle({ pkgText: realPkg, clientText: realClient })
  check('真实包自检通过', r.ok, true)
  check('info 带版本', r.info.version.length > 0, true)
  check('info 的 inject 不是空', r.info.inject.length > 0, true)
}

// ③ id 与包名不一致 —— 就是 2026-10-25 那个坑
{
  const pkg = JSON.stringify({ name: 'dsh-qq-onebot', version: '9.9.9', dsh: { client: { inject: ['@deepseek-ai/dsh-api-remotes'] } } })
  const r = inspectBundle({ pkgText: pkg, clientText: "window.__ModuleLoader__.load({ id: 'dsh-qq', factory: () => ({}) })" })
  check('id 不一致 → 不通过', r.ok, false)
  check('id 不一致 → 报 client-id-mismatch', r.problems.map((p) => p.code), ['client-id-mismatch'])
  check('报错带两个名字', r.problems[0].message.includes('dsh-qq') && r.problems[0].message.includes('dsh-qq-onebot'), true)
}

// ④ client.js 里根本没有 load
{
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', dsh: { client: { inject: ['a'] } } })
  const r = inspectBundle({ pkgText: pkg, clientText: '// nothing' })
  check('没有 load → 报 no-client-id', r.problems.map((p) => p.code), ['no-client-id'])
}

// ⑤ inject 为空
{
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', dsh: { client: { inject: [] } } })
  const r = inspectBundle({ pkgText: pkg, clientText: "window.__ModuleLoader__.load({ id: 'x' })" })
  check('inject 空 → 报 no-inject', r.problems.map((p) => p.code), ['no-inject'])
}

// ⑥ 坏 package.json 不抛异常
{
  const r = inspectBundle({ pkgText: '{ 坏的', clientText: '' })
  check('坏 JSON → 不抛、有报错', r.problems.map((p) => p.code), ['bad-package-json'])
}

// ⑦ 骨架 settings 里的 `//` 说明键不能被当成覆盖项
{
  const skeleton = { '//': '说明文字', wsUrl: 'ws://127.0.0.1:3001' }
  const clean = sanitizeOverrides(skeleton)
  check('骨架说明键被忽略', Object.keys(clean), ['wsUrl'])
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
