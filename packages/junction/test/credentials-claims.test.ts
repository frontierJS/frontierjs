// test/credentials-claims.test.ts
//
// FJS-2276 / FJS-D475 — what a key stands for is the SESSION `keyFor` answers.
// That session is a principal like any other: a field on it that the schema's
// tenancy claim names scopes rows, and a standing field reaches the gate and
// the policies, so an app issuing a key to a tenant states the tenant and the
// standing once, in `keyFor`, and not again in `principal`.
//
// Against a real Litestone client: a stub agrees with whatever it was written
// to agree with, and a key scoped into the wrong tenant looks like success.

import { describe, test, expect } from 'bun:test'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { createClient } from '../../litestone/src/index.js'
import { createApp, createService, defaultConfig, signedRequest, membershipClaim } from '../index.ts'
import type { PrincipalSetting } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { $ } from '../index.ts'

const SECRET = 'partner-secret'
const NOW    = 1_800_000_000

const SCHEMA = `
  tenancy { strategy row  column agencyId  claim agencyId }

  model Member {
    id       Int    @id @default(autoincrement())
    agencyId String
    userId   String
    role     String
    @@tenant(none)
  }

  model Doc {
    id       Int    @id @default(autoincrement())
    agencyId String
    title    String
  }
`

// What the key was issued with: the agency it belongs to and the standing it holds there.
const PARTNER = {
  id: 'key:7', userType: 'service', agencyId: 'a2', memberRole: 'partner',
} as unknown as SessionContext

async function callAs(principal?: PrincipalSetting) {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.doc.create({ data: { agencyId: 'a1', title: 'one' } })
  await sys.doc.create({ data: { agencyId: 'a2', title: 'two' } })

  const seen: { user?: unknown } = {}
  const app = createApp({
    config: { ...defaultConfig, port: 0 },
    db,
    ...(principal ? { principal } : {}),
    credentials: [signedRequest({ now: () => NOW, keyFor: () => ({ secret: SECRET, session: PARTNER }) })],
  })
  app.services.register(createService({
    name: 'docs',
    async find(ctx: ServiceContext) {
      seen.user = ctx.user
      return ($.db as any).doc.findMany({})
    },
  }))
  await app.start()
  const sig = await signRequest({ secret: SECRET, method: 'GET', path: '/docs', body: '', timestamp: NOW, nonce: 'n1' })
  const res = await app.http.fetch(new Request('http://localhost/docs', { headers: sig }))
  const body = await res.json() as { data: { title: string }[] }
  await app.stop()
  return { status: res.status, titles: body.data.map(r => r.title), user: seen.user as Record<string, unknown> }
}

describe('a signed request carries the claim and standing its key was issued with', () => {
  test('with no principal resolver, the session scopes the rows and states the standing', async () => {
    const got = await callAs()
    expect(got.status).toBe(200)
    expect(got.titles).toEqual(['two'])
    expect(got.user.memberRole).toBe('partner')
  })

  test('a membership resolver that finds no row for the key leaves the key\'s claim standing', async () => {
    const got = await callAs(membershipClaim({
      tenantFrom: () => null, model: 'member', subject: 'userId', tenant: 'agencyId',
      standing: 'role', standingAs: 'memberRole',
    }))
    expect(got.titles).toEqual(['two'])
    expect(got.user.memberRole).toBe('partner')
  })
})
