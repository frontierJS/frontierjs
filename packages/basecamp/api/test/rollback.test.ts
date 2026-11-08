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
    const { app: target } = await anAppWithHistory({ port: 8080, containerPort: 80, healthCheck: '/up', memLimitMb: 128, stopGraceSeconds: 25 })
    const made: any = await env.as(developer).service('deployments').create({ appId: target.id, toImage: `${target.slug}:v3` })
    const snap = async () => (await (env.system as any).deployment.findUnique({ where: { id: made.id } })).configSnapshot
    const shipped = { port: 8080, containerPort: 80, healthCheck: '/up', memLimitMb: 128, stopGrace: 25 }
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
      expect(started.config.env.FJS_BUILD).toBe(current.commitSha)
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

describe('how the machine swapped, on the row', () => {

  /** A rollback whose one step starts the container, against a machine that answers `/deploy` with `deployed`.
   *  `live` is what the App says now; `shipped` is the runtime the release's snapshot holds. */
  async function startAgainst(deployed: Record<string, unknown>, live: Record<string, unknown> = {}, shipped: Record<string, unknown> = {}, hostname?: string, release: Record<string, unknown> = {}) {
    const { app, first, current } = await anAppWithHistory()
    const sys = env.system as any
    if (Object.keys(live).length) await sys.app.update({ where: { id: app.id }, data: live })
    if (hostname) await sys.domain.create({ data: { workspaceId: ws.id, appId: app.id, hostname } })
    const replacement = await sys.deployment.create({ data: {
      appId: app.id, workspaceId: ws.id, toImage: first.toImage, trigger: 'rollback',
      previousDeploymentId: current.id,
      configSnapshot: { ...(first.configSnapshot as any), runtime: { ...(first.configSnapshot as any).runtime, ...shipped } },
      ...release } })
    await sys.deploymentStep.create({ data: { deploymentId: replacement.id, position: 0, name: 'Start container' } })

    const sent: any[] = []
    const conduit = {
      resolve: async () => ({ pinned_cert: true }),
      send: async (call: any) => { sent.push(call); return { data: call.path === '/deploy' ? deployed : {} } },
    }
    const via = new Proxy(env.app, { get: (t, k) =>
      k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })
    await env.app.runAs(admin.id, { tenant: ws.id }, () =>
      (deploymentRun as any).handler({ app: via, data: { deployment_id: replacement.id } }))
    const row = await sys.deployment.findUnique({ where: { id: replacement.id } })
    const body = sent.find(c => c.path === '/deploy')?.body
    return Object.assign(row, { asked: body?.swap, env: body?.config?.env })
  }

  describe('the build the container states (FJS-D1969)', () => {
    const sha = 'c'.repeat(40)

    test('the container is started with the release\'s commit as FJS_BUILD', async () => {
      expect((await startAgainst({}, {}, {}, undefined, { commitSha: sha })).env.FJS_BUILD).toBe(sha)
    })

    test('a stored FJS_BUILD Variable does not name another commit', async () => {
      const row = await startAgainst({}, {}, {}, undefined, {
        commitSha: sha, configSnapshot: { env: { FJS_BUILD: 'stale', KEPT: '1' }, runtime: {} } })
      expect(row.env).toMatchObject({ FJS_BUILD: sha, KEPT: '1' })
    })

    test('a git release states the commit /build answered, not the one the row was opened with', async () => {
      const { app } = await anAppWithHistory()
      const sys = env.system as any
      const built = 'd'.repeat(40)
      const release = await sys.deployment.create({ data: {
        appId: app.id, workspaceId: ws.id, toImage: `${app.slug}:git`, trigger: 'push', commitSha: 'e'.repeat(40),
        configSnapshot: { source: { kind: 'git', repo: 'https://example.test/app.git', branch: 'main' }, runtime: {} } } })
      for (const [position, name] of ['Build image', 'Start container'].entries())
        await sys.deploymentStep.create({ data: { deploymentId: release.id, position, name } })
      const sent: any[] = []
      const conduit = {
        resolve: async () => ({ pinned_cert: true }),
        send: async (call: any) => {
          sent.push(call)
          return { data: call.path === '/build' ? { digest: 'sha256:' + 'f'.repeat(64), commit_sha: built } : {} }
        },
      }
      const via = new Proxy(env.app, { get: (t, k) =>
        k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })
      await env.app.runAs(admin.id, { tenant: ws.id }, () =>
        (deploymentRun as any).handler({ app: via, data: { deployment_id: release.id } }))
      expect(sent.find(c => c.path === '/deploy')?.body?.config?.env?.FJS_BUILD).toBe(built)
    })

    test('a release that names no commit states no build', async () => {
      expect((await startAgainst({})).env).not.toHaveProperty('FJS_BUILD')
    })
  })

  // IDEAS/read-only-copy.md 1.4 (FJS-D1914): the image follows the release into
  // the replica bucket, and only for an App that has one.
  describe('the release\'s image export', () => {
    const deployAndWatch = async (replicates: boolean) => {
      const { app, first, current } = await anAppWithHistory()
      const sys = env.system as any
      if (replicates) {
        const dest = await sys.backupDestination.create({ data: {
          workspaceId: ws.id, name: `img-${uniq()}`, endpoint: 'http://127.0.0.1:9', region: 'auto', bucket: `img-${uniq()}` } })
        await sys.app.update({ where: { id: app.id }, data: { replicaDestinationId: dest.id } })
      }
      const replacement = await sys.deployment.create({ data: {
        appId: app.id, workspaceId: ws.id, toImage: first.toImage, trigger: 'rollback',
        previousDeploymentId: current.id, configSnapshot: first.configSnapshot } })
      await sys.deploymentStep.create({ data: { deploymentId: replacement.id, position: 0, name: 'Start container' } })
      const dispatched: { name: string; data: any; opts: any }[] = []
      const conduit = { resolve: async () => ({ pinned_cert: true }), send: async () => ({ data: {} }) }
      const via = new Proxy(env.app, { get: (t, k) =>
        k === 'conduit' ? conduit
        : k === 'jobs' ? { dispatch: async (job: any, data: any, opts: any) => { dispatched.push({ name: job.name, data, opts }); return {} } }
        : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })
      await env.app.runAs(admin.id, { tenant: ws.id }, () =>
        (deploymentRun as any).handler({ app: via, data: { deployment_id: replacement.id } }))
      expect((await sys.deployment.findUnique({ where: { id: replacement.id } })).status).toBe('success')
      return { dispatched: dispatched.filter(d => d.name === 'release-image:export'), id: replacement.id }
    }

    test('a release of an App with a replica destination dispatches the export once it succeeds', async () => {
      const { dispatched, id } = await deployAndWatch(true)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].data).toMatchObject({ deploymentId: id, serverId: box.id })
      expect(dispatched[0].opts).toMatchObject({ id: `image-export:${id}` })
    })

    test('an App with no replica destination dispatches none', async () => {
      expect((await deployAndWatch(false)).dispatched).toEqual([])
    })
  })

  test('a rollback onto the older schema is stop-first, and the row says why', async () => {
    const row = await startAgainst({ swap: 'stop-first', swap_reason: 'this release is a contract' })
    expect(row.status).toBe('success')
    expect(row.swap).toBe('stopFirst')
    expect(row.swapReason).toBe('this release is a contract')
  })

  test('an overlap records no reason, and a machine that names no swap records none', async () => {
    expect(await startAgainst({ swap: 'start-first', swap_reason: null })).toMatchObject({ swap: 'startFirst', swapReason: null })
    expect(await startAgainst({})).toMatchObject({ swap: null, swapReason: null })
  })

  describe('what the App asks for (FJS-D1882)', () => {
    const host = () => `swap-${uniq()}.example.test`

    test('start-first goes out for an App that asked, with a host, a published port and a health path', async () => {
      const row = await startAgainst({}, { swap: 'startFirst' }, { port: 4100, healthCheck: '/health' }, host())
      expect(row.asked).toBe('start-first')
    })

    test('an App that asked for nothing is sent stop-first', async () => {
      const row = await startAgainst({}, {}, { port: 4100 }, host())
      expect(row.asked).toBe('stop-first')
    })

    test('an App that exposes its port is sent stop-first whatever it asks', async () => {
      const row = await startAgainst({}, { swap: 'startFirst', hasExposedPort: true }, { port: 4100 }, host())
      expect(row.asked).toBe('stop-first')
    })

    test('an App with nothing to route to is sent stop-first, so Outpost does not refuse the release', async () => {
      expect((await startAgainst({}, { swap: 'startFirst' }, { port: 4100 })).asked).toBe('stop-first')
      expect((await startAgainst({}, { swap: 'startFirst' }, {}, host())).asked).toBe('stop-first')
    })

    test('an App with no health path is sent stop-first: running is all the overlap could ask (FJS-4012)', async () => {
      expect((await startAgainst({}, { swap: 'startFirst' }, { port: 4100, healthCheck: null }, host())).asked).toBe('stop-first')
    })

    test('a rollback reads the live App, not what the release shipped with', async () => {
      // The snapshot says nothing of swap, and turning it off since is honored.
      const off = await startAgainst({}, { swap: 'stopFirst' }, { port: 4100, swap: 'startFirst' }, host())
      expect(off.asked).toBe('stop-first')
      const on = await startAgainst({}, { swap: 'startFirst' }, { port: 4100, healthCheck: '/health', swap: 'stopFirst' }, host())
      expect(on.asked).toBe('start-first')
    })
  })
})

// ─── web/ from the API's own commit (FJS-D1979, FJS-D1980, FJS-D1981) ────────
describe('an API App\'s git release builds web/ for the static App in front of it', () => {
  const API = { id: 'a1' }
  const WEB = { id: 'w1', name: 'app', source: { kind: 'inline' }, domains: [{ id: 'd1', hostname: 'nela.awe.dev' }] }

  test('the static App whose Domain routes to no other App is the one in front of it', async () => {
    const { frontingStatics } = await import('../src/domain/release/fronting.ts')
    const IMG = { id: 'c2', source: { kind: 'image' }, domains: [{ id: 'd2', hostname: 'other.awe.dev' }] }
    expect(frontingStatics({ app: API, siblings: [WEB, IMG], routes: [{ domainId: 'd1', appId: 'a1' }] }).map(f => f.app.id)).toEqual(['w1'])
    expect(frontingStatics({ app: API, siblings: [WEB], routes: [{ domainId: 'd1', appId: 'other' }] })).toEqual([])
    expect(frontingStatics({ app: API, siblings: [WEB], routes: [] }).map(f => f.domain.id)).toEqual(['d1'])
  })

  const commit = 'c'.repeat(40)
  const files  = [{ path: 'index.html', content_base64: Buffer.from('<h1>kos</h1>').toString('base64') }]

  /** A git API App with a static App beside it holding a Domain, both on `box`. */
  async function aSplitApp(environmentId = environment.id) {
    const sys  = env.system as any
    const slug = `api-${uniq()}`
    const api = await sys.app.create({ data: { workspaceId: ws.id, environmentId, name: slug, slug, kind: 'container',
      source: { kind: 'git', repo: 'https://example.test/kos.git', branch: 'main' } } })
    const page = await sys.app.create({ data: { workspaceId: ws.id, environmentId, name: `${slug}-web`, slug: `${slug}-web`,
      kind: 'static', source: { kind: 'inline', files: [] } } })
    for (const a of [api, page]) await sys.appServer.create({ data: { appId: a.id, serverId: box.id, replicaIndex: 0 } })
    await sys.domain.create({ data: { workspaceId: ws.id, appId: page.id, hostname: `${slug}.example.test` } })
    return { api, page }
  }

  async function release(api: any, answers: Record<string, (body: any) => any>) {
    const sys = env.system as any
    const row = await sys.deployment.create({ data: {
      appId: api.id, workspaceId: ws.id, toImage: `${api.slug}:git`, trigger: 'push',
      configSnapshot: { source: api.source, runtime: {} } } })
    // No 'Health check': the stub conduit answers it with nothing, which waits out its budget.
    for (const [position, name] of ['Build image', 'Build web', 'Start container', 'Release web'].entries())
      await sys.deploymentStep.create({ data: { deploymentId: row.id, position, name } })
    const sent: any[] = []
    const conduit = {
      resolve: async () => ({ pinned_cert: true }),
      send: async (call: any) => { sent.push(call); return answers[call.path]?.(call.body) ?? { data: {} } },
    }
    const via = new Proxy(env.app, { get: (t, k) =>
      k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })
    await env.app.runAs(admin.id, { tenant: ws.id }, () =>
      (deploymentRun as any).handler({ app: via, data: { deployment_id: row.id } }))
    return { row: await sys.deployment.findUnique({ where: { id: row.id } }), sent }
  }

  const BUILT = { '/build': () => ({ data: { digest: 'sha256:' + 'f'.repeat(64), commit_sha: commit } }) }

  test('web/ is built from the commit /build answered, written before the swap, and released as the static App\'s own row', async () => {
    const { api, page } = await aSplitApp()
    const { row, sent } = await release(api, {
      ...BUILT,
      '/web/build':      () => ({ data: { commit_sha: commit, files } }),
      '/static/publish': () => ({ data: { digest: 'sha256:' + 'e'.repeat(64) } }),
    })
    expect(row.status).toBe('success')
    const paths = sent.map(c => c.path)
    expect(sent.find(c => c.path === '/web/build')?.body).toMatchObject({ app_id: api.id, commit })
    expect(sent.find(c => c.path === '/static/publish')?.body).toMatchObject({ app_id: page.id, files })
    expect(paths.indexOf('/static/publish')).toBeLessThan(paths.indexOf('/deploy'))
    const web = await (env.system as any).deployment.findFirst({ where: { appId: page.id } })
    expect(web).toMatchObject({ builtImage: 'sha256:' + 'e'.repeat(64), commitSha: commit, trigger: 'push' })
  })

  /** A split app alone in an environment of its own, with a widgets App holding a Domain beside it. */
  async function aSplitAppWithWidgets() {
    const sys = env.system as any
    const own = await sys.environment.create({ data: { workspaceId: ws.id, projectId: environment.projectId, name: 'Widgets', slug: `e-${uniq()}` } })
    const { api, page } = await aSplitApp(own.id)
    const widgets = await sys.app.create({ data: { workspaceId: ws.id, environmentId: own.id, name: `${api.slug}-widgets`, slug: `${api.slug}-widgets`,
      kind: 'static', source: { kind: 'inline', files: [], surface: 'widgets' } } })
    await sys.appServer.create({ data: { appId: widgets.id, serverId: box.id, replicaIndex: 0 } })
    await sys.domain.create({ data: { workspaceId: ws.id, appId: widgets.id, hostname: `widgets.${api.slug}.example.test` } })
    return { api, page, widgets }
  }

  test('a widgets front is built from widgets/ once, each bundle told the other origin, and released beside web/ (FJS-D2032, FJS-D2034)', async () => {
    const { api, page, widgets } = await aSplitAppWithWidgets()
    const sys = env.system as any
    const embeds = [{ path: 'lawn.js', content_base64: Buffer.from('void 0').toString('base64') }]
    const { row, sent } = await release(api, {
      ...BUILT,
      '/web/build':      (body) => ({ data: { commit_sha: commit, surface: body.surface, files: body.surface === 'widgets' ? embeds : files } }),
      '/static/publish': (body) => ({ data: { digest: 'sha256:' + (body.app_id === widgets.id ? 'b' : 'e').repeat(64) } }),
    })
    expect(row.status).toBe('success')
    const builds = sent.filter(c => c.path === '/web/build').map(c => c.body)
    expect(builds.map(b => b.surface).sort()).toEqual(['web', 'widgets'])
    expect(builds.find(b => b.surface === 'web')).toMatchObject({ widgets_url: `https://widgets.${api.slug}.example.test` })
    expect(builds.find(b => b.surface === 'web')).not.toHaveProperty('api_url')
    expect(builds.find(b => b.surface === 'widgets')).toMatchObject({ api_url: `https://${api.slug}.example.test` })
    expect(builds.find(b => b.surface === 'widgets')).not.toHaveProperty('widgets_url')
    const published = sent.filter(c => c.path === '/static/publish').map(c => c.body)
    expect(published.find(b => b.app_id === widgets.id)).toMatchObject({ files: embeds })
    expect(published.find(b => b.app_id === page.id)).toMatchObject({ files })
    expect(await sys.deployment.findFirst({ where: { appId: widgets.id } })).toMatchObject({ builtImage: 'sha256:' + 'b'.repeat(64), commitSha: commit })
  })

  test('a machine that answers web/ for a widgets build fails the release before the swap', async () => {
    const { api } = await aSplitAppWithWidgets()
    const sys = env.system as any
    const { row, sent } = await release(api, {
      ...BUILT,
      '/web/build':      () => ({ data: { commit_sha: commit, files } }),
      '/static/publish': () => ({ data: { digest: 'sha256:' + 'e'.repeat(64) } }),
    })
    expect(row.status).toBe('failed')
    const steps = await sys.deploymentStep.findMany({ where: { deploymentId: row.id } })
    expect(JSON.stringify(steps)).toContain('predates the surface')
    expect(sent.some(c => c.path === '/deploy')).toBe(false)
  })

  test('a failed web build fails the release before the swap', async () => {
    const { api, page } = await aSplitApp()
    const { row, sent } = await release(api, {
      ...BUILT,
      '/web/build': () => ({ error: { message: 'vite build failed', raw: { error: 'vite: config/vite.config.js not found' } } }),
    })
    expect(row.status).toBe('failed')
    expect(sent.some(c => c.path === '/deploy')).toBe(false)
    expect(sent.some(c => c.path === '/static/publish')).toBe(false)
    expect(await (env.system as any).deployment.findFirst({ where: { appId: page.id } })).toBeNull()
  })

  test('the queued release lists the web steps only when a static App fronts it', async () => {
    const { api } = await aSplitApp()
    const lone = await (env.system as any).app.create({ data: { workspaceId: ws.id, environmentId: (await (env.system as any).environment.create({ data: {
      workspaceId: ws.id, projectId: environment.projectId, name: 'Lone', slug: `e-${uniq()}` } })).id,
      name: `lone-${uniq()}`, slug: `lone-${uniq()}`, kind: 'container', source: api.source } })
    await (env.system as any).appServer.create({ data: { appId: lone.id, serverId: box.id, replicaIndex: 0 } })
    const stepsOf = async (appId: string) => {
      const made = await env.as(admin).service('deployments').create({ appId })
      return (await (env.system as any).deploymentStep.findMany({ where: { deploymentId: made.id }, orderBy: { position: 'asc' } })).map((s: any) => s.name)
    }
    expect(await stepsOf(api.id)).toEqual(['Validate', 'Build image', 'Build web', 'Start container', 'Health check', 'Release web'])
    expect(await stepsOf(lone.id)).toEqual(['Validate', 'Build image', 'Start container', 'Health check'])
  })
})

// FJS-4059: `pushIngressCert` is tested directly; this is the release calling it.
describe('the ingress wildcard a release pushes (FJS-D1975)', () => {
  const sys = () => env.system as any

  /** One release of a fresh app, its machine answering through a recording conduit. */
  async function releaseWith(material: Record<string, unknown> | null) {
    const { app, first } = await anAppWithHistory()
    const before = await sys().workspace.findFirst({ where: { id: ws.id } })
    let secretId: string | null = null
    if (material) {
      const secret = await sys().secret.create({ data: { workspaceId: ws.id, name: `wild-${uniq()}`, kind: 'tlsCert', data: JSON.stringify(material) } })
      secretId = secret.id
      await sys().workspace.update({ where: { id: ws.id }, data: { ingressCertSecretId: secretId, ingressCertExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(), version: before.version },
        system: ['ingressCertSecretId', 'ingressCertExpiresAt'] })
    }
    try {
      const replacement = await sys().deployment.create({ data: {
        appId: app.id, workspaceId: ws.id, toImage: first.toImage, trigger: 'rollback',
        configSnapshot: first.configSnapshot } })
      await sys().deploymentStep.create({ data: { deploymentId: replacement.id, position: 0, name: 'Start container' } })
      const sent: any[] = []
      const conduit = {
        resolve: async () => ({ pinned_cert: true }),
        send: async (call: any) => { sent.push(call); return { data: {} } },
      }
      const via = new Proxy(env.app, { get: (t, k) =>
        k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })
      await env.app.runAs(admin.id, { tenant: ws.id }, () =>
        (deploymentRun as any).handler({ app: via, data: { deployment_id: replacement.id } }))
      return sent
    } finally {
      if (secretId) {
        const now = await sys().workspace.findFirst({ where: { id: ws.id } })
        await sys().workspace.update({ where: { id: ws.id }, data: { ingressCertSecretId: null, ingressCertExpiresAt: null, version: now.version },
          system: ['ingressCertSecretId', 'ingressCertExpiresAt'] })
        await sys().secret.delete({ where: { id: secretId } })
      }
    }
  }

  test('the stored wildcard reaches the machine before the first step acts', async () => {
    const sent  = await releaseWith({ cert: 'CERT-PEM', key: 'KEY-PEM' })
    const paths = sent.map(c => c.path)
    expect(paths).toContain('/certs/load')
    expect(paths.indexOf('/certs/load')).toBeLessThan(paths.indexOf('/deploy'))
    expect(sent.find(c => c.path === '/certs/load').body).toEqual({ id: 'ingress', cert: 'CERT-PEM', key: 'KEY-PEM' })
  })

  test('a workspace with no wildcard sends no /certs/load', async () => {
    expect((await releaseWith(null)).map(c => c.path)).not.toContain('/certs/load')
  })
})
