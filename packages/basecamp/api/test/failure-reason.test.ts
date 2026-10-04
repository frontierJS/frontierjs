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
})
