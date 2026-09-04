// tests/p3-fixes.test.ts
// ─────────────────────────────────────────────────────────────────────────
// Regression tests for the P3 structure pass (2026-07-18):
//
//   1. Context types live in core (core/context.ts); transport/bridge.ts
//      re-exports the same bindings for compatibility.
//   2. Scheduler + AI moved out of plugins/ — old import paths still work
//      via shims.
//   3. The SMTP client moved to src/mail/smtp.ts — old path still works.
//   4. HTTP PUT now dispatches update (full replace), PATCH stays patch.
//   5. createBaseService delegates to the litestone base: query operators
//      ($gt/$in) are translated for plain clients, and remove() falls back
//      to a plain client's delete().
//   6. configure() fails loudly on a plugin whose register() throws.
//   7. Broken (existing-but-invalid) config files abort loading instead of
//      silently booting on defaults.
//   8. The two route matchers agree (matchRoute delegates).
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'bun:test'
import { createTestApp, request, createService, createBaseService } from '../index.ts'
import { requestMeta as coreRequestMeta, freezeUser as coreFreezeUser } from '../src/core/context.ts'
import { requestMeta as bridgeRequestMeta, freezeUser as bridgeFreezeUser } from '../src/transport/bridge.ts'
import { sendMail as shimSendMail } from '../src/plugins/email/system/smtp.ts'
import { sendMail } from '../src/mail/smtp.ts'
import { matchRouteSegments, matchPathDirect, parsePathSegments } from '../src/transport/router.ts'
import { loadConfig } from '../src/config/index.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── 1–3. Moves with stable re-exports ────────────────────────────────────

describe('P3: relocations keep old import paths working', () => {

  it('bridge re-exports the SAME context bindings core owns', () => {
    expect(bridgeRequestMeta).toBe(coreRequestMeta)
    expect(bridgeFreezeUser).toBe(coreFreezeUser)
  })

  // The `plugins/scheduler` and `plugins/ai` shims that used to be asserted
  // here are gone: neither path was in the `exports` map, so the old import
  // they preserved could not be reached from outside the package at all.
  // This one stays because `plugins/email/system/smtp` IS live — the `./email`
  // subpath re-exports SmtpError through it.
  it('plugins/email/system/smtp shim re-exports src/mail/smtp', () => {
    expect(shimSendMail).toBe(sendMail)
  })
})

// ─── 4. PUT → update ──────────────────────────────────────────────────────

describe('P3: HTTP PUT dispatches update', () => {

  function makeSvc(calls: string[]) {
    return createService({
      name: 'docs',
      async get()        { return { id: '1' } },
      async update(ctx)  { calls.push('update'); return { id: String(ctx.id), ...ctx.data as object } },
      async patch(ctx)   { calls.push('patch');  return { id: String(ctx.id), ...ctx.data as object } },
    })
  }

  it('PUT → update, PATCH → patch', async () => {
    const calls: string[] = []
    const app = await createTestApp({ services: [() => makeSvc(calls)] })

    const put = await request(app).put('/docs/1').send({ name: 'replaced' })
    expect(put.status).toBe(200)
    const patch = await request(app).patch('/docs/1').send({ name: 'merged' })
    expect(patch.status).toBe(200)

    expect(calls).toEqual(['update', 'patch'])
  })
})

// ─── 5. Merged base service ───────────────────────────────────────────────

describe('P3: createBaseService delegates to the litestone base', () => {

  function capturingClient() {
    const captured: Record<string, unknown>[] = []
    const rows = [{ id: '1', age: 30 }]
    return {
      captured,
      client: {
        things: {
          findMany:  async (args: Record<string, unknown>) => { captured.push(args); return rows },
          count:     async () => rows.length,
          findUnique: async () => rows[0],
          create:    async (a: { data: unknown }) => a.data,
          update:    async (a: { data: Record<string, unknown> }) => ({ id: '1', ...a.data }),
          updateMany: async () => ({ count: 1 }),
          // NOTE: plain-client contract — only `delete`, no `remove`
          delete:    async () => rows[0],
          deleteMany: async () => ({ count: 1 }),
        },
      },
    }
  }

  it('translates $gt/$in operators for plain clients', async () => {
    const { captured, client } = capturingClient()
    const base = createBaseService({ model: 'things', db: () => client })
    const svc  = createService({ name: 'things', ...base })
    const app  = await createTestApp({ services: [() => svc] })

    const res = await app.service('things').find({ age: { $gt: 18 } })
    expect(res).toBeDefined()

    // The old independent implementation passed `{ age: { $gt: 18 } }`
    // through raw; the merged path translates to litestone's `gt`.
    const where = (captured.at(-1) as { where: Record<string, unknown> }).where
    expect(where.age).toEqual({ gt: 18 })
  })

  it("remove() falls back to a plain client's delete()", async () => {
    const { client } = capturingClient()
    const base = createBaseService({ model: 'things', db: () => client })
    const svc  = createService({ name: 'things', ...base })
    const app  = await createTestApp({ services: [() => svc] })

    const res = await request(app).delete('/things/1')
    expect(res.status).toBe(200)
  })
})

// ─── 6. configure() fails loudly ──────────────────────────────────────────

describe('P3: configure() rethrows sync register() failures', () => {

  it('throws at the configure() call site', async () => {
    const app = await createTestApp({})
    expect(() =>
      app.configure({
        name: 'broken',
        register() { throw new Error('boom') },
      })
    ).toThrow(/broken.*register.*boom|boom/)
  })
})

// ─── 7. Broken config aborts loading ──────────────────────────────────────

describe('P3: config imports fail loudly', () => {

  it('missing config dir → defaults, no throw', async () => {
    const cfg = await loadConfig('/tmp/definitely-does-not-exist-junction')
    expect(cfg.port).toBeDefined()   // defaults applied
  })

  it('existing-but-broken config file → throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junction-cfg-'))
    try {
      writeFileSync(join(dir, 'default.ts'), 'export default { port: 1234, oops: (}')  // syntax error
      expect(loadConfig(dir)).rejects.toThrow(/failed to load/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── 8. One route matcher ─────────────────────────────────────────────────

describe('P3: route matchers agree', () => {

  it('mid-pattern wildcards match identically via both entry points', () => {
    const segments = parsePathSegments('/files/*/meta')
    const path     = '/files/a/b/c'

    const direct  = matchPathDirect(segments, path)
    const viaSegs = matchRouteSegments(segments, ['files', 'a', 'b', 'c'])

    // Previously matchRoute only honored last-segment wildcards and would
    // reject this pattern while matchPathDirect accepted it.
    expect(viaSegs).toEqual(direct)
  })
})

// ─── 9. Minimal service file: createBaseService({ model }) only ──────────

describe('P3.1: db-less createBaseService + loader wrapping', () => {

  function plainPostsClient() {
    const rows: Record<string, unknown>[] = [{ id: '1', title: 'hello' }]
    return {
      posts: {
        findMany:   async () => rows,
        count:      async () => rows.length,
        findUnique: async (a: { where: { id: string } }) => rows.find(r => r.id === a.where.id) ?? null,
        create:     async (a: { data: Record<string, unknown> }) => { const rec = { id: '2', ...a.data }; rows.push(rec); return rec },
        update:     async (a: { where: { id: string }; data: Record<string, unknown> }) => {
          const rec = rows.find(r => r.id === a.where.id); if (!rec) return null
          Object.assign(rec, a.data); return rec
        },
        updateMany: async () => ({ count: 1 }),
        delete:     async (a: { where: { id: string } }) => rows.find(r => r.id === a.where.id) ?? null,
        deleteMany: async () => ({ count: 1 }),
      },
    }
  }

  it('createService({ name, model }) with no db falls back to app.db', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'posts', model: 'posts' })],
    })
    ;(app as { db: unknown }).db = plainPostsClient()

    const list = await request(app).get('/posts')
    expect(list.status).toBe(200)
    expect((list.body as { total: number }).total).toBe(1)

    const one = await request(app).get('/posts/1')
    expect(one.status).toBe(200)
    expect((one.body as { title: string }).title).toBe('hello')
  })

  it("the loader wraps a bare createBaseService({ model }) return — the user's minimal file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'junction-svcdir-'))
    try {
      // The exact minimal file shape (import path absolute for the test env)
      writeFileSync(join(dir, 'posts.service.ts'), `
import { createBaseService } from '${process.cwd()}/index.ts'

export function createPostsService() {
  return createBaseService({
    model: 'posts',
  })
}
`)
      const app = await createTestApp({})
      ;(app as { db: unknown }).db = plainPostsClient()

      const { autoloadServices } = await import('../src/core/loader.ts')
      await autoloadServices({ dir, app, registry: app.services })

      expect(app.services.has('posts')).toBe(true)     // name from filename

      const res = await request(app).get('/posts/1')
      expect(res.status).toBe(200)
      expect((res.body as { title: string }).title).toBe('hello')

      const created = await request(app).post('/posts').send({ title: 'new' })
      expect(created.status).toBe(201)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
