/**
 * 表情包收藏夹。
 *
 * 两种条目：
 *  - `mface`：QQ 商城表情，靠 `emoji_id` + `emoji_package_id` 这一对身份证重发
 *  - `image`：一张本地图片（主人扔过来的表情包），靠文件路径重发
 *
 * 为什么需要它：发商城表情必须同时给出 id，而 Agent 手上没有这份清单 ——
 * 它连「有哪些表情可发」都不知道，只能干瞪眼。所以在收到别人发表情包时，
 * 顺手把身份证记下来存盘；以后 `qq_mface` 不传 id 就从收藏里随机挑一个发。
 *
 * ⚠️ 收藏是有门槛的（主人定的）：只收「鲸鱼娘 / AI 娘化」这类表情包，
 * 因为群里什么图都存会变成一个垃圾场。图片条目由 Agent 判断后主动调用
 * `qq_keep_face` 才进来，插件自己不自动保存图片。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_KEEP = 200

/**
 * 收藏文件：放在会话根目录（workspaceRoot）下，所有 QQ 会话共享一份。
 * 表情包是主人攒的资产，不该跟着某一次私聊一起过期。
 */
export function facesPath(config) {
  const base =
    String(config?.workspaceRoot ?? '').trim() ||
    String(config?.cwd ?? '').trim() ||
    process.cwd()
  return join(base, '表情包收藏.json')
}

function load(config) {
  const file = facesPath(config)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function save(config, list) {
  const file = facesPath(config)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(list.slice(-MAX_KEEP), null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** mface 的稳定去重键 */
function mfaceKey(f) {
  return `m:${f.packageId}/${f.emojiId}`
}

/** image 的稳定去重键（按路径） */
function imageKey(f) {
  return `i:${f.path}`
}

/**
 * 收到商城表情时调用：把能用的 id 记下来。
 * 缺 emojiId 或 packageId 的一律丢弃 —— 存着也发不出去。
 * @returns {number} 这次新增了几条
 */
export function rememberFaces(config, mfacesLog) {
  if (!Array.isArray(mfacesLog) || mfacesLog.length === 0) return 0
  const usable = mfacesLog.filter((f) => f?.emojiId && f?.packageId)
  if (usable.length === 0) return 0

  const list = load(config)
  const seen = new Set(list.map((f) => (f.kind === 'image' ? imageKey(f) : mfaceKey(f))))
  let added = 0
  for (const f of usable) {
    const entry = {
      kind: 'mface',
      emojiId: String(f.emojiId),
      packageId: String(f.packageId),
      key: String(f.key ?? ''),
      summary: String(f.summary ?? ''),
      at: new Date().toISOString(),
    }
    const k = mfaceKey(entry)
    if (seen.has(k)) continue
    seen.add(k)
    list.push(entry)
    added += 1
  }
  if (added > 0) save(config, list)
  return added
}

/**
 * 把一张本地图片收进收藏（Agent 判断是鲸鱼娘/AI 娘化表情包后主动调用）。
 * @param {{ path: string, summary?: string }} input
 * @returns {{ ok: boolean, added: boolean, total: number, reason?: string }}
 */
export function keepFace(config, input) {
  const file = String(input?.path ?? '').trim()
  if (!file) return { ok: false, added: false, total: facesCount(config), reason: 'path 是空的' }
  if (!existsSync(file)) return { ok: false, added: false, total: facesCount(config), reason: `文件不存在：${file}` }

  const list = load(config)
  const entry = {
    kind: 'image',
    path: file,
    summary: String(input?.summary ?? '').trim(),
    at: new Date().toISOString(),
  }
  const k = imageKey(entry)
  if (list.some((f) => f.kind === 'image' && imageKey(f) === k)) {
    return { ok: true, added: false, total: list.length }
  }
  if (list.length >= MAX_KEEP) list.shift()
  list.push(entry)
  const saved = save(config, list)
  return { ok: saved, added: saved, total: saved ? list.length : list.length - 1, reason: saved ? undefined : '写盘失败' }
}

/** 随机挑一个收藏的表情；带 summary 时优先挑匹配的。 */
export function pickFace(config, summary) {
  const list = load(config)
  if (list.length === 0) return undefined
  const wanted = String(summary ?? '').trim()
  if (wanted) {
    const hit = list.find((f) => f.summary && f.summary.includes(wanted))
    if (hit) return hit
  }
  return list[Math.floor(Math.random() * list.length)]
}

/** 列出收藏（给工具描述/命令用）。 */
export function listFaces(config, limit = 30) {
  return load(config).slice(-limit)
}

export function facesCount(config) {
  return load(config).length
}
