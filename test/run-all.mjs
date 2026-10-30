#!/usr/bin/env node
/**
 * 把 test/ 下的 *.test.mjs 逐个跑一遍。`npm test` 走的就是这里。
 *
 * 为什么不用 `node --test`：它按进程池并发起子进程，在某些 Windows 环境（文件沙箱、
 * 部分杀软、限制子进程的容器）会直接 `spawn EPERM`，一个都跑不起来，报错还看不出
 * 是哪个测试的问题。逐个 `node <file>` 慢一些但稳，失败时能直接点名到文件。
 *
 * 判定「过」的两条：
 *   1. 退出码是 0（用 node:test / 自己 process.exit 的那批）
 *   2. 输出里没有 `失败 N`（N > 0）——手写断言的那批只打印「通过 N，失败 0」，不一定设退出码
 *
 * 用法：
 *   node test/run-all.mjs            全部
 *   node test/run-all.mjs wake       只跑文件名含 wake 的
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const filter = process.argv[2] ?? ''

const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs') && f.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(`test/ 下没有匹配 "${filter}" 的 *.test.mjs`)
  process.exit(1)
}

const failed = []
for (const file of files) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(here, file)], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const ms = Date.now() - t0
  process.stdout.write(out.endsWith('\n') || out === '' ? out : `${out}\n`)

  // spawn 失败（文件沙箱、杀软、限制子进程的容器）和测试失败要分开报：
  // 前者是环境问题，一个测试都没跑；后者才是代码问题。
  if (r.error) {
    failed.push(file)
    console.log(`✘ ${file}  —— 起不了子进程：${r.error.code ?? r.error.message}，${ms}ms`)
    continue
  }

  const bad = r.status !== 0 || /失败\s*[1-9]\d*/.test(out)
  if (bad) {
    failed.push(file)
    console.log(`✘ ${file}  —— 退出码 ${r.status ?? r.signal}，${ms}ms`)
  } else {
    console.log(`✔ ${file}  —— ${ms}ms\n`)
  }
}

const ok = files.length - failed.length
console.log('─'.repeat(60))
console.log(`文件 ${files.length} 个：通过 ${ok}，失败 ${failed.length}`)
if (failed.length) {
  console.log(`失败的是：\n  ${failed.join('\n  ')}`)
  process.exit(1)
}
