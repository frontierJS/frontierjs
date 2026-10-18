// test/audit-fanout.test.ts
//
// Fable audit run 1.5 — what a partial fan-out leaves behind.
//
// notify() formats every transport, validates every transport, then delivers
// them all in parallel with Promise.allSettled and throws if any failed. Each
// test here sends ONE notification through the real builder → driver → db/mail
// path with one transport broken, and asks what the other transport did.
//
// A `test.failing` asserts the behavior the package should have and therefore
// fails today; drop `.failing` when the fix lands.

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Notification } from '../notification.ts'
import { defineNotification } from '../define.ts'
import { inApp, mail } from '../builders.ts'
import { NotificationDeliveryError } from '../errors.ts'
import { notifications } from '../plugin.ts'
import { createTestApp } from '@frontierjs/junction'
import { mail as mailPlugin } from '@frontierjs/junction/mail'
import { makeApp } from './harness.ts'
import type { InAppMessage, MailMessage, Recipient, Transport } from '../types.ts'

class InvoiceDue extends Notification {
  static type = 'InvoiceDue'
  via(): Transport[] { return ['inApp', 'email'] }
  toInApp(): InAppMessage {
    return inApp().title('Invoice due').context('Invoice', 42).build()
  }
  toEmail(): MailMessage {
    return mail().subject('Invoice due').line('Pay up.').build()
  }
}

const bob: Recipient = { id: 'u-bob', email: 'bob@x.test' }

describe('audit 1.5 — a failed transport after a committed one', () => {
  // The first call writes the in-app row, the email throws, notify() throws
  // NotificationDeliveryError. A caller that retries — every job in `example/`
  // throws to make Caravan retry — calls notify() again; the declared key is
  // what tells that retry from a new notification (FJS-D872).
  const smtpDown = (h: { app: any }) => {
    const seen = { attempts: 0 }
    h.app.configure(mailPlugin({ mailer: {
      send: async () => { seen.attempts++; throw new Error('smtp down') },
      batch: async () => { throw new Error('smtp down') },
    } }))
    return seen
  }
  const bobsRows = async (h: { rows: () => Promise<{ userId: unknown, contextId: unknown }[]> }) =>
    (await h.rows()).filter(r => r.userId === 'u-bob' && r.contextId === '42').length

  test('a retry after a failed email does not write a second in-app row', async () => {
    class KeyedInvoiceDue extends InvoiceDue {
      key(): string { return 'invoice:42' }
    }
    const h    = await makeApp({ noMailer: true })
    const seen = smtpDown(h)

    await expect(h.app.notify(bob, new KeyedInvoiceDue())).rejects.toBeInstanceOf(NotificationDeliveryError)
    expect((await h.rows()).length).toBe(1)

    // The retry, as Caravan would make it.
    await h.app.notify(bob, new KeyedInvoiceDue()).catch(() => {})
    expect(seen.attempts).toBe(2)
    expect(await bobsRows(h)).toBe(1)
  })

  test('the key a defineNotification declares holds the retry to one row, per recipient', async () => {
    const invoiceDue = defineNotification<{ id: number }>({
      type:  'InvoiceDue',
      via:   () => ['inApp', 'email'],
      key:   (invoice) => `invoice:${invoice.id}`,
      inApp: (invoice) => inApp().title('Invoice due').context('Invoice', invoice.id),
      email: () => mail().subject('Invoice due').line('Pay up.'),
    })
    const h = await makeApp({ noMailer: true })
    smtpDown(h)

    for (let i = 0; i < 3; i++) await h.app.notify(bob, invoiceDue({ id: 42 })).catch(() => {})
    await h.app.notify({ id: 'u-alice', email: 'alice@x.test' }, invoiceDue({ id: 42 })).catch(() => {})
    expect(await bobsRows(h)).toBe(1)
    expect((await h.rows()).length).toBe(2)
  })

  test('a notification that declares no key keeps writing a row per send', async () => {
    const h = await makeApp({ noMailer: true })
    smtpDown(h)
    await h.app.notify(bob, new InvoiceDue()).catch(() => {})
    await h.app.notify(bob, new InvoiceDue()).catch(() => {})
    expect(await bobsRows(h)).toBe(2)
  })

  // notify() promises to "fail before any delivery" when a transport cannot
  // deliver. `email` is built in, so the driver check passes with no
  // `transports.email` configured and no mailer on the app; the boot check only
  // fires when `transports.email` is a plain object. Without the eager check the
  // in-app row is written, THEN the email driver discovers there is no app.mail.
  test('an email transport with no mailer is refused before the in-app row is written', async () => {
    const h = await makeApp({ noMailer: true })
    await expect(h.app.notify(bob, new InvoiceDue())).rejects.toThrow()
    expect((await h.rows()).length).toBe(0)
  })

  // The record commits before the email leaves; otherwise a failed create
  // leaves the person with mail about a notification that does not exist, and
  // the retry sends the mail again.
  test('no email leaves when the in-app record fails to commit', async () => {
    const h = await makeApp()
    const raw = new Database(process.env.MAIN_DB_PATH!)
    raw.run('DROP TABLE notification')
    raw.close()

    await expect(h.app.notify(bob, new InvoiceDue())).rejects.toBeInstanceOf(NotificationDeliveryError)
    expect(h.sent.length).toBe(0)
  })

  // `transports.email` is the one plain object the plugin accepts — `{ mailer }`
  // — and the name is read by nothing: the driver always sends through
  // app.mail. A second mailer named here configures nothing and is found when
  // mail goes out through the wrong one.
  test('a mailer name no plugin registered is refused at construction', () => {
    expect(() => notifications({ db: {}, transports: { email: { mailer: 'secondary' } } }))
      .toThrow(/secondary/)
    expect(() => notifications({ db: {}, transports: { email: { mailer: 'default' } } })).not.toThrow()
    expect(() => notifications({ db: {}, transports: { email: {} } })).not.toThrow()
  })

  test('the observed shape: one row, no mail, a thrown error (what the three cases above build on)', async () => {
    const h = await makeApp({ noMailer: true })
    h.app.configure(mailPlugin({ mailer: {
      send: async () => { throw new Error('smtp down') },
      batch: async () => { throw new Error('smtp down') },
    } }))
    await expect(h.app.notify(bob, new InvoiceDue())).rejects.toBeInstanceOf(NotificationDeliveryError)
    expect((await h.rows()).length).toBe(1)
    expect(h.sent.length).toBe(0)
  })
})

describe('audit 1.5 — per-recipient grading of the WS push', () => {
  test('the in-app push reaches only the channel named for the recipient', async () => {
    const h = await makeApp()
    const bobFrames   = h.listen('u-bob')
    const aliceFrames = h.listen('u-alice')
    await h.app.notify(bob, new InvoiceDue())
    expect(bobFrames.length).toBe(1)
    expect(aliceFrames.length).toBe(0)
    expect((bobFrames[0] as { event: string }).event).toBe('notifications created')
  })

  test('createTestApp has no channels — the push is skipped and the row still lands', async () => {
    const app: any = await createTestApp()
    const h = await makeApp()
    app.configure(notifications({ db: h.db }))
    await app._startForTest()
    await app.notify({ id: 'u-carol' }, new (class extends Notification {
      static type = 'OnlyInApp'
      via(): Transport[] { return ['inApp'] }
      toInApp(): InAppMessage { return inApp().title('t').build() }
    })())
    expect((await h.rows()).some(r => r.userId === 'u-carol')).toBe(true)
  })
})
