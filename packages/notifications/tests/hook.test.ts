// tests/hook.test.ts
//
// `ctx.app.notify(...)` from a service hook — the way plugin.ts's doc comment
// and every examples/ file say to use this package, and the one path nothing
// exercised (FJS-050). It is not a restatement of the fan-out tests: those call
// `app.notify` on the app object directly, and the claim under test here is
// that a HOOK reaches the same function through `ctx.app`, which is Junction's
// context contract rather than this package's.
//
// The second half of that issue was "no consumer of the in-app record shape
// exists in the repo". The row a UI reads is asserted here field by field, and
// `example/web/src/resources/Notification.mesa` is the real one.

import { describe, test, expect, beforeAll } from 'bun:test'
import { Notification } from '../notification.ts'
import { inApp } from '../builders.ts'
import { createService } from '@frontierjs/junction'
import { makeApp, type Harness } from './harness.ts'
import type { InAppMessage, NotificationRecord, Recipient, Transport } from '../types.ts'

class Signed extends Notification {
  static type = 'Signed'
  constructor(private title: string) { super() }
  via(): Transport[] { return ['inApp'] }
  toInApp(r: Recipient): InAppMessage {
    return inApp()
      .title(this.title)
      .body(`for ${r.id}`)
      .action('Open', '/docs/1')
      .context('Document', 1)
      .data({ documentId: 1 })
      .build()
  }
}

let h: Harness

beforeAll(async () => {
  h = await makeApp()

  // A real service with a real after hook — the row it writes is the evidence
  // the hook ran at all.
  let nextId = 1
  h.app.services.register(createService({
    name:    'documents',
    methods: ['create'],
    async create(ctx: any) { return { id: nextId++, ...ctx.data } },
    hooks: {
      after: {
        create: [
          async (ctx: any) => {
            // `ctx.result` is the envelope — a single travels as { kind, data }.
            const doc = ctx.result.data
            await ctx.app.notify({ id: doc.ownerId }, new Signed(`"${doc.title}" was created`))
          },
        ],
      },
    },
  } as never))
})

describe('ctx.app.notify from a service hook', () => {
  test('the hook reaches app.notify and the row lands', async () => {
    const before = (await h.rows()).length

    await h.app.service('documents').create({ title: 'Contract', ownerId: 'owner-1' })

    const rows = await h.rows()
    expect(rows.length).toBe(before + 1)
    expect(rows[rows.length - 1].userId).toBe('owner-1')
  })

  test('the persisted record has the shape a UI reads', async () => {
    // What `createResource('notifications')` binds to: the row's own columns,
    // and the payload the notification class wrote into `data`.
    await h.app.service('documents').create({ title: 'Invoice', ownerId: 'owner-2' })

    const rows = await h.rows()
    const row: NotificationRecord = rows[rows.length - 1]

    expect(row.type).toBe('Signed')                       // which class rendered it
    expect(row.readAt).toBeNull()                         // unread — what the bell counts
    expect(typeof row.createdAt).toBe('string')           // ISO-8601 TEXT, orderable
    expect(row.contextType).toBe('Document')              // the loose reference
    expect(row.contextId).toBe(1)
    expect(row.data.title).toBe('"Invoice" was created')
    expect(row.data.body).toBe('for owner-2')
    expect(row.data.action).toEqual({ label: 'Open', url: '/docs/1' })
    expect(row.data.documentId).toBe(1)
  })

  test('the WS push carries the same record to the subscribed owner', async () => {
    const frames = h.listen('owner-3')

    await h.app.service('documents').create({ title: 'Receipt', ownerId: 'owner-3' })

    expect(frames.length).toBe(1)
    const frame = frames[0] as { event: string; data: NotificationRecord }
    expect(frame.event).toBe('notification:created')
    expect(frame.data.userId).toBe('owner-3')
    expect(frame.data.data.title).toBe('"Receipt" was created')
  })

  test('a throwing notification surfaces through the hook, not silently', async () => {
    // A hook that swallows this is how "the notification never arrived" becomes
    // a support ticket instead of a stack trace.
    class Broken extends Notification {
      static type = 'Broken'
      via(): Transport[] { return ['inApp'] }
      // no toInApp()
    }
    h.app.services.register(createService({
      name:    'widgets',
      methods: ['create'],
      async create(ctx: any) { return { id: 1, ...ctx.data } },
      hooks: {
        after: { create: [async (ctx: any) => { await ctx.app.notify({ id: 'w' }, new Broken()) }] },
      },
    } as never))

    await expect(h.app.service('widgets').create({}))
      .rejects.toThrow(/does not implement toInApp\(\)/)
  })
})
