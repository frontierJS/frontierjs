/*
 * test/principal-standing.test.ts — the tool list follows the app's principal
 * resolver, not the bare session.
 *
 * Under `strategy row` with `createApp({ principal: membershipClaim(…) })` the
 * standing is a claim the resolver adds per call: *admin of THIS workspace*. The
 * session carries none of it, so a projection graded off the session offers an
 * admin and a viewer one identical list — measured on basecamp, where an owner,
 * an admin, a developer and a viewer all saw 109 tools. The boundary still
 * refuses what the viewer may not do, so nothing escalates; the list is simply
 * wrong for everybody.
 *
 * Every row is a PAIR: the same caller with and without the header that names
 * the workspace, and two members of one workspace a role apart.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient, GatePlugin } from '@frontierjs/litestone'
import { createApp, createService, membershipClaim } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const SCHEMA = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Member {
    id          Int    @id @default(autoincrement())
    workspaceId String
    userId      String
    role        String
    @@tenant(none)
  }

  /// Read by any member, written by an admin of the workspace.
  model Doc {
    id          Int    @id @default(autoincrement())
    workspaceId String
    title       String
    @@gate("4.5.5.5")
  }
`

// The app's own mapping, as basecamp writes it: the role on the membership row,
// never anything the session carries.
const ROLE_LEVEL: Record<string, number> = { admin: 5, viewer: 4 }
const getLevel = (user?: { memberRole?: string } | null) =>
  !user ? 0 : ROLE_LEVEL[user.memberRole ?? ''] ?? 1

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string

beforeAll(async () => {
  const db: any = await createClient({
    db: ':memory:', schema: SCHEMA, claims: ['workspaceId'],
    plugins: [new GatePlugin({ getLevel })],
  })
  const sys = db.asSystem()
  await sys.member.create({ data: { workspaceId: 'w1', userId: 'ada',  role: 'admin'  } })
  await sys.member.create({ data: { workspaceId: 'w1', userId: 'vera', role: 'viewer' } })

  app = createApp({
    db,
    auth:     createStubAuth({ users: [{ id: 'ada' }, { id: 'vera' }] }),
    config:   { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
    principal: membershipClaim({
      tenantFrom: (ctx: { caller?: { headers?: Record<string, string> } }) => ctx.caller?.headers?.['x-workspace-id'],
      model:      'member',
      subject:    'userId',
      tenant:     'workspaceId',
      standing:   'role',
      standingAs: 'memberRole',
    }),
  } as never) as never

  app.services.register(createService({
    name: 'docs', model: 'Doc',
    methods: ['find', 'get', 'create'],
  }))
  app.configure(mcpPlugin({ name: 'workspaces' }))
  await app.start()
  base = `http://localhost:${app.http.port}/mcp`
})

afterAll(async () => { await app?.stop?.() })

async function names(user: string, workspace?: string): Promise<string[]> {
  const res = await fetch(base, {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      accept:         'application/json, text/event-stream',
      authorization:  `Bearer test-token-${user}`,
      ...(workspace ? { 'x-workspace-id': workspace } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const body = await res.json() as { result?: { tools?: Array<{ name: string }> } }
  return (body.result?.tools ?? []).map(t => t.name)
}

describe('the standing is the one the principal resolver answers', () => {

  test('an admin of the named workspace is offered the write', async () => {
    expect(await names('ada', 'w1')).toContain('docs_create')
  })

  test('a viewer of the same workspace reads and is not offered the write', async () => {
    const vera = await names('vera', 'w1')
    expect(vera).toContain('docs_find')
    expect(vera).not.toContain('docs_create')
  })

  test('the admin naming no workspace holds no role, and is offered neither', async () => {
    const ada = await names('ada')
    expect(ada).not.toContain('docs_find')
    expect(ada).not.toContain('docs_create')
  })
})
