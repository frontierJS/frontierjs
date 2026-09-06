// support-attribution.test.ts — who an audit entry says did it, when somebody
// was standing behind the principal.
//
// Inside a support episode the session resolves to the SUBJECT — that is what
// bounds an operator at the subject's own level without anything having to
// check — so `ctx.auth.id` answers who the write was made AS and nothing
// answers who made it. Left alone, every impersonated write files under the
// person it was done to. That is the default in the field (Laravel Nova files
// the impersonated user as the owner of the action) and it is what makes a
// trail useless as evidence: the one name that matters is the one missing.
//
// Every row here is a PAIR — the same write with and without an operator —
// because a swap that fired on every write would satisfy any test that only
// asked about the episode.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver logger }
  model Thing { id String @id @default(uuid())  name String  @@log(audit) }
`

const PRINCIPAL = { id: 'subject-1', type: 'user' }

/** One write as `PRINCIPAL`, with whatever provenance `from` answers. */
async function writeOne(dir: string, from: Record<string, unknown> | null) {
  const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  if (from) db.$logContext(() => from)
  await db.$setAuth(PRINCIPAL).thing.create({ data: { name: 'x' } })
  await tick()
  const rows = await db.asSystem().auditLogs.findMany({})
  db.$close()
  return rows[0]
}

describe('an audit entry names the operator when there is one', () => {

  test('with no episode the entry is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-support-'))
    try {
      const row = await writeOne(dir, null)
      expect(row.actorId).toBe('subject-1')
      expect(row.actorType).toBe('user')
      expect(row.subjectId).toBeNull()
      expect(row.episodeId).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('inside an episode the two ids swap roles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-support-'))
    try {
      const row = await writeOne(dir, { operatorId: 'operator-9', episodeId: 'sess-7' })
      // The half that is the whole feature: the person who did it is named.
      expect(row.actorId).toBe('operator-9')
      // And the half that keeps the row honest — `actorId` no longer answers
      // *which principal did the Data boundary enforce as*, so that answer has
      // to be somewhere or the entry has traded one missing name for another.
      expect(row.subjectId).toBe('subject-1')
      expect(row.episodeId).toBe('sess-7')
      expect(row.actorType).toBe('support')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('provenance without an operator does not swap anything', async () => {
    // The negative control. Every other provenance column is present, so a
    // swap keyed on *is there a log context at all* would pass the row above
    // and fail here.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-support-'))
    try {
      const row = await writeOne(dir, {
        correlationId: 'corr-1', source: 'things.create', origin: 'http',
        ip: '127.0.0.1', userAgent: 'test', tenant: null,
      })
      expect(row.correlationId).toBe('corr-1')
      expect(row.actorId).toBe('subject-1')
      expect(row.actorType).toBe('user')
      expect(row.subjectId).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an operator with no principal is still named', async () => {
    // `asSystem()` has no principal, so the subject is null and the operator is
    // the only name there is. It must not fall back to the system's silence.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-support-'))
    try {
      const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
      db.$logContext(() => ({ operatorId: 'operator-9', episodeId: 'sess-7' }))
      await db.asSystem().thing.create({ data: { name: 'x' } })
      await tick()
      const row = (await db.asSystem().auditLogs.findMany({}))[0]
      db.$close()
      expect(row.actorId).toBe('operator-9')
      expect(row.subjectId).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a trail the app declared itself keeps only what it declared', () => {

  test('the operator is dropped in silence, and that is the accepted gap', async () => {
    // `@@log` may name a real model instead of the auto one, and an entry is
    // written with the keys that model does not declare dropped — no error, no
    // warning, `dropped: 0`. So an app that declared its own trail before this
    // existed records episodes with the operator missing.
    //
    // Asserted rather than argued, and asserted as still-BROKEN: the fix is a
    // `litestone advise` rule, deliberately not built while every scaffolded
    // app uses the auto-model (IDEAS/support-mode.md § What was cut). When that
    // rule lands this row is what tells you it did.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-support-'))
    try {
      const schema = `
        database main  { path ":memory:" }
        database audit { path "${dir}/audit.db" driver logger model AuditRow }
        model AuditRow {
          id String @id @default(uuid())
          operation String
          model String
          actorId String?
          createdAt DateTime @default(now())
          @@db(audit)
        }
        model Thing { id String @id @default(uuid())  name String  @@log(audit) }
      `
      const db: any = await createClient({ schema, resolveFrom: dir })
      db.$logContext(() => ({ operatorId: 'operator-9', episodeId: 'sess-7' }))
      await db.$setAuth(PRINCIPAL).thing.create({ data: { name: 'x' } })
      await tick()
      const rows = await db.asSystem().auditRow.findMany({})
      const stats = db.$logStats()
      db.$close()

      expect(rows).toHaveLength(1)
      expect(stats.dropped).toBe(0)          // nothing failed
      expect(rows[0].actorId).toBe('operator-9')
      expect('subjectId' in rows[0]).toBe(false)   // and nothing said so
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
