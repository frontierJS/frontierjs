// The console — `litestone repl` / `fli tinker`.
//
// Two things here are worth a suite rather than a look:
//
//   1. Statements must complete in the order they were typed. Against a
//      database, out-of-order is writes landing in an order nobody wrote, and it
//      is invisible until it matters. It was the first version's behavior.
//   2. The standing must be legible. A console that does not say what it is
//      running as is a god-mode console with an extra flag, and every claim this
//      command makes rests on the prompt being true.

import { describe, it, expect } from 'bun:test'
import { PassThrough }          from 'node:stream'
import { startRepl, describeStanding } from '../src/tools/repl.js'

/** Drive a session: feed lines, collect what it printed. */
async function session(lines: string[], binds: any = {}) {
  const input  = new PassThrough()
  const output = new PassThrough()
  const said: string[] = []

  // readline reads process.stdin in the real command; the streams go in here so
  // a test needs no terminal.
  const realIn  = process.stdin
  const realOut = process.stdout
  Object.defineProperty(process, 'stdin',  { value: input,  configurable: true })
  Object.defineProperty(process, 'stdout', { value: output, configurable: true })

  try {
    const done = startRepl({
      db:        binds.db  ?? {},
      sys:       binds.sys ?? {},
      standing:  binds.standing ?? 'anonymous(0)',
      accessors: binds.accessors ?? ['order'],
      out:       (l: string) => said.push(l),
    })
    for (const line of lines) input.write(`${line}\n`)
    input.end()
    await done
  } finally {
    Object.defineProperty(process, 'stdin',  { value: realIn,  configurable: true })
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true })
  }

  return said.join('\n')
}

describe('a statement finishes before the next one starts', () => {
  it('a slow line then a fast one answer in the order they were typed', async () => {
    const order: string[] = []
    const db = {
      slow: () => new Promise(r => setTimeout(() => { order.push('slow'); r('slow') }, 40)),
      fast: () => { order.push('fast'); return 'fast' },
    }

    // The failure this is here for: `rl.pause()` does NOT hold back lines that
    // are already buffered, so both handlers ran and the fast one finished
    // first. Piped input and a pasted block are the same thing to readline.
    await session(['await db.slow()', 'db.fast()'], { db })

    expect(order).toEqual(['slow', 'fast'])
  })

  it('a session that closes mid-statement waits for it', async () => {
    let finished = false
    const db = { slow: () => new Promise(r => setTimeout(() => { finished = true; r(1) }, 40)) }

    await session(['await db.slow()'], { db })

    expect(finished).toBe(true)
  })
})

describe('what the prompt says it is', () => {
  it('names the person and the level they were graded at', () => {
    expect(describeStanding({ label: 'alice@x.com', graded: 4 })).toBe('alice@x.com(4)')
  })

  it('a synthetic standing reads differently from a graded one', () => {
    // Not cosmetic: `--level` never asked the app's resolver, so a ladder walked
    // with it says nothing about whether that resolver works.
    expect(describeStanding({ graded: 4, synthetic: true })).toBe('level 4')
    expect(describeStanding({ label: 'alice@x.com', graded: 4, synthetic: true })).toBe('alice@x.com@4')
  })

  it('no standing at all is STRANGER, said rather than left blank', () => {
    expect(describeStanding({})).toBe('anonymous(0)')
  })
})

describe('evaluating', () => {
  it('a bare expression answers its value, without a return', async () => {
    const out = await session(['1 + 1'])
    expect(out).toContain('2')
  })

  it('top-level await works', async () => {
    const out = await session(['await db.count()'], { db: { count: async () => 7 } })
    expect(out).toContain('7')
  })

  it('a body with a statement in it needs no parenthesising', async () => {
    const out = await session(['const n = 2; return n * 3'])
    expect(out).toContain('6')
  })

  it('a throw prints the message, not a stack from inside the client', async () => {
    const db = { boom: () => { const e: any = new Error('"Order.create" requires level 4'); e.name = 'AccessDeniedError'; throw e } }
    const out = await session(['db.boom()'], { db })

    expect(out).toContain('AccessDeniedError: "Order.create" requires level 4')
    expect(out).not.toContain('at ')
  })

  it('the session survives a throw', async () => {
    const out = await session(['nope()', '1 + 1'])
    expect(out).toContain('2')
  })
})

describe('printing a row', () => {
  it('a Date survives, where JSON.stringify would have dropped or mangled it', async () => {
    const out = await session(['db.row()'], { db: { row: () => ({ createdAt: new Date('2026-08-15T00:00:00.000Z') }) } })
    expect(out).toContain('2026-08-15T00:00:00.000Z')
  })

  it('a BigInt does not throw the session', async () => {
    const out = await session(['db.row()'], { db: { row: () => ({ n: 9007199254740993n }) } })
    expect(out).toContain('9007199254740993n')
  })

  it('undefined and null are said, not printed as an empty line', async () => {
    expect(await session(['undefined'])).toContain('undefined')
    expect(await session(['null'])).toContain('null')
  })

  it('bytes are summarized rather than dumped', async () => {
    const out = await session(['db.row()'], { db: { row: () => ({ blob: new Uint8Array(2048) }) } })
    expect(out).toContain('<2048 bytes>')
  })
})

describe('dot commands', () => {
  it('.standing answers what the prompt already says, for a scrolled-away session', async () => {
    const out = await session(['.standing'], { standing: 'alice@x.com(4)' })
    expect(out).toContain('alice@x.com(4)')
  })

  it('.help names both clients, because sys is the one nobody would guess', async () => {
    const out = await session(['.help'])
    expect(out).toContain('sys')
    expect(out).toContain('asSystem()')
  })

  it('.help lists ACCESSORS, camelCase singular — a shipped bug printed `db.User.`', async () => {
    const out = await session(['.help'], { accessors: ['user', 'post'] })
    expect(out).toMatch(/accessors\s+[^\n]*\buser\b/)
    expect(out).not.toContain('User')
  })
})
