/*
 * failure-reason.test.ts — a failed release says why, on the step it stopped at.
 *
 * The reason used to reach two places and stop: Outpost's sentence was kept by
 * conduit as a raw body behind *Server error: 500*, and `finishRun` took an
 * `error` it wrote nowhere. The release screen showed *Start container failed*
 * and nothing else; the reason was in the machine's log.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { join }              from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'
import { machineSaid }       from '../src/providers/executor.ts'

process.env.BASECAMP_STUB_OUTPOST = '1'

describe("the machine's sentence", () => {
  test('is lifted out of the body Outpost refused with', () => {
    expect(machineSaid(JSON.stringify({ error: 'hosts need a published port to route to — config.port is not set' })))
      .toBe('hosts need a published port to route to — config.port is not set')
  })

  test('is nothing when the body does not carry one', () => {
    expect(machineSaid('<html>bad gateway</html>')).toBeNull()
    expect(machineSaid(JSON.stringify({ error: { code: 1 } }))).toBeNull()
    expect(machineSaid('')).toBeNull()
    expect(machineSaid(undefined)).toBeNull()
  })
})

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
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug, type: 'container' } })
})

describe('a release that fails mid-run', () => {
  test('carries the reason on the step it stopped at, and only there', async () => {
    const sys = env.system as any
    const row = await sys.deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
    await sys.deployment.transition(row.id, 'build')
    const [pull, start, health] = await Promise.all(['Pull image', 'Start container', 'Health check'].map(name =>
      sys.deploymentStep.create({ data: { deploymentId: row.id, name } })))
    await sys.deploymentStep.update({ where: { id: pull.id }, data: { status: 'success', output: 'pulled' } })
    await sys.deploymentStep.update({ where: { id: start.id }, data: { status: 'running' } })

    await env.as(admin).service('deployments').call('finishRun', row.id, {
      status: 'failed', stepId: start.id, error: 'Deploy failed: config.port is not set' })

    const after = Object.fromEntries((await sys.deploymentStep.findMany({ where: { deploymentId: row.id } }))
      .map((s: any) => [s.id, s]))
    expect(after[start.id].status).toBe('failed')
    expect(after[start.id].output).toBe('Deploy failed: config.port is not set')
    expect(after[pull.id].output).toBe('pulled')
    expect(after[health.id].output).toBeNull()
  })

  test('a step it never reached is skipped, not failed', async () => {
    const sys = env.system as any
    const row = await sys.deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
    await sys.deployment.transition(row.id, 'build')
    const [pull, start, health] = await Promise.all(['Pull image', 'Start container', 'Health check'].map(name =>
      sys.deploymentStep.create({ data: { deploymentId: row.id, name } })))
    await sys.deploymentStep.update({ where: { id: pull.id }, data: { status: 'failed' } })
    await sys.deploymentStep.update({ where: { id: start.id }, data: { status: 'running' } })

    await env.as(admin).service('deployments').call('finishRun', row.id, {
      status: 'failed', stepId: pull.id, error: 'Pull failed: manifest unknown' })

    const after = Object.fromEntries((await sys.deploymentStep.findMany({ where: { deploymentId: row.id } }))
      .map((s: any) => [s.id, s.status]))
    // A step left running when the release died did fail; the one after it
    // was never asked of the machine.
    expect(after).toEqual({ [pull.id]: 'failed', [start.id]: 'failed', [health.id]: 'skipped' })
  })

  test('the steps read back in run order, the failed one above the ones it stopped', async () => {
    // Written last-first, so insertion order and run order disagree — and the
    // two never-started steps carry no `startedAt`, which sorted them to the
    // top while that was the order.
    const sys = env.system as any
    const row = await sys.deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
    await sys.deployment.transition(row.id, 'build')
    const names = ['Validate', 'Pull image', 'Start container', 'Health check']
    const ids: Record<string, string> = {}
    for (const position of [3, 2, 1, 0])
      ids[names[position]] = (await sys.deploymentStep.create({
        data: { deploymentId: row.id, position, name: names[position] } })).id
    await sys.deploymentStep.update({ where: { id: ids['Validate'] },
      data: { status: 'success', startedAt: new Date().toISOString() } })
    await sys.deploymentStep.update({ where: { id: ids['Pull image'] },
      data: { status: 'running', startedAt: new Date().toISOString() } })

    await env.as(admin).service('deployments').call('finishRun', row.id, {
      status: 'failed', stepId: ids['Pull image'], error: 'Pull failed: manifest unknown' })

    const got: any = await env.as(admin).service('deployments').get(row.id)
    expect(got.steps.map((s: any) => [s.name, s.status])).toEqual([
      ['Validate', 'success'], ['Pull image', 'failed'],
      ['Start container', 'skipped'], ['Health check', 'skipped'],
    ])
  })
})

describe("the App's status after a failed release", () => {
  // Whether the machine replaced what was serving is the step the release
  // stopped at: Outpost refuses /deploy before it removes the old container
  // (`FJS-1682`), so only a failure after the swap leaves the App broken.
  async function releaseStoppingAt(stop: 'Pull image' | 'Start container' | 'Health check' | null) {
    const sys = env.system as any
    await sys.app.update({ where: { id: target.id }, data: { status: 'running' } })
    const row = await sys.deployment.create({ data: { workspaceId: ws.id, appId: target.id, toImage: `x:${uniq()}` } })
    await sys.deployment.transition(row.id, 'build')
    const names = ['Pull image', 'Start container', 'Health check']
    const steps = await Promise.all(names.map((name, position) =>
      sys.deploymentStep.create({ data: { deploymentId: row.id, position, name } })))
    const at = stop ? names.indexOf(stop) : -1
    for (const [i, s] of steps.entries())
      if (i < at) await sys.deploymentStep.update({ where: { id: s.id }, data: { status: 'success' } })
    if (at >= 0) await sys.deploymentStep.update({ where: { id: steps[at].id }, data: { status: 'running' } })

    await env.as(admin).service('deployments').call('finishRun', row.id, {
      status: 'failed', stepId: steps[Math.max(at, 0)].id, error: 'refused' })
    return (await sys.app.findUnique({ where: { id: target.id } })).status
  }

  test('a release refused at the swap leaves the App running', async () => {
    expect(await releaseStoppingAt('Start container')).toBe('running')
  })

  test('so does one stopped before it, or refused before any step ran', async () => {
    expect(await releaseStoppingAt('Pull image')).toBe('running')
    expect(await releaseStoppingAt(null)).toBe('running')
  })

  test('a release that fails after the swap is the App in error', async () => {
    expect(await releaseStoppingAt('Health check')).toBe('error')
  })
})
