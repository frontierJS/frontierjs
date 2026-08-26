// tests/real-litestone-client.test.ts
//
// Every other test in this suite builds services over a plain-object fake db.
// That is fast and it is also how the accessor-resolution fix shipped broken:
// a real Litestone client is a Proxy that THROWS on an unknown accessor
// ("posts" is not a table in this schema) instead of returning undefined, so
// probing candidate spellings in order aborted on the first miss. Against
// `{ post: {...} }` the loop worked perfectly; against every real client it
// never reached the second candidate.
//
// These tests use the workspace Litestone client so that class of assumption
// cannot pass again. Keep them here — they are the only place the two packages
// are exercised together.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService, createBaseService } from '../src/core/service.ts'
import { gateAuth, autoValidate, liftReservedQuery, resetReservedQueryChecks } from '../src/core/litestone.ts'
import { toFrameworkError } from '../src/core/errors.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type AnyClient = Record<string, never> & {
  asSystem(): Record<string, { create(a: unknown): Promise<unknown> }>
}

async function mkDb(): Promise<AnyClient> {
  return await createClient({
    db: ':memory:',
    schema: `
      model Post {
        id        Int      @id
        title     String   @length(1, 20)
        body      String?
        createdAt DateTime @default(now())

        @@gate("0.4.4.5")
      }
    `,
  }) as unknown as AnyClient
}

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method: 'find', id: undefined, data: null,
    params: {}, query: {}, auth: {}, client: {},
    locals: { db }, app: {},
    ...over,
  } as unknown as ServiceContext
}

describe('accessor resolution against a real Litestone client', () => {

  test.each([
    ['explicit singular', { name: 'posts', model: 'post'  }],
    ['plural spelling',   { name: 'posts', model: 'posts' }],
  ])('%s resolves to db.post', async (_label, def) => {
    const db = await mkDb()
    await db.asSystem().post!.create({ data: { id: 1, title: 'Hi' } })

    const out = await createService(def).find(ctx(db)) as { data: unknown[] }
    expect(out.data).toHaveLength(1)
  })

  test('model omitted — the whole service file is createBaseService({})', async () => {
    const db = await mkDb()
    await db.asSystem().post!.create({ data: { id: 1, title: 'Hi' } })

    // Exactly what the autoloader builds from services/posts.service.ts.
    const svc = createService({ name: 'posts', ...(createBaseService({}) as object) } as never)
    const out = await svc.find(ctx(db)) as { data: unknown[] }
    expect(out.data).toHaveLength(1)
  })

  test('an unresolvable name reports Junction\'s diagnostic, not a proxy TypeError', async () => {
    const db  = await mkDb()
    const svc = createService({ name: 'widgets', model: 'widget' })
    const err = await svc.find(ctx(db, { service: 'widgets' })).catch((e: Error) => e) as Error

    expect(err.message).toContain("not found on db client")
    expect(err.message).toContain('PascalCase singular')
    // Object.keys() on the client proxy throws (duplicate ownKeys); the
    // diagnostic must survive that rather than be replaced by it.
    expect(err.message).not.toContain('ownKeys')
  })
})

describe('derived hooks against a real Litestone client', () => {

  test('@@gate("0.4.4.5") — anonymous read allowed, anonymous write rejected', async () => {
    const db = await mkDb()
    expect(() => gateAuth(undefined, 'read')(ctx(db))).not.toThrow()
    expect(() => gateAuth(undefined, 'create')(ctx(db))).toThrow('Authentication required')
  })

  test('field rules become 400s — @length(1, 20) enforced with no model named', async () => {
    const db  = await mkDb()
    const c   = ctx(db, { method: 'create', data: { title: 'x'.repeat(50) } })
    const err = await autoValidate(undefined, 'create')(c).catch((e: Error) => e) as Error

    expect(err.name).toBe('BadRequest')
    expect(err.message).toContain('title')
  })

  test('a valid payload passes validation', async () => {
    const db = await mkDb()
    const c  = ctx(db, { method: 'create', data: { title: 'Fine' } })
    await expect(autoValidate(undefined, 'create')(c)).resolves.toBeUndefined()
  })
})

// ─── The Data realm's per-call options, over the wire ─────────────────────────
//
// `@@hasTemplates` had no wire name at all: `parseDirectives`, `QueryDirectives`
// and the two wire builders each named a fixed set, and none of them named a
// template — so an app declaring the attribute had a template list screen it
// could not build over HTTP or from a browser (FJS-306). The same shape
// FJS-290 had just closed for soft delete.
//
// A fake db cannot grade any of this: it is the real client's filter that has
// to change, and its refusal that has to arrive as a 400.

describe('the template and soft-delete directives reach a real client', () => {

  async function tmplDb(): Promise<AnyClient> {
    const db = await createClient({
      db: ':memory:',
      schema: `model Quote {
        id    Int    @id
        title String
        @@hasTemplates
      }`,
    }) as unknown as AnyClient
    const t = (db as unknown as Record<string, { create(a: unknown): Promise<unknown> }>).quote!
    await t.create({ data: { id: 1, title: 'live' } })
    await t.create({ data: { id: 2, title: 'template', isTemplate: true } })
    return db
  }

  const quotes = () => createService({ name: 'quotes', model: 'Quote' })

  test('the default read still hides templates', async () => {
    const out = await quotes().find(ctx(await tmplDb(), { service: 'quotes' })) as { data: { id: number }[] }
    expect(out.data.map(r => r.id)).toEqual([1])
  })

  test('$onlyTemplates and $withTemplates reach the WHERE clause', async () => {
    const db = await tmplDb()
    const only = await quotes().find(
      ctx(db, { service: 'quotes', directives: { onlyTemplates: true } })) as { data: { id: number }[] }
    expect(only.data.map(r => r.id)).toEqual([2])

    const both = await quotes().find(
      ctx(db, { service: 'quotes', directives: { withTemplates: true } })) as { data: { id: number }[] }
    expect(both.data.map(r => r.id)).toEqual([1, 2])
  })

  test('the same names travel as `$` params, which is what a browser sends', async () => {
    const db = await tmplDb()
    // What the bridge produces from `?$onlyTemplates=true`: the parse is
    // toolbelt's, and this is the fallback path parseQuery keeps for callers
    // that predate ctx.directives.
    const out = await quotes().find(
      ctx(db, { service: 'quotes', query: { $onlyTemplates: 'true' } })) as { data: { id: number }[] }
    expect(out.data.map(r => r.id)).toEqual([2])
  })

  test('a directive the model cannot satisfy is a 400, not a silent no-op', async () => {
    // FJS-293: this answered the live rows — the opposite of the question —
    // with nothing anywhere saying the flag had not applied.
    const db  = await mkDb()
    const err = await createService({ name: 'posts', model: 'Post' })
      .find(ctx(db, { directives: { onlyDeleted: true } })).catch((e: Error) => e) as Error & { status?: number }

    expect(err.name).toBe('CapabilityNotDeclaredError')
    expect(err.status).toBe(400)
    expect(err.message).toContain('@@softDelete')
  })
})

describe('$search answers the list envelope', () => {

  async function ftsDb(): Promise<AnyClient> {
    const db = await createClient({
      db: ':memory:',
      schema: `model Doc {
        id   Int    @id
        body String
        @@fts([body])
      }`,
    }) as unknown as AnyClient
    const t = (db as unknown as Record<string, { create(a: unknown): Promise<unknown> }>).doc!
    await t.create({ data: { id: 1, body: 'a blue widget' } })
    await t.create({ data: { id: 2, body: 'nothing here'  } })
    return db
  }

  test('a match answers rows and a total', async () => {
    // It answered `{"limit":20,"offset":0}` — the branch destructured
    // `{ rows, total }` off the array `search()` returns, so a search that
    // matched came back empty with a 200.
    const out = await createService({ name: 'docs', model: 'Doc' })
      .find(ctx(await ftsDb(), { service: 'docs', directives: { search: 'widget' } })) as
      { data: { id: number }[]; total: number }

    expect(out.data.map(r => r.id)).toEqual([1])
    expect(out.total).toBe(1)
  })

  test('a model with no @@fts refuses with a 400, not a 500', async () => {
    // FJS-292. The message always named the fix; the STATUS said the server
    // had broken about a request it understood.
    const err = await createService({ name: 'posts', model: 'Post' })
      .find(ctx(await mkDb(), { directives: { search: 'x' } })).catch((e: Error) => e) as Error & { status?: number }

    expect(err.name).toBe('CapabilityNotDeclaredError')
    expect(err.status).toBe(400)
    expect(err.message).toContain('@@fts')
  })
})

// ─── @transient — validated, then lifted off the payload ─────────────────────
//
// The wire-only field, declared instead of conventional (`FJS-D23`). Two halves
// have to hold together and only a real client can show it: the value is
// validated by the model's own rules like any other field, and it is GONE from
// ctx.data by the time the write happens — because litestone refuses a
// transient key by name, so a service passing ctx.data on whole would fail the
// write rather than the field.

async function mkChannelDb(): Promise<AnyClient> {
  return await createClient({
    db: ':memory:',
    schema: `
      model Channel {
        id     Int     @id
        name   String  @length(1, 20)
        secret String? @transient @length(4, 64)
      }
    `,
  }) as unknown as AnyClient
}

describe('@transient', () => {

  test('is lifted onto ctx.transients and leaves the payload', async () => {
    const db = await mkChannelDb()
    const c  = ctx(db, { method: 'create', data: { id: 1, name: 'ops', secret: 'hunter2' }, transients: {} })

    await autoValidate('channel', 'create')(c)

    expect(c.transients.secret).toBe('hunter2')
    expect('secret' in (c.data as Record<string, unknown>)).toBe(false)
    expect((c.data as Record<string, unknown>).name).toBe('ops')
  })

  test('and what is left writes cleanly through the real client', async () => {
    // The half a fake db cannot show: a transient key reaching litestone throws.
    const db = await mkChannelDb()
    const c  = ctx(db, { method: 'create', data: { id: 1, name: 'ops', secret: 'hunter2' }, transients: {} })

    await autoValidate('channel', 'create')(c)
    const row = await db.asSystem().channel!.create({ data: c.data as Record<string, unknown> })
    expect((row as { name: string }).name).toBe('ops')

    await expect(db.asSystem().channel!.create({ data: { id: 2, name: 'x', secret: 'hunter2' } }))
      .rejects.toThrow(/is @transient/)
  })

  test('is validated before it is lifted — the rules in the schema are the rules', async () => {
    const db = await mkChannelDb()
    const c  = ctx(db, { method: 'create', data: { id: 1, name: 'ops', secret: 'no' }, transients: {} })

    await expect(autoValidate('channel', 'create')(c)).rejects.toThrow(/secret/i)
  })

  test('a bulk write carrying one is refused by name, never silently dropped', async () => {
    const db = await mkChannelDb()
    const c  = ctx(db, {
      method: 'create',
      data:   [{ id: 1, name: 'a' }, { id: 2, name: 'b', secret: 'hunter2' }],
      transients: {},
    })

    await expect(autoValidate('channel', 'create')(c)).rejects.toThrow(/'secret'/)
    await expect(autoValidate('channel', 'create')(c)).rejects.toThrow(/@transient/)
  })

  test('a model declaring none leaves ctx.transients empty', async () => {
    const db = await mkDb()
    const c  = ctx(db, { method: 'create', data: { id: 1, title: 'Hi' }, transients: {} })

    await autoValidate('post', 'create')(c)
    expect(c.transients).toEqual({})
  })
})


describe('@version survives autoValidate — the patch schema is the UPDATE schema', () => {

  // Litestone's PROPERTY SET is mode-dependent, not just its required[]:
  // `@version` is emitted for update and omitted for create. Junction derived
  // one create-mode document and compiled the patch validator from it, so the
  // version a caller sent was stripped as an unknown key — and the Data
  // boundary then refused the write for not carrying one. The whole feature was
  // unusable through a service, and every existing test called svc.patch()
  // directly, where no hook runs.

  async function mkDocDb(): Promise<AnyClient> {
    return await createClient({
      db: ':memory:',
      schema: `
        model Doc {
          id    Int    @id
          title String
          ver   Int    @version
        }
      `,
    }) as unknown as AnyClient
  }

  test('the version a caller sends reaches ctx.data', async () => {
    const db = await mkDocDb()
    const c  = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { title: 'z', ver: 1 }, transients: {} })

    await autoValidate('doc', 'patch')(c)
    expect((c.data as Record<string, unknown>).ver).toBe(1)
  })

  test('and a patch through the service lands, then conflicts on a stale one', async () => {
    const db  = await mkDocDb()
    await db.asSystem().doc!.create({ data: { id: 1, title: 'a' } })

    const svc = createService({ name: 'docs', model: 'Doc' }) as never as
      { patch(c: ServiceContext): Promise<Record<string, unknown>> }

    const first = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { title: 'b', ver: 1 }, transients: {} })
    await autoValidate('doc', 'patch')(first)
    expect((await svc.patch(first)).ver).toBe(2)

    // The second editor still holds version 1. Without the fix this was a 400
    // about a missing version rather than a 409 about a moved row, which is a
    // different sentence and a different thing to do next.
    const stale = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { title: 'c', ver: 1 }, transients: {} })
    await autoValidate('doc', 'patch')(stale)
    await expect(svc.patch(stale)).rejects.toThrow(/ver/)
  })

  test('and the id is still stripped — a patch must not rewrite the primary key', async () => {
    // The trap in fixing this: the UPDATE document also carries `@id`, which
    // the create one omits. Litestone writes what it is given — `update({ where:
    // { id: 1 }, data: { id: 99 } })` moves the row and answers 99 — so taking
    // the whole update document would have let any caller rewrite a primary key
    // through a PATCH. Only the version crosses.
    const db = await mkDocDb()
    await db.asSystem().doc!.create({ data: { id: 1, title: 'a' } })

    const c = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { id: 99, title: 'b', ver: 1 }, transients: {} })
    await autoValidate('doc', 'patch')(c)
    expect((c.data as Record<string, unknown>).id).toBeUndefined()
    expect((c.data as Record<string, unknown>).ver).toBe(1)

    const svc = createService({ name: 'docs', model: 'Doc' }) as never as
      { patch(c: ServiceContext): Promise<Record<string, unknown>> }
    expect((await svc.patch(c)).id).toBe(1)
  })

  // What the browser is left holding. `retryable` says a retry is a strategy and
  // the status says a conflict happened; neither can say WHICH revisions
  // disagreed, and a screen offering *reload* against *overwrite* needs both
  // numbers. They travel on `data`, which the error boundary carries — asserted
  // here against a real thrown VersionConflictError rather than a constructed
  // one, because the question is whether the payload survives the boundary.
  test('the losing editor is told which two revisions disagreed', async () => {
    const db  = await mkDocDb()
    await db.asSystem().doc!.create({ data: { id: 1, title: 'a' } })

    const svc = createService({ name: 'docs', model: 'Doc' }) as never as
      { patch(c: ServiceContext): Promise<Record<string, unknown>> }

    const first = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { title: 'b', ver: 1 }, transients: {} })
    await autoValidate('doc', 'patch')(first)
    await svc.patch(first)

    const stale = ctx(db, { service: 'docs', method: 'patch', id: 1, data: { title: 'c', ver: 1 }, transients: {} })
    await autoValidate('doc', 'patch')(stale)

    const thrown = await svc.patch(stale).then(() => null, (e: unknown) => e)
    const fe     = toFrameworkError(thrown)

    expect(fe.code).toBe(409)
    expect(fe.retryable).toBe(true)
    expect(fe.data).toEqual({ model: 'Doc', field: 'ver', expected: 1, actual: 2 })
    // And on the wire, not merely on the instance.
    expect(fe.toJSON()).toMatchObject({ code: 409, data: { expected: 1, actual: 2 } })
  })

  test('create still omits it — a caller does not choose the first version', async () => {
    const db = await mkDocDb()
    const c  = ctx(db, { service: 'docs', method: 'create', data: { id: 2, title: 'a', ver: 99 }, transients: {} })

    await autoValidate('doc', 'create')(c)
    expect((c.data as Record<string, unknown>).ver).toBeUndefined()
  })
})

describe('reservedQuery — a reserved key that is also a column', () => {
  test('is refused by name on first use', async () => {
    // Asked of the real client, because this is exactly the shape a fake hides:
    // `$checkWhere` is what knows the model's columns, and a plain-object db
    // has no opinion at all — the check would no-op and the collision ship.
    //
    // Refused rather than resolved: a reservation that shadows a column stops
    // that column filtering with nothing saying so, which is the silent 200
    // autoFilter exists to turn into a 400.
    resetReservedQueryChecks()
    const db = await mkDb()
    const c  = ctx(db, { service: 'posts', query: { title: 'x' } })

    expect(() => liftReservedQuery(c, 'posts', ['title']))
      .toThrow(/reserves 'title'.*is a column on post/s)
  })

  test('a name the model does not have is reserved and lifted', async () => {
    resetReservedQueryChecks()
    const db = await mkDb()
    const c  = ctx(db, { service: 'posts', query: { workspace_id: 'ws_7', title: 'x' } })

    liftReservedQuery(c, 'posts', ['workspace_id'])

    expect(c.reserved).toEqual({ workspace_id: 'ws_7' })
    expect(c.query).toEqual({ title: 'x' })
  })

  test('the column check runs once per service, not once per call', async () => {
    // It costs a $checkWhere round trip, and a reservation cannot change
    // between calls — it is fixed at construction.
    resetReservedQueryChecks()
    const db = await mkDb()
    let asked = 0
    const spy = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop === '$checkWhere') {
          asked++
          return Reflect.get(target, prop, recv)
        }
        return Reflect.get(target, prop, recv)
      },
    })

    for (let i = 0; i < 3; i++)
      liftReservedQuery(ctx(spy, { service: 'posts', query: { workspace_id: 'w' } }), 'posts', ['workspace_id'])

    expect(asked).toBe(1)
  })
})

// ─── releasing a @unique value a soft-deleted row still holds ─────────────────
//
// `SoftDeletedUniqueError` is a 409 telling a caller their value is held by a
// row they cannot see, and litestone's documented way out is to move the value
// aside: `update({ …, withDeleted: true })`. Every READ passed `$withDeleted`
// through and no WRITE did, so the escape hatch the refusal points at was
// unreachable through a service — a soft-deleted row's reference could never be
// freed by any request an app could make (`FJS-523`).
//
// `remove` is deliberately not covered: against an already-deleted row the only
// remaining action is to stop keeping it, which is a hard delete, and giving
// `DELETE ?$withDeleted=true` that meaning is a decision rather than a
// passthrough. Asserted below as still refused, so making it work is a
// deliberate change and not a side effect.

async function mkSoftDb(): Promise<AnyClient> {
  return await createClient({
    db: ':memory:',
    schema: `
      // No @@gate: what is under test is a directive, and a gated model would
      // refuse these writes at level 0 for a reason that has nothing to do with
      // it. The accessor tests above keep the gated model.
      model Doc {
        id        Int       @id
        code      String    @unique
        title     String?
        deletedAt DateTime?

        @@softDelete
      }
    `,
  }) as unknown as AnyClient
}

describe('$withDeleted on a write', () => {
  const svc = () => createService({ name: 'docs', model: 'doc' })

  const seedDeleted = async () => {
    const db = await mkSoftDb()
    const t  = (db as unknown as { asSystem(): Record<string, {
      create(a: unknown): Promise<unknown>, remove(a: unknown): Promise<unknown> }> }).asSystem().doc!
    await t.create({ data: { id: 1, code: 'X', title: 'first' } })
    await t.remove({ where: { id: 1 } })
    return db
  }

  test('the deleted row is out of an ordinary read and its code is still taken', async () => {
    const db = await seedDeleted()
    const out = await svc().find(ctx(db, { service: 'docs' })) as { data: unknown[] }
    expect(out.data).toHaveLength(0)

    const err = await svc().create(ctx(db, {
      service: 'docs', method: 'create', data: { id: 2, code: 'X' },
    })).catch((e: Error) => e) as Error
    expect(toFrameworkError(err).code).toBe(409)
  })

  test('a patch by id cannot reach it without the directive', async () => {
    const db  = await seedDeleted()
    const err = await svc().patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1, data: { title: 'nope' },
    })).catch((e: Error) => e) as Error
    expect(toFrameworkError(err).code).toBe(404)
  })

  test('…and does with it, which is what frees the value', async () => {
    const db  = await seedDeleted()
    const row = await svc().patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1,
      data: { code: 'X-archived' }, directives: { withDeleted: true },
    })) as { code: string }
    expect(row.code).toBe('X-archived')

    // The slot is free now, which is the whole point of the exercise.
    const made = await svc().create(ctx(db, {
      service: 'docs', method: 'create', data: { id: 2, code: 'X' },
    })) as { code: string }
    expect(made.code).toBe('X')
  })

  test('update by id honours it the same way', async () => {
    const db  = await seedDeleted()
    const row = await svc().update(ctx(db, {
      service: 'docs', method: 'update', id: 1,
      data: { code: 'X-2', title: 'moved' }, directives: { withDeleted: true },
    })) as { code: string }
    expect(row.code).toBe('X-2')
  })

  test('the row stays deleted — moving a value is not a restore', async () => {
    const db = await seedDeleted()
    await svc().patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1,
      data: { code: 'X-archived' }, directives: { withDeleted: true },
    }))
    const out = await svc().find(ctx(db, { service: 'docs' })) as { data: unknown[] }
    expect(out.data).toHaveLength(0)
  })

  // `softDelete:` on a service is the Junction-side OVERRIDE, for a model whose
  // schema does not declare `@@softDelete`; by default the adapter trusts
  // litestone and its own filter never runs. Both halves have to lift together
  // or the directive works on one kind of service and not the other, so the
  // override is exercised here rather than left to the default path above.
  test('the override path lifts too, and still refuses the column itself', async () => {
    const over = createService({ name: 'docs', model: 'doc', softDelete: 'deletedAt' } as never)

    const db  = await seedDeleted()
    const err = await over.patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1, data: { deletedAt: null },
    })).catch((e: Error) => e) as Error
    expect(err.message).toContain('use remove()')

    const blind = await over.patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1, data: { title: 'nope' },
    })).catch((e: Error) => e) as Error
    expect(toFrameworkError(blind).code).toBe(404)

    const row = await over.patch(ctx(db, {
      service: 'docs', method: 'patch', id: 1,
      data: { code: 'X-archived' }, directives: { withDeleted: true },
    })) as { code: string }
    expect(row.code).toBe('X-archived')
  })

  test('remove still does NOT read it — that half is a decision, not a passthrough', async () => {
    const db  = await seedDeleted()
    const err = await svc().remove(ctx(db, {
      service: 'docs', method: 'remove', id: 1, directives: { withDeleted: true },
    })).catch((e: Error) => e) as Error
    expect(toFrameworkError(err).code).toBe(404)
  })
})
