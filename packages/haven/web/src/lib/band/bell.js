// bell.js — the kitchen's bells, for `#sound`: pure, so a strike sounds the
// same on every machine and is rendered once. `chef` is two warbling strikes
// that sag downhill, a session waiting on you; `order` is one bright strike, a
// plate on the pass.
//
// `createBells().ring(kind)` queues a strike and `samples(from, n)` is what
// `#sound` pulls. A strike has no sample of its own until the next pull: the
// player is fed ahead of the clock, so a strike placed at now would land in
// samples already sent and never be heard.

export const RATE = 44100

// A desk bell's partials are not whole multiples of its note; whole multiples
// sound like an organ, not a bell.
const PARTIALS = [
  { r: 1,    a: 1,    decay: 1.1 },
  { r: 2.32, a: 0.45, decay: 0.45 },
  { r: 4.25, a: 0.22, decay: 0.22 },
  { r: 6.63, a: 0.1,  decay: 0.1 },
]
const LEVEL  = 0.28
const ATTACK = 0.002
const LENGTH = 1.4

/** One strike of a bell at `hz`, in -1..1. */
function strike(hz) {
  const out = new Float32Array(Math.floor(LENGTH * RATE))
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    let v = 0
    for (const p of PARTIALS) v += p.a * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * hz * p.r * t)
    out[i] = v * LEVEL * Math.min(1, t / ATTACK)
  }
  return out
}

/**
 * One strike of a bell knocked off its hook: the note sags by `sag` and
 * wobbles. A CHEF! heard across the room must not pass for a plate, and two
 * true strikes in a row did.
 */
function wonk(hz, sag) {
  const out = new Float32Array(Math.floor(LENGTH * RATE))
  const phase = PARTIALS.map(() => 0)
  let twin = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const f = hz * (1 - sag * (1 - Math.exp(-t / 0.25))) * (1 + 0.03 * Math.sin(2 * Math.PI * 6.5 * t))
    let v = 0
    PARTIALS.forEach((p, k) => {
      phase[k] += 2 * Math.PI * f * p.r / RATE
      v += p.a * Math.exp(-t / p.decay) * Math.sin(phase[k])
    })
    // A second fundamental a hair flat beats against the first, the wah-wah.
    twin += 2 * Math.PI * f * 0.985 / RATE
    v += 0.6 * Math.exp(-t / 1.1) * Math.sin(twin)
    out[i] = v * LEVEL * 0.8 * Math.min(1, t / ATTACK)
  }
  return out
}

/** A kind's strikes, each `{ at, buf }` with `at` in samples from the first. */
const KINDS = {
  chef:  () => [{ at: 0, buf: wonk(1320, 0.1) }, { at: Math.floor(0.22 * RATE), buf: wonk(1050, 0.3) }],
  order: () => [{ at: 0, buf: strike(1760) }],
}

export function createBells() {
  const rendered = new Map()
  const of = (kind) => {
    if (!rendered.has(kind)) rendered.set(kind, KINDS[kind]())
    return rendered.get(kind)
  }
  let queued = []   // each `{ at, buf }`, `at` null until the next pull seats it
  return {
    ring(kind) {
      for (const s of of(kind)) queued.push({ offset: s.at, at: null, buf: s.buf })
    },
    samples(from, n) {
      const out = new Float32Array(n)
      for (const q of queued) {
        if (q.at === null) q.at = from + q.offset
        const lo = Math.max(from, q.at)
        const hi = Math.min(from + n, q.at + q.buf.length)
        for (let s = lo; s < hi; s++) out[s - from] += q.buf[s - q.at]
      }
      queued = queued.filter((q) => q.at + q.buf.length > from + n)
      return out
    },
  }
}
