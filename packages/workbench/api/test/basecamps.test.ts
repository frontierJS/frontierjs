/**
 * basecamps.test.ts -- the Basecamps screen's verbs against a stub Basecamp,
 * over a temp `basecamps.json` so the laptop's own index is never read. The
 * stub answers what `takeHubBackup` asks: `/health`, the `/hub-backups` list,
 * `hub-config current`, the `take`, and the row it polls until settled.
 * Restart runs a root command over ssh, so only its refusal is tested here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { listBasecamps, startBackup, startRestart, outcomeOf } from '../src/domain/basecamps/basecamps.ts'

const home = mkdtempSync(join(tmpdir(), 'wb-basecamps-'))
const KEY  = 'bc_admin_secret_key'

const older = { id: 'hb_1', status: 'success', createdAt: '2026-11-01T10:00:00.000Z', startedAt: '2026-11-01T10:00:00.000Z' }
const rows: Array<Record<string, unknown>> = [older]
const asked: string[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch (req) {
      const url    = new URL(req.url)
      const method = req.headers.get('x-service-method')
      asked.push(`${req.method} ${url.pathname}${method ? ` ${method}` : ''}`)
      if (url.pathname === '/health') return Response.json({ status: 'ok' })
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ message: 'no key' }, { status: 401 })
      if (url.pathname === '/hub-config' && method === 'current') return Response.json({ data: { app: { backupDestinationId: null } } })
      if (url.pathname === '/hub-backups' && req.method === 'GET') {
        const newest = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        return Response.json({ data: newest.slice(0, Number(url.searchParams.get('$limit') ?? 100)) })
      }
      if (url.pathname === '/hub-backups' && method === 'take') {
        const row = { id: 'hb_2', status: 'running', createdAt: '2026-11-05T09:00:00.000Z', startedAt: '2026-11-05T09:00:00.000Z' }
        rows.push(row)
        return Response.json({ data: row })
      }
      const one = url.pathname.match(/^\/hub-backups\/([^/]+)$/)
      if (one && req.method === 'GET') {
        const row = rows.find(r => r.id === decodeURIComponent(one[1]))
        if (!row) return Response.json({ message: 'not found' }, { status: 404 })
        row.status = 'success'
        return Response.json({ data: row })
      }
      return Response.json({ message: `stub has no ${req.method} ${url.pathname}` }, { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  writeBasecamp('stub',   { url, apiKey: KEY, scopedKey: 'bc_scoped_secret', peerKeyId: 'key_peer_secret' }, { home })
  writeBasecamp('nokey',  { url }, { home })
  writeBasecamp('down',   { url: 'http://127.0.0.1:9', host: 'down-box', apiKey: KEY }, { home })
})

afterAll(() => { server?.stop(true); rmSync(home, { recursive: true, force: true }) })

async function settled (name: string) {
  for (let i = 0; i < 100; i++) {
    const o = outcomeOf(name)
    if (o && o.state !== 'working') return o
    await Bun.sleep(20)
  }
  throw new Error(`${name}'s verb never settled`)
}

describe('list', () => {
  test('every entry, whether it answers, its newest backup — and no key', async () => {
    const listed = await listBasecamps({ home })
    const by = Object.fromEntries(listed.map(e => [e.name, e]))
    expect(Object.keys(by).sort()).toEqual(['down', 'nokey', 'stub'])

    expect(by.stub.answers.ok).toBe(true)
    expect(by.stub.hasKey).toBe(true)
    expect(by.stub.hasScopedKey).toBe(true)
    expect(by.stub.host).toBeNull()
    expect(by.stub.newestBackup?.id).toBe('hb_1')
    expect(by.stub.outcome).toBeNull()

    expect(by.nokey.answers.ok).toBe(true)
    expect(by.nokey.hasKey).toBe(false)
    expect(by.nokey.newestBackup).toBeNull()

    expect(by.down.answers.ok).toBe(false)
    expect(by.down.host).toBe('down-box')
    expect(by.down.newestBackup).toBeNull()

    const said = JSON.stringify(listed)
    for (const secret of [KEY, 'bc_scoped_secret', 'key_peer_secret']) expect(said).not.toContain(secret)
    for (const field of ['apiKey', 'scopedKey', 'peerKeyId']) expect(said).not.toContain(field)
  })
})

describe('backup', () => {
  test('takes Basecamp\'s own backup and holds the row it recorded', async () => {
    const started = await startBackup('stub', { home })
    expect('refused' in started).toBe(false)
    const o = await settled('stub')
    expect(o).toMatchObject({ verb: 'backup', state: 'done', row: { id: 'hb_2', status: 'success' } })
    expect(o.finishedAt).toBeString()
    expect(asked).toContain('POST /hub-backups take')
    expect(asked.some(a => a.startsWith('GET /hub-backups/hb_2'))).toBe(true)
    expect(asked.some(a => a.includes('download'))).toBe(false)

    const listed = await listBasecamps({ home })
    const stub   = listed.find(e => e.name === 'stub')!
    expect(stub.newestBackup?.id).toBe('hb_2')
    expect(stub.outcome?.state).toBe('done')
  })

  test('an entry with no key is refused, naming the command that files one', async () => {
    const out = await startBackup('nokey', { home })
    expect(out).toEqual({ refused: expect.stringContaining('fli basecamp:key') })
    expect(outcomeOf('nokey')).toBeNull()
  })

  test('a Basecamp that does not answer ends in error, saying so', async () => {
    await startBackup('down', { home })
    const o = await settled('down')
    expect(o.state).toBe('error')
    expect(o.error).toMatch(/could not reach Basecamp/)
  })
})

describe('restart', () => {
  test('an entry with no ssh Host is refused by name', async () => {
    const out = await startRestart('stub', { home })
    expect(out).toEqual({ refused: expect.stringContaining('no ssh Host') })
  })

  test('an entry not in the index is refused', async () => {
    expect(await startRestart('nowhere', { home })).toEqual({ refused: expect.stringContaining("No Basecamp named 'nowhere'") })
  })
})
