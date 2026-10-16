// sound.js — `#sound` in the terminal: a terminal has no audio, so the sound
// is raw 16-bit mono PCM piped into a player process on this machine. One
// process for the whole stay, fed a little ahead of the wall clock: a process
// a note would start each one late by however long the spawn took. Over ssh
// the player is the far machine's, which is nobody's speaker.
//
// `stream(fill, { rate })` pulls `fill(fromSample, n)` (samples counted from
// the epoch) and answers a stop, or null where no player is installed.
// `gain()`, 0 to 1, is asked once a chunk, so a level changed is heard within
// `AHEAD_MS`.

const CHUNK_MS = 100
const AHEAD_MS = 300

const PLAYERS = (rate) => [
  ['aplay', '-q', '-t', 'raw', '-f', 'S16_LE', '-r', `${rate}`, '-c', '1'],
  ['paplay', '--raw', '--format=s16le', `--rate=${rate}`, '--channels=1'],
  ['play', '-q', '-t', 'raw', '-r', `${rate}`, '-e', 'signed', '-b', '16', '-c', '1', '-'],
]

export function stream(fill, { rate, gain = () => 1 }) {
  const argv = PLAYERS(rate).find(([cmd]) => Bun.which(cmd))
  if (!argv) return null
  const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
  let dead = false
  proc.exited.then(() => { dead = true })

  const now = () => Math.floor((Date.now() / 1000) * rate)
  let cursor = now()
  const pump = () => {
    if (dead) return
    // Behind the clock means the player starved; skip to now, so this screen
    // hears the beat the others hear rather than a late copy of it.
    if (cursor < now()) cursor = now()
    const until = now() + Math.floor((AHEAD_MS / 1000) * rate)
    if (cursor >= until) return
    const f   = fill(cursor, until - cursor)
    const pcm = new Int16Array(f.length)
    const g   = gain()
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i] * g)) * 32767
    cursor = until
    try {
      proc.stdin.write(new Uint8Array(pcm.buffer))
      proc.stdin.flush()
    } catch { dead = true }
  }
  // Quitting Haven tears down no route, and an orphaned player plays its
  // buffer on with nobody in the loft.
  const kill = () => proc.kill()
  process.once('exit', kill)
  pump()
  const timer = setInterval(pump, CHUNK_MS)
  return () => {
    clearInterval(timer)
    process.off('exit', kill)
    dead = true
    try { proc.stdin.end() } catch {}
    proc.kill()
  }
}
