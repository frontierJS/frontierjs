// api/test/restore-schedules.test.ts
//
// FJS-327: every scheduled job in the app stopped firing at the first restart.
//
// A cron registration is in-process — in junction's scheduler and in Caravan
// alike — and the only place a Job's schedule was ever registered was the
// service's `create()`. Nothing re-read the rows at boot, so a deploy silently
// emptied the clock while every row still said `scheduled` in the UI.
//
// Against a real Litestone client AND a real Caravan queue: the claim is that a
// query over rows produces registrations in a scheduler, and both halves are
// exactly what a stand-in would have been written to agree with.

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'

import { GatePlugin }    from '../../../litestone/src/index.js'
import { createTestEnv } from '../../../litestone/src/testing.js'
import { createCaravan } from '@frontierjs/caravan'
import type { CaravanInstance } from '@frontierjs/caravan'

import { basecampGateLevel } from '../src/core/gate.ts'
import { createJobEngine }   from '../src/engine/job.engine.ts'
import { scheduleName }      from '../src/engine/job-schedule.ts'
import type { BasecampApp }  from '../src/basecamp.types.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)

const envs:   { close(): void }[] = []
const queues: CaravanInstance[]   = []

afterEach(async () => {
  for (const q of queues.splice(0)) await q.stop()
  for (const e of envs.splice(0))   e.close()
})

const noopLog = () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
              child: () => l }
  return l
}

/** A real client, a real queue, and the engine over both. */
async function makeApp() {
  const env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: ENC_KEY,
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
  })
  envs.push(env)

  const jobs = createCaravan({ db: ':memory:', pollInterval: 20 })
  queues.push(jobs)

  // `any`, the same reason db/test/schema.test.ts gives: a Litestone client is a
  // Proxy whose accessors are the schema's models, and no static type here
  // knows them. Every line below would otherwise open with the same cast.
  const db: any = env.db.asSystem()
  const app = { data: env.db, jobs, logger: noopLog() } as unknown as BasecampApp
  return { app, jobs, db, engine: createJobEngine(app) }
}

/** A workspace to hang jobs off — Job.workspaceId is required. */
async function workspace(db: any): Promise<string> {
  const stamp   = `${Date.now()}-${Math.round(performance.now())}`
  const account = await db.account.create({
    data: { displayName: 'Acme', slug: `acme-${stamp}` },
  })
  const ws = await db.workspace.create({
    data: { name: 'Ops', slug: `ops-${stamp}`, accountId: account.id, ownerId: account.id },
  })
  return ws.id as string
}

const names = (jobs: CaravanInstance) => jobs.nextRuns().map(r => r.name).sort()

describe('restoreSchedules — the clock is rebuilt from the rows', () => {

  it('re-registers every live scheduled job', async () => {
    // The filed defect, stated as a test: these rows exist and nothing had put
    // them back on the clock since the process that created them.
    const { jobs, db, engine } = await makeApp()
    const workspaceId = await workspace(db)

    await db.job.create({ data: { workspaceId, name: 'nightly', kind: 'scheduled',
                                  cronExpression: '0 2 * * *', command: 'true' } })
    await db.job.create({ data: { workspaceId, name: 'hourly', kind: 'scheduled',
                                  cronExpression: '0 * * * *', command: 'true' } })

    expect(names(jobs)).toEqual([])
    const restored = await engine.restoreSchedules()

    expect(restored).toBe(2)
    expect(names(jobs)).toHaveLength(2)
  })

  it('leaves one-shot and cancelled jobs off the clock', async () => {
    const { jobs, db, engine } = await makeApp()
    const workspaceId = await workspace(db)

    await db.job.create({ data: { workspaceId, name: 'once', kind: 'one_shot', command: 'true' } })
    await db.job.create({ data: { workspaceId, name: 'stopped', kind: 'scheduled',
                                  cronExpression: '0 2 * * *', status: 'cancelled', command: 'true' } })
    const live = await db.job.create({ data: { workspaceId, name: 'live', kind: 'scheduled',
                                               cronExpression: '0 3 * * *', command: 'true' } })

    await engine.restoreSchedules()
    expect(names(jobs)).toEqual([scheduleName(live.id)])
  })

  it('a soft-deleted job is not restored', async () => {
    // `remove()` cancels and soft-deletes, so the row is invisible to every
    // read — including this one. A schedule holding its id would dispatch runs
    // for a job nobody can see.
    const { jobs, db, engine } = await makeApp()
    const workspaceId = await workspace(db)

    const job = await db.job.create({ data: { workspaceId, name: 'gone', kind: 'scheduled',
                                              cronExpression: '0 2 * * *', command: 'true' } })
    await db.job.remove({ where: { id: job.id } })

    await engine.restoreSchedules()
    expect(names(jobs)).toEqual([])
  })

  it('one unparseable expression does not cost the others their schedule', async () => {
    // The expression is refused on the way in, so a row holding a bad one
    // predates the check or was written around it — and losing every OTHER
    // job's schedule to it is the failure mode worth spending a try/catch on.
    const { jobs, db, engine } = await makeApp()
    const workspaceId = await workspace(db)

    await db.job.create({ data: { workspaceId, name: 'bad', kind: 'scheduled',
                                  cronExpression: 'every night', command: 'true' } })
    const good = await db.job.create({ data: { workspaceId, name: 'good', kind: 'scheduled',
                                               cronExpression: '0 4 * * *', command: 'true' } })

    const restored = await engine.restoreSchedules()
    expect(restored).toBe(1)
    expect(names(jobs)).toEqual([scheduleName(good.id)])
  })
})
