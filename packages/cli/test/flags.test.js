// ─── flags.test.js — what a declared flag permits, and how it is written ─────
//
// The value half is graded through `getConfig` in `runtime.test.js`, which is
// where a value meets it. This is the leaf: the spelling the three listings
// print, the constraint text beside it, and the declarations it refuses.

import { describe, test, expect } from 'bun:test'
import { flagSpelling, flagConstraint, declarationProblem, valueProblem, withModuleFlags } from '../core/flags.js'

describe('flagSpelling', () => {
  test('a boolean that defaults on is written as the switch that turns it off', () => {
    expect(flagSpelling('push', { type: 'boolean', defaultValue: true })).toBe('--no-push')
  })

  test('every other flag is written as itself', () => {
    expect(flagSpelling('push',  { type: 'boolean', defaultValue: false })).toBe('--push')
    expect(flagSpelling('push',  { type: 'boolean' })).toBe('--push')
    // A string defaulting to the STRING 'true' is not a switch.
    expect(flagSpelling('mode',  { type: 'string', defaultValue: 'true' })).toBe('--mode')
  })
})

describe('flagConstraint', () => {
  test('choices, a range, and each open end', () => {
    expect(flagConstraint({ choices: ['table', 'json'] })).toBe('table|json')
    expect(flagConstraint({ min: 5, max: 90 })).toBe('5–90')
    expect(flagConstraint({ min: 5 })).toBe('≥ 5')
    expect(flagConstraint({ max: 90 })).toBe('≤ 90')
    expect(flagConstraint({ type: 'string' })).toBe('')
  })
})

describe('declarationProblem', () => {
  test('names the positive flag a `no-` declaration should have been', () => {
    expect(declarationProblem('no-push', { type: 'boolean' })).toMatch(/`push` with type: boolean and defaultValue: true/)
  })

  test('refuses `options`, a `choices` that is not a list, and a bound on a non-number', () => {
    expect(declarationProblem('env', { options: { a: 'A' } })).toMatch(/`choices`/)
    expect(declarationProblem('f', { choices: '[a, b]' })).toMatch(/one `- value` per/)
    expect(declarationProblem('f', { choices: [] })).toMatch(/Write a list/)
    expect(declarationProblem('n', { type: 'string', min: 1 })).toMatch(/not type: number/)
    expect(declarationProblem('n', { type: 'number', max: 'ten' })).toMatch(/not a number/)
  })

  test('refuses an `as` that offers json, since JSON is `--json` (FJS-D401)', () => {
    expect(declarationProblem('as', { type: 'string', choices: ['report', 'json'] })).toMatch(/JSON is `--json`/)
    // `as` naming a person (db:tinker) has no choices and is not a layout.
    expect(declarationProblem('as', { type: 'string', defaultValue: '' })).toBeNull()
    expect(declarationProblem('format', { type: 'string', choices: ['json', 'csv'] })).toBeNull()
  })

  test('passes a well-formed declaration', () => {
    expect(declarationProblem('every', { type: 'number', min: 5, max: 90 })).toBeNull()
    expect(declarationProblem('format', { type: 'string', choices: ['a'] })).toBeNull()
    expect(declarationProblem('push', { type: 'boolean', defaultValue: true })).toBeNull()
  })
})

describe('valueProblem', () => {
  test('a number from the frontmatter matches the same number typed as text', () => {
    // The frontmatter reader coerces `- 2` to a number; argv may carry '2'.
    expect(valueProblem('n', { choices: [1, 2] }, '2')).toBeNull()
  })

  test('`--as=json` names `--json` when the command has it', () => {
    const as = { choices: ['report', 'serve'] }
    expect(valueProblem('as', as, 'json', { as, json: { type: 'boolean' } })).toMatch(/the model is `--json`$/)
    expect(valueProblem('as', as, 'json', { as })).not.toMatch(/--json/)
  })

  test('says which end was crossed', () => {
    expect(valueProblem('e', { min: 5, max: 90 }, 91)).toMatch(/between 5 and 90 — got 91/)
    expect(valueProblem('e', { min: 5 }, 4)).toMatch(/at least 5/)
    expect(valueProblem('e', { max: 90 }, 91)).toMatch(/at most 90/)
  })
})

describe('withModuleFlags', () => {
  const mod = { meta: { defaults: { flags: {
    server: { type: 'string', description: 'where', defaultValue: '' },
    region: { type: 'string', defaultValue: '${FLI_TEST_REGION}' },
  } } } }

  // Copying only the default left a namespace-wide flag untyped and out of --help.
  test('a command gets the module flag whole', () => {
    expect(withModuleFlags({}, mod, {}).server).toEqual({ type: 'string', description: 'where', defaultValue: '' })
  })

  test('the command\'s own declaration wins field by field', () => {
    const out = withModuleFlags({ server: { description: 'mine', defaultValue: 'x' } }, mod, {})
    expect(out.server).toEqual({ type: 'string', description: 'mine', defaultValue: 'x' })
  })

  test('a ${VAR} default is read from the environment', () => {
    expect(withModuleFlags({}, mod, { FLI_TEST_REGION: 'eu' }).region.defaultValue).toBe('eu')
    expect(withModuleFlags({}, mod, {}).region.defaultValue).toBe('')
  })

  test('no module flags leaves the command\'s alone', () => {
    const own = { a: { type: 'boolean' } }
    expect(withModuleFlags(own, null)).toBe(own)
  })
})
