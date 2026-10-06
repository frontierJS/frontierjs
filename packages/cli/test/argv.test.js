// The argv reader replaced minimist and keeps its readings; each case below is
// one minimist gave, so a command written against the old parse reads the same.
import { describe, test, expect } from 'bun:test'
import { parseArgv, BOOL_ARGV } from '../core/argv.js'

const parse = (args) => parseArgv(args, { bools: BOOL_ARGV })

describe('parseArgv', () => {
  test('positionals, numbers coerced by look', () => {
    expect(parse(['x', '123', 'abc', '1.5'])).toEqual({ _: ['x', 123, 'abc', 1.5] })
  })

  test('a long flag takes the next word, or =', () => {
    expect(parse(['x', '--port', '8080'])).toEqual({ _: ['x'], port: 8080 })
    expect(parse(['x', '--as=report'])).toEqual({ _: ['x'], as: 'report' })
    expect(parse(['x', '--q', 'a=b'])).toEqual({ _: ['x'], q: 'a=b' })
    expect(parse(['x', '--neg', '-3'])).toEqual({ _: ['x'], neg: true, 3: true })
  })

  test('a flag followed by a flag is true', () => {
    expect(parse(['x', '--a', '--b', 'v'])).toEqual({ _: ['x'], a: true, b: 'v' })
  })

  test('a boolean never takes a value, except a literal true/false', () => {
    expect(parse(['x', '--dry', 'foo'])).toEqual({ _: ['x', 'foo'], dry: true })
    expect(parse(['x', '--dry', 'false'])).toEqual({ _: ['x'], dry: false })
    expect(parse(['x', '--dry=false'])).toEqual({ _: ['x'], dry: false })
  })

  test('an untyped boolean is absent, never false', () => {
    expect(parse(['x'])).toEqual({ _: ['x'] })
  })

  test('--no-x is x: false', () => {
    expect(parse(['x', '--no-color'])).toEqual({ _: ['x'], color: false })
  })

  test('short flags cluster, and the last takes a value', () => {
    expect(parse(['x', '-dt'])).toEqual({ _: ['x'], d: true, t: true })
    expect(parse(['x', '-dp', '80'])).toEqual({ _: ['x'], d: true, p: 80 })
    expect(parse(['x', '-p8080'])).toEqual({ _: ['x'], p: 8080 })
    expect(parse(['x', '-p=abc'])).toEqual({ _: ['x'], p: 'abc' })
    expect(parse(['x', '-o/tmp'])).toEqual({ _: ['x'], o: '/tmp' })
  })

  test('twice is an array; a boolean twice is not', () => {
    expect(parse(['x', '--filter', 'a', '--filter', 'b'])).toEqual({ _: ['x'], filter: ['a', 'b'] })
    expect(parse(['x', '-d', '--dry'])).toEqual({ _: ['x'], d: true, dry: true })
  })

  test('after -- everything is a positional, uncoerced', () => {
    expect(parse(['x', '--', '--raw', '3'])).toEqual({ _: ['x', '--raw', '3'] })
  })

  test('a lone - is a positional', () => {
    expect(parse(['x', '-'])).toEqual({ _: ['x', '-'] })
  })
})
