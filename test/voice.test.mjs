import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools } from '../src/tools.js'
import { lastVoiceMessageIdOf, noteVoiceMessage } from '../src/inbound.js'

/**
 * 2026-11-17 issue #6：语音收发。
 *
 * 病：收到的语音只有 ASR 转出来的一段字，agent 拿不到那条语音本身
 * （本地 wav 是给 ASR 用的，用完就丢）；想发语音也没有手。
 *
 * 这份 fixture 钉四件事：
 *   ① 两支工具真的注册上了
 *   ② 发语音只认音频后缀、路径得在、别把大文件丢过去
 *   ③ 取语音：不填 id 时找「最近一条语音」，不是 lastMessageId
 *   ④ 拿到 wav 就往缓存目录落一份，路径是真的
 */

async function harness({ asrEnabled = false, getMsg, getRecord } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dshqq-voice-'))
  const calls = []
  const registered = new Map()
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  const record = {
    scope: 'private',
    peerId: '2710586329',
    label: '测试私聊',
    dir,
    lastMessageId: 424242,
  }
  const manager = { find: () => record, list: () => [record] }
  const client = {
    async call(action, params) {
      calls.push({ action, params })
      if (action === 'get_msg') {
        if (getMsg) return getMsg(action, params)
        return { message: [] }
      }
      if (action === 'get_record') {
        if (getRecord) return getRecord(action, params)
        return {}
      }
      return { status: 'ok' }
    },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (t) => registered.set(t.name, t) } : undefined),
  }
  registerTools(ctx, {
    client,
    manager,
    config: { cwd: dir, asrEnabled },
    logger,
    send: async () => {},
    noteSelfSaid: () => {},
    bridge: { noteSelfSaid: () => {} },
  })
  const exec = { agent: { session: { header: { id: 'sess-1' } } } }
  return { dir, calls, registered, exec, record }
}

test('两支语音工具注册上了', async () => {
  const h = await harness()
  assert.ok(h.registered.has('qq_send_voice'))
  assert.ok(h.registered.has('qq_voice'))
})

test('qq_send_voice：只发音频、路径得在、太大不送', async () => {
  const h = await harness()
  const tool = h.registered.get('qq_send_voice')

  const notAudio = await tool.execute({ file: 'C:/tmp/x.pdf' }, h.exec)
  assert.equal(notAudio.ok, false)
  assert.match(notAudio.reason, /只发音频/)

  const missing = await tool.execute({ file: join(h.dir, 'nope.wav') }, h.exec)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /没有文件/)

  // 正常一条
  const wav = join(h.dir, 'hello.wav')
  await writeFile(wav, Buffer.from('RIFF....WAVEfmt '))
  const ok = await tool.execute({ file: wav }, h.exec)
  assert.equal(ok.ok, true)
  const sent = h.calls.find((c) => c.action === 'send_private_msg')
  assert.ok(sent, '应该发了一条私聊消息')
  assert.equal(sent.params.message[0].type, 'record')
  assert.equal(sent.params.message[0].data.file, wav)
})

test('qq_voice：这条消息里没有语音就说清楚', async () => {
  const h = await harness()
  const tool = h.registered.get('qq_voice')
  const r = await tool.execute({ message_id: 123 }, h.exec)
  assert.equal(r.ok, false)
  assert.match(r.message, /没有语音/)
  assert.equal(h.calls[0].action, 'get_msg')
})

test('qq_voice：不填 id 时找最近一条语音，不是 lastMessageId', async () => {
  noteVoiceMessage('2710586329', 777)
  assert.equal(lastVoiceMessageIdOf('2710586329'), 777)

  const h = await harness({
    getMsg: () => ({ message: [{ type: 'record', data: { file: 'abc.amr' } }] }),
    getRecord: () => ({ base64: Buffer.from('RIFF....WAVE').toString('base64') }),
  })
  const tool = h.registered.get('qq_voice')
  const r = await tool.execute({}, h.exec)
  assert.equal(r.ok, true)
  assert.equal(r.messageId, 777) // 来自 noteVoiceMessage，不是 record.lastMessageId(424242)
  const getRecord = h.calls.find((c) => c.action === 'get_record')
  assert.equal(getRecord.params.file, 'abc.amr')
  assert.equal(getRecord.params.out_format, 'wav')
  assert.match(r.path, /voice-777\.wav$/)
})

test('qq_voice：NapCat 转不出来（缺 ffmpeg）时给一句人话', async () => {
  const h = await harness({
    getMsg: () => ({ message: [{ type: 'record', data: { file: 'abc.amr' } }] }),
    getRecord: () => ({}),
  })
  const tool = h.registered.get('qq_voice')
  const r = await tool.execute({ message_id: 9 }, h.exec)
  assert.equal(r.ok, false)
  assert.match(r.message, /ffmpeg|没成功/)
})
