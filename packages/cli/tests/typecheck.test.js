// The engine behind `fli typecheck` and `scripts/typecheck.mjs`. Both callers
// need the same answer to one question — which of tsc's diagnostics are mine —
// so the question is asked here and the two halves that differ (a baseline
// ratchet, an exit code) stay with their callers.
//
// The tests drive the parser rather than tsc: what breaks in practice is the
// classification, and running a real compile would prove typescript's tests.

import { test, expect, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join }                   from 'node:path'
import { tmpdir }                 from 'node:os'

import { findTsc, runTypecheck, formatTypecheck } from '../core/typecheck.js'

// runTypecheck shells out, so the classification is tested through a stub tsc
// that prints a fixed transcript. Same code path, no compiler.
function withStubTsc(output, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fli-typecheck-'))
  const bin = join(dir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const script = join(bin, 'tsc')
  writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)})\n`, { mode: 0o755 })
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const TRANSCRIPT = [
  `api/src/app.ts(12,3): error TS2345: Argument of type 'string' is not assignable.`,
  `  Type 'string' is not assignable to type 'number'.`,
  `node_modules/@frontierjs/junction/src/transport/http.ts(222,53): error TS2345: Argument of type 'X'.`,
  `  Type 'unknown' is not assignable to type 'WsData'.`,
  `../shared/util.ts(4,1): error TS2304: Cannot find name 'foo'.`,
  `web/src/main.js(9,9): error TS2554: Expected 1 arguments, but got 0.`,
  '',
].join('\n')

describe('whose diagnostic is it', () => {
  test('node_modules and paths above the project belong to someone else', () => {
    // Every @frontierjs package ships TypeScript source, so tsc checks the
    // framework as part of the consumer's program. Without this split a
    // scaffolded app's typecheck reports hundreds of errors, none of them its
    // own, and the signal is useless in exactly the projects that have
    // dependencies.
    withStubTsc(TRANSCRIPT, dir => {
      const result = runTypecheck({ dir })
      expect(result.status).toBe('ok')
      expect(result.ownCount).toBe(2)
      expect(result.foreignCount).toBe(2)
      expect(result.foreign).toEqual([
        '../shared/util.ts',
        'node_modules/@frontierjs/junction/src/transport/http.ts',
      ])
    })
  })

  test('a continuation line follows the diagnostic above it', () => {
    // An indented line carries the detail and no path of its own. Attributing
    // it by position is the only option, and getting it wrong puts a
    // framework's explanation under the app's error.
    withStubTsc(TRANSCRIPT, dir => {
      const { own } = runTypecheck({ dir })
      expect(own[1].trim()).toBe(`Type 'string' is not assignable to type 'number'.`)
      expect(own.join('\n')).not.toContain('WsData')
    })
  })

  test('a clean compile is clean', () => {
    withStubTsc('', dir => {
      const result = runTypecheck({ dir })
      expect(result.ownCount).toBe(0)
      expect(result.foreignCount).toBe(0)
    })
  })
})

describe('what it says about the ones it dropped', () => {
  test('they are summarised, never silently gone', () => {
    // A count that vanishes reads as coverage. They are someone's problem —
    // just not this exit code's.
    withStubTsc(TRANSCRIPT, dir => {
      const report = formatTypecheck(runTypecheck({ dir }))
      expect(report).toContain('2 diagnostic(s)')
      expect(report).toContain('2 file(s)')
      expect(report).toContain('--foreign')
    })
  })

  test('--foreign prints them', () => {
    withStubTsc(TRANSCRIPT, dir => {
      const report = formatTypecheck(runTypecheck({ dir }), { showForeign: true })
      expect(report).toContain('WsData')
    })
  })

  test('--quiet drops the summary but not the errors', () => {
    withStubTsc(TRANSCRIPT, dir => {
      const report = formatTypecheck(runTypecheck({ dir }), { quiet: true })
      expect(report).not.toContain('diagnostic(s)')
      expect(report).toContain('TS2345')
    })
  })
})

describe('finding tsc', () => {
  test('it walks up, so a hoisted install is found from a package', () => {
    withStubTsc('', dir => {
      const nested = join(dir, 'packages', 'thing')
      mkdirSync(nested, { recursive: true })
      expect(findTsc(nested)).toBe(join(dir, 'node_modules', '.bin', 'tsc'))
    })
  })

  test('no tsc is a distinct status, not zero errors', () => {
    // Reporting "clean" because the compiler is missing is the worst possible
    // failure mode for a gate.
    const dir = mkdtempSync(join(tmpdir(), 'fli-no-tsc-'))
    try {
      const result = runTypecheck({ dir })
      expect(result.status).toBe('no-tsc')
      expect(result.ownCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
