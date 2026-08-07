// data-principal.test.ts — the second half of the identity translation.
//
// Junction's SessionContext names the caller `userId`. Litestone's policy
// language reads `auth().id` — its documented spelling, the one every `@@allow`
// example in its docs uses. Nothing bridged the two, so a session handed
// straight to `$setAuth` reached the Data boundary with NO `id`, and
//
//   @@allow('read', userId == auth().id)
//
// compared a column to `undefined` and matched nothing. Silent: an empty list,
// not an error, and only for policies — every `@@gate` still worked, because
// `sessionGateLevel()` was written against Junction's shape.
//
// Found 2026-08-06 in example/: a signed-in user's own notifications were
// invisible to them and plainly there under `asSystem()`.

import { describe, it, expect } from 'bun:test'
import { toDataPrincipal, withLitestoneDb } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

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
    expect(ctx.locals.db).toBeDefined()
  })

  it('an anonymous caller still gets the unscoped client', async () => {
    const { client, seen } = clientSpy()
    const ctx = ctxWith(null)

    await withLitestoneDb(client)(ctx, async () => {})

    expect(seen).toHaveLength(0)
    // Cast: ctx.locals.db is typed as a LitestoneClient and this spy is the
    // minimal shape withLitestoneDb actually touches.
    expect(ctx.locals.db as unknown).toBe(client as unknown)
  })
})
