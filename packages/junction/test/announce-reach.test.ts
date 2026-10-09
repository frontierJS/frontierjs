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

  test('silent without channels — nothing is listening to be missed', async () => {
    expect(await bootWith('', false)).toHaveLength(0)
  })
})
