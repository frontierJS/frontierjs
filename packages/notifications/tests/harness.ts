// tests/harness.ts
// A real Litestone database + a real Junction app with channels, a capturing
// mailer, and notificationsPlugin.
//
// The bug this package shipped twice — an empty email body, then an empty
// in-app payload — was invisible to unit tests of the renderers because those
// were fed hand-built arrays. Only sending a notification through the real
// builder → driver → db/WS/mail path shows it. See ../../VERIFYING.md.

import { createClient, parse, generateDDLForDatabase } from '@frontierjs/litestone'
import { splitStatements } from '@frontierjs/litestone/migrate'
import { createTestApp, channels, mailerPlugin } from '@frontierjs/junction'
import { Database } from 'bun:sqlite'
// Relative, not '@frontierjs/litestone/testing': bun resolves workspace:* to a
// COPY under node_modules/.bun, so the package spec tests a stale reaper.
import { tempDir } from '../../litestone/src/tmp-dirs.js'
import { join } from 'path'
import { notificationsPlugin } from '../plugin.ts'
import type { NotificationRecord, OutgoingMail } from '../types.ts'

// The schema exactly as README.md and examples/wiring.ts document it.
// userId is String because @frontierjs/auth issues uuid ids.
const MODEL = `
model Notification {
  id          Int       @id
  userId      String
  type        String
  data        Json
  contextType String?
  contextId   Int?
  readAt      DateTime?
  createdAt   DateTime  @default(now())

  @@gate("0.8.4.8")
}
`


export interface Harness {
  app:      any
  db:       any
  sys:      any
  /** Every message handed to app.mail.send(). */
  sent:     OutgoingMail[]
  /** All persisted notification rows, newest last. */
  rows:     () => Promise<NotificationRecord[]>
  /** Subscribe a fake WS connection to a user's channel; returns received frames. */
  listen:   (userId: string | number) => unknown[]
  cleanup:  () => void
}

export async function makeApp(opts: {
  transports?: Record<string, unknown>
  /** Omit the mailer entirely, to exercise the missing-mailer path. */
  noMailer?: boolean
  /** Where `*.notification.ts` live. Absent, the plugin probes from the entry —
   *  which under a test runner is the TEST FILE, so it finds nothing. */
  notifications?: string | false
} = {}): Promise<Harness> {
  const dir = tempDir('fjs-notif-')
  const dbPath = join(dir, 'n.db')

  const parsed = parse(`database main { path "${dbPath}" }\n${MODEL}`)
  if (!parsed.valid) throw new Error(`schema failed to parse: ${parsed.errors.join(', ')}`)

  const raw = new Database(dbPath)
  for (const stmt of splitStatements(generateDDLForDatabase(parsed.schema, 'main'))) {
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  }
  raw.close()

  process.env.MAIN_DB_PATH = dbPath
  const db = await createClient({ parsed })

  const sent: OutgoingMail[] = []
  const app: any = await createTestApp()
  app.configure(channels())
  // CONFIGURED, not assigned. `app.mail = {...}` set the property without the
  // plugin, so `requires: ['mailer']` — which notificationsPlugin declares and
  // junction checks at startup against presence AND configure order — had
  // nothing to find. It never fired because this harness stopped at configure()
  // and no boot phase ran; an app wired this way is refused at start().
  if (!opts.noMailer) {
    // `mailerPlugin` takes the whole IMail — a `send` answering void satisfied
    // `app.mail = …` by assignment and fails the interface by name.
    const send = async (m: OutgoingMail) => { sent.push(m); return { id: String(sent.length), message: 'captured' } }
    app.configure(mailerPlugin({ send, batch: (ms: OutgoingMail[]) => Promise.all(ms.map(send)) }))
  }
  app.configure(notificationsPlugin({
    db,
    notifications: opts.notifications,
    transports:    opts.transports as never,
  }))

  // The harness stopped at configure() for its whole life, so no plugin's
  // boot() had ever run here — an app that is configured and never started.
  // register() is where drivers land, which is why the fan-out tests passed;
  // anything a plugin does at boot was invisible. Idempotent, and it skips
  // every phase that needs a port.
  await app._startForTest()

  // asSystem() is untyped at this boundary (notifications duck-types the
  // Litestone client rather than importing it) — name the one accessor used.
  const sys = db.asSystem() as unknown as {
    notification: { findMany(opts: Record<string, unknown>): Promise<NotificationRecord[]> }
  }

  return {
    app,
    db,
    sys,
    sent,
    rows:    () => sys.notification.findMany({}),
    listen:  (userId) => {
      const frames: unknown[] = []
      const conn = {
        id: `c-${String(userId)}`,
        data: {},
        socket: {
          send: (d: string) => { try { frames.push(JSON.parse(d)) } catch { frames.push(d) } },
          close() {},
          readyState: 1,
        },
      }
      app.channel(`notifications:user:${userId}`).join(conn)
      return frames
    },
    cleanup: () => { /* dir is reaped by the NEXT run — see tmp-dirs.js */ },
  }
}
