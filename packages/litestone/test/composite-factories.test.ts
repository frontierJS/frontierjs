// Factories and the sample-write builder read a composite relation over EVERY
// pair of its key (FJS-2793, the testing half of FJS-2790).
//
// `rel.fields[0]` named one column of `(scheduleId, personId)`: a fresh parent
// filled `scheduleId` and left `personId` unset, and a `has()` child was pointed
// back by `scheduleId` alone. Both fail loud — NOT NULL, FK refusal — but only at
// the model that has the shape. The fixture shares its first column between two
// relations, which is what makes the second parent have to be built UNDER the
// first one's value.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { createTestEnv, sampleWrites } from '../src/testing.js'

const CLI     = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')
const rootTmp = mkdtempSync(join(tmpdir(), 'litestone-composite-'))
afterAll(() => { try { rmSync(rootTmp, { recursive: true, force: true }) } catch {} })

const SRC = `
model Schedule {
  id     String @id
  people Person[]
  shifts Shift[]
}

model Person {
  id          String @id
  scheduleId  String
  schedule    Schedule @relation(fields: [scheduleId], references: [id])
  name        String
  assignments Assignment[]
  @@unique([scheduleId, id])
}

model Shift {
  id          String @id
  scheduleId  String
  schedule    Schedule @relation(fields: [scheduleId], references: [id])
  name        String
  assignments Assignment[]
  @@unique([scheduleId, id])
}

model Assignment {
  id          String @id
  scheduleId  String
  shiftId     String
  shift       Shift  @relation(fields: [scheduleId, shiftId], references: [scheduleId, id])
  personId    String
  person      Person @relation(fields: [scheduleId, personId], references: [scheduleId, id])
}
`

describe('a composite relation is filled on every column', () => {
  test('sampleWrites: the create payload names a real Shift and Person of one schedule', async () => {
    const env: any = await createTestEnv({ schema: SRC, autoFactories: true })
    const s: any = await sampleWrites(env.schema, env.system, { models: ['Assignment'] })
    expect(s.Assignment.error).toBeUndefined()
    const { create } = s.Assignment
    expect(create.scheduleId).toBeDefined()
    expect(create.shiftId).toBeDefined()
    expect(create.personId).toBeDefined()
    const made = await env.system.assignment.create({ data: create })
    expect(made.personId).toBe(create.personId)
    const person = await env.system.person.findFirst({ where: { id: create.personId } })
    expect(person.scheduleId).toBe(create.scheduleId)
  })

  test('has(): a child of a composite relation is pointed back on every column', async () => {
    const env: any = await createTestEnv({ schema: SRC, autoFactories: true })
    const schedule = await env.factories.schedule.asSystem().createOne()
    const person   = await env.factories.person.asSystem().createOne({ scheduleId: schedule.id })
    const made = await env.factories.shift.asSystem()
      .has('assignments', 2, { overrides: { personId: person.id } })
      .createOne({ scheduleId: schedule.id })
    expect(made.assignments).toHaveLength(2)
    for (const a of made.assignments) {
      expect(a.scheduleId).toBe(schedule.id)
      expect(a.shiftId).toBe(made.id)
    }
  })
})

// ─── the CLI and Studio ───────────────────────────────────────────────────────

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

async function cli(cwd: string, args: string[]) {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout: stripAnsi(out), stderr: stripAnsi(err), exit }
}

async function project(label: string, assignmentIndexes: string) {
  const dir = mkdtempSync(join(rootTmp, `${label}-`))
  mkdirSync(join(dir, 'migrations'))
  writeFileSync(join(dir, 'schema.lite'),
    SRC.replace(/(model Assignment \{[\s\S]*?)\n\}/, `$1\n${assignmentIndexes}\n}`)
       .replace(/(@@unique\(\[scheduleId, id\]\))/g, '$1\n  @@index([scheduleId])'))
  writeFileSync(join(dir, 'litestone.config.js'),
    `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`)
  await cli(dir, ['migrate', 'create', 'init'])
  await cli(dir, ['migrate', 'apply'])
  return dir
}

describe('the CLI advises on a composite key as one key', () => {
  test('doctor: an unindexed (scheduleId, shiftId) names both columns', async () => {
    const dir = await project('doctor-bare', '')
    const r = await cli(dir, ['doctor'])
    expect(r.stdout).toContain('scheduleId+shiftId')
    expect(r.stdout).toContain('scheduleId+personId')
    expect(r.stdout).toContain('@@index([scheduleId, shiftId])')
  })

  test('doctor: an index leading with the key columns, in any order, answers it', async () => {
    const dir = await project('doctor-indexed', '@@index([shiftId, scheduleId])\n  @@index([personId, scheduleId])')
    const r = await cli(dir, ['doctor'])
    expect(r.stdout).not.toContain('Assignment: FK column')
  })
})

describe('Studio resolves a composite parent by every pair', () => {
  test('/api/row/detail: the parent is the Person of that schedule, not its first', async () => {
    const dir = await project('studio', '')
    const db = new Database(join(dir, 'test.db'))
    db.run(`INSERT INTO "Schedule" (id) VALUES ('s1'), ('s2')`)
    db.run(`INSERT INTO "Person" (id, scheduleId, name) VALUES ('sam', 's1', 'Sam'), ('bob', 's1', 'Bob'), ('zed', 's2', 'Zed')`)
    db.run(`INSERT INTO "Shift" (id, scheduleId, name) VALUES ('am', 's1', 'Morning')`)
    db.run(`INSERT INTO "Assignment" (id, scheduleId, shiftId, personId) VALUES ('a1', 's1', 'am', 'bob')`)
    db.close()

    const proc = Bun.spawn(['bun', CLI, 'studio', '--port=0', '--no-open'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    try {
      const reader = proc.stdout.getReader()
      let buf = ''
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !/Litestone Studio at/.test(buf)) {
        const { value, done } = await reader.read()
        if (done) break
        buf += stripAnsi(new TextDecoder().decode(value))
      }
      const port = Number(buf.match(/http:\/\/localhost:(\d+)/)?.[1])
      expect(port).toBeGreaterThan(0)
      const d: any = await fetch(`http://localhost:${port}/api/row/detail`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: 'Assignment', id: 'a1' }),
      }).then(r => r.json())
      const person = d.parents.find((p: any) => p.relation === 'person')
      expect(person.row.id).toBe('bob')
      expect(person.fk).toBe('scheduleId, personId')
      expect(person.jump).toBe('bob')
    } finally {
      try { proc.kill('SIGKILL') } catch {}
      await proc.exited
    }
  })
})
