#!/usr/bin/env bun
// web/test/notification-fixture.mjs — an inbox for the seeded owner.
//
//   bun web/test/notification-fixture.mjs <tag>
//
// `verify-screens.mjs`'s fixture for the bell and /notifications/. The seed
// writes no notifications — they are records of sends, and a seed run sends
// nothing — so the drive writes three, the way the inApp driver does: through
// `asSystem()`, with `title`, `body` and `action` merged into `data`.
//
// Two unread and one read, so the bell's count, the Unread filter and All each
// have a different answer. Newer than now, so they sit at the top of the list
// in a known order: the first line of stdout names them newest first.

import { createBasecampDb } from '../../api/src/core/db.ts'

const tag = process.argv[2] ?? 'drive'

const db  = await createBasecampDb()
const sys = db.asSystem()

const owner = await sys.user.findFirst({ where: { email: 'sam@example.com' } })
if (!owner) { console.error('no seeded owner — run db/seed.js first'); process.exit(1) }

const base = Date.now() + 60_000
const rows = [
  { title: `Deploy failed ${tag}`,  body: 'Site → prod — stopped at build', url: '/deployments/', read: false },
  { title: `Job failed ${tag}`,     body: 'nightly-backup exited 1',        url: '/jobs/',        read: false },
  { title: `Alert resolved ${tag}`, body: 'CPU back under 80%',             url: '/alerts/',      read: true  },
]

const made = []
for (const [i, r] of rows.entries()) {
  const n = await sys.notification.create({
    data: {
      userId:    owner.id,
      type:      'deploy_failed',
      data:      { title: r.title, body: r.body, action: { label: 'Open', url: r.url } },
      createdAt: new Date(base - i * 1000).toISOString(),
      readAt:    r.read ? new Date(base).toISOString() : null,
    },
  })
  made.push({ id: n.id, title: r.title, url: r.url, read: r.read })
}

console.log(JSON.stringify(made))
db.$close()
