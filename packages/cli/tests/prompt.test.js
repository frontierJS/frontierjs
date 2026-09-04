// prompt.test.js — the two engines this replaced disagreed, so both halves are
// pinned here.
//
// The one that costs a day when it breaks is the piped branch: readline hands
// out buffered lines eagerly, so a scripted run answers question one and drops
// every answer after it — silently, because each later question then reads the
// empty string and takes its default. `answers in order` is that case.
//
// The `--yes` rows are the other one. Opening stdin when nothing is going to
// write to it is a CI hang with no output, and a test that asserts the ANSWER
// cannot see it: only never resolving the stream can.

import { describe, test, expect } from 'bun:test'
import { PassThrough }            from 'stream'

import { createPrompts } from '../core/prompt.js'

// A pipe carrying `lines`, closed. A real non-TTY stdin.
function piped(lines) {
  const input = new PassThrough()
  input.isTTY = false
  input.end(lines.join('\n'))
  return input
}

// A pipe that never ends — stdin inherited by a process nobody is typing at.
// Anything that reads this hangs, which is the point.
function silent() {
  const input = new PassThrough()
  input.isTTY = false
  return input
}

function sink() {
  const out = new PassThrough()
  out.setEncoding('utf8')
  let text = ''
  out.on('data', (c) => { text += c })
  return Object.assign(out, { text: () => text })
}

// Every await here is bounded: a prompt that blocks fails as a timeout rather
// than hanging the suite.
const within = (ms, promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`blocked for ${ms}ms`)), ms)),
])

describe('piped input', () => {
  test('answers in order — every question, not just the first', async () => {
    const p = createPrompts({ input: piped(['one', 'two', 'three']), output: sink() })

    expect(await within(500, p.ask('a › '))).toBe('one')
    expect(await within(500, p.ask('b › '))).toBe('two')
    expect(await within(500, p.ask('c › '))).toBe('three')
    p.close()
  })

  test('the prompt is still written, so a transcript reads as the session did', async () => {
    const out = sink()
    const p   = createPrompts({ input: piped(['x']), output: out })

    await within(500, p.ask('name › '))
    expect(out.text()).toContain('name › ')
    p.close()
  })

  test('an exhausted buffer answers the default, exactly as a bare Enter does', async () => {
    const p = createPrompts({ input: piped(['only']), output: sink() })

    expect(await within(500, p.ask('a › '))).toBe('only')
    expect(await within(500, p.ask('b › '))).toBe(null)
    expect(await within(500, p.confirm('c', { default: true }))).toBe(true)
    p.close()
  })
})

describe('confirm', () => {
  test('yes and no are read, in either case', async () => {
    const p = createPrompts({ input: piped(['y', 'YES', 'n', 'nope']), output: sink() })

    expect(await within(500, p.confirm('a'))).toBe(true)
    expect(await within(500, p.confirm('b'))).toBe(true)
    expect(await within(500, p.confirm('c'))).toBe(false)
    expect(await within(500, p.confirm('d'))).toBe(false)
    p.close()
  })

  test('a bare Enter takes the stated default, in both directions', async () => {
    const p = createPrompts({ input: piped(['', '']), output: sink() })

    expect(await within(500, p.confirm('a', { default: true }))).toBe(true)
    expect(await within(500, p.confirm('b', { default: false }))).toBe(false)
    p.close()
  })

  test('an unstated default is a refusal', async () => {
    const p = createPrompts({ input: piped(['']), output: sink() })

    expect(await within(500, p.confirm('a'))).toBe(false)
    p.close()
  })

  test('the hint says which way Enter goes', async () => {
    const out = sink()
    const p   = createPrompts({ input: piped(['', '']), output: out })

    await within(500, p.confirm('a', { default: true }))
    await within(500, p.confirm('b', { default: false }))
    expect(out.text()).toContain('(Y/n)')
    expect(out.text()).toContain('(y/n)')
    p.close()
  })
})

describe('choose', () => {
  test('an index picks its option', async () => {
    const p = createPrompts({ input: piped(['2']), output: sink() })

    expect(await within(500, p.choose('pick', ['a', 'b', 'c']))).toBe('b')
    p.close()
  })

  test('out of range and unparseable both take the default', async () => {
    const p = createPrompts({ input: piped(['9', 'banana', '0', '']), output: sink() })

    expect(await within(500, p.choose('a', ['x', 'y']))).toBe('x')
    expect(await within(500, p.choose('b', ['x', 'y']))).toBe('x')
    expect(await within(500, p.choose('c', ['x', 'y']))).toBe('x')
    expect(await within(500, p.choose('d', ['x', 'y'], { default: 1 }))).toBe('y')
    p.close()
  })

  test('the options are listed', async () => {
    const out = sink()
    const p   = createPrompts({ input: piped(['1']), output: out })

    await within(500, p.choose('pick', ['alpha', 'beta']))
    expect(out.text()).toContain('1) alpha')
    expect(out.text()).toContain('2) beta')
    p.close()
  })
})

describe('a supplied answer', () => {
  test('is returned without asking, and consumes no line', async () => {
    const p = createPrompts({ input: piped(['from-stdin']), output: sink() })

    expect(await within(500, p.ask('a › ', 'from-a-flag'))).toBe('from-a-flag')
    expect(await within(500, p.ask('b › '))).toBe('from-stdin')
    p.close()
  })

  test('an empty fallback is not an answer', async () => {
    const p = createPrompts({ input: piped(['typed']), output: sink() })

    expect(await within(500, p.ask('a › ', ''))).toBe('typed')
    p.close()
  })
})

describe('yes: true', () => {
  // The whole point: stdin is never opened, so a stream nobody writes to cannot
  // block the run. Every one of these would time out against an implementation
  // that reads first and short-circuits after.
  test('answers everything without reading a stream that never ends', async () => {
    const p = createPrompts({ yes: true, input: silent(), output: sink() })

    expect(await within(500, p.confirm('a', { default: true }))).toBe(true)
    expect(await within(500, p.confirm('b', { default: false }))).toBe(false)
    expect(await within(500, p.choose('c', ['x', 'y']))).toBe('x')
    expect(await within(500, p.choose('d', ['x', 'y'], { default: 1 }))).toBe('y')
    expect(await within(500, p.ask('e › '))).toBe(null)
    expect(await within(500, p.ask('f › ', 'given'))).toBe('given')
    await within(500, p.pause())
    p.close()
  })
})

describe('pause', () => {
  test('is a no-op with no terminal', async () => {
    const p = createPrompts({ input: silent(), output: sink() })

    await within(500, p.pause())
    p.close()
  })
})

describe('close', () => {
  test('is safe when nothing was ever asked', () => {
    const p = createPrompts({ input: silent(), output: sink() })

    expect(() => p.close()).not.toThrow()
  })
})
