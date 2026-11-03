/*
 * rollback.test.ts — putting back what a release replaced.
 *
 * `rollback: success -> rolledBack @gate(5)` was declared on `Deployment`,
 * `previousDeploymentId` was chained on every create under a comment saying a
 * rollback would want it, `configSnapshot` recorded what the app looked like at
 * release time — and four screens carried a tone for a state no write in the
 * app could produce. Everything but the act (`FJS-517`).
 *
 * Two claims carry this file and neither is about the happy path.
 *
 * **The settings come from the TARGET.** That is the whole of what separates a
 * rollback from a redeploy, and both write a Deployment that looks right: a
 * rollback taking the app's columns puts the old image back with the new settings,
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
import deploymentRun         from '../src/jobs/deployment-run.job.ts'

// `resolveExecutor` refuses an app it cannot reach, and this suite has no
// machine. The stub is the shape a laptop with no fleet already runs in.
process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, developer: any, box: any, environment: any
const uniq = () => Math.random().toString(36).slice(2, 8)

/** A release already at `status` — a Deployment is born `pending`, even for the system. */
async function releaseAt(status: 'success' | 'failed', data: Record<string, unknown>) {
  const sys = env.system as any
  const row = await sys.deployment.create({ data })
  const moves = status === 'success' ? ['build', 'succeed'] : ['fail']
  for (const move of moves) await sys.deployment.transition(row.id, move)
  return sys.deployment.findUnique({ where: { id: row.id } })
}

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
    data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  for (const [u, role] of [[a, 'admin'], [d, 'developer']] as const)
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: u.id, role,
      capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })

  // ADMIN is 5 and DEVELOPER is 4, which is the pair the gate sits between:
  // `@gate(5)` on the move against `Deployment`'s own update gate of USER(4).
  admin     = session({ id: a.id, workspaceId: ws.id })
  developer = session({ id: d.id, workspaceId: ws.id })

  // A machine that can take a release, or `resolveExecutor` refuses before any
  // of this is reached.
  box = await sys.server.create({ data: {
    workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
  box = await sys.server.transition(box.id, 'checkIn')

  // `App.environmentId` is required, and an Environment hangs off a Project.
  const project = await sys.project.create({ data: {
    workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
})

/** An app with two shipped releases behind it, placed on a machine that can
 *  take another. `runtime` is what the app looks like NOW — deliberately not
 *  what either release shipped with. */
async function anAppWithHistory(runtime: Record<string, unknown> = { cpuLimit: 3 }, shipped1: Record<string, unknown> = { cpuLimit: 1 }) {
  const sys  = env.system as any
  const slug = `app-${uniq()}`
  const target = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug,
    kind: 'container', ...runtime } })
  await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })

  const shipped = async (data: Record<string, unknown>) => releaseAt('success', {
    appId: target.id, workspaceId: ws.id,
    finishedAt: new Date().toISOString(), ...data })

  const first = await shipped({
    toImage: `${slug}:v1`, builtImage: 'sha256:' + 'a'.repeat(64),
    configSnapshot: { source: {}, runtime: shipped1 },
    commitSha: 'aaaaaaa', branch: 'main',
  })
  const current = await shipped({
    toImage: `${slug}:v2`, builtImage: 'sha256:' + 'b'.repeat(64),
    configSnapshot: { source: {}, runtime: { cpuLimit: 2 } },
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

    expect(await statusOf(current.id)).toBe('rolledBack')
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

  test('the settings come from the TARGET and never from the app', async () => {
    // The claim this file exists for. A rollback taking the app's columns puts the
    // old image back with settings neither release ever ran, and the row it
    // writes looks correct from every screen.
    const { first, current, app } = await anAppWithHistory({ cpuLimit: 9 })
    const replacement: any = await roll(admin, current.id)

    expect(replacement.configSnapshot).toEqual(first.configSnapshot)
    expect((replacement.configSnapshot as any).runtime.cpuLimit).toBe(1)
    // Paired with the app's own value, or *equals the target* and *equals
    // whatever was lying around* are the same assertion.
    expect(app.cpuLimit).toBe(9)
    expect((replacement.configSnapshot as any).runtime.cpuLimit).not.toBe(9)
  })

  test('a release records its variables when it is made, plain values by copy and secrets by id', async () => {
    const { app: target } = await anAppWithHistory()
    const vars = env.as(admin).service('variables')
    const level = await vars.create({ appId: target.id, key: 'LOG_LEVEL', value: 'debug' }) as any
    await vars.create({ appId: target.id, key: 'API_TOKEN', value: 'tok-sealed', isSecret: true })

    const made: any = await env.as(developer).service('deployments').create({ appId: target.id, toImage: `${target.slug}:v3` })
    const snap = (await (env.system as any).deployment.findUnique({ where: { id: made.id } })).configSnapshot
    expect(snap.env).toEqual({ LOG_LEVEL: 'debug' })
    expect(Object.keys(snap.secretEnv)).toEqual(['API_TOKEN'])
    expect(JSON.stringify(snap)).not.toContain('tok-sealed')

    // A plain value is copied, so a rollback to this release puts back
    // `debug` whatever the variable says by then.
    await vars.patch(level.id, { value: 'warn', version: level.version })
    const again = (await (env.system as any).deployment.findUnique({ where: { id: made.id } })).configSnapshot
    expect(again.env).toEqual({ LOG_LEVEL: 'debug' })
  })

  test('a release records how its container starts, and a later edit leaves it alone', async () => {
    const { app: target } = await anAppWithHistory({ port: 8080, containerPort: 80, healthCheck: '/up', memLimitMb: 128 })
    const made: any = await env.as(developer).service('deployments').create({ appId: target.id, toImage: `${target.slug}:v3` })
    const snap = async () => (await (env.system as any).deployment.findUnique({ where: { id: made.id } })).configSnapshot
    const shipped = { port: 8080, containerPort: 80, healthCheck: '/up', memLimitMb: 128 }
    expect((await snap()).runtime).toEqual(shipped)

    await env.as(admin).service('apps').patch(target.id, { memLimitMb: 512 })
    expect((await snap()).runtime).toEqual(shipped)
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
    expect(await statusOf(theirs.current.id)).toBe('rolledBack')
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
      kind: 'container' } })
    await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })
    const only = await releaseAt('success', {
      appId: target.id, workspaceId: ws.id,
      toImage: `${slug}:v1`, finishedAt: new Date().toISOString() })

    await expect(roll(admin, only.id)).rejects.toThrow(/first release/i)
    expect(await statusOf(only.id)).toBe('success')
  })

  test('a release that did not ship cannot be rolled back', async () => {
    // `success` is the whole from-list. A failed release put nothing on the
    // machine, so there is nothing of it to undo.
    const { current, app } = await anAppWithHistory()
    const _sys = env.system as any
    const failed = await releaseAt('failed', {
      appId: app.id, workspaceId: ws.id,
      previousDeploymentId: current.id, toImage: 'x:v3' })

    await expect(roll(admin, failed.id)).rejects.toThrow(/cannot be rolled back/i)
    expect(await statusOf(failed.id)).toBe('failed')
  })

  test('a predecessor that recorded no image is a refusal, not an empty release', async () => {
    const sys  = env.system as any
    const slug = `noimg-${uniq()}`
    const target = await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: environment.id, name: slug, slug,
      kind: 'container' } })
    await sys.appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })
    const blank = await releaseAt('success', {
      appId: target.id, workspaceId: ws.id })
    const current = await releaseAt('success', {
      appId: target.id, workspaceId: ws.id,
      toImage: `${slug}:v2`, previousDeploymentId: blank.id })

    await expect(roll(admin, current.id)).rejects.toThrow(/no image/i)
    expect(await statusOf(current.id)).toBe('success')
  })

  test('a release in another workspace is not found, and nothing moves', async () => {
    const sys   = env.system as any
    const other = await sys.workspace.create({ data: {
      accountId: (await sys.account.findFirst({})).id,
      name: 'Other', slug: `o-${uniq()}` } })
    const slug   = `their-${uniq()}`
    const otherProject = await sys.project.create({ data: {
      workspaceId: other.id, name: 'Theirs', slug: `p-${uniq()}` } })
    const otherEnv = await sys.environment.create({ data: {
      workspaceId: other.id, projectId: otherProject.id, name: 'Production', slug: `e-${uniq()}` } })
    const target = await sys.app.create({ data: {
      workspaceId: other.id, environmentId: otherEnv.id, name: slug, slug,
      kind: 'container' } })
    const theirs = await releaseAt('success', {
      appId: target.id, workspaceId: other.id, toImage: 'x:v1' })

    await expect(roll(admin, theirs.id)).rejects.toThrow(/not found/i)
    expect(await statusOf(theirs.id)).toBe('success')
  })
})

describe('what a rollback may put back', () => {

  // FJS-3862: `previousDeploymentId` is a column a caller can write.
  test('a predecessor of another app is refused, and nothing is retired', async () => {
    const sys = env.system as any
    const mine = await anAppWithHistory(), theirs = await anAppWithHistory()
    const forged = await releaseAt('success', {
      appId: mine.app.id, workspaceId: ws.id, toImage: 'x:forged',
      finishedAt: new Date(Date.now() + 60_000).toISOString(), previousDeploymentId: theirs.first.id })
    await expect(roll(admin, forged.id)).rejects.toThrow(/another app/)
    expect(await statusOf(forged.id)).toBe('success')
    void sys
  })

  test('only the release currently serving can be rolled back', async () => {
    const { first, current } = await anAppWithHistory()
    // `first` is a success too, and an older one.
    await (env.system as any).deployment.update({ where: { id: first.id }, data: { finishedAt: new Date(Date.now() - 60_000).toISOString() } })
    await expect(roll(admin, first.id)).rejects.toThrow(/later release/)
    expect(await statusOf(first.id)).toBe('success')
    expect(await statusOf(current.id)).toBe('success')
  })

  // FJS-3849: two releases of one App race each other on the machine.
  test('a release already in flight refuses another, 409', async () => {
    const { app, current } = await anAppWithHistory()
    const queued: any = await roll(admin, current.id)
    expect(queued.status).toBe('pending')
    await expect(env.as(admin).service('deployments').create({ appId: app.id, workspaceId: ws.id, toImage: 'x:1' }))
      .rejects.toMatchObject({ code: 409 })
  })
})

// FJS-D1796: a rollback keeps the volume unless it is asked to put the copy
// back, and an ask it cannot meet is refused before anything moves.
describe('a rollback and the volume', () => {

  const rollRestoring = (who: any, id: string) =>
    env.as(who).service('deployments').call('rollback', id, { isRestoringVolume: true })

  const stepNames = async (id: string) =>
    (await (env.system as any).deploymentStep.findMany({ where: { deploymentId: id }, orderBy: { position: 'asc' } }))
      .map((s: any) => s.name)

  /** The target release is the one that recorded a volume, so the steps know to copy. */
  async function withVolume() {
    return anAppWithHistory(undefined, { volumePath: '/db' })
  }

  test('by default the volume is kept and a fresh copy is taken first', async () => {
    const { current } = await withVolume()
    const replacement: any = await roll(admin, current.id)
    const names = await stepNames(replacement.id)
    expect(names).toContain('Back up volume')
    expect(names).not.toContain('Restore volume')
  })

  test('asking to restore with no copy taken is refused, and the release is left alone', async () => {
    const { current } = await withVolume()
    await expect(rollRestoring(admin, current.id)).rejects.toThrow(/No copy was taken/)
    expect(await statusOf(current.id)).toBe('success')
  })

  test('a copy that never left its machine cannot be restored from, and is named so', async () => {
    const { app, current } = await withVolume()
    await (env.system as any).appBackup.create({ data: {
      appId: app.id, serverId: box.id, kind: 'release', deploymentId: current.id,
      status: 'success', location: '/var/lib/outpost/backups/x.tar.gz', sha256: 'c'.repeat(64) } })
    await expect(rollRestoring(admin, current.id)).rejects.toThrow(/never left its machine/)
    expect(await statusOf(current.id)).toBe('success')
  })

  test('with a copy in a bucket, the steps stop the app and restore instead of copying', async () => {
    const { app, current } = await withVolume()
    const sys  = env.system as any
    const dest = await env.as(admin).service('backupDestinations').create({
      name: `Rollback ${uniq()}`, endpoint: 'http://127.0.0.1:9', region: 'auto',
      bucket: `rb-${uniq()}`, prefix: 'apps', secret: 'AKID:secret',
    }) as any
    const copy = await sys.appBackup.create({ data: {
      appId: app.id, serverId: box.id, destinationId: dest.id, kind: 'release', deploymentId: current.id,
      status: 'success', location: `apps/${app.id}-x.tar.gz`, sha256: 'd'.repeat(64), sizeBytes: 10 } })

    const plan: any = await env.as(admin).service('deployments').call('rollbackCopy', current.id, {})
    expect(plan.available).toBe(true)
    expect(plan.copy.id).toBe(copy.id)
    expect(plan.discards).toContain('replaced by the copy')

    const replacement: any = await rollRestoring(admin, current.id)
    const names = await stepNames(replacement.id)
    expect(names).toEqual(['Validate', 'Pull image', 'Stop container', 'Restore volume', 'Start container', 'Health check'])
    expect(await statusOf(current.id)).toBe('rolledBack')
  })

  // ─── a restore that fails with the app already stopped ─────────────────────
  // The Outpost is a recording conduit answering per path, so the job's own
  // executor code runs against the reply a real machine sends.
  describe('a restore that fails', () => {
    const STEPS = ['Validate', 'Pull image', 'Stop container', 'Restore volume', 'Start container', 'Health check']

    async function run(restoreReply: { message: string; body: Record<string, unknown> }) {
      const { app, first, current } = await withVolume()
      const sys  = env.system as any
      const dest = await env.as(admin).service('backupDestinations').create({
        name: `Rollback ${uniq()}`, endpoint: 'http://127.0.0.1:9', region: 'auto',
        bucket: `rb-${uniq()}`, prefix: 'apps', secret: 'AKID:secret',
      }) as any
      await sys.appBackup.create({ data: {
        appId: app.id, serverId: box.id, destinationId: dest.id, kind: 'release', deploymentId: current.id,
        status: 'success', location: `apps/${app.id}-x.tar.gz`, sha256: 'd'.repeat(64), sizeBytes: 10 } })

      const replacement = await sys.deployment.create({ data: {
        appId: app.id, workspaceId: ws.id, toImage: first.toImage, trigger: 'rollback',
        previousDeploymentId: current.id, configSnapshot: first.configSnapshot } })
      for (const [position, name] of STEPS.entries())
        await sys.deploymentStep.create({ data: { deploymentId: replacement.id, position, name } })

      const sent: { path: string; body: any }[] = []
      const conduit = {
        resolve: async () => ({ pinned_cert: true }),
        send: async (call: any) => {
          sent.push({ path: call.path, body: call.body })
          if (call.path === '/volume/restore')
            return { error: { kind: 'server', message: 'Server error: 500',
              raw: JSON.stringify({ error: restoreReply.message, ...restoreReply.body }) } }
          return { data: {} }
        },
      }
      const via = new Proxy(env.app, { get: (t, k) =>
        k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })

      await env.app.runAs(admin.id, { tenant: ws.id }, () =>
        (deploymentRun as any).handler({ app: via, data: { deployment_id: replacement.id } }))

      const status = (await sys.deployment.findUnique({ where: { id: replacement.id } })).status
      const failed = await sys.deploymentStep.findFirst({ where: { deploymentId: replacement.id, status: 'failed' } })
      return { sent, row: { status, error: failed?.output as string, step: failed?.name as string }, first, current }
    }

    test('before the volume was touched, the release that was live is started again and the message says so', async () => {
      const { sent, row, current } = await run({ message: 'the bucket refused the archive' , body: {} })
      expect(row.status).toBe('failed')
      expect(row.step).toBe('Restore volume')
      expect(row.error).toContain('The volume is unchanged')
      expect(row.error).toContain('the previous release is running again')

      const paths = sent.map(s => s.path)
      expect(paths.slice(paths.indexOf('/stop'))).toEqual(['/stop', '/volume/restore', '/deploy'])
      // What went back is the release the rollback was undoing, not the one it targeted.
      const started = sent.find(s => s.path === '/deploy')!.body
      expect(started.image).toBe(current.toImage)
      expect(started.digest).toBe(current.builtImage)
      expect(started.deployment_id).toBe(current.id)
      expect(paths).not.toContain('/health-check')
    })

    test('after the extract began, nothing is started and the message names the copy to restore by hand', async () => {
      const { sent, row } = await run({ message: 'restore into /data failed (exit 2): tar: unexpected EOF',
                                        body: { volume_touched: true } })
      expect(row.status).toBe('failed')
      expect(row.error).toContain('unknown state')
      expect(row.error).toMatch(/put back the copy by hand: apps\//)
      expect(row.error).not.toContain('running again')
      expect(sent.map(s => s.path)).not.toContain('/deploy')
    })
  })
})
