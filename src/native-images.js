/**
 * 把 QQ 图片变成「模型真能看见的图」。
 *
 * 2026-11-17 移植（issue #10）：原来插件只是把图片下载到本地、把路径塞进正文，
 * 让 agent 自己用 `read_image` 去看——可插件创建的会话里根本没有这支工具
 * （工具面是宿主给的 31 个里没有它），于是 agent 永远只能说「图是黑的」。
 *
 * 现在改成走宿主原生多模态附件接口：
 *   `ctx.inject(['attachments'], sub => sub.attachments)`
 *   → `saveImages([{ data, mediaType }])` 落成附件
 *   → `admitPromptContent(blocks)` 做准入校验（数量 / 大小 / 格式）
 * 图片作为 `{ type: 'image', attachment }` 内容块直接进这一轮的用户消息，
 * 和文字保持原来的先后顺序。
 *
 * 这段移植自社区补丁 https://github.com/ouo-77/dsh-qq-vision-fix （MIT），
 * 按我们自己的注释口径重写了一遍；白名单和体积上限比原版更保守：只认 QQ 自己的
 * 几个 CDN 域名、只认 PNG/JPEG/GIF/WEBP，别让别的地址借这条路把文件塞进模型。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 只信这几个域名的 https 图片：QQ 自己发图的落点。 */
const QQ_CDNS = new Set([
  'gchat.qpic.cn',
  'c2cpicdw.qpic.cn',
  'multimedia.nt.qq.com.cn',
  'gchatpic_new.qq.com',
])

/** base64:// 或 https:// 两种来源 → Buffer，顺手卡大小。 */
async function imageBytes(source, limit) {
  if (typeof source !== 'string') throw Error('图片来源无效')
  if (source.startsWith('base64://')) {
    const encoded = source.slice(9)
    if (encoded.length > Math.ceil(limit / 3) * 4) throw Error('图片超出大小限制')
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length || bytes.toString('base64') !== encoded) throw Error('图片 base64 编码损坏')
    if (bytes.length > limit) throw Error('图片超出大小限制')
    return bytes
  }
  let url
  try {
    url = new URL(source)
  } catch {
    throw Error('缺少受信任的 QQ 图片地址')
  }
  if (url.protocol !== 'https:' || !QQ_CDNS.has(url.hostname) || url.port || url.username || url.password) {
    throw Error('图片来源不在 QQ CDN 白名单内')
  }
  const controller = new AbortController()
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
    if (!response.ok || !response.body) throw Error('QQ CDN 下载失败')
    if (Number(response.headers.get('content-length')) > limit) throw Error('图片超出大小限制')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > limit) throw Error('图片超出大小限制')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally {
    controller.abort()
  }
}

/** 认文件头，别信扩展名（QQ 的 url 后缀经常和真实格式对不上）。 */
function imageType(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpeg'
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  throw Error('格式不支持或图片已损坏')
}

/**
 * 宿主的 imageLimits 是这几个上限的权威来源，但别假设它一定在——
 * 老版本或别的宿主形态下会整个缺掉，那时用保守的默认值，而不是在这儿崩。
 */
function limitsOf(store) {
  const l = store?.imageLimits ?? {}
  return {
    maxImagesPerMessage: Number(l.maxImagesPerMessage) || 4,
    maxImageBytes: Number(l.maxImageBytes) || 8 * 1048576,
    maxMessageImageBytes: Number(l.maxMessageImageBytes) || 16 * 1048576,
  }
}

/**
 * 下载 + 存进宿主附件库 + 顺手在本地缓存目录留一份。
 * @param {string[]} sources  QQ 图片地址（最多取 4 张）
 * @param {object} store      宿主 attachments 服务
 * @param {string} dir        本地图片缓存目录
 * @param {number} maxMB      单张上限（MB）
 * @returns {Promise<Array<{type:'image', attachment:any, encodedBytes:number}>>}
 */
export async function loadImages(sources, store, dir, maxMB) {
  if (!store?.saveImages) throw Error('DSH 图片附件服务不可用')
  const limits = limitsOf(store)
  if (sources.length > Math.min(4, limits.maxImagesPerMessage)) throw Error('图片数量超限')
  const limit = Math.min(Math.max(1, maxMB) * 1048576, 8 * 1048576, limits.maxImageBytes)
  const inputs = []
  let total = 0
  for (const source of sources) {
    const data = await imageBytes(source, limit)
    total += data.length
    if (total > limits.maxMessageImageBytes) throw Error('图片总大小超限')
    inputs.push({ data, mediaType: `image/${imageType(data)}` })
  }
  const refs = await store.saveImages(inputs).catch(() => {
    throw Error('DSH 校验或保存图片失败')
  })
  await mkdir(dir, { recursive: true })
  for (const { data, mediaType } of inputs) {
    await writeFile(join(dir, `qq-${randomUUID()}.${mediaType.slice(6)}`), data, { flag: 'wx' })
  }
  return refs.map((attachment, i) => ({ type: 'image', attachment, encodedBytes: inputs[i].data.length }))
}

/**
 * 同 loadImages，但图片已经在盘上了——「到达那一刻」先下过一份的复用这条路，
 * 别为了投递再下一遍网络。
 */
export async function loadImagesFromPaths(paths, store, dir, maxMB) {
  if (!store?.saveImages) throw Error('DSH 图片附件服务不可用')
  const limits = limitsOf(store)
  if (paths.length > Math.min(4, limits.maxImagesPerMessage)) throw Error('图片数量超限')
  const limit = Math.min(Math.max(1, maxMB) * 1048576, 8 * 1048576, limits.maxImageBytes)
  const inputs = []
  let total = 0
  for (const p of paths) {
    const data = await readFile(p)
    if (data.length > limit) throw Error('图片超出大小限制')
    total += data.length
    if (total > limits.maxMessageImageBytes) throw Error('图片总大小超限')
    inputs.push({ data, mediaType: `image/${imageType(data)}` })
  }
  const refs = await store.saveImages(inputs).catch(() => {
    throw Error('DSH 校验或保存图片失败')
  })
  return refs.map((attachment, i) => ({ type: 'image', attachment, encodedBytes: inputs[i].data.length }))
}

/**
 * 把「字符串 / 内容块数组」混在一起的 parts 拼成一份 content 数组。
 * 相邻文本块会被并起来（中间补分隔符），避免几十个小块碎在提示里；
 * 图片块两侧不塞分隔符——否则文字末尾会多出一个空行。
 */
export function joinContent(parts, separator = '\n') {
  const flat = []
  for (const part of parts) {
    if (typeof part === 'string') flat.push({ type: 'text', text: part })
    else for (const block of part) flat.push(block)
  }
  const blocks = []
  for (const block of flat) {
    const last = blocks.at(-1)
    if (block.type === 'text' && last?.type === 'text') last.text += separator + block.text
    else blocks.push({ ...block })
  }
  return blocks
}
