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
    data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}`, ownerId: a.id } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: a.id, role: 'admin',
    capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  admin = session({ userId: a.id, workspaceId: ws.id })

  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  const environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
  const slug = `app-${uniq()}`
  target = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug, type: 'container', config: {} } })
})

describe('a job run that finishes after the job was cancelled', () => {
  async function running() {
    const sys = env.system as any
    const job = await sys.job.create({ data: { workspaceId: ws.id, name: `j-${uniq()}`, kind: 'one_shot', command: 'true' } })
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

  test('an uncancelled release succeeds', async () => {
    const sys = env.system as any
    const d = await building()
    await env.as(admin).service('deployments').call('finishRun', d.id, { status: 'success' })
    expect((await sys.deployment.findUnique({ where: { id: d.id } })).status).toBe('success')
  })
})
