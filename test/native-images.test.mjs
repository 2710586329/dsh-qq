import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { joinContent, loadImages, loadImagesFromPaths } from '../src/native-images.js'

/**
 * 2026-11-17 issue #10 的落地测试。
 *
 * 病：插件创建的会话里没有 `read_image`（宿主给的 31 支工具里没它），
 * 所以「把图片下载到本地、把路径塞进正文」这条路对它等于不存在——
 * 它永远只能说「图是黑的」。改法是走宿主原生多模态附件：
 * `saveImages` + `admitPromptContent`，图作为内容块直接进这一轮的用户消息。
 *
 * 这份 fixture 钉四件事：
 *   ① 混排的 parts 拼成 content 时，顺序不乱、相邻文字合并
 *   ② 只认 QQ 自己的 CDN，别的地址不能借这条路把文件塞进模型
 *   ③ 数量 / 体积 / 格式三道闸都在，且报错说的是人话
 *   ④ 盘上已有的图（到达时先下过的那份）能复用，不用再下第二遍网络
 */

/** 一张「够用」的 PNG：只要求文件头正确——宿主那边的真解码由 saveImages 负责。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108', 'hex')

function mockStore(overrides = {}) {
  const saved = []
  return {
    saved,
    imageLimits: {
      maxImagesPerMessage: 4,
      maxImageBytes: 8 * 1048576,
      maxMessageImageBytes: 32 * 1048576,
    },
    async saveImages(inputs) {
      saved.push(...inputs)
      return inputs.map((_, i) => ({ id: `att-${saved.length}-${i}` }))
    },
    ...overrides,
  }
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dshqq-img-'))
}

test('joinContent：文字和图片块按原顺序拼，相邻文字并起来', () => {
  const img = { type: 'image', attachment: { id: 'a1' }, encodedBytes: 12 }
  const out = joinContent(['第一句', '第二句', [img], '第三句'])
  assert.deepEqual(
    out.map((b) => b.type),
    ['text', 'image', 'text'],
  )
  assert.equal(out[0].text, '第一句\n第二句') // 相邻文字合并
  assert.equal(out[2].text, '第三句')
  assert.equal(out[1].attachment.id, 'a1')
})

test('joinContent：自定义分隔符 / 空数组 / 纯文字', () => {
  assert.equal(joinContent(['a', 'b'], '\n\n')[0].text, 'a\n\nb')
  assert.deepEqual(joinContent([[]]), [])
  assert.deepEqual(joinContent(['只有一句']), [{ type: 'text', text: '只有一句' }])
})

test('loadImages：base64 来源能变成图片块，并在本地留一份', async () => {
  const dir = await tempDir()
  const store = mockStore()
  const blocks = await loadImages([`base64://${PNG.toString('base64')}`], store, dir, 8)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'image')
  assert.equal(blocks[0].encodedBytes, PNG.length)
  assert.equal(store.saved[0].mediaType, 'image/png')
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^qq-[0-9a-f-]+\.png$/)
})

test('loadImages：不在 QQ CDN 白名单的地址一律拒绝', async () => {
  const dir = await tempDir()
  const store = mockStore()
  const bad = [
    'https://example.com/a.png',
    'http://gchat.qpic.cn/a.png', // 不是 https
    'https://gchat.qpic.cn:8443/a.png', // 带端口
    'https://user:pw@gchat.qpic.cn/a.png', // 带凭据
    'file:///etc/passwd',
    'not-even-a-url',
  ]
  for (const source of bad) {
    await assert.rejects(() => loadImages([source], store, dir, 8), /白名单|图片地址|图片来源无效|受信任/)
  }
})

test('loadImages：数量、体积、格式三道闸', async () => {
  const dir = await tempDir()
  const one = `base64://${PNG.toString('base64')}`

  // 数量：宿主上限 4，给 5 张就拦
  await assert.rejects(() => loadImages([one, one, one, one, one], mockStore(), dir, 8), /数量超限/)

  // 体积：store 把单张上限压到 8 字节（比这张 PNG 还小）
  const tiny = mockStore({ imageLimits: { maxImagesPerMessage: 4, maxImageBytes: 8, maxMessageImageBytes: 32 } })
  await assert.rejects(() => loadImages([one], tiny, dir, 8), /大小限制/)

  // 格式：不是图片的字节
  const notImage = `base64://${Buffer.from('hello world, not an image').toString('base64')}`
  await assert.rejects(() => loadImages([notImage], mockStore(), dir, 8), /格式不支持/)
})

test('loadImages：base64 坏掉、宿主存不下，各自报清楚', async () => {
  const dir = await tempDir()
  await assert.rejects(() => loadImages(['base64://@@@'], mockStore(), dir, 8), /编码损坏|大小限制/)

  const broken = mockStore({ async saveImages() { throw Error('boom') } })
  await assert.rejects(() => loadImages([`base64://${PNG.toString('base64')}`], broken, dir, 8), /保存图片失败/)

  // 宿主没有附件服务：这是最常见的一种（版本对不上），得说人话
  await assert.rejects(() => loadImages([`base64://${PNG.toString('base64')}`], {}, dir, 8), /附件服务不可用/)
})

test('loadImages：宿主不给 imageLimits 时用保守默认值，不崩', async () => {
  const dir = await tempDir()
  const store = mockStore()
  delete store.imageLimits
  const blocks = await loadImages([`base64://${PNG.toString('base64')}`], store, dir, 8)
  assert.equal(blocks.length, 1)
})

test('loadImagesFromPaths：盘上已有的图直接复用，不再下一次网络', async () => {
  const dir = await tempDir()
  const file = join(dir, 'arrived.png')
  await writeFile(file, PNG)

  const store = mockStore()
  const blocks = await loadImagesFromPaths([file], store, dir, 8)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'image')
  assert.equal(store.saved.length, 1)

  // 坏文件 / 不是图片
  const junk = join(dir, 'junk.png')
  await writeFile(junk, 'not an image at all')
  await assert.rejects(() => loadImagesFromPaths([junk], mockStore(), dir, 8), /格式不支持/)

  // 数量同样拦
  await assert.rejects(
    () => loadImagesFromPaths([file, file, file, file, file], mockStore(), dir, 8),
    /数量超限/,
  )
})
