// sound.browser.js — `#sound` in a browser: the same pull as the terminal's,
// into Web Audio. A page may not make sound before the member has pressed or
// clicked something, so the context waits suspended until then. Chunks are
// laid end to end on the context's own clock, anchored once to the wall
// clock; placing each by `Date.now()` would leave a click at every seam.
// `gain()`, 0 to 1, is asked once a chunk, as the terminal's is.

const CHUNK_MS = 100
const AHEAD_MS = 300

export function stream(fill, { rate, gain = () => 1 }) {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!Ctx) return null
  const ctx    = new Ctx()
  const resume = () => { ctx.resume() }
  addEventListener('keydown', resume)
  addEventListener('pointerdown', resume)

  const now = () => Math.floor((Date.now() / 1000) * rate)
  const n   = Math.floor((CHUNK_MS / 1000) * rate)
  let anchor = null   // { s, t }: sample `s` plays at context time `t`
  let cursor = 0
  const pump = () => {
    if (ctx.state !== 'running') return
    if (!anchor || anchor.t + (cursor - anchor.s) / rate < ctx.currentTime) {
      cursor = now()
      anchor = { s: cursor, t: ctx.currentTime + 0.05 }
    }
    while (cursor < now() + (AHEAD_MS / 1000) * rate) {
      const buf = ctx.createBuffer(1, n, rate)
      const g = gain()
      buf.copyToChannel(fill(cursor, n).map((v) => v * g), 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.start(anchor.t + (cursor - anchor.s) / rate)
      cursor += n
    }
  }
  const timer = setInterval(pump, CHUNK_MS)
  return () => {
    clearInterval(timer)
    removeEventListener('keydown', resume)
    removeEventListener('pointerdown', resume)
    ctx.close()
  }
}
