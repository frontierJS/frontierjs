/*
 * test/argv.test.ts — every tool two real apps publish, read as a command line.
 *
 * The fixtures are `tools/list` captured over a real MCP client from `example`
 * (administrator) and `basecamp` (owner, with its workspace header) — 526 tools
 * whose schemas nobody here wrote for this test. A hand-written schema agrees
 * with the parser it was written beside; these are what the generator actually
 * emits, `anyOf` nullables, operator branches, `$ref`s and all.
 *
 * The sharpest row is the round trip: a command line built from each tool's own
 * flags is parsed back and handed to `fromJsonSchema` — the SAME validator the
 * server runs before dispatch. A parse that typed a value wrongly is refused
 * there exactly as the person's call would be.
 *
 * Recapture after the projection changes what it emits: the two `verify:mcp`
 * drives boot each app; the capture is `client.listTools()` at the standing the
 * fixture names, written as `{ captured, how, tools }`.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { fromJsonSchema }         from '@modelcontextprotocol/server'
import { commandFor, parseArgs, ArgvError, type Command, type ToolListing } from '../src/client/argv.ts'

const load = (name: string): ToolListing[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/tools/${name}.json`, import.meta.url), 'utf8')).tools

const APPS = { example: load('example-admin'), basecamp: load('basecamp-owner') }
const ALL  = [...APPS.example, ...APPS.basecamp]

const tool = (app: keyof typeof APPS, name: string) => {
  const t = APPS[app].find(x => x.name === name)
  if (!t) throw new Error(`fixture has no ${name} — recapture, or pick another tool`)
  return t
}
const cmd  = (app: keyof typeof APPS, name: string) => commandFor(tool(app, name))

const validate = (t: ToolListing, args: unknown) => {
  const r = fromJsonSchema((t.inputSchema ?? {}) as never)['~standard'].validate(args) as
    { value?: unknown; issues?: Array<{ message: string }> }
  return r.issues ? r.issues.map(i => i.message).join('; ') : null
}

// ─── a sample value per schema ───────────────────────────────────────────────

type S = Record<string, any>

function sample(s: S, defs: S): unknown {
  if (s.$ref) return sample(defs[String(s.$ref).split('/').pop()!] ?? {}, defs)
  if (Array.isArray(s.anyOf)) return sample(s.anyOf.find((b: S) => b.type !== 'null') ?? {}, defs)
  if (Array.isArray(s.enum)) return s.enum.find((v: unknown) => v !== null)
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type
  switch (type) {
    case 'string':
      if (s.format === 'email')     return 'a@b.co'
      if (s.format === 'date')      return '2026-01-01'
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z'
      return 'x'.repeat(Math.max(1, s.minLength ?? 1))
    case 'integer': return Math.max(1, s.minimum ?? 1)
    case 'number':  return Math.max(1, s.minimum ?? 1)
    case 'boolean': return true
    case 'array':   return []
    case 'object': {
      const out: S = {}
      for (const k of s.required ?? []) out[k] = sample(s.properties?.[k] ?? {}, defs)
      return out
    }
    default: return 'x'
  }
}

const schemaOf = (t: ToolListing, c: Command, slot: string, name: string): S => {
  const p = (t.inputSchema as S).properties
  return slot === 'args' ? p[name] : p[slot].properties[name]
}

/** Every flag the command offers, set to a value its schema accepts. */
function argvFor(t: ToolListing, c: Command): string[] {
  const defs = ((t.inputSchema as S).$defs ?? {}) as S
  const argv: string[] = []
  if (c.id) argv.push('7')
  for (const f of c.flags) {
    const v = sample(schemaOf(t, c, f.slot, f.name), defs)
    if (f.type === 'boolean') { argv.push(`--${f.name}`); continue }
    argv.push(`--${f.name}`, f.type === 'json' ? JSON.stringify(v) : String(v))
  }
  return argv
}

// ─── every tool ──────────────────────────────────────────────────────────────

describe('every published tool is a command', () => {

  test('the fixtures are the size of two real apps, so a vacuous pass is impossible', () => {
    expect(APPS.example.length).toBeGreaterThan(100)
    expect(APPS.basecamp.length).toBeGreaterThan(100)
  })

  test('each reads as `service method` and reproduces its own tool name', () => {
    for (const t of ALL) {
      const c = commandFor(t)
      expect(c.method, t.name).not.toBe('')
      expect(`${c.service}_${c.method}`).toBe(t.name)
    }
  })

  test('every top-level argument is reachable — an id, a flag, or the whole-payload flag', () => {
    for (const t of ALL) {
      const c = commandFor(t)
      for (const k of Object.keys((t.inputSchema as S)?.properties ?? {})) {
        // A server-owned column is not a flag, so it is reached through the whole
        // payload or not at all — and not at all is the Data boundary's call.
        const readOnly = (t.inputSchema as S).properties[k].readOnly === true
        const reached = k === 'id' ? !!c.id
          : k === c.whole?.name || k === 'directives' || c.flags.some(f => f.name === k)
            || readOnly
        expect(reached, `${t.name}: '${k}'`).toBe(true)
      }
    }
  })

  test('every flag set at once parses, and the server\'s own validator takes the result', () => {
    const refused: string[] = []
    for (const t of ALL) {
      const c = commandFor(t)
      const args = parseArgs(c, argvFor(t, c))
      const why  = validate(t, args)
      if (why) refused.push(`${t.name}: ${why}`)
    }
    expect(refused).toEqual([])
  })

  test('a tool with no described payload still takes one, through --data', () => {
    const undescribed = ALL.map(commandFor).filter(c => c.payload === 'undescribed')
    expect(undescribed.length).toBeGreaterThan(0)
    for (const c of undescribed) expect(c.whole, c.tool).not.toBeNull()
  })
})

// ─── what a value means ──────────────────────────────────────────────────────

describe('the schema types each value', () => {
  const find = cmd('example', 'orders_find')

  test('a find: a filter, an operator in bracket notation, and a directive, each in its own slot', () => {
    expect(parseArgs(find, ['--status', 'paid', '--subtotal[gte]', '1000', '--limit', '5'])).toEqual({
      query:      { status: 'paid', subtotal: { gte: 1000 } },
      directives: { limit: 5 },
    })
  })

  test('a list operator is a list of the column\'s own values', () => {
    expect(parseArgs(find, ['--status[in][]', 'paid', '--status[in][]', 'shipped'])).toEqual({
      query: { status: { in: ['paid', 'shipped'] } },
    })
  })

  test('a string column keeps 0012 as text — the URL reading would have made it 12', () => {
    expect(parseArgs(find, ['--reference', '0012'])).toEqual({ query: { reference: '0012' } })
  })

  test('an untyped directive reads as the URL does, bracket notation included', () => {
    expect(parseArgs(find, ['--orderBy[createdAt]', 'desc'])).toEqual({ directives: { orderBy: { createdAt: 'desc' } } })
    expect(parseArgs(find, ['--orderBy', 'createdAt'])).toEqual({ directives: { orderBy: 'createdAt' } })
  })

  test('refused by name: a non-number for an integer, and an enum value the column does not have', () => {
    expect(() => parseArgs(find, ['--limit', '12a'])).toThrow(/--limit takes a whole number/)
    expect(() => parseArgs(find, ['--status', 'lost'])).toThrow(/--status is one of pending, paid/)
  })

  test('an unknown flag is refused, naming the flag and what the command takes', () => {
    let err: unknown
    try { parseArgs(find, ['--statsu', 'paid']) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ArgvError)
    expect((err as ArgvError).flag).toBe('statsu')
    expect((err as Error).message).toMatch(/--status/)
  })

  test('a server-owned column is not a flag on a write — refused rather than sent and dropped', () => {
    const create = cmd('example', 'orders_create')
    expect(() => parseArgs(create, ['--subtotal', '5'])).toThrow(/unknown flag --subtotal/)
    expect(parseArgs(create, ['--reference', 'ORD-9', '--customerId', '3'])).toEqual({ reference: 'ORD-9', customerId: 3 })
  })

  test('null clears a nullable column, and "null" in quotes is the four letters', () => {
    const create = cmd('example', 'orders_create')
    expect(parseArgs(create, ['--note', 'null'])).toEqual({ note: null })
    expect(parseArgs(create, ['--note', '"null"'])).toEqual({ note: 'null' })
  })
})

// ─── ids and payloads ────────────────────────────────────────────────────────

describe('an id and a payload', () => {

  test('a move takes its id as the first bare word, and refuses to run without one', () => {
    const reboot = cmd('basecamp', 'servers_reboot')
    expect(parseArgs(reboot, ['srv-1'])).toEqual({ id: 'srv-1' })
    expect(parseArgs(reboot, ['--id', 'srv-1'])).toEqual({ id: 'srv-1' })
    expect(() => parseArgs(reboot, [])).toThrow(/needs an id: servers reboot <id>/)
    expect(() => parseArgs(reboot, ['a', 'b'])).toThrow(/unexpected argument 'b'/)
  })

  test('an undescribed payload is --data only: JSON, @file or stdin', () => {
    const role = cmd('basecamp', 'workspaces_setMemberRole')
    expect(role.payload).toBe('undescribed')
    expect(parseArgs(role, ['ws-1', '--data', '{"role":"admin"}'])).toEqual({ id: 'ws-1', data: { role: 'admin' } })
    expect(parseArgs(role, ['ws-1', '--data', '@role.json'], { readFile: p => p === 'role.json' ? '{"role":"viewer"}' : '' }))
      .toEqual({ id: 'ws-1', data: { role: 'viewer' } })
    expect(parseArgs(role, ['ws-1', '--data', '-'], { readStdin: () => '{"role":"developer"}' }))
      .toEqual({ id: 'ws-1', data: { role: 'developer' } })
    expect(() => parseArgs(role, ['ws-1', '--role', 'admin'])).toThrow(/unknown flag --role/)
  })

  test('a described payload is flags, and a flag wins over the --data it is written beside', () => {
    const discount = cmd('example', 'carts_applyDiscount')
    expect(discount.payload).toBe('flags')
    expect(parseArgs(discount, ['9', '--data', '{"code":"OLD"}', '--code', 'SPRING'])).toEqual({ id: '9', data: { code: 'SPRING' } })
  })

  test('JSON that is not JSON is refused naming the flag', () => {
    const role = cmd('basecamp', 'workspaces_setMemberRole')
    expect(() => parseArgs(role, ['ws-1', '--data', '{role:admin}'])).toThrow(/--data takes JSON/)
  })
})
