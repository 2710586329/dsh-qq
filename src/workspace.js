import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 每个 QQ 会话（私聊 / 群）各自的独立工作目录。
 *
 * 为什么要有这一层：Agent 的记忆区如果是全局的，一个群里几百个人的闲聊会
 * 全部沉淀进同一份日记，既脏又互相串；而宿主自己的私人记忆区更不该被 QQ
 * 消息写进去。所以每个 peer 一个目录，插件首次用到时把 AGENTS.md 与
 * 记忆区骨架铺好，之后这个会话就活在自己那一小块地里。
 */

/** 目录名：私聊_QQ号 / 群_群号。 */
export function peerDirName(scope, peerId) {
  const kind = scope === 'group' ? '群' : '私聊'
  // peerId 是 QQ 号 / 群号，理论上纯数字，兜底把斜杠之类换掉
  const safe = String(peerId ?? 'unknown').replace(/[\\/:*?"<>|]/g, '_')
  return `${kind}_${safe}`
}

/**
 * 算出某个会话该用哪个工作目录。
 * @returns {string|null} null 表示不隔离，沿用宿主的 cwd
 */
export function resolvePeerWorkspace(config, scope, peerId) {
  if (!config || config.isolateByPeer === false) return null
  const root =
    String(config.workspaceRoot ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '会话')
  return join(root, peerDirName(scope, peerId))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function agentsTemplate({ scope, peerId, label }) {
  // label 形如「私聊 昵称(QQ号)」/「群 群号」，本身就是给人看的一句话，直接用
  const who = String(label || '').trim() || (scope === 'group' ? `群 ${peerId}` : `私聊 ${peerId}`)
  return `# 这个会话的工作目录

这里是 **${who}** 自己的目录，只属于这一段对话。别的 QQ 会话有它们自己的目录，
彼此不共享文件，也不要去翻别人的。

## 记忆区

- 根目录：\`./记忆区/\`
- 日记：\`./记忆区/日记/YYYY-MM-DD-HH-mm.md\`（每 2 小时一档，写满了按分钟开新档）
- 大纲与索引：\`./记忆区/大纲/索引.md\`
- 项目：\`./记忆区/项目/<项目名>/\`

### 记忆规矩

1. 重要的事做完就写进日记：第一视角，写具体——时间、涉及的文件名、做了什么、结论是什么。
2. 写之前先看 \`记忆区/大纲/索引.md\` 和最近两三篇日记；细节记不清就回日记原文里查，不要凭印象编。
3. 记忆区只属于这个会话。不要读写别的会话目录，也不要往宿主自己的记忆区里写东西。
4. 如果记忆根目录读不到（路径不存在或被拒绝），先停下告诉主人「记忆区路径异常」，等确认后再写；
   不要自己另建目录、也不要换一种格式另写。

## 其它

- 收到的图片、语音、文件默认落在本目录下（\`图片缓存/\` 等）。
- 表情包收藏在 \`./表情包收藏.json\`，用 \`qq_mface\` 工具发。
`
}

/**
 * 确保会话目录与记忆区骨架存在。已存在就不覆盖（主人可能自己改过 AGENTS.md）。
 * @returns {Promise<string>} 目录路径
 */
export async function ensurePeerWorkspace(dir, info) {
  await mkdir(join(dir, '记忆区', '日记'), { recursive: true })
  await mkdir(join(dir, '记忆区', '项目'), { recursive: true })
  await mkdir(join(dir, '记忆区', '大纲'), { recursive: true })
  await mkdir(join(dir, '记忆区', '收藏'), { recursive: true })
  await mkdir(join(dir, '记忆区', '压缩记忆'), { recursive: true })

  const agentsPath = join(dir, 'AGENTS.md')
  if (!(await exists(agentsPath))) {
    await writeFile(agentsPath, agentsTemplate(info), 'utf8')
  }

  const indexPath = join(dir, '记忆区', '大纲', '索引.md')
  if (!(await exists(indexPath))) {
    await writeFile(
      indexPath,
      `# 索引\n\n> 本会话的记忆索引。每写一篇日记或一条项目记录，就在这里加一行。\n\n## 日记\n\n（还没有）\n\n## 项目\n\n（还没有）\n`,
      'utf8',
    )
  }
  return dir
}
