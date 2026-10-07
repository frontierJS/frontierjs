/*
 * test/audit-withhold-tenant.test.ts — FJS-D473 on the tenant-per-database shape.
 *
 * `run()` backstops a system write's return by reading the protected columns
 * off a client. Under `tenancy { strategy database }` there is no `app.db`, and
 * with no client the list is empty, so a custom method returning an `asSystem()`
 * write (`credentials.mint`) handed the agent its decrypted `@secret` and its
 * `@guarded` column (`FJS-1835`). `plugin.test.ts` proves the redaction only on
 * an app with one client, and `example` — the flagship — is this shape.
 *
 * A real registry, a real app and a real port, for `plugin.test.ts`'s reason:
 * the client the redaction reads is the crossing, and a stub supplies one.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTenantRegistry } from '@frontierjs/litestone'
import { createApp, createService, $ } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const SHOP = readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string

beforeAll(async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'mcp-withhold-tenant-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, `tenancy { strategy database  dir "${dir}/tenants"  registry "${dir}/registry.db"  resolve header("X-Tenant-Id") }\n${SHOP}`)
  const registry: any = await createTenantRegistry({ path, encryptionKey: '0'.repeat(64) })
  await registry.create('acme')

  app = createApp({
    tenants:  registry,
    auth:     createStubAuth({ users: [{ id: 'staff', isAdmin: true }] }),
    config:   { port: 0, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  }) as never

  type Creds = { asSystem(): { credential: { create(a: unknown): Promise<unknown> } } }
  app.services.register(createService({
    name: 'credentials', model: 'Credential',
    mint: async () => ($.db as unknown as Creds).asSystem().credential.create({
      data: { label: 'minted', value: 'hunter2-minted', scope: 'scope-minted' },
    }),
    methods: ['find', 'get', { method: 'mint', gate: 5 }],
  }))

  app.configure(mcpPlugin({ name: 'shop' }))
  await app.start()
  base = `http://localhost:${app.http.port}/mcp`
})

afterAll(async () => { await app?.stop?.() })

describe('a protected column reaches no tool RESULT under strategy database (FJS-D473)', () => {

  test('a method returning a system write answers the row without its @secret or @guarded', async () => {
    const res = await fetch(base, {
      method:  'POST',
      headers: {
        'content-type': 'application/json',
        accept:         'application/json, text/event-stream',
        authorization:  'Bearer test-token-staff',
        'x-tenant-id':  'acme',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'credentials_mint', arguments: {} } }),
    })
    const text = await res.text()
    // The control: an answer that was refused satisfies every absence below.
    expect(res.status).toBe(200)
    expect(text).not.toContain('isError')
    expect(text).toContain('minted')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('scope-minted')
  })
})
