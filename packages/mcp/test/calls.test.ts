/*
 * test/calls.test.ts — every tool call lands in the app's audit trail, and
 * `GET /mcp/calls` reads it back for an operator.
 *
 * `@@log` records a write and cannot say an agent made it, nor see a call the
 * boundary refused. So each row here is one the trail could not have held
 * before: a done write naming its row and field names, a refusal with the
 * message the agent was given, and a read with how many rows it answered.
 * The argument VALUES never reach the trail — `meta` is written unredacted.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient }  from '@frontierjs/litestone'
import { createApp, createService, $ } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const dir = mkdtempSync(join(tmpdir(), 'mcp-calls-'))
// The shop, with the logger database an app's `fli auth:install` declares.
const SCHEMA =
  `database main  { path "${join(dir, 'main.db')}" }\n` +
  `database audit { path "${join(dir, 'audit')}/" driver logger }\n` +
  readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string

beforeAll(async () => {
  const db = await createClient({ schema: SCHEMA, encryptionKey: '0'.repeat(64) }) as Record<string, never>
  const auth = createStubAuth({ users: [{ id: 'staff', isAdmin: true }, { id: 'shopper' }] })
  app = createApp({
    db, auth,
    config:   { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  }) as never

  type Orders = { order: { transition(id: unknown, name: string): Promise<unknown> } }
  app.services.register(createService({
    name: 'orders', model: 'Order',
    refund: async () => ($.db as unknown as Orders).order.transition(Number($.id), 'refund'),
    methods: ['find', 'get', 'create', 'patch', 'refund'],
  }))
  app.configure(mcpPlugin({ name: 'shop' }))
  await app.start()
  base = `http://localhost:${app.http.port}/mcp`

  const system = (db as unknown as { asSystem(): Record<string, { create(a: unknown): Promise<unknown> }> }).asSystem()
  await system.order!.create({ data: { id: 1, reference: 'ORD-1', total: 2500 } })
})

afterAll(async () => {
  await app?.stop?.()
  rmSync(dir, { recursive: true, force: true })
})

async function callTool(name: string, args: unknown, token: string) {
  const res = await fetch(base, {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      accept:         'application/json, text/event-stream',
      authorization:  `Bearer test-token-${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return res.text()
}

type Call = {
  at: string; actorId: string | null; records: string[]; tool: string; outcome: string
  fields?: string[]; count?: number; code?: number; message?: string
}

async function calls(token?: string) {
  const res = await fetch(`${base}/calls`, { headers: token ? { authorization: `Bearer test-token-${token}` } : {} })
  return { status: res.status, body: await res.json() as { recorded: boolean; calls: Call[] } }
}

describe('GET /mcp/calls — what each agent did, for an operator', () => {

  test('a done write, a refusal and a read are each recorded, newest first', async () => {
    await callTool('orders_find', {}, 'shopper')
    await callTool('orders_patch', { id: 1, data: { reference: 'ORD-1-SECRET' } }, 'shopper')
    // `refund` is @gate(5); the shopper stands at 4. Offered nowhere they can
    // see it, so the call is unknown to their server — staff call it instead
    // on an order that is not paid, which the transition refuses as a 4xx.
    await callTool('orders_refund', { id: 1 }, 'staff')

    const { status, body } = await calls('staff')
    expect(status).toBe(200)
    expect(body.recorded).toBe(true)
    const [refund, patch, find] = body.calls
    expect(refund).toMatchObject({ tool: 'orders_refund', actorId: 'staff', records: ['1'] })
    expect(refund!.outcome).not.toBe('done')
    expect(refund!.code).toBeGreaterThanOrEqual(400)
    expect(refund!.message).toBeTruthy()

    expect(patch).toMatchObject({ tool: 'orders_patch', actorId: 'shopper', records: ['1'], outcome: 'done', fields: ['reference'] })
    expect(find).toMatchObject({ tool: 'orders_find', outcome: 'done', count: 1 })
  })

  test('a value an agent sent never reaches the trail — only the field name', async () => {
    const { body } = await calls('staff')
    expect(JSON.stringify(body)).not.toContain('ORD-1-SECRET')
  })

  test('a user and a stranger are refused the trail; staff are answered it', async () => {
    expect((await calls('staff')).status).toBe(200)
    expect((await calls('shopper')).status).toBe(403)
    expect((await calls()).status).toBe(403)
  })
})
