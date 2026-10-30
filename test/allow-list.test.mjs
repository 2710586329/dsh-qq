/**
 * issue #3 的回归：`privateAllow` / `groupAllow` 写成字符串时不能把入站处理炸掉。
 *
 * 原来三处直接 `(config.privateAllow ?? []).map(...)`，配置写成 `"123456"` 就抛
 * `TypeError: (c.privateAllow ?? []).map is not a function`，而且抛出点离配置项很远，
 * 用户只看到「消息没反应」。
 *
 * 这里两件事一起钉：
 *   ① `listOf()` 自己认得各种写法（数组、字符串、逗号、中文逗号、数字、空值）
 *   ② 四个用到白名单的文件里，那几处裸 `.map()` 已经被换掉 —— 光测函数不够，
 *      哪天有人在别的文件里又写一遍 `(config.privateAllow ?? []).map`，这条会红
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listOf } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const src = (name) => readFileSync(join(root, 'src', name), 'utf8')
const flat = (name) => src(name).replace(/\s+/g, '')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✔ ${name}`)
  } else {
    fail += 1
    console.log(`  ✘ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(name, g === w, `拿到 ${g}，期望 ${w}`)
}

console.log('\n[1] listOf 认哪些写法')
eq('数组原样', listOf(['123', '456']), ['123', '456'])
eq('数组去空白和空串', listOf([' 123 ', '', '456', null]), ['123', '456'])
eq('数字项', listOf([123456]), ['123456'])
eq('英文逗号', listOf('123,456'), ['123', '456'])
eq('中文逗号', listOf('123，456'), ['123', '456'])
eq('空格和换行', listOf('123 456\n789'), ['123', '456', '789'])
eq('单个号（就是 issue #3 的写法）', listOf('123456'), ['123456'])
eq('带空白的单个号', listOf('  123456  '), ['123456'])
eq('连续逗号不留空项', listOf('1,,2, ,3'), ['1', '2', '3'])
eq('数字当单个号', listOf(123456), ['123456'])
eq('null', listOf(null), [])
eq('undefined', listOf(undefined), [])
eq('空串', listOf(''), [])
eq('只有空白', listOf('   '), [])
eq('对象不炸', listOf({ a: 1 }), [])
eq('布尔不炸', listOf(true), [])
eq('空数组', listOf([]), [])

console.log('\n[2] 四个文件里那几处裸 .map 已经换掉')
ok(
  'inbound.js 私聊门控用 listOf',
  flat('inbound.js').includes('listOf(config.privateAllow)') &&
    !flat('inbound.js').includes('privateAllow??[]).map'),
  '还在直接 .map()',
)
ok(
  'inbound.js 群门控用 listOf',
  flat('inbound.js').includes('listOf(config.groupAllow)') &&
    !flat('inbound.js').includes('groupAllow??[]).map'),
  '还在直接 .map()',
)
ok(
  'index.js 启动检查用 listOf',
  flat('index.js').includes('listOf(config.privateAllow)') &&
    !flat('index.js').includes('privateAllow??[]).map'),
  '还在直接 .map()',
)
ok(
  'reading.js 取第一个 peered 用 listOf',
  flat('reading.js').includes('listOf(config?.privateAllow)[0]') &&
    !flat('reading.js').includes('privateAllow?.[0]'),
  '还在 ?.[0]，字符串会取到第一个字符',
)
ok(
  'wake.js 复活冷会话用 listOf',
  flat('wake.js').includes('listOf(config?.privateAllow)') &&
    !flat('wake.js').includes('Array.isArray(config?.privateAllow)'),
  '还在 Array.isArray 挡着，字符串会变空',
)

console.log('\n[3] 骨架 settings.json 模板记得白名单（issue #2 最后一条）')
const settings = src('settings.js')
ok('骨架里带 privateAllow', settings.includes('"privateAllow": ["你的QQ号"]'), '模板没跟上默认值')
ok('骨架里说明了 allowlist 空着谁都不理', settings.includes('privateAllow 空着就谁都不理'))
ok('启动那条 warn 带上 settings.json 路径', flat('index.js').includes('settingsFileOf(ctx,logger)'))

console.log('\n[4] 包里有 test/，能自己跑（issue #2 最后一条）')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
ok('files 里有 test', Array.isArray(pkg.files) && pkg.files.includes('test'), JSON.stringify(pkg.files))
ok('有 scripts.test', typeof pkg.scripts?.test === 'string' && pkg.scripts.test.includes('run-all'), JSON.stringify(pkg.scripts))

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
