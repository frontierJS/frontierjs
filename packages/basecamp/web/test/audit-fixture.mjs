#!/usr/bin/env bun
// web/test/audit-fixture.mjs — a trail long enough to have a far edge.
//
//   bun web/test/audit-fixture.mjs <count> <tag>
//
// `verify-screens.mjs`'s fixture for the audit window, and a separate file
// because it needs the app's own Litestone client: it runs under bun, imports
// `api/src/core/db.ts`, and must sit inside the package for `@frontierjs/*` to
// resolve at all.
//
// The seeder writes about fourteen trail rows per workspace, which is a fleet
// with a full catalogue and a trail that fits on one screen — fine as an
// example, useless as a fixture for a window, since a window with nothing past
// its edge is indistinguishable from a hard cap.
//
// Two things about the rows are deliberate.
//
// **They are NEWER than everything already there**, so they occupy the top of
// the trail in a known order and the drive can name a row by its position.
//
// **Five of them share one `createdAt`, straddling the 50-row edge** (indices
// 47–51). `createdAt` is not unique — a burst of writes inside one millisecond
// is the ordinary case for an audit trail, which is written by a hook on every
// mutation — so a cursor built from the sort column ALONE names a position five
// rows wide: resuming strictly past it skips two of them, resuming at it serves
// three twice. Litestone appends the model's own id to the sort keys for
// exactly this, and this block is what makes that visible rather than assumed.

import { createBasecampDb } from '../../api/src/core/db.ts'

const count = Number(process.argv[2] ?? 60)
const tag   = process.argv[3] ?? 'window'
if (!Number.isFinite(count) || count < 1) {
  console.error('usage: bun web/test/audit-fixture.mjs <count> <tag>')
  process.exit(1)
}

const db  = await createBasecampDb()
const sys = db.asSystem()

// The workspace the drive signs into: the seeded owner's first membership.
const owner = await sys.user.findFirst({ where: { email: 'sam@example.com' } })
if (!owner) { console.error('no seeded owner — run db/seed.js first'); process.exit(1) }
const member = await sys.workspaceMember.findFirst({
  where: { userId: owner.id }, orderBy: { acceptedAt: 'asc' },
})
if (!member) { console.error('the seeded owner is in no workspace'); process.exit(1) }

// Newer than anything in the trail, by a margin no seeded row can be inside.
const base = Date.now() + 60_000
const TIE_FROM = 47, TIE_TO = 51

const at = (i) => {
  // Descending: index 0 is the newest. The tie block collapses onto one instant.
  const rank = (i >= TIE_FROM && i <= TIE_TO) ? TIE_FROM : i
  return new Date(base - rank * 1000).toISOString()
}

for (let i = 0; i < count; i++) {
  await sys.auditEvent.create({
    data: {
      workspaceId: member.workspaceId,
      actorId:     owner.id,
      actorType:   'user',
      action:      `drive.${tag}`,
      subjectType: 'drive',
      // Short on purpose: the table truncates a subject id to eight
      // characters, and the drive names rows by reading them off the screen.
      subjectId:   `${tag[0]}-${String(i).padStart(3, '0')}`,
      createdAt:   at(i),
      diff:        { note: `${tag} #${i}` },
    },
  })
}

console.log(JSON.stringify({ workspaceId: member.workspaceId, count, tag }))
db.$close()
