// browser.test.js — finding Chrome, and the two probes that read a page.
//
// The launch itself is not tested here and must not be: `packages/cli`'s `test`
// script runs on a machine with no browser, and a suite that needed one would
// be a suite that is skipped. What IS testable without Chrome is everything
// that decides — which binary, and what a probe does with an answer — so both
// take their world as an argument.
//
// `$FJS_CHROME` being AUTHORITATIVE rather than preferred is the one worth
// pinning: somebody who names a binary names it for a reason, and falling
// through to whatever else is installed answers a different question silently.

import { describe, test, expect } from 'bun:test'
import { findChrome }             from '../core/browser.js'
import { pageEval, pageClean }    from '../core/probe.js'

const world = ({ have = [], files = [], env = {} } = {}) => ({
  run:    (bin) => have.includes(bin),
  exists: (p)   => files.includes(p),
  env,
})

describe('findChrome', () => {
  test('takes the first candidate on PATH', () => {
    expect(findChrome({ ...world({ have: ['chromium'] }) })).toBe('chromium')
  })

  test('takes an absolute candidate that exists', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(findChrome({ ...world({ files: [mac] }) })).toBe(mac)
  })

  test('null when there is none — a fact about the machine, not a failure', () => {
    expect(findChrome({ ...world() })).toBe(null)
  })

  test('$FJS_CHROME wins over anything installed', () => {
    const named = '/opt/chrome-131/chrome'
    expect(findChrome({ ...world({ have: ['google-chrome'], files: [named], env: { FJS_CHROME: named } }) }))
      .toBe(named)
  })

  test('$FJS_CHROME naming nothing is null, NOT a fallback', () => {
    // The whole point: an installed google-chrome must not answer here, or a
    // person who pinned a version silently gets a different browser.
    expect(findChrome({ ...world({ have: ['google-chrome'], env: { FJS_CHROME: '/gone/chrome' } }) }))
      .toBe(null)
  })

  test('$FJS_CHROME may name something on PATH', () => {
    expect(findChrome({ ...world({ have: ['my-chrome'], env: { FJS_CHROME: 'my-chrome' } }) }))
      .toBe('my-chrome')
  })
})

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
