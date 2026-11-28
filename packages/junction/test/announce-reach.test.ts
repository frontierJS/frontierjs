// test/announce-reach.test.ts
//
// FJS-2146. A write on replica B reached a socket on replica A under
// `announce crossProcess` and never under the default `inProcess`, and nothing
// at boot said so — the live screen simply stayed stale on the other replica.
// Junction cannot know how many processes the deploy runs, so what it can do is
// say, once, at the point it mounts the WebSocket layer, that the database's
// announcement reaches this process only and what declares otherwise.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../../litestone/src/index.js'
import { createApp, channels } from '../index.ts'
import { membershipClaim }  from '../src/core/litestone.ts'
import { header }           from '../src/core/bearer.ts'

async function bootWith(announce: string, withChannels = true): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-reach-'))
  const db: any = await createClient({ schema: `
    database main {
      path "${join(dir, 'app.db')}"
      ${announce}
    }
    model Note {
      id   Int    @id @default(autoincrement())
      body String
      @@db(main)
    }` })
  const app = createApp({ db })
  if (withChannels) app.configure(channels())

  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try { await app._startForTest() } finally { console.warn = original }
  return lines.filter(l => l.includes('crossProcess'))
}

describe('the announce-reach report', () => {

  test('channels over an inProcess database say so at boot, and name the declaration', async () => {
    const lines = await bootWith('')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('main')
    expect(lines[0]).toContain('announce crossProcess')
  })

  test('silent once the database declares crossProcess', async () => {
    expect(await bootWith('announce crossProcess')).toHaveLength(0)
  })

  // FJS-D851: the default and a written inProcess reach alike, and only the
  // written one says a single process is meant.
  test('silent once the database states inProcess, and the warning names that spelling', async () => {
    expect(await bootWith('announce inProcess')).toHaveLength(0)
    expect((await bootWith(''))[0]).toContain('announce inProcess')
  })

  test('silent without channels — nothing is listening to be missed', async () => {
    expect(await bootWith('', false)).toHaveLength(0)
  })
})

// FJS-4683. A broadcast carries no request, so a tenant claim read off a header
// admits no socket, and an app whose channels() states no claims resolver had
// every tenant-scoped frame refused with nothing logged.
async function bootHeaderTenant(opts: Parameters<typeof channels>[1] = {}, from: 'header' | 'fn' = 'header'): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-reach-'))
  const db: any = await createClient({ schema: `
    database main {
      path "${join(dir, 'app.db')}"
      announce crossProcess
    }
    model Note {
      id   Int    @id @default(autoincrement())
      body String
      @@db(main)
    }` })
  const principal = membershipClaim({
    tenantFrom: from === 'header' ? header('X-Shop-Id') : () => 'shop-1',
    model:      'shopMember',
    subject:    'userId',
    tenant:     'shopId',
  })
  const app = createApp({ db, principal } as never)
  app.configure(channels(undefined, opts))

  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try { await app._startForTest() } finally { console.warn = original }
  return lines.filter(l => l.includes('channels({ claims })'))
}

describe('the header-tenant report', () => {

  test('a header-read tenant claim and no claims resolver say so at boot, naming the header and the fix', async () => {
    const lines = await bootHeaderTenant()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('X-Shop-Id')
  })

  test('silent once channels() states a claims resolver', async () => {
    expect(await bootHeaderTenant({ claims: () => null })).toHaveLength(0)
  })

  test('silent when the tenant is not read from a header', async () => {
    expect(await bootHeaderTenant({}, 'fn')).toHaveLength(0)
  })
})
