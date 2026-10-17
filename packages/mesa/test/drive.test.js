// @vitest-environment node
//
// drive.test.js — what `@frontierjs/mesa/drive` answers without a browser.
//
// `findChrome` is tested with its world passed in, because the answer a caller
// SKIPS on has to be right on a machine that has none. `openChrome`'s refusals
// happen before it launches anything. Everything that launches Chrome is the
// drive at `test/browser/drive/`.

import { describe, test, expect } from 'vitest'
import { openChrome, findChrome } from '../src/drive.js'

const world =({ have = [], files = [], env = {} } = {}) => ({
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
    // An installed google-chrome must not answer here, or a person who pinned
    // a version silently gets a different browser.
    expect(findChrome({ ...world({ have: ['google-chrome'], env: { FJS_CHROME: '/gone/chrome' } }) }))
      .toBe(null)
  })

  test('$FJS_CHROME may name something on PATH', () => {
    expect(findChrome({ ...world({ have: ['my-chrome'], env: { FJS_CHROME: 'my-chrome' } }) }))
      .toBe('my-chrome')
  })
})

test('openChrome throws, rather than exiting, when $FJS_CHROME names nothing', async () => {
  const was = process.env.FJS_CHROME
  process.env.FJS_CHROME = '/gone/chrome'
  try {
    await expect(openChrome()).rejects.toThrow(/\$FJS_CHROME names \/gone\/chrome/)
  } finally {
    if (was === undefined) delete process.env.FJS_CHROME
    else process.env.FJS_CHROME = was
  }
})

test('openChrome refuses the flags it owns, before launching anything', async () => {
  await expect(openChrome({ args: ['--remote-debugging-port=9222'] })).rejects.toThrow(/--remote-debugging-port is the driver's own flag/)
  await expect(openChrome({ args: ['--user-data-dir=/tmp/x'] })).rejects.toThrow(/--user-data-dir is the driver's own flag/)
})
