// api/test/notify.test.ts
//
// FJS-967: seven kinds were declared, a screen honoured them, and nothing had
// ever sent one — so a person could switch off an email they were never going
// to get, which reads as evidence the delivery exists.
//
// Three claims, and they fail in three different ways.
//
//   **The three lists are one list.** `NotificationKind` (the column's CHECK),
//   `kinds.ts` (what the screen renders) and `api/src/notifications/*` (what can
//   actually be sent) are three spellings of one vocabulary, and any two of them
//   agreeing proves nothing about the third. A kind with no file is a preference
//   nothing honours; a file with no kind is a notification nobody can switch off.
//
//   **The preference decides.** Every acceptance below is PAIRED with the
//   identical send to somebody who turned it off, because a sender that
//   delivered to nobody satisfies any test that only asks about the refusal.
//
//   **Email is a capability, not a preference.** An app with no mailer must
//   still deliver the in-app copy — `notify()` throws on an undeliverable
//   transport BEFORE delivering any of them, so getting this wrong costs the
//   person both.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }             from 'node:path'
import { readdirSync }      from 'node:fs'
import { createTestEnv }    from '@frontierjs/litestone/testing'
import { GatePlugin }       from '@frontierjs/litestone'
import { notificationsPlugin } from '@frontierjs/notifications'

import { basecampGateLevel }   from '../src/core/gate.ts'
import { NOTIFICATION_KINDS }  from '../src/services/notification-preferences/kinds.ts'
import { transportsFor, notifyPeople, workspaceMembers } from '../src/core/notify.ts'
import type { BasecampApp }    from '../src/basecamp.types.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const NOTIF_DIR  = join(import.meta.dir, '..', 'src', 'notifications')
const ENC_KEY    = '0'.repeat(64)

// ─── the three lists ─────────────────────────────────────────────────────

describe('the kinds, the screen and the files are one vocabulary', () => {
  const fromFiles = readdirSync(NOTIF_DIR)
    .filter(f => f.endsWith('.notification.ts'))
    .map(f => f.replace('.notification.ts', ''))
    .sort()

  const fromTable = NOTIFICATION_KINDS.map(k => k.kind).sort()

  test('every kind the screen offers has a notification that can send it', () => {
    // The defect this file exists for, as one assertion. A kind here with no
    // file is a row in `NotificationPreference` that nothing ever reads.
    expect(fromFiles).toEqual(fromTable)
  })

  test('…and the schema enum is the same list again', async () => {
    // The third leg. `kinds.ts` is a deliberate COPY of the enum so a bad kind
    // gets a sentence rather than a SQLite constraint message; a copy is only
    // safe while something holds it to the original. `db/test/schema.test.ts`
    // holds enum ↔ kinds.ts, this holds kinds.ts ↔ the files, and the two
    // together close the triangle.
    // `parseFile` answers `{ valid, schema }` and is synchronous — `.schema` is
    // the half with the models on it.
    const { parseFile } = await import('@frontierjs/litestone')
    const { schema } = parseFile(SCHEMA) as any
    const values = (schema.enums.find((e: any) => e.name === 'NotificationKind')?.values ?? [])
      .map((v: any) => v.name ?? v).sort()
    expect(fromFiles).toEqual(values)
  })

  test('no definition states a type — the file name is the only one', async () => {
    // `type` on an unstamped factory THROWS by design: reading it before the
    // loader has run is asking for a value that does not exist yet, and
    // answering `undefined` would write rows nothing can read back. So the
    // throw IS the assertion — a definition that stated a type would answer
    // instead, and that second spelling is what `notifications.type` and
    // `NotificationPreference.kind` cannot afford between them.
    // Imported FRESH. A module is cached per process and the loader stamps the
    // definitions it walks, so once anything in this suite has built an app —
    // which several files do — the cached module answers its type and this
    // assertion inverts. It passed for as long as it did because no test file
    // sorting before this one booted one; adding a file that does is what
    // showed it. The query string is what defeats the module cache, and reading
    // the source unstamped is what the claim was always about.
    for (const name of fromFiles) {
      const mod = await import(`${join(NOTIF_DIR, `${name}.notification.ts`)}?unstamped`)
      expect(() => (mod.default as any).type).toThrow(/has no type/)
    }
  })
})

// ─── the preference ──────────────────────────────────────────────────────

const noopLog = () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return l
}

const envs: { close(): void }[] = []
afterAll(() => { for (const e of envs.splice(0)) e.close() })

/** A real client and the real plugin. The plugin is what registers the
 *  definitions, and a stand-in registry would agree with a directory that had
 *  been renamed out from under it. */
async function makeApp(opts: { mail?: boolean } = {}) {
  const env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
  })
  envs.push(env)

  const sent: { to: string; subject: string }[] = []
  const app: any = {
    db: env.db, logger: noopLog(),
    // The mailer is real enough to be graded: what matters is whether the email
    // transport was ATTEMPTED, which a recorder answers and a missing property
    // cannot.
    ...(opts.mail ? { mail: { send: async (m: any) => { sent.push({ to: m.to, subject: m.subject }); return { id: '1', message: 'ok' } } } } : {}),
    channel: () => undefined,
    claim(name: string, value: unknown) { (this as any)[name] = value },
  }

  const plugin = notificationsPlugin({
    db: env.db,
    notifications: NOTIF_DIR,
    transports: opts.mail ? { email: { mailer: 'default' } } : {},
  }) as any
  plugin.register(app)
  await plugin.boot?.(app)

  return { app: app as BasecampApp, db: env.db.asSystem() as any, sent }
}

/** A workspace with one accepted member. */
async function member(db: any, tag: string) {
  const stamp = `${tag}-${Math.random().toString(36).slice(2, 8)}`
  const acct  = await db.account.create({ data: { displayName: 'Acme', slug: `acme-${stamp}` } })
  const user  = await db.user.create({
    data: { email: `${stamp}@x.co`, name: 'Pat', accountId: acct.id, status: 'active' },
  })
  const ws = await db.workspace.create({
    data: { name: 'Ops', slug: `ops-${stamp}`, accountId: acct.id, ownerId: user.id },
  })
  await db.workspaceMember.create({
    data: { workspaceId: ws.id, userId: user.id, role: 'owner',
            acceptedAt: new Date().toISOString() },
  })
  return { ws, user }
}

const PAYLOAD = {
  deploymentId: 'd1', appName: 'api', environment: 'production', release: 'v2',
}

describe('a preference decides, and no row means the default', () => {

  test('nobody has said anything, so the kind default applies', async () => {
    // The half a first draft gets backwards. `NotificationPreference` holds a
    // row only where somebody has CHOSEN, so *no row* has to resolve to the
    // kind's own default — resolving it to silence means this app delivers
    // nothing to anybody until they open a screen they have no reason to open.
    const { app, db } = await makeApp()
    const { user } = await member(db, 'default')

    expect(await transportsFor(app, user.id, 'deploy_success')).toEqual(['inApp'])
  })

  test('switching a kind off means nothing is sent — paired with leaving it on', async () => {
    const { app, db } = await makeApp()
    const off = await member(db, 'off')
    const on  = await member(db, 'on')

    await db.notificationPreference.create({
      data: { userId: off.user.id, kind: 'deploy_success', inApp: false, email: false },
    })

    expect(await notifyPeople(app, 'deploy_success', [off.user.id], PAYLOAD)).toBe(0)
    expect(await notifyPeople(app, 'deploy_success', [on.user.id],  PAYLOAD)).toBe(1)

    expect(await db.notification.count({ where: { userId: off.user.id } })).toBe(0)
    expect(await db.notification.count({ where: { userId: on.user.id } })).toBe(1)
  })

  test('the row that lands carries the FILE NAME as its type', async () => {
    // The string the browser reads to pick a renderer, and the same string
    // `NotificationPreference.kind` holds. If these two ever part, a preference
    // stops governing the thing it names and nothing errors.
    const { app, db } = await makeApp()
    const { user } = await member(db, 'type')

    await notifyPeople(app, 'deploy_failed', [user.id], { ...PAYLOAD, reason: 'boom' })
    const row = await db.notification.findFirst({ where: { userId: user.id } })
    expect(row.type).toBe('deploy_failed')
    expect(row.contextType).toBe('Deployment')
    expect(row.readAt).toBe(null)
  })

  test('one person named twice is told once', async () => {
    // Callers assemble their recipient lists from different queries — two
    // memberships, a subject somebody both owns and watches — so the de-dupe is
    // here rather than at each call site.
    const { app, db } = await makeApp()
    const { user } = await member(db, 'dupe')

    expect(await notifyPeople(app, 'deploy_success', [user.id, user.id, user.id], PAYLOAD)).toBe(1)
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(1)
  })

  test('a suspended account is not paged — paired with the active one beside it', async () => {
    const { app, db } = await makeApp()
    const gone   = await member(db, 'susp')
    const active = await member(db, 'live')
    await db.user.update({ where: { id: gone.user.id }, data: { status: 'suspended' } })

    expect(await notifyPeople(app, 'deploy_success', [gone.user.id],   PAYLOAD)).toBe(0)
    expect(await notifyPeople(app, 'deploy_success', [active.user.id], PAYLOAD)).toBe(1)
  })

  test('a kind with no notification file is reported, not thrown', async () => {
    // The one failure this shape adds. A throw here would take out every
    // recipient after it in the same pass, for a fault that is a missing FILE.
    const { app, db } = await makeApp()
    const { user } = await member(db, 'ghost')
    expect(await notifyPeople(app, 'no_such_kind', [user.id], PAYLOAD)).toBe(0)
  })
})

describe('email is a capability, not a preference', () => {

  test('with no mailer the email half is DROPPED and the in-app copy survives', async () => {
    // A Basecamp with no mail provider is a supported configuration. `notify()`
    // validates every requested transport and throws before delivering any of
    // them, so a person who asked for email on an app that cannot mail would
    // otherwise get neither.
    const { app, db } = await makeApp({ mail: false })
    const { user } = await member(db, 'nomail')
    await db.notificationPreference.create({
      data: { userId: user.id, kind: 'deploy_failed', inApp: true, email: true },
    })

    expect(await transportsFor(app, user.id, 'deploy_failed')).toEqual(['inApp'])
    expect(await notifyPeople(app, 'deploy_failed', [user.id], { ...PAYLOAD, reason: 'boom' })).toBe(1)
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(1)
  })

  test('…and with one, the same person gets both', async () => {
    // The pair. Without it, a drop that removed email unconditionally would
    // look exactly like a drop that reads the capability.
    const { app, db, sent } = await makeApp({ mail: true })
    const { user } = await member(db, 'mail')
    await db.notificationPreference.create({
      data: { userId: user.id, kind: 'deploy_failed', inApp: true, email: true },
    })

    expect(await transportsFor(app, user.id, 'deploy_failed')).toEqual(['inApp', 'email'])
    await notifyPeople(app, 'deploy_failed', [user.id], { ...PAYLOAD, reason: 'boom' })

    expect(await db.notification.count({ where: { userId: user.id } })).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(user.email)
    expect(sent[0]!.subject).toContain('api')
  })

  test('every kind can be delivered on BOTH transports', async () => {
    // `kinds.ts` holds DEFAULTS, not a ceiling: a person may turn email on for a
    // kind whose default is in-app only. `notify()` throws
    // NotificationTransportNotImplementedError for a transport with no
    // formatter, so a missing email formatter does not mean *no email* — it
    // means that person gets neither.
    const { app, db, sent } = await makeApp({ mail: true })

    for (const { kind } of NOTIFICATION_KINDS) {
      const { user } = await member(db, `all-${kind}`)
      await db.notificationPreference.create({
        data: { userId: user.id, kind, inApp: true, email: true },
      })
      const n = await notifyPeople(app, kind, [user.id], BOTH_PAYLOAD)
      expect({ kind, delivered: n }).toEqual({ kind, delivered: 1 })
    }
    expect(sent).toHaveLength(NOTIFICATION_KINDS.length)
  })
})

/** A payload wide enough for all seven formatters. Every field any of them
 *  reads, so this test is about the TRANSPORTS rather than about the shapes. */
const BOTH_PAYLOAD = {
  deploymentId: 'd1', appName: 'api', environment: 'production', release: 'v2', reason: 'boom',
  runId: 'r1', jobId: 'j1', jobName: 'nightly',
  eventId: 'e1', ruleName: 'Memory high', severity: 'warning', message: 'over',
  workspaceId: 'w1', workspaceName: 'Ops', personEmail: 'new@x.co', role: 'developer',
  from: '2026-09-01', to: '2026-09-08',
  deploysOk: 3, deploysFailed: 1, alertsFired: 2, jobsFailed: 0,
}

describe('who a workspace tells', () => {
  test('an invitation nobody accepted is not a member', async () => {
    // `acceptedAt` is required by the read. A pending invitation that reached
    // the roster would be telling a stranger about a fleet.
    const { app, db } = await makeApp()
    const { ws, user } = await member(db, 'roster')
    const acct = await db.account.create({
      data: { displayName: 'B', slug: `b-${Math.random().toString(36).slice(2, 8)}` },
    })
    const pending = await db.user.create({
      data: { email: `pending-${Math.random().toString(36).slice(2, 8)}@x.co`,
              accountId: acct.id, status: 'active' },
    })
    await db.workspaceMember.create({
      data: { workspaceId: ws.id, userId: pending.id, role: 'viewer' },   // no acceptedAt
    })

    expect(await workspaceMembers(app, ws.id)).toEqual([user.id])
  })
})
