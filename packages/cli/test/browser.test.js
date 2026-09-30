// browser.test.js — the two probes that read a page.
//
// The launch itself is not tested here and must not be: `packages/cli`'s `test`
// script runs on a machine with no browser, and a suite that needed one would
// be a suite that is skipped. What IS testable without Chrome is what a probe
// does with an answer, so a probe takes its page as an argument. Which binary
// is found is `@frontierjs/mesa/drive`'s, and tested there.

import { describe, test, expect } from 'bun:test'
import { pageEval, pageClean }    from '../core/probe.js'

/** A page that answers a scripted sequence, so a probe's retry is observable. */
const fakePage = (answers, errors = []) => {
  let i = 0
  return {
    errors,
    calls: 0,
    async eval() {
      this.calls++
      const a = answers[Math.min(i++, answers.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
  }
}

describe('pageEval', () => {
  test('answers with the value when it satisfies expect', async () => {
    const page = fakePage([3])
    const r = await pageEval({ page, ask: 'x', expect: (v) => v === 3, name: 'three' })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(3)
  })

  test('retries until the page catches up — a page is asynchronous', async () => {
    const page = fakePage([0, 0, 2])
    const r = await pageEval({ page, ask: 'x', expect: (v) => v === 2, retries: 5, everyMs: 1 })
    expect(r.ok).toBe(true)
    expect(page.calls).toBe(3)
  })

  test('fails with what it actually got, and the page’s own errors beside it', async () => {
    const page = fakePage([0], ['exception: Cannot read properties of null'])
    const r = await pageEval({ page, ask: 'x', expect: (v) => v === 1, retries: 2, everyMs: 1, name: 'one' })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('0')
    expect(r.detail).toContain('Cannot read properties of null')
  })

  test('a throw is reported as a throw, not as a wrong answer', async () => {
    const page = fakePage([new Error('Cannot find context')])
    const r = await pageEval({ page, ask: 'x', expect: () => true, retries: 2, everyMs: 1 })
    expect(r.ok).toBe(false)
    expect(r.got).toContain('it threw')
  })

  test('with no expect, truthiness is the test', async () => {
    expect((await pageEval({ page: fakePage([true]),  ask: 'x' })).ok).toBe(true)
    expect((await pageEval({ page: fakePage([false]), ask: 'x', retries: 1 })).ok).toBe(false)
  })
})

describe('pageClean', () => {
  test('passes on a page that said nothing', () => {
    expect(pageClean({ page: fakePage([], []) }).ok).toBe(true)
  })

  // Its own probe because a component that throws while rendering still leaves
  // a partial tree — so every assertion about what IS on the page passes.
  test('fails on a page that threw, and names how many', () => {
    const r = pageClean({ page: fakePage([], ['exception: boom', 'console.error: nope']) })
    expect(r.ok).toBe(false)
    expect(r.got).toBe('2')
    expect(r.detail).toContain('boom')
  })
})
