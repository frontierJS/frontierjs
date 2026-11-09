/*
 * finish-after-cancel.test.ts — a run that answers after its row was cancelled.
 *
 * `cancelled` is a one-way door on both `Job` and `Deployment`, and the
 * runner's `finishRun` writes as the system client. It used to write the old
 * way through that door: a job cancelled mid-run went back to `pending` or
 * `failed`, and a release cancelled mid-build became `success` and put its app
 * back to `running`. Since `asSystem()` holds the machine (`FJS-D502`) the same
 * write is refused, so the method has to leave a cancelled row where it is.
 * Each case is paired with the uncancelled run finishing normally.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { join }              from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'

process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, target: any
const uniq = () => Math.random().toString(36).slice(2, 8)

beforeAll(async () => {
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
  const a    = await sys.user.create({ data: { email: `u-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: a.id, role: 'admin',
    capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  admin = session({ id: a.id, workspaceId: ws.id })

  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  const environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
  const slug = `app-${uniq()}`
  target = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug, kind: 'container' } })
})

describe('a job run that finishes after the job was cancelled', () => {
  async function running() {
    const sys = env.system as any
    const job = await sys.job.create({ data: { workspaceId: ws.id, name: `j-${uniq()}`, kind: 'oneShot', command: 'true' } })
    const run = await env.as(admin).service('jobs').call('startRun', job.id, { trigger: 'manual' })
    return { job, runId: run.runId as string }
  }

  test('leaves the job cancelled, and records how the run ended', async () => {
    const sys = env.system as any
    const { job, runId } = await running()
    await sys.job.transition(job.id, 'cancel')
    await env.as(admin).service('jobs').call('finishRun', job.id, { runId, status: 'success', output: 'ok' })
    expect((await sys.job.findUnique({ where: { id: job.id } })).status).toBe('cancelled')
    expect((await sys.jobRun.findUnique({ where: { id: runId } })).status).toBe('success')
  })

  test('an uncancelled job goes back to pending', async () => {
    const sys = env.system as any
    const { job, runId } = await running()
    await env.as(admin).service('jobs').call('finishRun', job.id, { runId, status: 'success', output: 'ok' })
    expect((await sys.job.findUnique({ where: { id: job.id } })).status).toBe('pending')
  })
})

describe('a release that finishes after it was cancelled', () => {
  async function building() {
    const sys = env.system as any
    const row = await sys.deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
    return sys.deployment.transition(row.id, 'build')
  }

  test('stays cancelled', async () => {
    const sys = env.system as any
    const d = await building()
    await sys.deployment.transition(d.id, 'cancel')
    const out = await env.as(admin).service('deployments').call('finishRun', d.id, { status: 'success' })
    expect(out.status).toBe('cancelled')
    expect((await sys.deployment.findUnique({ where: { id: d.id } })).status).toBe('cancelled')
    expect((await sys.app.findUnique({ where: { id: target.id } })).status).not.toBe('running')
  })

  // A follow-up queued behind this release (`jobs/release-follow-up.job.ts`)
  // creates the next one only when no release reads in flight.
  test('is no longer in flight, so a queued follow-up may release', async () => {
    const { inFlightRelease } = await import('../src/domain/release/release-record.ts')
    const sys = env.system as any
    const d = await building()
    expect((await inFlightRelease(env.app, target.id))?.id).toBe(d.id)
    await sys.deployment.transition(d.id, 'cancel')
    await env.as(admin).service('deployments').call('finishRun', d.id, { status: 'success' })
    expect(await inFlightRelease(env.app, target.id)).toBeNull()
  })

  test('an uncancelled release succeeds', async () => {
    const sys = env.system as any
    const d = await building()
    await env.as(admin).service('deployments').call('finishRun', d.id, { status: 'success' })
    expect((await sys.deployment.findUnique({ where: { id: d.id } })).status).toBe('success')
  })
})

describe('a release run a second time', () => {
  const pending = async () => (env.system as any).deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
  const statusOf = async (id: string) => (await (env.system as any).deployment.findUnique({ where: { id } })).status

  // FJS-3850: caravan replays a job whose worker stopped, and the replay
  // found the row `building` and ran the whole release again.
  test('a release already building at start is failed as interrupted, not run', async () => {
    const d = await pending()
    const first = await env.as(admin).service('deployments').call('startRun', d.id)
    expect(first.runnable).toBe(true)
    const again = await env.as(admin).service('deployments').call('startRun', d.id)
    expect(again).toMatchObject({ runnable: false, interrupted: true })
    expect(await statusOf(d.id)).toBe('failed')
  })

  test('a cancelled release does not start', async () => {
    const d = await pending()
    await (env.system as any).deployment.transition(d.id, 'cancel')
    const out = await env.as(admin).service('deployments').call('startRun', d.id)
    expect(out).toMatchObject({ runnable: false, status: 'cancelled' })
  })

  // FJS-4129: `/deploy` runs to its end with the hub gone, so the release the
  // replay fails may be the one serving, and the last `success` is older bytes.
  describe('a rebind after an interrupted release', () => {
    const older = `sha256:${'a'.repeat(64)}`
    const svc   = () => env.as(admin).service('deployments')

    // An App of its own, with one release live and a second that died holding
    // the steps named: `begun` had started when the hub went, `dying` was running.
    async function interrupted(begun: string[], dying: string) {
      const sys  = env.system as any
      const slug = `app-${uniq()}`
      const own  = await sys.app.create({ data: {
        workspaceId: ws.id, environmentId: target.environmentId, name: slug, slug, kind: 'container' } })

      const live = await sys.deployment.create({ data: { workspaceId: ws.id, appId: own.id, toImage: `x:${uniq()}`, builtImage: older } })
      await svc().call('startRun', live.id)
      await svc().call('finishRun', live.id, { status: 'success' })

      const newer = await sys.deployment.create({ data: { workspaceId: ws.id, appId: own.id, toImage: `x:${uniq()}`, builtImage: `sha256:${'b'.repeat(64)}` } })
      await svc().call('startRun', newer.id)
      const startedAt = new Date().toISOString()
      for (const [position, name] of [...begun, dying].entries())
        await sys.deploymentStep.create({ data: { deploymentId: newer.id, position, name, startedAt, status: name === dying ? 'running' : 'success' } })
      expect(await svc().call('startRun', newer.id)).toMatchObject({ runnable: false, interrupted: true })
      const stopped = await sys.deploymentStep.findFirst({ where: { deploymentId: newer.id, name: dying } })
      return { own, newer, stopped }
    }

    test('skips one that stopped during the swap, and the step says it may be serving', async () => {
      const { own, newer, stopped } = await interrupted([], 'Start container')
      const out = await svc().call('rebind', own.id)
      expect(out.skipped).toContain(newer.id)
      expect(out.builtImage).toBeUndefined()
      expect(stopped.output).toContain('may be what is serving')
    })

    test('skips one that stopped after the swap, at its health check', async () => {
      const { own, newer } = await interrupted(['Start container'], 'Health check')
      expect((await svc().call('rebind', own.id)).skipped).toContain(newer.id)
    })

    test('still starts the live bytes after one that stopped before the swap', async () => {
      const { own, stopped } = await interrupted([], 'Pull image')
      expect((await svc().call('rebind', own.id)).builtImage).toBe(older)
      expect(stopped.output).not.toContain('may be what is serving')
    })
  })

  // FJS-3861: a release no job is left running reads as in flight forever.
  test('the sweep fails an old release with no live job, and leaves a fresh one', async () => {
    const { sweepStuckReleases, RELEASE_BOUND_MS } = await import('../src/domain/release/release-record.ts')
    const sys = env.system as any
    const d = await pending()
    expect(await sweepStuckReleases(env.app)).not.toContain(d.id)
    expect(await statusOf(d.id)).toBe('pending')
    expect(await sweepStuckReleases(env.app, Date.now() + RELEASE_BOUND_MS + 60_000)).toContain(d.id)
    expect(await statusOf(d.id)).toBe('failed')
    void sys
  })
})
