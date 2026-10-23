import { deriveSessionId, sessionKey } from './shared/session-id.js'

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

  /** 按 scope + peerId 拿一个可用的会话记录，必要时新建。 */
  async obtain({ scope, peerId, label }) {
    if (this.closed) throw new Error('dsh-qq 已停止')
    const key = sessionKey(this.selfId, scope, peerId)

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

    const attached = await this.#attach(sessionId)
    const record = {
      sessionId,
      key,
      scope,
      peerId,
      label,
      agent: attached.agent,
      dispose: attached.dispose,
      owned: attached.owned,
      lastActive: Date.now(),
      busy: 0,
      queue: Promise.resolve(),
      history: [],
    }
    this.#records.set(sessionId, record)
    this.#byPeer.set(key, sessionId)
    this.logger.info?.(`[dsh-qq] 会话就绪 ${label} → ${sessionId}`)
    return record
  }

  async #attach(sessionId) {
    const agentOptions = {}
    if (this.config.provider) agentOptions.provider = this.config.provider
    if (this.config.model) agentOptions.model = this.config.model

    const hasAgentOptions = Object.keys(agentOptions).length > 0

    // 1) 宿主里已经有这个 agent 在跑 → 直接借用（不算我们拥有，别 dispose）
    try {
      const live = this.agents.get?.(sessionId)
      if (live && typeof live.followup === 'function') {
        return { agent: live, dispose: null, owned: false }
      }
    } catch {
      /* get 不可用就往下走 */
    }

    // 2) 恢复持久化的历史会话
    try {
      const handle = await this.agents.resume({
        resumeSessionId: sessionId,
        ...(hasAgentOptions ? { agentOptions } : {}),
      })
      if (handle?.agent) {
        return { agent: handle.agent, dispose: () => handle.dispose(), owned: true }
      }
    } catch {
      /* 没有历史，正常分支 */
    }

    // 3) 全新会话
    const meta = {}
    if (this.config.cwd) meta.cwd = this.config.cwd
    const handle = await this.agents.create({
      sessionId,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(hasAgentOptions ? { agentOptions } : {}),
    })
    if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
    return { agent: handle.agent, dispose: () => handle.dispose(), owned: true }
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
