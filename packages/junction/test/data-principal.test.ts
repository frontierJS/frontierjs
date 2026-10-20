// data-principal.test.ts — the second half of the identity translation.
//
// Junction's SessionContext names the caller `userId`. Litestone's policy
// language reads `auth().id` — its documented spelling, the one every `@@allow`
// example in its docs uses. Nothing bridged the two, so a session handed
// straight to `$setAuth` reached the Data boundary with NO `id`, and
//
//   @@allow(read, userId == auth().id)
//
// compared a column to `undefined` and matched nothing. Silent: an empty list,
// not an error, and only for policies — every `@@gate` still worked, because
// `sessionGateLevel()` was written against Junction's shape.
//
// Found 2026-08-06 in example/: a signed-in user's own notifications were
// invisible to them and plainly there under `asSystem()`.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../../litestone/src/index.js'
import { toDataPrincipal, withLitestoneDb } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { auditDatabase } from './audit-trail-model.ts'
import { callDb } from '../src/core/context.ts'

describe('toDataPrincipal', () => {

  it('gives a SessionContext the `id` Litestone policies read', () => {
    const session = { userId: 'u-1', userType: 'user', role: 'admin', authMethod: 'session' }
    expect(toDataPrincipal(session)).toEqual({ ...session, id: 'u-1' })
  })

  it('leaves every other field alone — the names already agree', () => {
    const session = {
      userId: 'u-1', email: 'a@b.test', role: 'admin',
      accountId: 'acc-9', workspaceId: 'w-2', scopes: ['read'],
    }
    const out = toDataPrincipal(session) as Record<string, unknown>
    expect(out.email).toBe('a@b.test')
    expect(out.role).toBe('admin')
    expect(out.accountId).toBe('acc-9')
    expect(out.workspaceId).toBe('w-2')
    expect(out.scopes).toEqual(['read'])
  })

  it('an explicit id wins — a caller already speaking Litestone is untouched', () => {
    const user = { id: 42, userId: 'u-1' }
    expect(toDataPrincipal(user)).toBe(user)
  })

  it('passes null, undefined and non-objects straight through', () => {
    expect(toDataPrincipal(null)).toBe(null)
    expect(toDataPrincipal(undefined)).toBe(undefined)
    expect(toDataPrincipal('nope')).toBe('nope')
  })

  it('does not invent an id from a missing userId', () => {
    // An anonymous-ish principal must stay without an id rather than gain
    // `id: undefined`, which a policy would compare against a NULL column.
    const odd = { role: 'admin' }
    expect(toDataPrincipal(odd)).toBe(odd)
    expect('id' in (toDataPrincipal(odd) as object)).toBe(false)
  })

  it('a null id is treated as absent, not as a value', () => {
    expect(toDataPrincipal({ id: null, userId: 'u-1' })).toEqual({ id: 'u-1', userId: 'u-1' })
  })
})

describe('withLitestoneDb scopes with the translated principal', () => {

  const clientSpy = () => {
    const seen: unknown[] = []
    const client = {
      $setAuth(user: unknown) { seen.push(user); return { ...client, __scoped: true } },
    }
    return { client, seen }
  }

  const ctxWith = (user: unknown) => ({
    auth: { user }, locals: {} as Record<string, unknown>,
  } as unknown as ServiceContext)

  it('$setAuth receives an id, not a bare userId', async () => {
    const { client, seen } = clientSpy()
    const ctx = ctxWith({ userId: 'u-7', role: 'user' })

    await withLitestoneDb(client)(ctx, async () => {})

    expect(seen).toHaveLength(1)
    expect((seen[0] as { id?: string }).id).toBe('u-7')
    expect(callDb(ctx)).toBeDefined()
  })

  it('an anonymous caller still gets the unscoped client', async () => {
    const { client, seen } = clientSpy()
    const ctx = ctxWith(null)

    await withLitestoneDb(client)(ctx, async () => {})

    expect(seen).toHaveLength(0)
    expect(callDb(ctx) as unknown).toBe(client as unknown)
  })
})

// FJS-2514 — the app's own principal is a service, and the trail says so.
// `actorTypeOf` reads `auth.type`; a SessionContext states `userType`, and the
// one translation between the two shapes is `toDataPrincipal`. Asserted against
// a REAL client: a unit test on either side of the crossing passes unwired.
describe('toDataPrincipal carries the kind of caller to the audit trail', () => {
  const SYSTEM = { userId: 'system', userType: 'service', role: 'system', authMethod: 'created' }

  const writeAs = async (principal: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-dp-'))
    try {
      const db: any = await createClient({
        schema: `
          database main  { path ":memory:" }
          ${auditDatabase(dir)}
          model Thing { id String @id @default(uuid())  name String  @@gate(0)  @@trail(audit) }
        `,
        resolveFrom: dir,
      })
      await db.$setAuth(principal).thing.create({ data: { name: 'x' } })
      await new Promise((r) => setImmediate(r))
      const [row] = await db.asSystem().auditTrail.findMany({})
      db.$close()
      return row
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('a service principal writes actorType service', async () => {
    const row = await writeAs(toDataPrincipal(SYSTEM))
    expect(row.actorId).toBe('system')
    expect(row.actorType).toBe('service')
  })

  it('a user principal is still a user, whatever its role', async () => {
    const row = await writeAs(toDataPrincipal({ userId: 'u-1', userType: 'user', role: 'admin' }))
    expect(row.actorType).toBe('user')
  })
})
