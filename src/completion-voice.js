import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_VOICE_FILE = fileURLToPath(new URL('../assets/voice/task-complete.wav', import.meta.url))

// Plays a short completion cue through the Windows SoundPlayer. Playback is a
// fire-and-forget hidden child process, so the ~2s PlaySync never blocks the
// DSH host event loop, and overlapping completions within one clip are dropped
// instead of stacking.
export class CompletionVoice {
  constructor({ file = DEFAULT_VOICE_FILE, logger } = {}) {
    this.file = file
    this.logger = logger
    this.playing = false
  }

  play() {
    if (process.platform !== 'win32') return false
    if (this.playing) return false
    this.playing = true
    const escaped = this.file.replace(/'/gu, "''")
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
    ], { stdio: 'ignore', windowsHide: true })
    const release = () => { this.playing = false }
    child.on('error', (error) => {
      release()
      this.logger?.warn?.(`dsh-dafeiyu completion voice failed: ${error.message}`)
    })
    child.on('exit', release)
    child.unref()
    return true
  }
}
