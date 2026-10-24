/**
 * 设置页的「配置覆盖层」——**让 dsh-qq 的设置能在 DSH 设置界面里改**。
 * ============================================================================
 * 为什么要有这一层（而不是让设置页去改 profile 的 `cordis.patch.yml`）：
 *
 *   · profile 的 patch 是**整行替换 config**，手写 YAML、注释、别的插件都在里面，
 *     一个文本框改错就把整个 profile 弄哑；
 *   · 那个文件属于「宿主配置」，插件不该去动它（权限、热重载语义都不一样）。
 *
 * 所以改成抄 dsh-bili-scroll 的做法：**插件自己的家**里放一份 `settings.json`，
 * 只存「用户改过的键」。启动时用它覆盖 cordis 注入的默认值：
 *
 *     cordis 注入的 config  ←  settings.json 里用户改过的键
 *
 * 家在 `$DSH_HOME/dsh-qq/settings.json`（拿不到 DSH_HOME 就退回 `~/.dsh`）。
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**不是字符串 —— 见 dsh-bili-scroll/lib/state.mjs
 *    那段踩坑记录（当字符串用会把函数源码拼进路径，mkdir ENOENT，插件直接不激活）。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'

/**
 * 设置页本地服务端口。
 * 插件自己拉起的「小工作台」——DSH 的 /api/dsh-qq 路由不通时，前端会自动回退到这里。
 * 只绑 127.0.0.1，外面访问不到。
 */
export const LOCAL_API_PORT = 34569

/** 能在家目录里被覆盖的键。不在名单里的一律忽略（防止设置页把结构化字段改坏）。 */
export const OVERRIDABLE = [
  // 连接
  'wsUrl',
  'accessToken',
  'selfId',
  'reconnectMs',
  // 人设 / 称呼
  'persona',
  'personaFile',
  'ownerIds',
  'ownerLabel',
  'directPrompt',
  'groupPrompt',
  // 工作区与记忆
  'workspaceRoot',
  'isolateByPeer',
  'imageCacheDir',
  // 触发与节奏
  'requireMention',
  'groupWakeMs',
  'groupReplyGapMs',
  'groupMinGapMs',
  'rateLimitPerMin',
  'historyLimit',
  'groupMode',
  'groupAllow',
  'privateMode',
  'privateAllow',
  'botChatEnabled',
  'peerBots',
  // 输出
  'textChunkLimit',
  'showToolResults',
  'splitDelayMs',
  'streamReply',
  'streamMaxChunks',
  // 语音
  'asrEnabled',
  'asrPython',
  'asrModel',
  // 其它
  'debug',
]

/**
 * 插件家目录。`ctx.get('dshHomePath')` 可能是函数也可能是字符串，两种都认。
 * @returns {string}
 */
export function homeDirOf(ctx, logger) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('dsh-qq')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'dsh-qq')
    }
  } catch (err) {
    logger?.warn?.('取 dshHomePath 失败，退回 ~/.dsh:', err?.message ?? err)
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-qq')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger?.warn?.('创建 dsh-qq 家目录失败:', err?.message ?? err)
  }
  return dir
}

export function settingsFileOf(ctx, logger) {
  return join(homeDirOf(ctx, logger), 'settings.json')
}

/** 读覆盖表；坏文件当空的，不让一个坏 JSON 把插件拖住。 */
export function loadOverrides(ctx, logger) {
  const file = settingsFileOf(ctx, logger)
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return sanitizeOverrides(raw, logger)
  } catch (err) {
    logger?.warn?.(`读 ${file} 失败，按没有覆盖处理:`, err?.message ?? err)
    return {}
  }
}

/** 只留名单里的键；顺手把 `undefined` / `null` 剔掉（null 表示「清掉这条覆盖」）。 */
export function sanitizeOverrides(input, logger) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]
    if (value === undefined) continue
    if (value === null) continue
    out[key] = value
  }
  const dropped = Object.keys(input).filter((k) => !OVERRIDABLE.includes(k))
  if (dropped.length > 0) logger?.debug?.(`设置里有不认识的键，忽略: ${dropped.join(', ')}`)
  return out
}

/** 写覆盖表（整份覆盖，不做增量合并 —— 调用方给的是最终形态）。 */
export function saveOverrides(ctx, overrides, logger) {
  const file = settingsFileOf(ctx, logger)
  const clean = sanitizeOverrides(overrides, logger)
  try {
    writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return { ok: true, file, overrides: clean }
  } catch (err) {
    logger?.warn?.('写设置失败:', err?.message ?? err)
    return { ok: false, file, error: err?.message ?? String(err) }
  }
}

/**
 * 把覆盖应用到运行中的 config 上（就地改，所有下游模块共享同一个对象）。
 * @returns {string[]} 真正写进去的键
 */
export function applyOverrides(config, overrides, logger) {
  const applied = []
  if (!config || !overrides) return applied
  for (const [key, value] of Object.entries(overrides)) {
    try {
      config[key] = value
      applied.push(key)
    } catch (err) {
      logger?.warn?.(`覆盖 ${key} 失败:`, err?.message ?? err)
    }
  }
  return applied
}

/**
 * 「人设地址」：配了 `personaFile` 就从那个文件读人设，读到了就盖掉 `persona`。
 * 读不到**不报错也不清空**——保留 `persona` 原值，只 warn 一句，免得一次手滑把角色弄没。
 * @returns {{ ok: boolean, file?: string, chars?: number, error?: string }}
 */
export function resolvePersonaFile(config, logger) {
  const raw = String(config?.personaFile ?? '').trim()
  if (!raw) return { ok: false }
  const file = resolve(raw)
  try {
    if (!existsSync(file)) throw new Error('文件不存在')
    const text = readFileSync(file, 'utf8').trim()
    if (!text) throw new Error('文件是空的')
    config.persona = text
    logger?.info?.(`人设从 ${file} 读入（${text.length} 字）`)
    return { ok: true, file, chars: text.length }
  } catch (err) {
    logger?.warn?.(`人设文件读不到（${file}），继续用 persona 字段:`, err?.message ?? err)
    return { ok: false, file, error: err?.message ?? String(err) }
  }
}

/** 给设置页看的家目录状态。 */
export function settingsInfo(ctx, logger) {
  const home = homeDirOf(ctx, logger)
  const file = join(home, 'settings.json')
  let mtime = ''
  try {
    if (existsSync(file)) mtime = statSync(file).mtime.toISOString()
  } catch {
    /* 无所谓 */
  }
  return { home, file, exists: existsSync(file), mtime }
}

/**
 * 挂上 `/api/dsh-qq/*` —— 设置页（client.js）打的就是这几个口。
 *
 * @param {object} opts
 * @param {object} opts.ctx          cordis 上下文（**父 ctx**：effect 要挂在它上面才不被提前收掉）
 * @param {object} opts.webServer    由 `ctx.inject(['webServer'], cb)` 拿到的服务实例
 * @param {object} opts.config       运行中的 config（就地读写）
 * @param {object} opts.logger
 * @param {object} [opts.client]     OneBotClient；uiOnly 模式没有
 * @param {object} [opts.manager]    SessionManager；uiOnly 模式没有
 * @param {object} opts.personaRef   `{ current: {ok,file,chars} }`，保存后刷新这里
 * @param {object} opts.overridesRef `{ current: {} }`，设置页存下来的覆盖
 * @returns {boolean} 是否挂上
 */
export function installSettingsApi({ ctx, webServer: injectedWebServer, config, logger, client, manager, personaRef, overridesRef }) {
  // 自证：这次到底有没有把路由挂上（排查「设置页 404」时不用靠猜）
  const noteApiState = (ok, detail) => {
    try {
      writeFileSync(join(homeDirOf(ctx, logger), 'api-state.txt'), `${new Date().toISOString()} ok=${ok} ${detail || ''}\n`, 'utf8')
    } catch { /* 写不了就算了，别影响注册 */ }
  }

  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (err) {
      logger?.debug?.('回 JSON 失败:', err?.message ?? err)
    }
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new Error('请求体太大（>2MB）')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** 设置页看到的「当前生效值」——只给可改的键，不把整个 config 抖出去。 */
  const snapshot = () => {
    const values = {}
    for (const key of OVERRIDABLE) {
      if (config[key] !== undefined) values[key] = config[key]
    }
    return values
  }

  const statusOf = () => {
    const info = settingsInfo(ctx, logger)
    return {
      ok: true,
      uiOnly: Boolean(config.uiOnly),
      connected: Boolean(client?.connected),
      wsUrl: config.wsUrl,
      selfId: (manager?.selfId || String(config.selfId ?? '')) || '',
      selfName: manager?.selfName || '',
      persona: {
        fromFile: Boolean(personaRef?.current?.ok),
        file: personaRef?.current?.file ?? String(config.personaFile ?? ''),
        chars: String(config.persona ?? '').length,
      },
      home: info.home,
      settingsFile: info.file,
      settingsExists: info.exists,
      overrides: Object.keys(overridesRef?.current ?? {}).length,
    }
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    // ⚠️ 宿主给 prefix 路由的 req.url 有两种形态：完整路径（/api/dsh-qq/status），
    //    或者已经被剥掉前缀的（/status）。两种都认，不然会一直 404。
    const raw = url.pathname
    const path = raw.startsWith('/api/dsh-qq')
      ? raw
      : '/api/dsh-qq' + (raw.startsWith('/') ? raw : '/' + raw)

    if (req.method === 'GET' && path === '/api/dsh-qq/status') {
      return sendJson(res, 200, statusOf())
    }

    if (req.method === 'GET' && path === '/api/dsh-qq/settings') {
      const info = settingsInfo(ctx, logger)
      return sendJson(res, 200, {
        ok: true,
        values: snapshot(),
        overrides: { ...(overridesRef?.current ?? {}) },
        meta: { ...info, personaFromFile: Boolean(personaRef?.current?.ok), overridable: OVERRIDABLE },
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/settings') {
      const body = await readJsonBody(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      if (!patch || typeof patch !== 'object') return sendJson(res, 400, { ok: false, error: '要一个对象' })

      // 值是 null = 清掉这条覆盖，回到 cordis 里的默认值
      const next = { ...(overridesRef?.current ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (!OVERRIDABLE.includes(key)) continue
        if (value === null) delete next[key]
        else next[key] = value
      }

      const saved = saveOverrides(ctx, next, logger)
      if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, file: saved.file })

      // 就地应用：下游模块拿的就是这同一个 config 对象，所以绝大多数键立刻生效
      if (overridesRef) {
        for (const key of Object.keys(overridesRef.current ?? {})) delete overridesRef.current[key]
        Object.assign(overridesRef.current, saved.overrides)
      }
      applyOverrides(config, saved.overrides, logger)
      const personaNow = resolvePersonaFile(config, logger)
      if (personaRef) personaRef.current = personaNow

      const touched = (key) => Object.prototype.hasOwnProperty.call(patch, key)
      const needReconnect = ['wsUrl', 'accessToken'].some(touched)
      const needRestart = ['reconnectMs', 'selfId', 'workspaceRoot', 'isolateByPeer', 'asrPython'].some(touched)

      return sendJson(res, 200, {
        ok: true,
        values: snapshot(),
        file: saved.file,
        persona: personaNow,
        needReconnect,
        needRestart,
      })
    }

    // 改了 wsUrl / token 之后不用重启整个宿主，把客户端重开一次就行
    if (req.method === 'POST' && path === '/api/dsh-qq/reconnect') {
      if (!client) return sendJson(res, 400, { ok: false, error: '这一份只提供设置页（uiOnly），QQ 连接在另一个进程里；去那边重启' })
      try {
        client.stop()
        client.url = config.wsUrl
        client.token = config.accessToken
        client.start()
        return sendJson(res, 200, { ok: true, wsUrl: client.url })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  // 统一的请求处理体：两条路（DSH 路由 / 本地服务）共用同一份逻辑。
  const routeHandler = async (req, res) => {
    try {
      await handleApi(req, res)
    } catch (err) {
      logger?.warn?.('设置页接口出错:', err?.message ?? err)
      sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
    }
  }

  let mounted = false

  // ── 路 1：DSH 自带的 webServer ───────────────────────────────────────────
  // 能挂就挂（同源、免 CORS，最好用）。挂了但请求 404 也不影响下面那条兜底。
  if (injectedWebServer) {
    try {
      ctx.effect(
        () =>
          injectedWebServer.register({
            kind: 'prefix',
            path: '/api/dsh-qq',
            handler: routeHandler,
          }),
        'dsh-qq: /api/dsh-qq 设置页接口',
      )
      mounted = true
    } catch (err) {
      logger?.warn?.('DSH 路由没挂上（还有本地服务兜底）:', err?.message ?? err)
    }
  }

  // ── 路 2：插件自己的本地小服务（2026-10-24 加的兜底）─────────────────────
  // 为什么要有它：DSH 那边的路由实测会「register 成功、请求却 404」，
  // 调了两轮都没绕过去。插件自己监听 127.0.0.1 就完全不依赖宿主内部机制，
  // 这也是官方教程里说的插件形态（「插件在本地拉起一个 web 工作台」）。
  // 只绑 127.0.0.1，外面访问不到；CORS 放开是给 DSH 页面里的 client 用。
  try {
    const local = createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      await routeHandler(req, res)
    })
    local.on('error', (err) => {
      logger?.warn?.(`本地设置服务起不来（端口 ${LOCAL_API_PORT}）: ${err?.message ?? err}`)
    })
    local.listen(LOCAL_API_PORT, '127.0.0.1', () => {
      logger?.info?.(`设置页本地服务: http://127.0.0.1:${LOCAL_API_PORT}/api/dsh-qq`)
    })
    ctx.effect(
      () => () => {
        try {
          local.close()
        } catch {
          /* 收摊 */
        }
      },
      'dsh-qq: 本地设置服务',
    )
    mounted = true
  } catch (err) {
    logger?.warn?.('本地设置服务没起来:', err?.message ?? err)
  }

  noteApiState(
    mounted,
    `${injectedWebServer ? 'DSH 路由已尝试' : '没有 DSH 路由'} + 本地服务 ${LOCAL_API_PORT}`,
  )
  return mounted
}
