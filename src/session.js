import { deriveSessionId, sessionKey } from './shared/session-id.js'
import { ensurePeerWorkspace, resolvePeerWorkspace } from './workspace.js'

/**
 * 一个 QQ 会话（私聊 or 群）对应一个 DSH Agent。
 *
 * 生命周期：
 *   obtain()  → 内存命中 → 宿主里活着的 → resume 历史 → create 新建
 *   闲置超过 sessionIdleTimeout 且没有在跑的 turn → dispose + 清表
 *
 * 注意：`ctx.agents.create({ meta })` 的 meta 是**会持久化并被校验**的字段，
 * 只认 cwd / parentSession / seedLength / origin / delegationDepth / agentPreset，
 * 塞自定义键会被 session 边界拒绝，所以这里不往里放业务字段。
 */
export class SessionManager {
  #records = new Map() // sessionId -> record
  #byPeer = new Map() // peerKey -> sessionId
  #gens = new Map() // basePeerKey -> 代数（/reset 一次 +1，换一个全新 sessionId）
  #ready = new Map() // 已铺好的会话目录（避免每次 attach 都 mkdir）
  #sweeper = null

  constructor({ agents, selfId, config, logger }) {
    this.agents = agents
    this.selfId = selfId
    this.config = config
    this.logger = logger
    this.closed = false
  }

  get size() {
    return this.#records.size
  }

  start() {
    this.closed = false
    this.#sweeper = setInterval(() => this.#sweep(), 60_000)
    this.#sweeper.unref?.()
    return this
  }

  stop() {
    this.closed = true
    if (this.#sweeper) clearInterval(this.#sweeper)
    this.#sweeper = null
    for (const record of this.#records.values()) {
      if (!record.owned) continue
      try {
        Promise.resolve(record.dispose?.()).catch(() => {})
      } catch (err) {
        this.logger.warn?.('[dsh-qq] 释放会话失败:', err)
      }
    }
    this.#records.clear()
    this.#byPeer.clear()
  }

  find(sessionId) {
    return this.#records.get(sessionId) ?? null
  }

  /**
   * 按 Agent 实例反查记录。
   * `user-questions/request` 的 waterfall 里给的就是 Agent 实例，拿不到可靠的 sessionId 时靠它认人。
   */
  findByAgent(agent) {
    if (!agent) return null
    for (const record of this.#records.values()) {
      if (record.agent === agent) return record
    }
    return null
  }

  /** 按 scope + peerId 找到记录（不算新建）。 */
  findByPeer(scope, peerId) {
    const baseKey = this.#baseKey(scope, peerId)
    const id = this.#byPeer.get(baseKey) ?? this.#byPeer.get(`${baseKey}#${this.#gens.get(baseKey) ?? 0}`)
    return id ? (this.#records.get(id) ?? null) : null
  }

  /**
   * 会话键。开了目录隔离就在结尾加 `@iso`：老会话（当年用公共 cwd 建的）从此不再命中，
   * 保证「一隔离就一定落到自己的目录」，而且换成重启也不会退回老会话去。
   */
  #baseKey(scope, peerId) {
    const key = sessionKey(this.selfId, scope, peerId)
    const isolated = resolvePeerWorkspace(this.config, scope, peerId) !== null
    return isolated ? `${key}@iso` : key
  }

  /**
   * 重置一个 QQ 会话：扔掉当前代理与上下文，下一次消息会开一个全新的会话。
   * 历史记录留在磁盘上但不再被 resume（换了 sessionId）。
   */
  reset(record) {
    const current = this.#records.get(record.sessionId)
    if (!current) return false
    const baseKey = this.#baseKey(current.scope, current.peerId)
    this.#gens.set(baseKey, (this.#gens.get(baseKey) ?? 0) + 1)
    if (current.owned && current.dispose) {
      try {
        Promise.resolve(current.dispose()).catch(() => {})
      } catch {
        /* ignore */
      }
    }
    this.#records.delete(current.sessionId)
    if (this.#byPeer.get(current.key) === current.sessionId) this.#byPeer.delete(current.key)
    this.logger.info?.(`[dsh-qq] 重置会话 ${current.label}（gen → ${this.#gens.get(baseKey) ?? 0}）`)
    return true
  }

  /** 按 scope + peerId 拿一个可用的会话记录，必要时新建。 */
  async obtain({ scope, peerId, label }) {
    if (this.closed) throw new Error('dsh-qq 已停止')
    const baseKey = this.#baseKey(scope, peerId)
    const gen = this.#gens.get(baseKey) ?? 0
    // 第 0 代用原来的 key（保持跟已有历史对齐），之后每 /reset 一次换一个 key
    const key = gen > 0 ? `${baseKey}#${gen}` : baseKey

    const existingId = this.#byPeer.get(key)
    if (existingId) {
      const hit = this.#records.get(existingId)
      if (hit) {
        hit.lastActive = Date.now()
        return hit
      }
      this.#byPeer.delete(key)
    }

    const sessionId = deriveSessionId(key)
    const cached = this.#records.get(sessionId)
    if (cached) {
      cached.lastActive = Date.now()
      return cached
    }

    const attached = await this.#attach(sessionId, { scope, peerId, label })
    const record = {
      sessionId,
      key,
      scope,
      peerId,
      label,
      agent: attached.agent,
      dispose: attached.dispose,
      owned: attached.owned,
      dir: attached.cwd ?? null,
      lastActive: Date.now(),
      busy: 0,
      queue: Promise.resolve(),
      history: [],
      recent: [],
      swapSeed: null,
      chatPromptInjected: false,
    }
    this.#records.set(sessionId, record)
    this.#byPeer.set(key, sessionId)
    this.logger.info?.(`[dsh-qq] 会话就绪 ${label} → ${sessionId}`)
    return record
  }

  /**
   * 这个会话自己的目录。_isolateByPeer_ 关掉时返回 null（沿用宿主 cwd）。
   * 首次用到时把 AGENTS.md 与记忆区骨架铺好。
   */
  async #peerDir(info) {
    const dir = resolvePeerWorkspace(this.config, info.scope, info.peerId)
    if (!dir) return null
    if (this.#ready.get(dir)) return dir
    try {
      await ensurePeerWorkspace(dir, info)
      this.#ready.set(dir, true)
    } catch (err) {
      // 铺不出来就不要把会话钉死在半成品目录上，退回宿主 cwd
      this.logger.warn?.(`[dsh-qq] 初始化会话目录失败 ${dir}:`, err)
      return null
    }
    return dir
  }

  async #attach(sessionId, info) {
    const agentOptions = {}
    if (this.config.provider) agentOptions.provider = this.config.provider
    if (this.config.model) agentOptions.model = this.config.model

    const hasAgentOptions = Object.keys(agentOptions).length > 0
    const cwd = await this.#peerDir(info)
    this.logger.debug?.(
      `[dsh-qq] attach ${sessionId.slice(0, 8)} scope=${info.scope} peer=${info.peerId} cwd=${cwd ?? '(null)'}`,
    )

    // 1) 宿主里已经有这个 agent 在跑 → 直接借用（不算我们拥有，别 dispose）
    try {
      const live = this.agents.get?.(sessionId)
      if (live && typeof live.followup === 'function') {
        return { agent: live, dispose: null, owned: false, cwd }
      }
    } catch {
      /* get 不可用就往下走 */
    }

    // 2) 恢复持久化的历史会话
    try {
      const handle = await this.agents.resume({
        resumeSessionId: sessionId,
        ...(hasAgentOptions ? { agentOptions } : {}),
        ...(cwd ? { meta: { cwd } } : {}),
      })
      if (handle?.agent) {
        this.logger.debug?.(`[dsh-qq] resume 命中 ${sessionId.slice(0, 8)}`)
        return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd }
      }
    } catch (err) {
      // ⚠️ 带 meta 的 resume 若被宿主拒绝，退回不带 meta 的老调用（历史会话照旧能起来，
      // 只是工作目录还是它当年那个 —— 发一句 /reset 就会落到新目录）
      if (cwd) {
        try {
          const handle = await this.agents.resume({
            resumeSessionId: sessionId,
            ...(hasAgentOptions ? { agentOptions } : {}),
          })
          if (handle?.agent) {
            this.logger.warn?.(
              `[dsh-qq] 历史会话 ${sessionId} 沿用旧工作目录，发 /reset 可切到 ${cwd}（原因：${err?.message ?? err}）`,
            )
            return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd }
          }
        } catch {
          /* 没有历史，正常分支 */
        }
      }
    }

    // 3) 全新会话
    const meta = {}
    const workdir = cwd || this.config.cwd
    if (workdir) meta.cwd = workdir
    this.logger.debug?.(`[dsh-qq] create ${sessionId.slice(0, 8)} cwd=${workdir ?? '(null)'}`)
    const handle = await this.agents.create({
      sessionId,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(hasAgentOptions ? { agentOptions } : {}),
    })
    if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
    return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd: workdir || null }
  }

  #sweep() {
    const ttl = Number(this.config.sessionIdleTimeout) || 1_800_000
    const now = Date.now()
    for (const [sessionId, record] of this.#records) {
      if (record.busy > 0) continue
      if (now - record.lastActive <= ttl) continue
      if (record.owned && record.dispose) {
        try {
          Promise.resolve(record.dispose()).catch(() => {})
        } catch (err) {
          this.logger.warn?.('[dsh-qq] 回收会话失败:', err)
        }
      }
      this.#records.delete(sessionId)
      if (this.#byPeer.get(record.key) === sessionId) this.#byPeer.delete(record.key)
      this.logger.info?.(`[dsh-qq] 回收闲置会话 ${record.label}`)
    }
  }

  /** 串行化同一个会话里的处理，避免两次 followup 撞在一起。 */
  enqueue(record, task) {
    const run = record.queue.then(async () => {
      record.busy += 1
      record.lastActive = Date.now()
      try {
        return await task()
      } finally {
        record.busy -= 1
        record.lastActive = Date.now()
      }
    })
    // 吞掉链上的异常，避免污染后续任务
    record.queue = run.catch(() => {})
    return run
  }
}
