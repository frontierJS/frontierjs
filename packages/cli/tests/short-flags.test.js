import { describe, test, expect } from 'bun:test'
import minimist from 'minimist'
import { BOOL_ARGV, dropUntypedBooleans, getConfig } from '../core/runtime.js'

// `-d` is `--dry`, and for its whole life it was silently the opposite: minimist
// defaults every name in its `boolean:` list, so `-d` arrived as
// `{ d: true, dry: false }` and getConfig read that `false` as "the long name
// was given" and dropped the short one. `fli db:import -d` ran the real import.
//
// The pair is what makes the assertion: the same argv through the real parse and
// the real promotion, ending at the value a command body reads as `flag.dry`.

const parse = (args) =>
  dropUntypedBooleans(
    (({ _, ...flag }) => flag)(minimist(args, { boolean: BOOL_ARGV })),
    args
  )

const resolve = (args, flags = {}) => getConfig({ title: 't', args: [], flags }, [], parse(args))

describe('short boolean flags survive minimist defaulting', () => {
  test('-d is dry', () => {
    expect(resolve(['db:import', '-d']).flag.dry).toBe(true)
  })

  test('--dry is dry', () => {
    expect(resolve(['db:import', '--dry']).flag.dry).toBe(true)
  })

  test('neither is not dry', () => {
    expect(resolve(['db:import']).flag.dry).toBeUndefined()
  })

  test('a clustered short flag is still read', () => {
    expect(resolve(['db:import', '-dt']).flag.dry).toBe(true)
  })

  test('-d beside a command flag whose char is not d', () => {
    const { flag } = resolve(['db:import', '-d', '--dev'], { dev: { type: 'boolean' } })
    expect(flag.dry).toBe(true)
    expect(flag.dev).toBe(true)
  })

  test('an unpassed boolean is dropped rather than left false', () => {
    expect('dry' in parse(['db:import', '-d'])).toBe(false)
    expect('help' in parse(['db:import', '-d'])).toBe(false)
  })

  test('-h still reaches help', () => {
    expect(parse(['db:import', '-h']).h).toBe(true)
  })
})
