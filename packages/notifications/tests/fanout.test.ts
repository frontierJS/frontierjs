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
// of values, and both transports still shipped empty:
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
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
  NotificationRecipientError,
  NotificationTransportNotImplementedError,
} from '../errors.ts'
import { notificationsPlugin } from '../plugin.ts'
import { createTestApp, mailerPlugin } from '@frontierjs/junction'
import { makeApp, type Harness } from './harness.ts'
import type { InAppMessage, MailMessage, Recipient, Transport } from '../types.ts'

// Authored the canonical way — .build() at the end of the chain.
class Welcome extends Notification {
  static type = 'Welcome'
  constructor(private chans: Transport[] = ['inApp', 'email']) { super() }
  via(): Transport[] { return this.chans }
  toInApp(u: Recipient): InAppMessage {
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
  via(): Transport[] { return ['inApp', 'email'] }
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

describe('fan-out to all three transports', () => {
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
  test('a transport with no toX() fails eagerly, before any delivery', async () => {
    class Bad extends Notification {
      static type = 'Bad'
      via(): Transport[] { return ['inApp', 'email'] }
      toInApp(): InAppMessage { return inApp().title('x').build() }
    }
    const before = (await h.rows()).length

    await expect(h.app.notify({ id: 'u7', email: 'm@n.test' }, new Bad()))
      .rejects.toThrow(NotificationTransportNotImplementedError)

    // eager means nothing was delivered on the valid transport either
    expect((await h.rows()).length).toBe(before)
  })

  test('an unknown transport with no driver fails eagerly', async () => {
    class Slack extends Notification {
      static type = 'Slack'
      via(): Transport[] { return ['slack'] }
      toSlack() { return { text: 'hi' } }
    }
    await expect(h.app.notify({ id: 'u8' }, new Slack()))
      .rejects.toThrow(NotificationDriverNotFoundError)
  })

  test('the email transport without a mailer reports the ordering requirement', async () => {
    const bare = await makeApp({ noMailer: true })
    const err = await bare.app.notify({ id: 'u9', email: 'o@p.test' }, new Welcome(['email']))
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(NotificationDeliveryError)
    expect((err as Error).message).toContain('mailerPlugin')
  })

  test('an email with no address anywhere is refused eagerly', async () => {
    // Previously the chainable to() method made this guard pass, and the
    // mailer was handed a function as the address. It was then a delivery
    // failure; addressability is now decided before anything is sent, so a
    // two-transport notification does not half-land.
    const err = await h.app.notify({ id: 'u10' }, new Welcome(['email']))
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(NotificationRecipientError)
    expect((err as Error).message).toContain('recipient.email is missing')
  })

  test('a failing email does not stop the in-app record — transports are isolated', async () => {
    const iso = await makeApp()
    iso.app.mail = { send: async () => { throw new Error('SMTP down') } }
    const before = (await iso.rows()).length

    await expect(iso.app.notify({ id: 'u11', email: 'q@r.test' }, new Welcome(['inApp', 'email'])))
      .rejects.toThrow(NotificationDeliveryError)

    expect((await iso.rows()).length).toBe(before + 1)
  })
})

// ─── drivers ──────────────────────────────────────────────────────────────

describe('transport drivers', () => {
  test('a custom driver receives the materialised message', async () => {
    const seen: unknown[] = []
    const slack = { transport: 'slack', send: async (_r: Recipient, m: unknown) => { seen.push(m) } }
    class Slack extends Notification {
      static type = 'Slack2'
      via(): Transport[] { return ['slack'] }
      toSlack() { return { text: 'ping' } }
    }
    const a = await makeApp({ transports: { slack } })
    await a.app.notify({ id: 'u12' }, new Slack())

    expect(seen).toEqual([{ text: 'ping' }])
  })

  // A driver registered for a built-in name used to be stored and then never
  // consulted: the built-in ran and the explicit override was ignored.
  test('a driver registered for inApp OVERRIDES the built-in', async () => {
    let used = false
    const custom = { transport: 'inApp', send: async () => { used = true } }
    const a = await makeApp({ transports: { inApp: custom } })
    const before = (await a.rows()).length

    await a.app.notify({ id: 'u13', email: 's@t.test' }, new Welcome(['inApp']))

    expect(used).toBe(true)
    expect((await a.rows()).length).toBe(before)   // built-in did not also write
  })

  // 'email'/'sms' were skipped unconditionally when building the registry, so
  // an SMS driver could never be registered and SMS was unimplementable.
  test('sms becomes available once a driver is registered', async () => {
    const delivered: unknown[] = []
    const sms = { transport: 'sms', send: async (_r: Recipient, m: unknown) => { delivered.push(m) } }
    class Alert extends Notification {
      static type = 'Alert'
      via(): Transport[] { return ['sms'] }
      toSms() { return { body: 'ping' } }
    }
    const a = await makeApp({ transports: { sms } })
    await a.app.notify({ id: 'u14', phone: '+100' }, new Alert())

    expect(delivered).toEqual([{ body: 'ping' }])
  })

  test('sms without a driver fails eagerly rather than at delivery', async () => {
    class Alert extends Notification {
      static type = 'Alert2'
      via(): Transport[] { return ['sms'] }
      toSms() { return { body: 'ping' } }
    }
    await expect(h.app.notify({ id: 'u15', phone: '+1' }, new Alert()))
      .rejects.toThrow(NotificationDriverNotFoundError)
  })

  test('a plain config object is not mistaken for a driver', async () => {
    // { mailer: 'default' } configures the built-in email path; it has no
    // send(), so it must not be registered as an override.
    const a = await makeApp({ transports: { email: { mailer: 'default' } } })
    await a.app.notify({ id: 'u16', email: 'u@v.test' }, new Welcome(['email']))

    expect(a.sent.length).toBe(1)
    expect(a.sent[0].subject).toBe('Welcome aboard')
  })
})

// ─── cross-package shape ──────────────────────────────────────────────────

describe('composes with @frontierjs/auth user ids', () => {
  // The documented schema said `userId Int`, but auth issues String uuids, so
  // the in-app transport died on `cannot store TEXT value in INTEGER column`.
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
  // email transport is configured, and Junction refuses to boot without it.
  const opts = { db: {}, transports: { email: { mailer: 'default' } } } as never

  test('declares requires: ["mailer"] when the email transport is configured', () => {
    expect((notificationsPlugin(opts) as { requires?: string[] }).requires).toEqual(['mailer'])
  })

  test('does NOT require a mailer for in-app only', () => {
    expect((notificationsPlugin({ db: {} } as never) as { requires?: string[] }).requires)
      .toBeUndefined()
  })

  test('does NOT require a mailer when a custom email driver is supplied', () => {
    const driver = { transport: 'email', send: async () => {} }
    const p = notificationsPlugin({ db: {}, transports: { email: driver } } as never)
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

// ─── addressing (FJS-096) ─────────────────────────────────────────────────

describe('a recipient is not a user', () => {
  // The unit of address is structural, so a shop customer used to be passed as
  // a User with an invented id (`customer:42`). That is right for email and a
  // trap for inApp: the row is keyed by that id, so it is a notification nobody
  // can ever read, written with no error. `id` is now optional and inApp says so.
  test('an email-only recipient with no id delivers', async () => {
    await h.app.notify({ email: 'customer@shop.test', name: 'Ada' }, new Welcome(['email']))

    const msg = h.sent[h.sent.length - 1]
    expect(msg.to).toBe('customer@shop.test')
    expect(msg.subject).toBe('Welcome aboard')
  })

  test('inApp for a recipient with no id is refused by name, before any delivery', async () => {
    const before     = (await h.rows()).length
    const beforeMail = h.sent.length

    const err = await h.app.notify(
      { email: 'customer@shop.test' },
      new Welcome(['inApp', 'email']),
    ).catch((e: Error) => e)

    expect(err).toBeInstanceOf(NotificationRecipientError)
    expect((err as Error).message).toContain('no id')
    // Eager: the email half did not go out either — a fan-out that half-lands
    // is harder to reason about than one that refuses.
    expect((await h.rows()).length).toBe(before)
    expect(h.sent.length).toBe(beforeMail)
  })

  test('the driver restates the guard — it is reachable without notify()', async () => {
    const { sendInApp } = await import('../drivers/inapp.ts')
    await expect(
      sendInApp({ email: 'x@y.test' }, new Welcome(['inApp']), { title: 'x' }, h.app, h.db),
    ).rejects.toThrow(NotificationRecipientError)
  })

  test('a registered driver owns its own addressing rule', async () => {
    // Only the driver knows what it addresses by — a Slack driver wants a
    // handle, not an id or an email — so the built-in checks do not apply to it.
    const seen: Recipient[] = []
    const slack = { transport: 'slack', send: async (r: Recipient) => { seen.push(r) } }
    class Ping extends Notification {
      static type = 'Ping'
      via(): Transport[] { return ['slack'] }
      toSlack() { return { text: 'hi' } }
    }
    const a = await makeApp({ transports: { slack } })
    await a.app.notify({ handle: '@ada' }, new Ping())

    expect(seen).toEqual([{ handle: '@ada' }])
  })
})

// ─── formatting happens once ──────────────────────────────────────────────

describe('each to*() is called once per notify()', () => {
  // Validation used to build the message to check the method existed, throw it
  // away, and build it again to deliver. A formatter that renders a template
  // did it twice, and the message that was validated was never the one sent.
  test('one call per transport, not two', async () => {
    let inAppCalls = 0
    let emailCalls = 0
    class Counted extends Notification {
      static type = 'Counted'
      via(): Transport[] { return ['inApp', 'email'] }
      toInApp(): InAppMessage { inAppCalls++; return inApp().title('t').build() }
      toEmail(): MailMessage { emailCalls++; return mail().subject('s').line('l').build() }
    }
    await h.app.notify({ id: 'u17', email: 'y@z.test' }, new Counted())

    expect(inAppCalls).toBe(1)
    expect(emailCalls).toBe(1)
  })
})

// ─── plugin lifecycle (FJS-049) ───────────────────────────────────────────

describe('plugin lifecycle', () => {
  test('the old `channels:` option is refused by name, not ignored', () => {
    // Silently ignoring it would configure nothing and surface as a missing
    // driver at first send.
    expect(() => notificationsPlugin({ db: {}, channels: { email: { mailer: 'x' } } } as never))
      .toThrow(/`channels:` is now `transports:`/)
  })

  test('boot() refuses when the email transport has no app.mail', async () => {
    // requires: ['mailer'] proves the plugin is CONFIGURED. This proves the
    // mailer it should have installed is actually there.
    const app: any = await createTestApp()
    app.configure({ name: 'mailer', register() { /* installs nothing */ } })
    app.configure(notificationsPlugin({ db: {}, transports: { email: { mailer: 'default' } } } as never))

    await expect(app._startForTest()).rejects.toThrow(/app\.mail is not set/)
  })

  test('shutdown() closes every registered driver', async () => {
    const closed: string[] = []
    const a = { transport: 'a', send: async () => {}, shutdown: () => { closed.push('a') } }
    const b = { transport: 'b', send: async () => {}, shutdown: async () => { closed.push('b') } }
    const plugin = notificationsPlugin({ db: {}, transports: { a, b } } as never)
    plugin.register({} as never)

    await plugin.shutdown()
    expect(closed).toEqual(['a', 'b'])
  })

  test('one driver that cannot close does not stop the next', async () => {
    const closed: string[] = []
    const bad  = { transport: 'bad',  send: async () => {}, shutdown: () => { throw new Error('stuck') } }
    const good = { transport: 'good', send: async () => {}, shutdown: () => { closed.push('good') } }
    const plugin = notificationsPlugin({ db: {}, transports: { bad, good } } as never)
    plugin.register({} as never)

    await expect(plugin.shutdown()).resolves.toBeUndefined()
    expect(closed).toEqual(['good'])
  })

  test('a driver with no shutdown() is skipped, not called', async () => {
    const plugin = notificationsPlugin({ db: {}, transports: { x: { transport: 'x', send: async () => {} } } } as never)
    plugin.register({} as never)
    await expect(plugin.shutdown()).resolves.toBeUndefined()
  })
})

// ─── state ────────────────────────────────────────────────────────────────

describe('plugin state', () => {
  test('notify() on an app the plugin never configured names the missing plugin', async () => {
    const { notify } = await import('../notify.ts')
    await expect(notify({ id: 'u' }, new Welcome(['inApp']), {} as never))
      .rejects.toThrow(/notificationsPlugin/)
  })

  test('state does not enumerate onto the app surface', () => {
    const app: Record<string, unknown> = {}
    notificationsPlugin({ db: {} } as never).register(app as never)

    // `_db` and `_drivers` used to sit here in plain sight, and a JSON of the
    // app carried the whole Litestone client with it.
    expect(Object.keys(app)).toEqual(['notify'])
  })
})
