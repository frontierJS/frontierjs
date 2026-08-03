// tests/fanout.test.ts
//
// The fan-out — db record + WS event + email — against a real Junction app.
// This is the whole point of the package and none of it was covered: the 8
// pre-existing tests fed hand-built MailLine[] arrays straight to the
// renderers, so nothing ever ran a real builder through a real driver.
//
// That gap hid a defect for the second time. The 2026-08-01 fix added
// renderText/renderHtml for an empty-email-body bug and tested THOSE. But the
// drivers never called builder.build(), so they read chainable methods instead
// of values, and both channels still shipped empty:
//
//   in-app row → data:{}, contextType:null, contextId:null
//   email      → no subject, text:"", html = an empty wrapper div
//
// and notify() reported success. Every assertion below that inspects a payload
// exists because of that.

import { describe, test, expect, beforeAll } from 'bun:test'
import { Notification } from '../notification.ts'
import { inApp, mail } from '../builders.ts'
import {
  NotificationChannelNotImplementedError,
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
} from '../errors.ts'
import { notificationsPlugin } from '../plugin.ts'
import { createTestApp, mailerPlugin } from '@frontierjs/junction'
import { makeApp, type Harness } from './harness.ts'
import type { Channel, InAppMessage, MailMessage, User } from '../types.ts'

// Authored the canonical way — .build() at the end of the chain.
class Welcome extends Notification {
  static type = 'Welcome'
  constructor(private chans: Channel[] = ['inApp', 'email']) { super() }
  via(): Channel[] { return this.chans }
  toInApp(u: User): InAppMessage {
    return inApp()
      .title('Welcome!')
      .body(`Hi ${u.id}`)
      .action('Get started', '/dashboard')
      .context('Order', 7)
      .data({ plan: 'pro' })
      .build()
  }
  toEmail(): MailMessage {
    return mail()
      .subject('Welcome aboard')
      .greeting('Hi there')
      .line('Glad you joined.')
      .action('Open', 'https://x.test/go')
      .build()
  }
}

// Authored the way the JSDoc @example blocks used to show — no .build().
// TypeScript flags this (InAppBuilder is not an InAppMessage), but JavaScript
// consumers hit it silently, so notify() materialises it rather than shipping
// an empty payload.
class UnbuiltWelcome extends Notification {
  static type = 'UnbuiltWelcome'
  via(): Channel[] { return ['inApp', 'email'] }
  toInApp(): InAppMessage {
    return inApp().title('T').body('B').data({ k: 'v' }) as unknown as InAppMessage
  }
  toEmail(): MailMessage {
    return mail().subject('S').greeting('G').line('L') as unknown as MailMessage
  }
}

let h: Harness
beforeAll(async () => { h = await makeApp() })

// ─── the fan-out ──────────────────────────────────────────────────────────

describe('fan-out to all three channels', () => {
  test('register() attaches app.notify at configure() time', () => {
    expect(typeof h.app.notify).toBe('function')
  })

  test('an in-app notification persists a row with the FULL payload', async () => {
    const before = (await h.rows()).length
    await h.app.notify({ id: 'u1', email: 'a@b.test' }, new Welcome(['inApp']))

    const rows = await h.rows()
    expect(rows.length).toBe(before + 1)

    const row = rows[rows.length - 1]
    expect(row.userId).toBe('u1')
    expect(row.type).toBe('Welcome')
    // The regression: these were all empty/null.
    expect(row.data.title).toBe('Welcome!')
    expect(row.data.body).toBe('Hi u1')
    expect(row.data.action).toEqual({ label: 'Get started', url: '/dashboard' })
    expect(row.data.plan).toBe('pro')
    expect(row.contextType).toBe('Order')
    expect(row.contextId).toBe(7)
  })

  test('an email notification sends a real subject AND body', async () => {
    await h.app.notify({ id: 'u2', email: 'c@d.test' }, new Welcome(['email']))

    const msg = h.sent[h.sent.length - 1]
    expect(msg.to).toBe('c@d.test')
    expect(msg.subject).toBe('Welcome aboard')        // was undefined
    expect(msg.text).toContain('Hi there')            // was ''
    expect(msg.text).toContain('Glad you joined.')
    expect(msg.text).toContain('https://x.test/go')
    expect(msg.html).toContain('<strong>Hi there</strong>')
    expect(msg.html).toContain('href="https://x.test/go"')
  })

  test('a subscribed WS connection receives notification:created with the payload', async () => {
    const frames = h.listen('u3')
    await h.app.notify({ id: 'u3', email: 'e@f.test' }, new Welcome(['inApp']))

    expect(frames.length).toBe(1)
    const frame = frames[0] as { event: string; data: { userId: string; data: Record<string, unknown> } }
    expect(frame.event).toBe('notification:created')
    expect(frame.data.userId).toBe('u3')
    expect(frame.data.data.title).toBe('Welcome!')
  })

  test('one notify() reaches db, WS and mail together', async () => {
    const frames = h.listen('u4')
    const beforeRows = (await h.rows()).length
    const beforeMail = h.sent.length

    await h.app.notify({ id: 'u4', email: 'g@h.test' }, new Welcome(['inApp', 'email']))

    expect((await h.rows()).length).toBe(beforeRows + 1)
    expect(h.sent.length).toBe(beforeMail + 1)
    expect(frames.length).toBe(1)
  })

  test('the WS push is optional — no channels plugin still persists the row', async () => {
    // app.channel?.() returns undefined without the plugin; that must not throw.
    const bare = await makeApp()
    delete bare.app.channel
    const before = (await bare.rows()).length

    await bare.app.notify({ id: 'u5', email: 'i@j.test' }, new Welcome(['inApp']))
    expect((await bare.rows()).length).toBe(before + 1)
  })
})

// ─── un-built builders ────────────────────────────────────────────────────

describe('a builder that never had build() called', () => {
  // builders.ts documents build() as "called internally by the driver". It
  // wasn't. notify() now materialises, so the forgiving path delivers real
  // content instead of silently delivering nothing.
  test('still delivers a full in-app payload', async () => {
    const before = (await h.rows()).length
    await h.app.notify({ id: 'u6', email: 'k@l.test' }, new UnbuiltWelcome())

    const rows = await h.rows()
    expect(rows.length).toBe(before + 1)
    const row = rows[rows.length - 1]
    expect(row.data.title).toBe('T')
    expect(row.data.body).toBe('B')
    expect(row.data.k).toBe('v')
  })

  test('still sends a real subject and body', async () => {
    const msg = h.sent[h.sent.length - 1]
    expect(msg.subject).toBe('S')
    expect(msg.text).toContain('G')
    expect(msg.text).toContain('L')
    // The `to` guard used to see the chainable to() method and pass.
    expect(msg.to).toBe('k@l.test')
  })
})

// ─── failure paths ────────────────────────────────────────────────────────

describe('failure paths', () => {
  test('a channel with no toX() fails eagerly, before any delivery', async () => {
    class Bad extends Notification {
      static type = 'Bad'
      via(): Channel[] { return ['inApp', 'email'] }
      toInApp(): InAppMessage { return inApp().title('x').build() }
    }
    const before = (await h.rows()).length

    await expect(h.app.notify({ id: 'u7', email: 'm@n.test' }, new Bad()))
      .rejects.toThrow(NotificationChannelNotImplementedError)

    // eager means nothing was delivered on the valid channel either
    expect((await h.rows()).length).toBe(before)
  })

  test('an unknown channel with no driver fails eagerly', async () => {
    class Slack extends Notification {
      static type = 'Slack'
      via(): Channel[] { return ['slack'] }
      toSlack() { return { text: 'hi' } }
    }
    await expect(h.app.notify({ id: 'u8' }, new Slack()))
      .rejects.toThrow(NotificationDriverNotFoundError)
  })

  test('the email channel without a mailer reports the ordering requirement', async () => {
    const bare = await makeApp({ noMailer: true })
    const err = await bare.app.notify({ id: 'u9', email: 'o@p.test' }, new Welcome(['email']))
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(NotificationDeliveryError)
    expect((err as Error).message).toContain('mailerPlugin')
  })

  test('an email with no recipient anywhere is refused', async () => {
    // Previously the chainable to() method made this guard pass, and the
    // mailer was handed a function as the address.
    const err = await h.app.notify({ id: 'u10' }, new Welcome(['email']))
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(NotificationDeliveryError)
    expect((err as Error).message).toContain('recipient')
  })

  test('a failing email does not stop the in-app record — channels are isolated', async () => {
    const iso = await makeApp()
    iso.app.mail = { send: async () => { throw new Error('SMTP down') } }
    const before = (await iso.rows()).length

    await expect(iso.app.notify({ id: 'u11', email: 'q@r.test' }, new Welcome(['inApp', 'email'])))
      .rejects.toThrow(NotificationDeliveryError)

    expect((await iso.rows()).length).toBe(before + 1)
  })
})

// ─── drivers ──────────────────────────────────────────────────────────────

describe('channel drivers', () => {
  test('a custom driver receives the materialised message', async () => {
    const seen: unknown[] = []
    const slack = { channel: 'slack', send: async (_u: User, m: unknown) => { seen.push(m) } }
    class Slack extends Notification {
      static type = 'Slack2'
      via(): Channel[] { return ['slack'] }
      toSlack() { return { text: 'ping' } }
    }
    const a = await makeApp({ channels: { slack } })
    await a.app.notify({ id: 'u12' }, new Slack())

    expect(seen).toEqual([{ text: 'ping' }])
  })

  // A driver registered for a built-in name used to be stored and then never
  // consulted: the built-in ran and the explicit override was ignored.
  test('a driver registered for inApp OVERRIDES the built-in', async () => {
    let used = false
    const custom = { channel: 'inApp', send: async () => { used = true } }
    const a = await makeApp({ channels: { inApp: custom } })
    const before = (await a.rows()).length

    await a.app.notify({ id: 'u13', email: 's@t.test' }, new Welcome(['inApp']))

    expect(used).toBe(true)
    expect((await a.rows()).length).toBe(before)   // built-in did not also write
  })

  // 'email'/'sms' were skipped unconditionally when building the registry, so
  // an SMS driver could never be registered and SMS was unimplementable.
  test('sms becomes available once a driver is registered', async () => {
    const delivered: unknown[] = []
    const sms = { channel: 'sms', send: async (_u: User, m: unknown) => { delivered.push(m) } }
    class Alert extends Notification {
      static type = 'Alert'
      via(): Channel[] { return ['sms'] }
      toSms() { return { body: 'ping' } }
    }
    const a = await makeApp({ channels: { sms } })
    await a.app.notify({ id: 'u14', phone: '+100' }, new Alert())

    expect(delivered).toEqual([{ body: 'ping' }])
  })

  test('sms without a driver fails eagerly rather than at delivery', async () => {
    class Alert extends Notification {
      static type = 'Alert2'
      via(): Channel[] { return ['sms'] }
      toSms() { return { body: 'ping' } }
    }
    await expect(h.app.notify({ id: 'u15', phone: '+1' }, new Alert()))
      .rejects.toThrow(NotificationDriverNotFoundError)
  })

  test('a plain config object is not mistaken for a driver', async () => {
    // { mailer: 'default' } configures the built-in email path; it has no
    // send(), so it must not be registered as an override.
    const a = await makeApp({ channels: { email: { mailer: 'default' } } })
    await a.app.notify({ id: 'u16', email: 'u@v.test' }, new Welcome(['email']))

    expect(a.sent.length).toBe(1)
    expect(a.sent[0].subject).toBe('Welcome aboard')
  })
})

// ─── cross-package shape ──────────────────────────────────────────────────

describe('composes with @frontierjs/auth user ids', () => {
  // The documented schema said `userId Int`, but auth issues String uuids, so
  // the in-app channel died on `cannot store TEXT value in INTEGER column`.
  // README and examples/wiring.ts now document String.
  test('a uuid userId persists and round-trips', async () => {
    const uuid = 'c5a2c568-38f0-4a3d-b530-72bc0da3fef7'
    await h.app.notify({ id: uuid, email: 'w@x.test' }, new Welcome(['inApp']))

    const rows = await h.rows()
    expect(rows[rows.length - 1].userId).toBe(uuid)
  })
})

// ─── declared ordering ────────────────────────────────────────────────────

describe('the mailer dependency is declared, not just documented', () => {
  // "mailerPlugin must be configured before notificationsPlugin" used to live
  // only in an examples comment; getting it wrong surfaced as a failed send
  // long after startup. The plugin now declares requires: ['mailer'] when the
  // email channel is configured, and Junction refuses to boot without it.
  const opts = { db: {}, channels: { email: { mailer: 'default' } } } as never

  test('declares requires: ["mailer"] when the email channel is configured', () => {
    expect((notificationsPlugin(opts) as { requires?: string[] }).requires).toEqual(['mailer'])
  })

  test('does NOT require a mailer for in-app only', () => {
    expect((notificationsPlugin({ db: {} } as never) as { requires?: string[] }).requires)
      .toBeUndefined()
  })

  test('does NOT require a mailer when a custom email driver is supplied', () => {
    const driver = { channel: 'email', send: async () => {} }
    const p = notificationsPlugin({ db: {}, channels: { email: driver } } as never)
    expect((p as { requires?: string[] }).requires).toBeUndefined()
  })

  test('startup fails when the mailer is missing', async () => {
    const app: any = await createTestApp()
    app.configure(notificationsPlugin(opts))

    await expect(app._startForTest()).rejects.toThrow(/requires "mailer"/)
  })

  test('startup fails when the mailer is configured AFTER notifications', async () => {
    const app: any = await createTestApp()
    app.configure(notificationsPlugin(opts))
    app.configure(mailerPlugin({ send: async () => {} } as never))

    await expect(app._startForTest()).rejects.toThrow(/configured AFTER it/)
  })

  test('startup succeeds when the mailer comes first', async () => {
    const app: any = await createTestApp()
    app.configure(mailerPlugin({ send: async () => {} } as never))
    app.configure(notificationsPlugin(opts))

    await expect(app._startForTest()).resolves.toBeUndefined()
  })
})
