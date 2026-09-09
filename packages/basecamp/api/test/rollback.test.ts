/*
 * rollback.test.ts — putting back what a release replaced.
 *
 * `rollback: success -> rolled_back @gate(5)` was declared on `Deployment`,
 * `previousDeploymentId` was chained on every create under a comment saying a
 * rollback would want it, `configSnapshot` recorded what the app looked like at
 * release time — and four screens carried a tone for a state no write in the
 * app could produce. Everything but the act (`FJS-517`).
 *
 * Two claims carry this file and neither is about the happy path.
 *
 * **The config comes from the TARGET.** That is the whole of what separates a
 * rollback from a redeploy, and both write a Deployment that looks right: a
 * rollback taking `App.config` puts the old image back with the new settings,
 * which is neither release, and nothing on any screen would say so.
 *
 * **Nothing is written before the move.** Every refusal here is asserted with
 * the release's status read back afterwards, because a rollback that retired a
 * release and THEN discovered it had nowhere to go is the worst outcome the
 * method has available.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { join }              from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'

// `resolveExecutor` refuses an app it cannot reach, and this suite has no
// machine. The stub is the shape a laptop with no fleet already runs in.
process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, developer: any, box: any, environment: any
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
  const mk   = async () => sys.user.create({
    data: { email: `u-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })

  const a = await mk(), d = await mk()
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}`, ownerId: a.id } })
  for (const [u, role] of [[a, 'admin'], [d, 'developer']] as const)
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: u.id, role,
      capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })

  // ADMIN is 5 and DEVELOPER is 4, which is the pair the gate sits between:
  // `@gate(5)` on the move against `Deployment`'s own update gate of USER(4).
  admin     = session({ userId: a.id, workspaceId: ws.id })
  developer = session({ userId: d.id, workspaceId: ws.id })

  // A machine that can take a release, or `resolveExecutor` refuses before any
  // of this is reached.
  box = await sys.server.create({ data: {
    workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}`, status: 'online' } })

  // `App.environmentId` is required, and an Environment hangs off a Project.
  const project = await sys.project.create({ data: {
    workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
})

/** An app with two shipped releases behind it, placed on a machine that can
 *  take another. `config` is what the app looks like NOW — deliberately not
 *  what either release shipped with. */
async function anAppWithHistory(config: Record<string, unknown> = { replicas: 3 }) {
  const sys  = env.system as any
  const slug = `app-${uniq()}`
  const target = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug,
    type: 'container', config } })
  await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })

  const shipped = async (data: Record<string, unknown>) => sys.deployment.create({ data: {
    appId: target.id, workspaceId: ws.id, status: 'success',
    finishedAt: new Date().toISOString(), ...data } })

  const first = await shipped({
    toImage: `${slug}:v1`, builtImage: 'sha256:' + 'a'.repeat(64),
    configSnapshot: { source: {}, config: { replicas: 1 } },
    commitSha: 'aaaaaaa', branch: 'main',
  })
  const current = await shipped({
    toImage: `${slug}:v2`, builtImage: 'sha256:' + 'b'.repeat(64),
    configSnapshot: { source: {}, config: { replicas: 2 } },
    commitSha: 'bbbbbbb', branch: 'main',
    previousDeploymentId: first.id,
  })
  return { app: target, first, current }
}

const statusOf = async (id: string) =>
  (await (env.system as any).deployment.findUnique({ where: { id } })).status

const roll = (who: any, id: string) =>
  env.as(who).service('deployments').call('rollback', id, {})

describe('a release is put back', () => {

  test('the release is retired and its predecessor\'s bytes are released again', async () => {
    const { first, current } = await anAppWithHistory()
    const replacement: any = await roll(admin, current.id)

    expect(await statusOf(current.id)).toBe('rolled_back')
    // A NEW release of the OLD bytes, never a rerun of the old row: a
    // Deployment records what shipped and when, and re-running one would
    // rewrite the fact that somebody rolled back.
    expect(replacement.id).not.toBe(first.id)
    expect(await statusOf(first.id)).toBe('success')
    expect(replacement.toImage).toBe(first.toImage)
    expect(replacement.trigger).toBe('rollback')
    // What was running, and what is going back on.
    expect(replacement.fromImage).toBe(current.toImage)
    // The release this one replaces, which is `create`'s own meaning for the column.
    expect(replacement.previousDeploymentId).toBe(current.id)
  })

  test('the config comes from the TARGET and never from the app', async () => {
    // The claim this file exists for. A rollback taking `App.config` puts the
    // old image back with settings neither release ever ran, and the row it
    // writes looks correct from every screen.
    const { first, current, app } = await anAppWithHistory({ replicas: 9 })
    const replacement: any = await roll(admin, current.id)

    expect(replacement.configSnapshot).toEqual(first.configSnapshot)
    expect((replacement.configSnapshot as any).config.replicas).toBe(1)
    // Paired with the app's own value, or *equals the target* and *equals
    // whatever was lying around* are the same assertion.
    expect((app.config as any).replicas).toBe(9)
    expect((replacement.configSnapshot as any).config.replicas).not.toBe(9)
  })

  test('it carries the commit it is putting back, not the one it is undoing', async () => {
    const { first, current } = await anAppWithHistory()
    const replacement: any = await roll(admin, current.id)
    expect(replacement.commitSha).toBe(first.commitSha)
    expect(replacement.commitSha).not.toBe(current.commitSha)
  })

  test('the replacement is a real release — steps, and queued work', async () => {
    // A row with no steps is a release the job cannot run and the screen draws
    // as an empty timeline.
    const { current } = await anAppWithHistory()
    const replacement: any = await roll(admin, current.id)
    const steps = await (env.system as any).deploymentStep.findMany({
      where: { deploymentId: replacement.id } })
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((s: any) => s.status === 'pending')).toBe(true)
  })
})

describe('what a rollback refuses, before it writes anything', () => {

  test('a developer may not, and an admin may — the same call, one level apart', async () => {
    // `@gate(5)` on the move against `Deployment`'s own update gate of USER(4):
    // undoing a release somebody else shipped is not the authority to ship one.
    // Paired, or a method refusing everybody satisfies the refusal alone.
    const mine = await anAppWithHistory()
    await expect(roll(developer, mine.current.id)).rejects.toThrow(/standing/i)
    expect(await statusOf(mine.current.id)).toBe('success')

    const theirs = await anAppWithHistory()
    await expect(roll(admin, theirs.current.id)).resolves.toBeTruthy()
    expect(await statusOf(theirs.current.id)).toBe('rolled_back')
  })

  test('a first release has nothing to go back to, and is LEFT ALONE', async () => {
    // The row this method's ordering exists for. Retiring a release and then
    // discovering it has nowhere to go is the worst outcome available here, and
    // it is what a naive *move first, look second* does on every app's first
    // deploy.
    const sys  = env.system as any
    const slug = `solo-${uniq()}`
    const target = await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: environment.id, name: slug, slug,
      type: 'container', config: {} } })
    await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })
    const only = await sys.deployment.create({ data: {
      appId: target.id, workspaceId: ws.id, status: 'success',
      toImage: `${slug}:v1`, finishedAt: new Date().toISOString() } })

    await expect(roll(admin, only.id)).rejects.toThrow(/first release/i)
    expect(await statusOf(only.id)).toBe('success')
  })

  test('a release that did not ship cannot be rolled back', async () => {
    // `success` is the whole from-list. A failed release put nothing on the
    // machine, so there is nothing of it to undo.
    const { current, app } = await anAppWithHistory()
    const sys = env.system as any
    const failed = await sys.deployment.create({ data: {
      appId: app.id, workspaceId: ws.id, status: 'failed',
      previousDeploymentId: current.id, toImage: 'x:v3' } })

    await expect(roll(admin, failed.id)).rejects.toThrow(/cannot be rolled back/i)
    expect(await statusOf(failed.id)).toBe('failed')
  })

  test('a predecessor that recorded no image is a refusal, not an empty release', async () => {
    const sys  = env.system as any
    const slug = `noimg-${uniq()}`
    const target = await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: environment.id, name: slug, slug,
      type: 'container', config: {} } })
    await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })
    const blank = await sys.deployment.create({ data: {
      appId: target.id, workspaceId: ws.id, status: 'success' } })
    const current = await sys.deployment.create({ data: {
      appId: target.id, workspaceId: ws.id, status: 'success',
      toImage: `${slug}:v2`, previousDeploymentId: blank.id } })

    await expect(roll(admin, current.id)).rejects.toThrow(/no image/i)
    expect(await statusOf(current.id)).toBe('success')
  })

  test('a release in another workspace is not found, and nothing moves', async () => {
    const sys   = env.system as any
    const other = await sys.workspace.create({ data: {
      accountId: (await sys.account.findFirst({})).id,
      name: 'Other', slug: `o-${uniq()}`, ownerId: (await sys.user.findFirst({})).id } })
    const slug   = `their-${uniq()}`
    const otherProject = await sys.project.create({ data: {
      workspaceId: other.id, name: 'Theirs', slug: `p-${uniq()}` } })
    const otherEnv = await sys.environment.create({ data: {
      workspaceId: other.id, projectId: otherProject.id, name: 'Production', slug: `e-${uniq()}` } })
    const target = await sys.app.create({ data: {
      workspaceId: other.id, environmentId: otherEnv.id, name: slug, slug,
      type: 'container', config: {} } })
    const theirs = await sys.deployment.create({ data: {
      appId: target.id, workspaceId: other.id, status: 'success', toImage: 'x:v1' } })

    await expect(roll(admin, theirs.id)).rejects.toThrow(/not found/i)
    expect(await statusOf(theirs.id)).toBe('success')
  })
})
