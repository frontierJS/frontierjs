/*
 * test/audit-raw-smuggle.test.ts — AUDIT 1.2 (2026-10-05). EXPECTED TO FAIL.
 *
 * Attack brief, Invariant 10: "no `$`-prefixed key survives the bridge; an
 * unknown one is refused by name". The HTTP/WS bridge strips every `$`-key via
 * `splitParams`. The MCP surface dispatches `find` through `app.service().find`
 * in-process (never through `bridge.toContext()`), so a `$`-key in the `query`
 * tool argument reaches Litestone verbatim. `$raw` is NOT an unknown key the
 * Data boundary refuses — it is Litestone's raw-SQL escape hatch, executed for
 * ANY caller. So a stranger with a single ungraded `*_find` tool can run SQL as
 * a boolean/subquery oracle over `@guarded` columns and over tables whose
 * `@@gate` forbids the caller entirely.
 *
 * These tests assert the SECURE behavior (the oracle does not work). They fail
 * against the current surface, which executes the `$raw`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createClient }  from '@frontierjs/litestone'
import { createApp, createService } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const SCHEMA = readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string

beforeAll(async () => {
  const db = await createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: '0'.repeat(64) }) as Record<string, never>
  const auth = createStubAuth({ users: [{ id: 'staff', isAdmin: true }] })
  app = createApp({
    db, auth,
    config:   { port: 0, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  }) as never

  // Credential has NO @@gate — an ordinary "33 of 76 models" shape — so its
  // find tool is offered even to a stranger. Ledger reads at 5.
  app.services.register(createService({ name: 'credentials', model: 'Credential', methods: ['find'] }))
  app.services.register(createService({ name: 'ledgers', model: 'Ledger', methods: ['find'] }))
  app.configure(mcpPlugin({ name: 'shop' }))
  await app.start()
  base = `http://localhost:${app.http.port}/mcp`

  const system = (db as unknown as { asSystem(): Record<string, { create(a: unknown): Promise<unknown> }> }).asSystem()
  await system.credential!.create({ data: { id: 7, label: 'prod-key', value: 'hunter2', scope: 'admin:all' } })
  await system.ledger!.create({ data: { id: 1, memo: 'secret-ledger', amount: 100 } })
})

afterAll(async () => { await app?.stop?.() })

async function call(name: string, args: unknown, token?: string) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer test-token-${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await res.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
  const text = body.result?.content?.[0]?.text ?? ''
  const rows = (() => { try { return (JSON.parse(text) as { data?: unknown[] }).data ?? null } catch { return null } })()
  return { isError: body.result?.isError ?? false, text, count: rows?.length ?? null }
}

describe('AUDIT: a $-key in a find query must not survive the agent bridge (Invariant 10)', () => {

  test('$raw as a stranger is refused or inert — it must not act as a boolean oracle', async () => {
    const hit  = await call('credentials_find', { query: { $raw: "scope LIKE 'admin%'" } })
    const miss = await call('credentials_find', { query: { $raw: "scope LIKE 'zzz%'" } })
    // An oracle is: the two SQL predicates return DIFFERENT counts, revealing the
    // @guarded `scope` one comparison at a time. Secure behavior refuses $raw
    // (isError) or ignores it (both return the full table, equal counts).
    const oracle = !hit.isError && !miss.isError && hit.count !== miss.count
    expect(oracle, `$raw acted as an oracle on @guarded scope: hit=${hit.count} miss=${miss.count}`).toBe(false)
  })

  test('$raw cannot subquery a table the caller\'s gate forbids (Ledger reads at 5)', async () => {
    const hit  = await call('credentials_find', { query: { $raw: 'EXISTS (SELECT 1 FROM ledger WHERE amount = 100)' } })
    const miss = await call('credentials_find', { query: { $raw: 'EXISTS (SELECT 1 FROM ledger WHERE amount = 101)' } })
    const oracle = !hit.isError && !miss.isError && hit.count !== miss.count
    expect(oracle, `$raw leaked Ledger rows the stranger may not read: hit=${hit.count} miss=${miss.count}`).toBe(false)
  })
})
