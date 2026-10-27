// The console — `litestone repl` / `fli db:repl`.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync }            from 'node:child_process'
import { tmpdir }               from 'node:os'
import { join, resolve }        from 'node:path'
import { startRepl, evalOnce, describeStanding, replCommands } from '../src/tools/repl.js'

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
      binds:     binds.binds ?? { db: binds.db ?? {}, sys: binds.sys ?? {} },
      names:     binds.names,
      history:   binds.history ?? join(tmpdir(), `litestone-repl-test-${process.pid}`),
      commandsFrom: binds.commandsFrom,
      standing:  binds.standing ?? 'anonymous(0)',
      accessors: binds.accessors ?? ['order'],
      commands:  binds.commands ?? {},
      tenant:    binds.tenant ?? null,
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

  it('a body with a statement in it needs no parenthesizing', async () => {
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

describe("an app's own commands — db/repl.js", () => {
  it('.name runs the command with the clients, the words after it, and the tenant', async () => {
    let seen: any
    const commands = { resetPasswords: { help: 'set them all', run: async (ctx: any) => { seen = ctx; ctx.out('  done') } } }
    const db = { who: 'db' }, sys = { who: 'sys' }

    const out = await session(['.resetPasswords hunter2 --force'], { db, sys, commands, tenant: 'flagship' })

    expect(seen.args).toEqual(['hunter2', '--force'])
    expect(seen.sys).toBe(sys)
    expect(seen.db).toBe(db)
    expect(seen.tenant).toBe('flagship')
    expect(out).toContain('done')
  })

  it('an unknown .name is refused by name and never evaluated — paired with a known one running', async () => {
    let ran = 0
    const commands = { purge: { run: async () => { ran++ } } }

    const out = await session(['.prge', '.purge'], { commands })

    expect(out).toContain('No command .prge')
    expect(out).not.toContain('SyntaxError')
    expect(ran).toBe(1)
  })

  it('a command that throws prints the message and the session goes on', async () => {
    const commands = { boom: { run: async () => { throw new Error('refused: production') } } }
    const out = await session(['.boom', '1 + 1'], { commands })

    expect(out).toContain('Error: refused: production')
    expect(out).toContain('2')
  })

  it('runs in the order typed, like any other line', async () => {
    const order: string[] = []
    const commands = { slow: { run: () => new Promise<void>(r => setTimeout(() => { order.push('slow'); r() }, 40)) } }
    await session(['.slow', 'db.fast()'], { commands, db: { fast: () => order.push('fast') } })
    expect(order).toEqual(['slow', 'fast'])
  })

  it('.help lists each command with its help, and says where they come from when there are none', async () => {
    const withOne = await session(['.help'], { commands: { resetPasswords: { help: 'every password to one value', run: async () => {} } } })
    expect(withOne).toMatch(/\.resetPasswords\s+every password to one value/)

    expect(await session(['.help'])).toContain('db/repl.js')
  })
})

describe('replCommands — what the file must look like', () => {
  const ok = { resetPasswords: { help: 'h', run: async () => {} } }

  it('a table of { help, run } is accepted', () => {
    expect(replCommands({ default: ok })).toBe(ok)
  })

  it('no default export is refused, naming the shape', () => {
    expect(() => replCommands({ resetPasswords: ok.resetPasswords })).toThrow('export default an object')
  })

  it('a bare function is refused — beside the same function inside { run } accepted', () => {
    const fn = async () => {}
    expect(() => replCommands({ default: { purge: fn } })).toThrow('.purge needs a run function')
    expect(() => replCommands({ default: { purge: { run: fn } } })).not.toThrow()
  })

  it('a built-in name is refused — beside the same command under another name', () => {
    expect(() => replCommands({ default: { exit: ok.resetPasswords } })).toThrow('.exit is built in')
    expect(() => replCommands({ default: { leave: ok.resetPasswords } })).not.toThrow()
  })

  it('a name with a space is refused — beside a hyphenated one', () => {
    expect(() => replCommands({ default: { 'reset all': ok.resetPasswords } })).toThrow('not a command name')
    expect(() => replCommands({ default: { 'reset-all': ok.resetPasswords } })).not.toThrow()
  })
})

describe('evalOnce — fli db:repl -e', () => {
  const run = async (code: string, binds: any = {}) => {
    const out: string[] = [], err: string[] = []
    const exit = await evalOnce({ code, binds: { db: {}, sys: {}, ...binds.binds }, ...binds, out: (l: string) => out.push(l), err: (l: string) => err.push(l) })
    return { exit, out: out.join('\n'), err: err.join('\n') }
  }

  it('answers unindented JSON, so a pipe into jq reads it', async () => {
    const r = await run('({ a: [1, 2] })')
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ a: [1, 2] })
    expect(r.out.startsWith('{')).toBe(true)
  })

  it('a dot command runs with the words after it — an unknown one exits 1 naming the known', async () => {
    let seen: any
    const commands = { purge: { help: '', run: async (ctx: any) => { seen = ctx.args; ctx.out('done') } } }

    const known = await run('.purge 30', { commands })
    expect(known.exit).toBe(0)
    expect(seen).toEqual(['30'])
    expect(known.out).toBe('done')

    const unknown = await run('.purj 30', { commands })
    expect(unknown.exit).toBe(1)
    expect(unknown.err).toContain('No command .purj. Known: .purge')
  })

  it('a command that throws exits 1 — its answer is not a success', async () => {
    const commands = { boom: { help: '', run: async () => { throw new TypeError('bad') } } }
    const r = await run('.boom', { commands })
    expect(r.exit).toBe(1)
    expect(r.err).toContain('TypeError: bad')
  })
})

// Junction's app prompt opens this loop over names of its own (`FJS-D1532`).
// What it reads off a session must be what that caller bound — a `.help`
// naming `db` in a session that has no `db` sends the operator after a name
// that throws.
describe('a session over names of its own — junction call', () => {
  it('evaluates against the binds and nothing else', async () => {
    const said = await session(['app.name', 'typeof db'], { binds: { app: { name: 'shop' } } })
    expect(said).toContain('"shop"')
    expect(said).toContain('"undefined"')
  })

  it('.help lists exactly the binds, each with the caller\'s line', async () => {
    const said = await session(['.help'], { binds: { app: {} }, names: { app: 'the booted app' }, commandsFrom: null })
    expect(said).toContain('app         the booted app')
    expect(said).not.toContain('asSystem()')
    expect(said).not.toContain('db/repl.js')
  })

  it('reads a standing function before every prompt, so .standing follows it', async () => {
    let who = 'alice(4)'
    const said = await session(['.standing', 'switchTo()', '.standing'], {
      binds: { switchTo: () => { who = 'ops(5)' } }, standing: () => who,
    })
    expect(said).toContain('alice(4)')
    expect(said).toContain('ops(5)')
  })

  it('writes history to the file it was handed', async () => {
    const file = join(tmpdir(), `litestone-repl-history-${process.pid}`)
    rmSync(file, { force: true })
    await session(['1 + 1'], { history: file })
    expect(readFileSync(file, 'utf8')).toBe('1 + 1\n')
    rmSync(file, { force: true })
  })
})

// `FJS-D1534`, through the real command: a `sys` write is filed under whoever is
// at the keyboard, a `db` write under the standing. PAIRED — a swap that fired
// on every write from the console passes the first row and fails the second,
// and one that read `--as` as the operator fails the third.
describe('litestone repl files a sys write under the operator', () => {
  const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')
  const SCHEMA = `
    database main  { path "./main.db" }
    database audit { path "./audit/" driver trail }
    model User  { id Int @id  email String @unique  @@auth  @@gate(0)  @@trail(audit) }
    model Thing { id Int @id  name String  @@gate(0)  @@trail(audit) }
  `
  let dir = ''
  const repl = (code: string, ...args: string[]) => spawnSync('bun', [CLI, 'repl', '--schema', 'schema.lite', '--eval', code, ...args],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, USER: 'op-test' } })
  const last = () => readFileSync(join(dir, 'audit', 'AuditTrail.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)

  it('sys files the operator, typed repl; db at --as files the standing; sys under --as still the operator', () => {
    dir = mkdtempSync(join(tmpdir(), 'litestone-repl-actor-'))
    try {
      writeFileSync(join(dir, 'schema.lite'), SCHEMA)
      expect(spawnSync('bun', [CLI, 'migrate', 'dev', '--schema', 'schema.lite'], { cwd: dir }).status).toBe(0)

      expect(repl(`sys.user.create({ data: { email: 'a@x.test' } })`).status).toBe(0)
      expect(last()).toMatchObject({ model: 'User', actorId: 'op-test', actorType: 'repl' })

      expect(repl(`db.thing.create({ data: { name: 'mine' } })`, '--as', 'a@x.test').status).toBe(0)
      expect(last()).toMatchObject({ model: 'Thing', actorId: 1, actorType: 'user' })

      expect(repl(`sys.thing.create({ data: { name: 'by hand' } })`, '--as', 'a@x.test').status).toBe(0)
      expect(last()).toMatchObject({ model: 'Thing', actorId: 'op-test', actorType: 'repl' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
})
