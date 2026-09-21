import { describe, test, expect } from 'bun:test'
import { getConfig } from '../core/runtime.js'

// getConfig(metadata, rawArgs[], rawFlags{}) → config
// Tests cover: arg mapping, flag validation, defaults, short char, variadic, options

const base = (overrides = {}) => ({
  title: 'test:cmd',
  args: [],
  flags: {},
  ...overrides,
})

// ─── Arg mapping ──────────────────────────────────────────────────────────────

describe('getConfig — args', () => {

  test('maps positional args to names from metadata', () => {
    const meta = base({ args: [{ name: 'path' }, { name: 'method' }] })
    const { arg } = getConfig(meta, ['my/path', 'POST'], {})
    expect(arg.path).toBe('my/path')
    expect(arg.method).toBe('POST')
  })

  test('extra positional args beyond definitions are ignored', () => {
    const meta = base({ args: [{ name: 'name' }] })
    const { arg } = getConfig(meta, ['Alice', 'unexpected'], {})
    expect(arg.name).toBe('Alice')
    expect(arg.unexpected).toBeUndefined()
  })

  test('missing optional arg leaves it undefined', () => {
    const meta = base({ args: [{ name: 'target' }] })
    const { arg } = getConfig(meta, [], {})
    expect(arg.target).toBeUndefined()
  })

  test('uses defaultValue when arg is not provided', () => {
    const meta = base({ args: [{ name: 'dir', defaultValue: '.' }] })
    const { arg } = getConfig(meta, [], {})
    expect(arg.dir).toBe('.')
  })

  test('variadic arg joins all remaining values', () => {
    const meta = base({ args: [{ name: 'message', variadic: true }] })
    const { arg } = getConfig(meta, ['hello', 'world', 'foo'], {})
    expect(arg.message).toBe('hello world foo')
  })

})

// ─── Flag validation ──────────────────────────────────────────────────────────

describe('getConfig — flags', () => {

  test('passes valid flags through', () => {
    const meta = base({
      flags: { name: { type: 'string' } }
    })
    const { flag } = getConfig(meta, [], { name: 'Alice' })
    expect(flag.name).toBe('Alice')
  })

  test('applies defaultValue for flags not passed', () => {
    const meta = base({
      flags: {
        times: { type: 'number', defaultValue: 1 },
        shout: { type: 'boolean', defaultValue: false },
      }
    })
    const { flag } = getConfig(meta, [], {})
    expect(flag.times).toBe(1)
    expect(flag.shout).toBe(false)
  })

  test('expands short char flag to full name', () => {
    const meta = base({
      flags: { shout: { type: 'boolean', char: 's' } }
    })
    const { flag } = getConfig(meta, [], { s: true })
    expect(flag.shout).toBe(true)
    expect(flag.s).toBeUndefined()
  })

  test('resolves options enum to mapped value', () => {
    const meta = base({
      flags: {
        env: {
          options: {
            production: 'NODE_ENV=production',
            test:       'NODE_ENV=test',
          }
        }
      }
    })
    const { flag } = getConfig(meta, [], { env: 'production' })
    expect(flag.env).toBe('NODE_ENV=production')
  })

  test('throws on invalid options value', () => {
    const meta = base({
      flags: { env: { options: { production: 'NODE_ENV=production' } } }
    })
    expect(() => getConfig(meta, [], { env: 'staging' })).toThrow()
  })

  test('throws on wrong type', () => {
    const meta = base({
      flags: { count: { type: 'number' } }
    })
    // string 'five' is not a number
    expect(() => getConfig(meta, [], { count: 'five' })).toThrow()
  })

  test('warns and ignores unknown flags in non-strict mode', () => {
    const meta = base({ flags: {} })
    // should not throw
    expect(() => getConfig(meta, [], { unknown: true })).not.toThrow()
  })

  test('throws on unknown flags in strict mode', () => {
    const meta = base({ flags: {}, mode: 'strict' })
    expect(() => getConfig(meta, [], { unknown: true })).toThrow()
  })

  test('merges default flags (dry, test) into every command', () => {
    const meta = base({ flags: {} })
    const config = getConfig(meta, [], {})
    // default flag definitions are present in merged config.flags
    expect(config.flags.dry).toBeDefined()
    expect(config.flags.dry.type).toBe('boolean')
    expect(config.flags.test).toBeDefined()
    // original metadata is NOT mutated (deep-clone fix)
    expect(meta.flags.dry).toBeUndefined()
  })

  test('command flags override default flags with same name', () => {
    const meta = base({
      flags: {
        dry: { type: 'boolean', char: 'd', description: 'Custom dry' }
      }
    })
    const config = getConfig(meta, [], {})
    // command's own dry description wins in the merged config
    expect(config.flags.dry.description).toBe('Custom dry')
    // and the original is not mutated
    expect(meta.flags.dry.description).toBe('Custom dry')
  })

})
