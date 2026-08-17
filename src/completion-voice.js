import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_VOICE_FILE = fileURLToPath(new URL('../assets/voice/task-complete.wav', import.meta.url))

// Spawning powershell.exe at completion time costs 1-3s (longer under AV
// scanners), which made the cue lag several seconds behind the finished turn.
// Instead one hidden PowerShell worker is kept alive for the plugin's
// lifetime: it preloads the WAV once via SoundPlayer.Load(), then plays on
// demand over a line protocol, so play() is just a stdin write and the cue is
// audible the instant the SUCCESS pulse fires.  The worker exits on stdin
// EOF, and overlapping completions within one clip are dropped instead of
// stacking (the worker reports each finished playback with 'done').
export class CompletionVoice {
  constructor({ file = DEFAULT_VOICE_FILE, logger, platform = process.platform, spawnFn = spawn } = {}) {
    this.file = file
    this.logger = logger
    this.platform = platform
    this.spawnFn = spawnFn
    this.child = undefined
    this.playing = false
  }

  // Line protocol the worker runs: 'play' plays the preloaded clip and
  // acknowledges with 'done'; closing stdin lets the worker exit cleanly.
  workerScript() {
    const escaped = this.file.replace(/'/gu, "''")
    return [
      `$player = New-Object Media.SoundPlayer '${escaped}'`,
      '$player.Load()',
      "[Console]::Out.WriteLine('ready')",
      'while ($null -ne ($line = [Console]::In.ReadLine())) {',
      "  if ($line -eq 'play') { $player.PlaySync(); [Console]::Out.WriteLine('done') }",
      '}',
    ].join('\n')
  }

  // Starts the worker so the first completion does not pay the PowerShell
  // startup cost.  Idempotent, and play() also falls back to spawning lazily
  // in case the worker died in between.
  warmup() {
    if (this.platform !== 'win32' || this.child) return this.child !== undefined
    let child
    try {
      child = this.spawnFn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        this.workerScript(),
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      this.logger?.warn?.(`dsh-dafeiyu completion voice worker failed to start: ${error.message}`)
      return false
    }
    const buffer = { text: '' }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer.text += chunk
      let newline = buffer.text.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.text.slice(0, newline).trim()
        buffer.text = buffer.text.slice(newline + 1)
        if (line === 'done') this.playing = false
        newline = buffer.text.indexOf('\n')
      }
    })
    child.on('error', (error) => {
      this.#reset()
      this.logger?.warn?.(`dsh-dafeiyu completion voice worker failed: ${error.message}`)
    })
    child.on('exit', () => this.#reset())
    // The worker must never keep the DSH host alive; it exits on stdin EOF.
    child.unref?.()
    child.stdin?.unref?.()
    child.stdout?.unref?.()
    this.child = child
    return true
  }

  play() {
    if (this.platform !== 'win32') return false
    if (this.playing) return false
    if (!this.warmup()) return false
    if (!this.child?.stdin?.writable) return false
    this.playing = true
    this.child.stdin.write('play\n')
    return true
  }

  stop() {
    const child = this.child
    this.#reset()
    if (!child) return
    child.stdin?.end()
    child.kill()
  }

  #reset() {
    this.child = undefined
    this.playing = false
  }
}
