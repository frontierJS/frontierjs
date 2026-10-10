/*
 * test/file-column.test.ts — an agent supplies a File column over /mcp.
 *
 * The create tool's schema described the STORED ref (`key`, `bucket`, …), the
 * ORM refused that object, and the tool's own input check refused anything
 * else, so an app whose core flow is an upload could not do it through its own
 * agent (FJS-2062). FJS-D666: the bytes go inline, as a base64 data URL or
 * `{ name, type, data }`, and the tool's schema says so.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, autoMigrate } from '@frontierjs/litestone'
import { FileStorage }   from '@frontierjs/litestone/storage'
import { createApp, createService } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const dir     = mkdtempSync(join(tmpdir(), 'mcp-file-'))
const storage = join(dir, 'storage')
const PNG     = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')

const SCHEMA = `
  database main { path "${join(dir, 'main.db')}" }
  model Photo {
    id       Int    @id
    title    String
    original File   @accept("image/*")
    @@allow('all', auth() != null)
  }
`

type Db = { asSystem(): { photo: { findMany(): Promise<Array<{ id: number }>> } } }
let app: { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string
let db: Db

beforeAll(async () => {
  db = await createClient({
    schema: SCHEMA,
    plugins: [FileStorage({ provider: 'local', localPath: storage, bucket: 'test', publicBase: 'https://cdn.test' })],
  }) as unknown as Db
  await autoMigrate(db as never)
  app = createApp({
    db, auth: createStubAuth({ users: [{ id: 'u1' }] }),
    config:   { port: 0, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  }) as never
  app.services.register(createService({ name: 'photos', model: 'Photo', methods: ['find', 'get', 'create'] }))
  app.configure(mcpPlugin({ name: 'photos' }))
  await app.start()
  base = `http://localhost:${app.http.port}/mcp`
})

afterAll(async () => {
  await app?.stop?.()
  rmSync(dir, { recursive: true, force: true })
})

async function rpc(method: string, params: unknown) {
  const res = await fetch(base, {
    method:  'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer test-token-u1' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:'))!.slice(5)
  return JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: Record<string, any> }> } }
}

const stored = () => readdirSync(storage, { recursive: true }).filter(f => String(f).endsWith('.png'))

describe('an agent supplies a File column over /mcp (FJS-2062)', () => {

  test('the create tool describes the bytes it takes, not the stored ref', async () => {
    const { result } = await rpc('tools/list', {})
    const tool = result!.tools!.find(t => t.name === 'photos_create')!
    const text = JSON.stringify(tool.inputSchema)
    expect(text).toContain('FileInput')
    expect(text).toContain('data:<type>;base64')
    expect(text).not.toContain('uploadedAt')
  })

  test('a data URL is stored: the row is written and the bytes are in storage', async () => {
    const { result } = await rpc('tools/call', {
      name: 'photos_create',
      arguments: { title: 'beach', original: `data:image/png;base64,${PNG.toString('base64')}` },
    })
    expect(result?.isError).toBeFalsy()
    expect((await db.asSystem().photo.findMany()).map(r => r.id)).toEqual([1])
    const [file] = stored()
    expect(readFileSync(join(storage, String(file))).equals(PNG)).toBe(true)
  })

  test('{ name, type, data } is stored the same way', async () => {
    const { result } = await rpc('tools/call', {
      name: 'photos_create',
      arguments: { title: 'dune', original: { name: 'dune.png', type: 'image/png', data: PNG.toString('base64') } },
    })
    expect(result?.isError).toBeFalsy()
    expect(stored()).toHaveLength(2)
  })

  test('the stored ref sent back is refused, and nothing is written', async () => {
    const ref = { key: 'Photo/original/x.png', bucket: 'test', provider: 'local', size: 1, mime: 'image/png', uploadedAt: new Date().toISOString() }
    const { result } = await rpc('tools/call', { name: 'photos_create', arguments: { title: 'forged', original: ref } })
    expect(result?.isError).toBe(true)
    expect((await db.asSystem().photo.findMany()).map(r => r.id)).toEqual([1, 2])
  })
})
