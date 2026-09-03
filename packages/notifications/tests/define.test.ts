// tests/define.test.ts
//
// `defineNotification` — a notification with no class.
//
// The two halves worth testing are the ones a class could not get wrong and
// this can: the TYPE, which is persisted data and is now derived from a file
// name, and an ASYNC formatter, which is the whole reason the class needed a
// static factory behind a private constructor.
//
// Every send goes through the real plugin against a real database, for the
// reason `fanout.test.ts` states at the top of itself: this package has twice
// shipped a formatter that returned a chainable builder instead of a value,
// and reported success both times.

import { describe, test, expect, beforeAll } from 'bun:test'
import { join } from 'node:path'
import { defineNotification } from '../define.ts'
import { inApp, mail } from '../builders.ts'
import { resolveNotificationsDir, loadNotifications } from '../loader.ts'
import { makeApp, type Harness } from './harness.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'notifications')

describe('defineNotification — the definition itself', () => {

  test('refuses a definition with no via, naming what via is', () => {
    expect(() => defineNotification({} as never))
      .toThrow(/needs a `via`/)
  })

  test('refuses a definition with no transport formatter', () => {
    expect(() => defineNotification({ via: () => ['inApp'] }))
      .toThrow(/no transport formatter/)
  })

  test('answers its transports with NO payload — which is what a preferences screen asks', () => {
    const d = defineNotification<{ n: number }>({
      type:  'Two',
      via:   () => ['inApp'],
      inApp: (p) => inApp().title(String(p.n)),
      email: (p) => mail().subject(String(p.n)),
    })
    // `via` takes the payload rather than closing over it, so the definition is
    // answerable before anything is sent. A factory that bound the payload
    // could not answer this.
    expect(d.transports).toEqual(['inApp', 'email'])
  })

  test('an unnamed definition throws on FIRST USE rather than writing rows under undefined', () => {
    const d = defineNotification<void>({ via: () => ['inApp'], inApp: () => inApp().title('x') })
    // Constructing is fine — the loader has not run yet, and it is what names it.
    const sendable = d(undefined)
    expect(() => sendable.notificationType).toThrow(/has no type/)
    expect(() => d.type).toThrow(/<Type>\.notification\.ts/)
  })

  test('the three members notify() reads are the whole surface', () => {
    const d = defineNotification<{ a: string }>({
      type:  'Surface',
      via:   () => ['inApp'],
      inApp: (p) => inApp().title(p.a),
    })
    const n = d({ a: 'hello' })
    expect(n.notificationType).toBe('Surface')
    expect(n.via({ id: 1 })).toEqual(['inApp'])
    expect(n.getMessageFor('inApp', { id: 1 })).toBeDefined()
    // A transport with no formatter answers undefined, which is the contract
    // notify() turns into NotificationTransportNotImplementedError.
    expect(n.getMessageFor('sms', { id: 1 })).toBeUndefined()
  })

  test('via sees the payload AND the recipient, so one notification can route per person', () => {
    const d = defineNotification<{ urgent: boolean }>({
      type:  'Routed',
      via:   (p, r) => (p.urgent && r.email ? ['inApp', 'email'] : ['inApp']),
      inApp: () => inApp().title('x'),
      email: () => mail().subject('x'),
    })
    expect(d({ urgent: true  }).via({ id: 1, email: 'a@b.test' })).toEqual(['inApp', 'email'])
    expect(d({ urgent: true  }).via({ id: 1 })).toEqual(['inApp'])
    expect(d({ urgent: false }).via({ id: 1, email: 'a@b.test' })).toEqual(['inApp'])
  })
})

describe('the loader — the file name is the type', () => {

  test('a declared directory that is not there is reported, never probed around', () => {
    const r = resolveNotificationsDir({ declared: join(FIXTURES, 'nope') })
    expect(r.source).toBe('declared-missing')
    expect(r.dir).toBeNull()
  })

  test('false turns loading off', () => {
    expect(resolveNotificationsDir({ declared: false }).source).toBe('disabled')
  })

  test('probes both layouts beside the entry — flat, and the scaffolded one', () => {
    const r = resolveNotificationsDir({ entry: join(FIXTURES, '..', '..', 'entry.ts') })
    // tests/fixtures/../../ → the package root; neither candidate exists there,
    // and what matters is that BOTH were looked at and are nameable.
    expect(r.probed).toHaveLength(2)
    expect(r.probed[0]).toMatch(/notifications$/)
    expect(r.probed[1]).toMatch(/src[/\\]notifications$/)
  })

  test('names each definition for its file, with no case conversion to get wrong', async () => {
    const reg = await loadNotifications(FIXTURES)
    expect(reg.get('WelcomePerson')?.type).toBe('WelcomePerson')
    expect(reg.get('ReceiptIssued')?.type).toBe('ReceiptIssued')
  })

  test('a STATED type wins over the file name — the rename escape hatch', async () => {
    const reg = await loadNotifications(FIXTURES)
    // Renamed.notification.ts states 'LegacyName' because rows were written
    // under it. Registered under the stated string, not the file's.
    expect(reg.get('LegacyName')).toBeDefined()
    expect(reg.has('Renamed')).toBe(false)
  })

  test('a file exporting no definition is not registered', async () => {
    const reg = await loadNotifications(FIXTURES)
    expect(reg.has('NotOne')).toBe(false)
  })
})

describe('through the real plugin', () => {
  let h: Harness

  beforeAll(async () => {
    h = await makeApp({ notifications: FIXTURES, transports: { email: { mailer: 'default' } } })
  })

  test('app.notifications answers what this app can send, without sending one', () => {
    const reg = (h.app as { notifications?: Map<string, unknown> }).notifications
    expect(reg).toBeDefined()
    expect([...reg!.keys()].sort()).toEqual(['LegacyName', 'ReceiptIssued', 'WelcomePerson'])
  })

  test('the registry is read-only at RUNTIME, not only in the types', () => {
    const reg = (h.app as { notifications?: Map<string, unknown> }).notifications!
    // Object.freeze does nothing to a Map's internal slots, so the guard is on
    // the methods. What a build can send is decided at boot; a type added after
    // it makes the app disagree with its own snapshot.
    expect(() => reg.set('Injected', 1)).toThrow(/read-only/)
    expect(() => reg.delete('OrderPaid')).toThrow(/read-only/)
    expect(() => reg.clear()).toThrow(/read-only/)
    expect(reg.has('Injected')).toBe(false)
    // Reading is untouched.
    expect(reg.get('WelcomePerson')).toBeDefined()
    expect([...reg.keys()].length).toBe(3)
  })

  test('a loaded definition writes its FILE NAME into notifications.type', async () => {
    const welcome = (await import(join(FIXTURES, 'WelcomePerson.notification.ts'))).default
    await h.app.notify({ id: 'u1' }, welcome({ name: 'Ada' }))

    const rows = await h.rows()
    const row  = rows.find(r => r.userId === 'u1')
    expect(row?.type).toBe('WelcomePerson')
    // The payload really reached the row — the defect this package shipped
    // twice was a builder stored instead of its built value.
    expect(row?.data).toMatchObject({ title: 'Welcome', body: 'Ada', name: 'Ada' })
  })

  test('an ASYNC formatter is awaited, which is what retires the static factory', async () => {
    const receipt = (await import(join(FIXTURES, 'ReceiptIssued.notification.ts'))).default
    await h.app.notify({ id: 'u2', email: 'ada@example.test' }, receipt({ total: 1250 }))

    const sent = h.sent.at(-1)
    expect(sent?.subject).toBe('Receipt for 1250')
    // Not a Promise, not a builder — a rendered string. Both are what a missing
    // await produces, and both used to report success.
    expect(typeof sent?.text).toBe('string')
    expect(sent?.text).toContain('Thank you')
  })

  test('a definition the loader never saw is refused BEFORE it writes an unnamed row', async () => {
    const orphan = defineNotification<void>({ via: () => ['inApp'], inApp: () => inApp().title('x') })
    await expect(h.app.notify({ id: 'u3' }, orphan(undefined))).rejects.toThrow(/has no type/)
  })
})
