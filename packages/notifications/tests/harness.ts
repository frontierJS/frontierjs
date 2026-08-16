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
import { createTestApp, channels } from '@frontierjs/junction'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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

const tempDirs: string[] = []
let exitHookInstalled = false
function removeAtExit(dir: string): void {
  tempDirs.push(dir)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
}

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
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-notif-'))
  removeAtExit(dir)
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
  if (!opts.noMailer) app.mail = { send: async (m: OutgoingMail) => { sent.push(m) } }
  app.configure(notificationsPlugin({ db, transports: opts.transports as never }))

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
    cleanup: () => { /* dir is reaped at process exit */ },
  }
}
