// test/after-commit-warning.test.ts
//
// FJS-2070: `afterCommit` is at-most-once and `ctx.enqueue` is durable, under
// adjacent names. Mail sent from an afterCommit effect is lost by a crash
// between the commit and the send, so in development it warns, once per call
// site, naming `ctx.enqueue`. A warning and not a refusal: a toast is correct.

import { describe, test, expect } from 'bun:test'

import { createClient }  from '../../litestone/src/index.js'
import { createService, callService } from '../src/core/service.ts'
import { mailerPlugin } from '../src/mail/index.ts'
import { inAfterCommitDrain, warnEffectInDrain } from '../src/core/context.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const SCHEMA = `model Post { id Int @id @default(autoincrement())  title String }`

function ctx(db: unknown, app: unknown): ServiceContext {
  return {
    service: 'posts', method: 'create', id: undefined, data: { title: 't' },
    query: {}, auth: { user: null }, caller: {}, route: {},
    locals: { db }, app, result: null, type: 'before',
  } as unknown as ServiceContext
}

function appWithMail() {
  const sent: unknown[] = []
  const app: any = {}
  mailerPlugin({
    async send(m) { sent.push(m); return { id: '1', message: 'sent' } },
    async batch(ms) { sent.push(...ms); return [] },
  }).register!(app)
  return { app, sent }
}

async function warnings<T>(fn: () => Promise<T>): Promise<string[]> {
  const logged: string[] = []
  const real = console.warn
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  try { await fn() } finally { console.warn = real }
  return logged
}

describe('FJS-2070 — mail inside an afterCommit drain', () => {

  test('warns once per call site and names ctx.enqueue', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
    const { app, sent } = appWithMail()
    const svc = createService({
      name: 'posts',
      async create(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
      hooks: { after: { create: [(c: ServiceContext) => {
        c.afterCommit(async () => { await c.app.mail!.send({ to: 'a@b.co', subject: 's', html: 'h' }) })
      }] } },
    } as never)

    const logged = await warnings(async () => {
      await callService(svc, ctx(db, app))
      await callService(svc, ctx(db, app))
    })

    expect(sent).toHaveLength(2)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("afterCommit effect of 'posts.create'")
    expect(logged[0]).toContain('ctx.enqueue')
  })

  test('silent outside a drain, and the signal is unset there', async () => {
    const { app } = appWithMail()
    expect(inAfterCommitDrain()).toBeUndefined()
    const logged = await warnings(() => app.mail.send({ to: 'a@b.co', subject: 's', html: 'h' }))
    expect(logged).toEqual([])
  })

  test('silent in production', async () => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
      const svc = createService({
        name: 'posts',
        async create(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
        hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => warnEffectInDrain('x')) }] } },
      } as never)
      expect(await warnings(() => callService(svc, ctx(db, {})))).toEqual([])
    } finally { process.env.NODE_ENV = was }
  })
})
