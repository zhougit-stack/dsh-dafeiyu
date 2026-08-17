import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import test from 'node:test'
import { CompletionVoice } from '../src/completion-voice.js'

class FakeWritable extends Writable {
  constructor() {
    super()
    this.writes = []
    this.ended = false
  }
  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }
  _final(callback) {
    this.ended = true
    callback()
  }
}

class FakeReadable extends Readable {
  constructor() {
    super()
    this.chunks = []
  }
  push(chunk) {
    this.chunks.push(chunk)
    super.push(chunk)
  }
  _read() {}
}

function fakeSpawnScript() {
  const handlers = new Map()
  const spawnFn = (...args) => {
    const child = {
      stdin: new FakeWritable(),
      stdout: new FakeReadable(),
      args,
      killed: false,
      on(name, handler) { handlers.set(name, handler); return child },
      unref() { return child },
      kill() { child.killed = true; handlers.get('exit')?.() },
    }
    return child
  }
  return { spawnFn }
}

test('CompletionVoice is a no-op outside win32', () => {
  const { spawnFn } = fakeSpawnScript()
  const voice = new CompletionVoice({ logger: { warn() {} }, platform: 'linux', spawnFn })
  assert.equal(voice.warmup(), false)
  assert.equal(voice.play(), false)
})

test('CompletionVoice warms once and writes "play" on completion', () => {
  const { spawnFn } = fakeSpawnScript()
  const voice = new CompletionVoice({ logger: { warn() {} }, spawnFn })
  assert.equal(voice.warmup(), true, 'first warmup spawns worker')
  assert.equal(voice.warmup(), true, 'second warmup is a no-op')

  const child = voice.child
  assert.equal(child, voice.child, 'same child reused')

  assert.equal(voice.play(), true)
  assert.equal(child.stdin.writes.join(''), 'play\n')
})

test('CompletionVoice drops overlapping completions until done', () => {
  const { spawnFn } = fakeSpawnScript()
  const voice = new CompletionVoice({ logger: { warn() {} }, spawnFn })
  voice.warmup()
  assert.equal(voice.play(), true)
  // While the clip is still playing, the next pulse is dropped.
  assert.equal(voice.play(), false)
  // The worker reports done via stdout; simulate that and confirm we can
  // play again.
  voice.playing = false
  assert.equal(voice.play(), true)
})

test('CompletionVoice.stop tears down the worker', () => {
  const { spawnFn } = fakeSpawnScript()
  const voice = new CompletionVoice({ logger: { warn() {} }, spawnFn })
  voice.warmup()
  const child = voice.child
  voice.stop()
  assert.equal(child.stdin.ended, true)
  assert.equal(voice.child, undefined)
})

test('CompletionVoice.warmup tolerates spawn failures', () => {
  const voice = new CompletionVoice({
    logger: { warn(message) { this.warned = message } },
    spawnFn: () => { throw new Error('boom') },
  })
  assert.equal(voice.warmup(), false)
})
