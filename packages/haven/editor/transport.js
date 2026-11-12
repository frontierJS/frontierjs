// editor/transport.js — the band mixer's playback: one song of a band pulled
// into Web Audio from a cursor the page moves, where the loft's `#sound`
// follows the wall clock. The band is seated so song `k` starts at sample 0,
// so the cursor is the sample within the song and a seek is a new cursor.
//
// Chunks are laid end to end on the context's clock; one placed late would
// click at the seam, so a starved pump starts again a little ahead of now.
// A seek or a new band stops what is queued but not yet heard, or the old
// band plays on for `AHEAD` after the change.

import { createBand, songOf, RATE } from '#shared/band.js'

const CHUNK = Math.round(RATE * 0.1)
const AHEAD = 0.4

export function transport() {
  const ctx    = new AudioContext({ sampleRate: RATE })
  const master = ctx.createGain()
  master.connect(ctx.destination)

  let band    = null
  let song    = null
  let cursor  = 0
  let at      = 0       // context time the next chunk starts
  let playing = false
  let loop    = null    // { from, to } in bars
  let queued  = []      // { src, t, s }: chunk at song sample `s` starts at context time `t`

  const flush = () => {
    for (const q of queued) if (q.t > ctx.currentTime) q.src.stop()
    queued = queued.filter((q) => q.t <= ctx.currentTime)
  }
  const end = () => (loop ? loop.to * song.barN : (song.bars + 1) * song.barN)

  const pump = () => {
    if (!playing || !band) return
    if (at < ctx.currentTime + 0.02) at = ctx.currentTime + 0.05
    while (at < ctx.currentTime + AHEAD) {
      if (cursor >= end()) {
        if (!loop) { pause(); cursor = 0; return }
        cursor = loop.from * song.barN
      }
      const n   = Math.min(CHUNK, end() - cursor)
      const pcm = band.samples(cursor, n)
      const buf = ctx.createBuffer(2, n, RATE)
      for (let c = 0; c < 2; c++) buf.copyToChannel(pcm[c], c)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(master)
      src.start(at)
      queued.push({ src, t: at, s: cursor })
      at += n / RATE
      cursor += n
    }
    queued = queued.filter((q) => q.t + CHUNK / RATE > ctx.currentTime - 1)
  }
  const timer = setInterval(pump, 50)

  function pause() {
    playing = false
    const now = position()
    flush()
    cursor = now
  }

  /** The song sample heard now: the cursor when stopped, else read off the queue. */
  function position() {
    if (!playing) return cursor
    const t = ctx.currentTime
    const q = queued.findLast((x) => x.t <= t)
    return q ? Math.floor(q.s + (t - q.t) * RATE) : cursor
  }

  return {
    /** Song `k` under `conductor`, kept at the bar it was at. */
    load(k, conductor, solo) {
      const bar = song ? position() / song.barN : 0
      const was = playing
      if (was) pause()
      band = createBand({ conductor, solo })
      band.seat({ first: k, at: 0 })
      song = songOf(k, conductor)
      cursor = Math.floor(Math.min(bar, song.bars - 1) * song.barN)
      if (loop && loop.to > song.bars) loop = null
      if (was) this.play()
      return song
    },
    play() {
      ctx.resume()
      playing = true
      at = 0
      pump()
    },
    pause,
    seek(bar) {
      const was = playing
      if (was) pause()
      cursor = Math.max(0, bar) * song.barN
      if (was) this.play()
    },
    loopOver(range) { loop = range },
    volume(v) { master.gain.value = v },
    get playing() { return playing },
    /** Where the song is: its bar, the step in it, and the time in seconds. */
    where() {
      const s = position()
      return { bar: song ? Math.floor(s / song.barN) : 0, step: song ? Math.floor((s % song.barN) / (song.barN / 16)) : -1, seconds: s / RATE }
    },
    /** Each part's peak over the last 50 ms heard. */
    meters() {
      if (!band || !playing) return null
      const s = Math.max(0, position() - 2205)
      return band.levels(s, 1, 2205).map((x) => x[0])
    },
    close() {
      clearInterval(timer)
      ctx.close()
    },
  }
}
