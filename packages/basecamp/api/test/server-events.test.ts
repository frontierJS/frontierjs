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

const ROOT      = join(import.meta.dir, '..', '..')
const SCHEMA    = join(ROOT, 'db', 'schema.lite')
const MIGRATION = join(ROOT, 'db', 'migrations', 'main', '20260801000000_initial_schema.sql')
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
 * — `exitCode === 0 ? 'recipe_ran' : 'recipe_failed'`.
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

    for (const m of text.matchAll(/record(?:Server)?Event\(\s*[^,]+,\s*(?:[^,]+,\s*)?'([a-z_]+)'/g))
      note(m[1], short)
    for (const m of text.matchAll(
      /record(?:Server)?Event\(\s*[^,]+,\s*(?:[^,]+,\s*)?[^,()]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g,
    )) { note(m[1], short); note(m[2], short) }
    // `serverEvent.create({ data: { serverId, kind: 'x', … } })`, where the
    // literal may be several lines down from the accessor.
    for (const m of text.matchAll(/serverEvent\.create\(\{[\s\S]{0,240}?kind:\s*'([a-z_]+)'/g))
      note(m[1], short)
    // The two named-argument helpers, which pass a kind through an options bag.
    for (const m of text.matchAll(/kind:\s*'([a-z_]+)',\s*message:/g))
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
    const user = await sys.user.create({ data: { email: `e-${uniq}@x.co`, accountId: acct.id } })
    const ws   = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq}`, ownerId: user.id },
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
      data: { serverId: server.id, kind: 'provision_requested', message: 'fine' },
    })
    expect(good.kind).toBe('provision_requested')

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
