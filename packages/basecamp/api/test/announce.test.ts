// api/test/announce.test.ts
//
// What a job's push reaches, graded per recipient.
//
// `announce()` is how an engine — a deploy, a cleanup sweep, a job run — tells
// the workspace a row moved. It reads the row through `asSystem()`, because the
// engine runs with no caller, and it sent that row with `Channel.send`, which
// grades nobody: every socket in `workspace:<id>` received the whole row. A
// member removed mid-session keeps the socket they joined on, and the claims
// resolver reads membership per frame precisely so that socket stops receiving
// (`FJS-D472`) — through the graded path only (`FJS-2443`).
//
// Against the REAL app and the real channel manager: what is under test is
// which path the manager is asked to take, and a stand-in manager answers
// whichever one it was written to.

import { test, expect, describe, beforeAll } from 'bun:test'
import { join }           from 'node:path'
import { createTestEnv }  from '@frontierjs/testing'
import { GatePlugin }     from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'
import { announce, workspaceChannelName } from '../src/core/channels.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)

let env: any
let ws: any, member: any, removed: any

beforeAll(async () => {
  env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: ENC_KEY,
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })

  const sys  = env.system as any
  const uniq = () => Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `acme-${uniq()}`, displayName: 'Acme' } })
  member  = await sys.user.create({ data: { email: `m-${uniq()}@x.co`, accountId: acct.id } })
  removed = await sys.user.create({ data: { email: `r-${uniq()}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}`, ownerId: member.id },
  })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: member.id, role: 'viewer',
    capabilities: grantsFor('viewer'), acceptedAt: new Date().toISOString(),
  } })
})

/** A socket in the workspace channel, as the connection handler joins one. */
function subscriber(user: { id: string }) {
  const frames: Array<{ event?: string; data?: any }> = []
  const conn = {
    id:     Math.random().toString(36).slice(2),
    user:   { id: user.id, userId: user.id },
    socket: { send: (d: string) => { frames.push(JSON.parse(d)); return 1 }, close: () => {}, readyState: 1 },
    data:   {},
  }
  env.app.channels.channel(workspaceChannelName(ws.id)).join(conn)
  return { conn, frames }
}

describe('announce() — a system-read row, graded per recipient', () => {

  test('a member receives the row; a socket whose membership is gone does not', async () => {
    const sys = env.system as any
    const job = await sys.job.create({ data: {
      workspaceId: ws.id, name: 'nightly', kind: 'one_shot', command: 'true' } })

    // `removed` holds no membership row: a person taken out of the workspace
    // after the socket joined, which is the case the per-frame claim exists for.
    const kept = subscriber(member)
    const gone = subscriber(removed)
    try {
      await announce(env.app, ws.id, 'Job', 'jobs patched', job)

      expect(kept.frames.map(f => [f.event, f.data?.id])).toEqual([['jobs patched', job.id]])
      // `announce()` hands the grader no before-image, and a removal goes only
      // to a reader the before-image admitted (`FJS-D1199`) -- so the refused
      // socket is told nothing, neither the row nor a removal.
      expect(gone.frames).toEqual([])
    } finally {
      const ch = env.app.channels.channel(workspaceChannelName(ws.id))
      ch.leave(kept.conn); ch.leave(gone.conn)
    }
  })
})
