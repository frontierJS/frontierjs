/**
 * The flush's runaway guard — what it may and may not accuse the author of.
 *
 * Depth and cyclicity are different facts. The derived layer settles one
 * DOM-depth per pass on purpose, so a chain of memos costs one pass per link
 * while running no node twice; a pass budget cannot tell the two apart and
 * declared a thousand-link chain cyclic, dropping its pending nodes and telling
 * the author to hunt a cycle that was never there (`FJS-851`).
 *
 * The chains here are built with no DOM around them, so every memo sits at
 * depth 0 — which is the shape a generated or recursive component tree reaches
 * for real.
 */
import { describe, it, expect, vi } from 'vitest'
import { createSignal, createMemo, createEffect, flushSync } from '../src/runtime.js'

// A chain of `n` memos over one signal. The effect at the end is the consumer
// whose value is the whole assertion: a dropped generation leaves it stale.
function chain(n) {
  const [read, set] = createSignal(0)
  let cur = read
  for (let i = 0; i < n; i++) {
    const prev = cur
    cur = createMemo(() => prev() + 1)
  }
  let seen = null
  createEffect(() => { seen = cur() })
  return { set, seen: () => seen }
}

describe('a deep derivation chain', () => {
  it('settles past the old pass budget instead of being called cyclic', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const c = chain(1200)
      c.set(1)
      flushSync()
      expect(c.seen()).toBe(1201)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('settles either side of the old cliff', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const n of [998, 999, 1000, 1001]) {
        const c = chain(n)
        c.set(1)
        flushSync()
        expect(c.seen()).toBe(n + 1)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})

describe('a graph that really does not settle', () => {
  it('is still reported, and names the node that repeated', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const [a, setA] = createSignal(0)
      const [b, setB] = createSignal(0)
      createEffect(function writesB() { setB(a() + 1) })
      createEffect(function writesA() { setA(b() + 1) })
      setA(1)
      expect(() => flushSync()).not.toThrow()
      const msg = spy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(msg).toMatch(/Update cycle detected/)
      // The old message named only what was still queued, which in a two-effect
      // cycle is nothing. Without a culprit the reader has no place to start.
      expect(msg).toMatch(/writes[AB]/)
    } finally { spy.mockRestore() }
  })

  it('does not accuse a deep chain of the same thing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      chain(1500).set(1)
      flushSync()
      const msg = spy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(msg).not.toMatch(/cycle/i)
    } finally { spy.mockRestore() }
  })
})
