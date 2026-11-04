// api/test/server-events.test.ts
// One machine's history, and the vocabulary it is written in.
//
// `ServerEvent.kind` was a free `String`. Twenty-eight values had accumulated
// across six files with no list anywhere, so *what can happen to a machine* was
// answerable only by grepping — and `servers.logEvent` takes the kind off a
// payload, with `recordServerEvent` swallowing a failed write, so a misspelled
// kind landed as a row and rendered on the machine's own trail as whatever had
// been typed.
//
// Two tiers, and the second is the one that keeps the first true.
//
// **The column refuses** — the enum reaches SQLite as a CHECK, so a value
// outside the vocabulary cannot be stored even by `asSystem()`.
//
// **The SOURCE and the enum are one list.** An enum is only an owner while
// every writer uses it; a kind written by a literal that the schema has never
// heard of is a row that fails at runtime, quietly, because the job seam warns
// rather than throws. This scans what the app actually writes and holds the two
// together — in BOTH directions, since a declared value nothing writes is a
// vocabulary that has outlived its code just as surely.

import { test, expect, describe } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv } from '@frontierjs/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { runtimeEdges, stampRestarts } from '../src/domain/host/runtime.ts'

const ROOT      = join(import.meta.dir, '..', '..')
const SCHEMA    = join(ROOT, 'db', 'schema.lite')
// The current DDL, not the first migration: a migration is history and keeps the spelling an enum had when it was written.
const MIGRATION = join(ROOT, 'db', 'ddl.snapshot.sql')
const SRC       = join(ROOT, 'api', 'src')

/** The enum, read out of the schema rather than typed here — a second copy in
 *  this file would be the thing the file exists to prevent. */
function declaredKinds(): string[] {
  const text  = readFileSync(SCHEMA, 'utf8')
  const start = text.indexOf('enum ServerEventKind {')
  const body  = text.slice(start, start + text.slice(start).indexOf('}'))
  return body
    .split('\n').slice(1)
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Every kind this app writes, read off the source.
 *
 * Four shapes, because there are four ways a line is written and a scan that
 * knew three of them would report the fourth as absent: the services' own
 * `recordEvent(id, 'x', …)`, the job seam's
 * `recordServerEvent(app, id, 'x', …)`, a direct
 * `serverEvent.create({ data: { kind: 'x' } })`, and a kind CHOSEN at the call
 * — `exitCode === 0 ? 'recipeRan' : 'recipeFailed'`.
 *
 * The ternary is anchored to the call rather than matched on its own: there
 * are ten snake_case ternaries under `api/src/` and nine of them are about
 * something else, so a free-standing pattern would report `debug`, `resolve`
 * and `api_key` as undeclared event kinds and fail this file for a reason that
 * has nothing to do with a machine's history.
 */
function writtenKinds(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const note  = (kind: string, file: string) => {
    const at = found.get(kind) ?? []
    if (!at.includes(file)) at.push(file)
    found.set(kind, at)
  }

  for (const file of walk(SRC)) {
    const text  = readFileSync(file, 'utf8')
    const short = file.slice(ROOT.length + 1)

    for (const m of text.matchAll(/record(?:Server)?Event\(\s*[^,]+,\s*(?:[^,]+,\s*)?'([A-Za-z_]+)'/g))
      note(m[1], short)
    for (const m of text.matchAll(
      /record(?:Server)?Event\(\s*[^,]+,\s*(?:[^,]+,\s*)?[^,()]*\?\s*'([A-Za-z_]+)'\s*:\s*'([A-Za-z_]+)'/g,
    )) { note(m[1], short); note(m[2], short) }
    // `serverEvent.create({ data: { serverId, kind: 'x', … } })`, where the
    // literal may be several lines down from the accessor.
    for (const m of text.matchAll(/serverEvent\.create\(\{[\s\S]{0,240}?kind:\s*'([A-Za-z_]+)'/g))
      note(m[1], short)
    // The two named-argument helpers, which pass a kind through an options bag.
    for (const m of text.matchAll(/kind:\s*'([A-Za-z_]+)',\s*message:/g))
      note(m[1], short)
  }
  return found
}

describe('a machine\'s history is written in one vocabulary', () => {
  test('the enum reaches SQLite as a CHECK, so the column enforces it too', () => {
    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "server_event"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    expect(table).toContain('CHECK ("kind" IN (')
    for (const kind of declaredKinds()) expect(table).toContain(`'${kind}'`)
  })

  test('a kind outside the vocabulary is refused by the column, and a declared one is not', async () => {
    const env: any = await createTestEnv({
      schema: SCHEMA, migrations: join(ROOT, 'db', 'migrations'),
      encryptionKey: '0'.repeat(64),
      plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    })
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `ev-${uniq}`, displayName: 'Ev' } })
    await sys.user.create({ data: { email: `e-${uniq}@x.co`, accountId: acct.id } })
    const ws   = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq}` },
    })
    const server = await sys.server.create({
      data: { workspaceId: ws.id, name: 'ev-01', slug: `ev-${uniq}` },
    })

    // `asSystem()`, deliberately: a CHECK is below the API, so the strongest
    // claim is that the most privileged client there is cannot get past it.
    await expect(sys.serverEvent.create({
      data: { serverId: server.id, kind: 'provision_requsted', message: 'typo' },
    })).rejects.toThrow()

    // The pair. A column that refused everything would satisfy the row above,
    // and it is one character away from what a bad enum looks like.
    const good = await sys.serverEvent.create({
      data: { serverId: server.id, kind: 'provisionRequested', message: 'fine' },
    })
    expect(good.kind).toBe('provisionRequested')

    await env.close()
  })

  test('every kind the app WRITES is declared, and every declared kind is written', () => {
    const declared = new Set(declaredKinds())
    const written  = writtenKinds()

    // The control, and it is the assertion that keeps the two below honest: a
    // scan that matched nothing passes both directions vacuously, which is
    // exactly what a tripwire reading the wrong shape looks like.
    expect(written.size).toBeGreaterThan(20)
    expect(declared.size).toBeGreaterThan(20)

    // A kind the code writes and the schema does not know is a row that fails
    // at runtime — and the job seam warns rather than throwing, so it fails
    // where nobody is looking.
    const undeclared = [...written.entries()]
      .filter(([kind]) => !declared.has(kind))
      .map(([kind, files]) => `${kind} (${files.join(', ')})`)
    expect(undeclared).toEqual([])

    // And the other way: a value nothing writes is a vocabulary that outlived
    // its code, which is the state this enum was created out of.
    expect([...declared].filter(k => !written.has(k))).toEqual([])
  })
})

describe('a runtime reading files an event on each edge, and only there', () => {
  const box  = (o: Record<string, unknown> = {}) => ({ app_id: 'a1', name: 'fjs--p-prod-shop-a1', image: 'shop:1',
    state: 'running', status: 'Up', restart_count: 0, started_at: null, oom_killed: false, exit_code: 0, replaced: false, ...o })
  const unit = (active = 'active') => ({ unit: 'caddy-api', load: 'loaded', active, sub: null, since: null })
  const read = (o: Record<string, unknown> = {}) => ({ boot_id: 'b1', containers: [box()], units: [unit()], ...o }) as any
  const kinds = (a: any, b: any) => runtimeEdges(a, b, id => (id === 'a1' ? 'shop' : undefined)).map(e => e.kind)

  test('a null reading on either side fires nothing', () => {
    const down = read({ boot_id: 'b2', containers: [box({ state: 'restarting' })], units: [unit('failed')] })
    expect(kinds(null, down)).toEqual([])
    expect(kinds(down, null)).toEqual([])
    // Nor a null part: a box that could not read docker is not a box whose containers recovered.
    expect(kinds(read({ containers: null, units: null, boot_id: null }), down)).toEqual([])
    expect(kinds(down, read({ containers: null, units: null, boot_id: null }))).toEqual([])
  })

  test('a rise in restart_count files containerCrashLooping once, and the next beat with the same count nothing', () => {
    const first  = read()
    const second = read({ containers: [box({ restart_count: 1 })] })
    const edges  = runtimeEdges(first, second, () => 'shop')
    expect(edges.map(e => e.kind)).toEqual(['containerCrashLooping'])
    expect(edges[0].message).toContain('shop restarted 1 time(s)')
    expect(edges[0].metadata).toMatchObject({ app_id: 'a1', restart_count: 1 })
    expect(kinds(second, read({ containers: [box({ restart_count: 1 })] }))).toEqual([])
  })

  test('a live container stopping and coming back is the pair, and a set-aside is neither', () => {
    const stopped = read({ containers: [box({ state: 'exited', exit_code: 137 })] })
    expect(kinds(read(), stopped)).toEqual(['containerCrashLooping'])
    expect(kinds(stopped, stopped)).toEqual([])
    expect(kinds(stopped, read())).toEqual(['containerRecovered'])
    expect(kinds(read(), read({ containers: [box(), box({ name: 'x_replaced', state: 'exited', replaced: true })] }))).toEqual([])
  })

  test('a unit leaving active files unitFailed, and coming back unitRestored', () => {
    expect(kinds(read(), read({ units: [unit('failed')] }))).toEqual(['unitFailed'])
    expect(kinds(read({ units: [unit('failed')] }), read())).toEqual(['unitRestored'])
  })

  test('a changed boot_id files rebooted', () => {
    const edges = runtimeEdges(read(), read({ boot_id: 'b2' }))
    expect(edges.map(e => e.kind)).toEqual(['rebooted'])
    expect(edges[0].metadata).toEqual({ from: 'b1', to: 'b2' })
  })
})

describe('stampRestarts — what the receiver stores (FJS-D1860)', () => {
  const T0 = '2026-11-04T07:00:00.000Z', T1 = '2026-11-04T07:00:30.000Z', T2 = '2026-11-04T07:01:00.000Z'
  const box = (o: Record<string, unknown> = {}) => ({ app_id: 'a1', name: 'c1', image: 'i', state: 'running', status: 'Up',
    restart_count: 0, started_at: T0, oom_killed: false, exit_code: 0, replaced: false, ...o }) as any
  const read = (containers: any[] | null) => ({ boot_id: 'b', containers, units: [] }) as any

  test('no prior reading, or no count on either side, stamps null — unknown, never zero', () => {
    expect(stampRestarts(null, read([box()]), T0).containers![0]).toMatchObject({ restartsSinceLast: null, restartedAt: null })
    expect(stampRestarts(read([box({ restart_count: null })]), read([box()]), T1).containers![0]).toMatchObject({ restartsSinceLast: null, restartedAt: null })
  })

  test('a rise is stamped with its size and the beat that saw it', () => {
    const stored = stampRestarts(read([box()]), read([box({ restart_count: 2 })]), T1).containers![0]
    expect(stored).toMatchObject({ restartsSinceLast: 2, restartedAt: T1 })
  })

  test('the next quiet beat carries the stamp forward, so the hold window outlives one beat', () => {
    const first  = stampRestarts(read([box()]), read([box({ restart_count: 2 })]), T1)
    const second = stampRestarts(first, read([box({ restart_count: 2 })]), T2).containers![0]
    expect(second).toMatchObject({ restartsSinceLast: 2, restartedAt: T1 })
  })

  test('a lower count under the same name is a swap, stamped as no restart', () => {
    expect(stampRestarts(read([box({ restart_count: 5 })]), read([box({ restart_count: 0 })]), T1).containers![0]).toMatchObject({ restartsSinceLast: 0, restartedAt: null })
  })

  test('a reading with no container part is stored as it came', () => {
    expect(stampRestarts(read([box()]), read(null), T1).containers).toBeNull()
  })
})
