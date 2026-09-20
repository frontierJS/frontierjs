// verbosity.test.js — `log.detail` is the paragraph behind the line, and it is
// silent unless `--verbose` was typed.
//
// The level exists because the alternative was gating `log.info`, which every
// command in this package uses for lines somebody needs. Opt-in per call site,
// so the blast radius of the flag is exactly the call sites that asked for it.

import { describe, test, expect, afterEach } from 'bun:test'
import { logger }                            from '../core/utils.js'
import { setVerbose, isVerbose }             from '../core/verbosity.js'
import { BOOL_ARGV, dropUntypedBooleans }    from '../core/runtime.js'

const capture = (fn) => {
  const lines = []
  const real  = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try { fn() } finally { console.log = real }
  return lines
}

afterEach(() => setVerbose(false))

describe('log.detail', () => {
  test('silent by default', () => {
    setVerbose(false)
    expect(capture(() => logger('the long version', 'detail'))).toEqual([])
  })

  test('printed under --verbose, and unprefixed — the caller is prose', () => {
    setVerbose(true)
    const [line] = capture(() => logger('the long version', 'detail'))
    // Dim wrapping only; no `·`, no `[debug]`.
    expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toBe('the long version')
  })

  test('the levels a reader must not miss are never gated', () => {
    setVerbose(false)
    for (const level of ['info', 'success', 'dry']) {
      expect(capture(() => logger(`a ${level} line`, level)).length).toBe(1)
    }
  })
})

describe('--verbose parsing', () => {
  test('it is a boolean, so it cannot eat the next argument', () => {
    expect(BOOL_ARGV).toContain('verbose')
  })

  test('minimist defaults it to false; an untyped one is dropped', () => {
    // Left in place, getConfig reads a DEFINED false as "the flag was given".
    expect(dropUntypedBooleans({ verbose: false }, ['new', 'app'])).toEqual({})
    expect(dropUntypedBooleans({ verbose: true },  ['new', 'app', '--verbose'])).toEqual({ verbose: true })
  })
})

describe('setVerbose', () => {
  test('one bit, and it is global — the flag has to reach a composed command', () => {
    setVerbose(true)
    expect(isVerbose()).toBe(true)
    setVerbose(false)
    expect(isVerbose()).toBe(false)
  })
})
