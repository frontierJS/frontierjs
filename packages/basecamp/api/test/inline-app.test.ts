/*
 * inline-app.test.ts — an app whose source is the files themselves.
 *
 * The prototyping door: paste a page that pulls React off a CDN, save, deploy,
 * and it is running. No build, no image, no registry — which means none of the
 * container pipeline's six steps describe what has to happen, and the two
 * claims this file carries are both about that.
 *
 * **`source` and `type` are one decision.** An inline source served through the
 * container pipeline fails four steps in with a docker error about an image
 * nobody named, so the service refuses the two words disagreeing at the create.
 *
 * **The step list is read off the SOURCE, not off the app.** A rollback's whole
 * meaning is that its snapshot differs from the app as it stands now, so an app
 * switched between kinds since a release must roll that release back through
 * the pipeline its own bytes can run.
 *
 * What is NOT here is the machine: `@frontierjs/outpost`'s own suite owns the
 * filesystem half (digest, symlink swap, traversal), and basecamp's browser
 * drive is where the two meet. A fake outpost asserted here would be this
 * file's author's idea of the protocol rather than the protocol.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { parseAppSource, describeSource, INLINE_LIMITS } from '../src/core/app-source.ts'

process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, box: any, environment: any
const uniq = () => Math.random().toString(36).slice(2, 8)

const PAGE = '<!doctype html><html><body><div id="root"></div></body></html>'
const inline = (files = [{ path: 'index.html', content: PAGE }]) => ({ kind: 'inline', files })

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
  const user = await sys.user.create({ data: { email: `u-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })

  ws = await sys.workspace.create({ data: {
    accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}`, ownerId: user.id } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'admin',
    capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  admin = session({ userId: user.id, workspaceId: ws.id })

  box = await sys.server.create({ data: {
    workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
  box = await sys.server.transition(box.id, 'checkIn')
  const project = await sys.project.create({ data: {
    workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
})

const apps        = () => env.as(admin).service('apps')
const deployments = () => env.as(admin).service('deployments')

/** An inline app, placed on a machine that can take a release. */
async function anInlineApp(source: unknown = inline()) {
  const slug = `pasted-${uniq()}`
  const created: any = await apps().create({
    workspaceId: ws.id, environmentId: environment.id,
    name: slug, slug, type: 'static', source,
  })
  await (env.system as any).appServer.create({ data: { appId: created.id, serverId: box.id, replicaIndex: 0 } })
  return created
}

const stepNames = async (deploymentId: string) =>
  (await (env.system as any).deploymentStep.findMany({ where: { deploymentId } }))
    .map((s: any) => s.name)

describe('what a source may be', () => {

  test('an inline source is stored as it was declared', async () => {
    const created = await anInlineApp()
    expect(created.source.kind).toBe('inline')
    expect(created.source.files[0].content).toBe(PAGE)
  })

  test('a source with no kind is refused — nothing is inferred from which keys are present', async () => {
    await expect(apps().create({
      workspaceId: ws.id, environmentId: environment.id,
      name: 'x', slug: `x-${uniq()}`, type: 'container', source: { repo: 'git@host:a/b.git' },
    })).rejects.toThrow(/source\.kind/)
  })

  test('an unknown key cannot ride into the column and be read back as though it meant something', () => {
    const parsed = parseAppSource({ kind: 'git', repo: 'git@host:a/b.git', branch: 'main', deployKey: 'sneaky' })
    expect(parsed).toEqual({ kind: 'git', repo: 'git@host:a/b.git', branch: 'main' })
  })

  test('an empty source is a real answer — an app created and not yet pointed at anything', () => {
    expect(parseAppSource({})).toBeNull()
    expect(describeSource({})).toBe('nothing yet')
  })
})

describe('source and type are one decision', () => {

  test('an inline source on a container app is refused, naming both words', async () => {
    await expect(apps().create({
      workspaceId: ws.id, environmentId: environment.id,
      name: 'x', slug: `x-${uniq()}`, type: 'container', source: inline(),
    })).rejects.toThrow(/must be 'static'/)
  })

  test('and the type cannot be moved out from under a source that is already inline', async () => {
    const created = await anInlineApp()
    await expect(apps().patch(created.id, { type: 'container' })).rejects.toThrow(/must be 'static'/)
  })
})

describe('what the paste box refuses', () => {

  const bad = (files: unknown[]) => apps().create({
    workspaceId: ws.id, environmentId: environment.id,
    name: 'x', slug: `x-${uniq()}`, type: 'static', source: { kind: 'inline', files },
  })

  test('a release with no entry point — it would deploy green and answer 404 at its own address', async () => {
    await expect(bad([{ path: 'app.js', content: 'x' }])).rejects.toThrow(/needs an index\.html/)
  })

  test('a path that walks out of the app, named in the refusal', async () => {
    await expect(bad([{ path: '../../etc/cron.d/x', content: 'x' }])).rejects.toThrow(/not a path inside the app/)
  })

  test('the same path twice — one of them would silently win', async () => {
    await expect(bad([
      { path: 'index.html', content: 'a' }, { path: 'index.html', content: 'b' },
    ])).rejects.toThrow(/listed twice/)
  })

  test('a file bigger than the box takes, with the number in the sentence', async () => {
    await expect(bad([
      { path: 'index.html', content: PAGE },
      { path: 'big.js', content: 'x'.repeat(INLINE_LIMITS.fileBytes + 1) },
    ])).rejects.toThrow(/big\.js/)
  })

  test('a file with no content at all — an empty file is \'\', a missing one is a mistake', async () => {
    await expect(bad([{ path: 'index.html' }])).rejects.toThrow(/has no content/)
  })

  test('a size limit counts BYTES, so a page of emoji is not four times under it', async () => {
    // `'🚀'.length` is 2 and its encoding is 4. A limit measured in string
    // length lets twice what it says through, silently.
    const emoji = '🚀'.repeat(INLINE_LIMITS.fileBytes / 4 + 1)
    await expect(bad([{ path: 'index.html', content: PAGE }, { path: 'e.js', content: emoji }]))
      .rejects.toThrow(/over the/)
  })
})

describe('what a list carries and what it does not', () => {

  test('a list says what the source IS; the detail read says what it holds', async () => {
    const target = await anInlineApp()

    const listed: any = (await apps().find({ workspaceId: ws.id }))
      .data.find((a: any) => a.id === target.id)
    expect(listed.source.kind).toBe('inline')
    expect(listed.source.files[0]).toEqual({ path: 'index.html', bytes: PAGE.length })
    // REMOVED, not blanked: an empty string is an editor rendered over a file
    // that has a page in it, and saved back that way.
    expect('content' in listed.source.files[0]).toBe(false)

    const detail: any = await apps().get(target.id)
    expect(detail.source.files[0].content).toBe(PAGE)
  })

  test('a release list does not carry a copy of the source per release', async () => {
    const target = await anInlineApp()
    await deployments().create({ appId: target.id, workspaceId: ws.id })

    const detail: any = await apps().get(target.id)
    expect(detail.recent_deployments.length).toBeGreaterThan(0)
    expect(detail.recent_deployments[0].configSnapshot).toBeUndefined()
  })
})

describe('the release pipeline an inline app runs', () => {

  test('four steps, and not one of the container words', async () => {
    const target = await anInlineApp()
    const release: any = await deployments().create({ appId: target.id, workspaceId: ws.id })

    expect(await stepNames(release.id)).toEqual(['Validate', 'Upload files', 'Activate', 'Health check'])
  })

  const aContainerApp = async (source: unknown) => {
    const slug = `c-${uniq()}`
    const target: any = await apps().create({
      workspaceId: ws.id, environmentId: environment.id, name: slug, slug, type: 'container', source,
    })
    await (env.system as any).appServer.create({ data: { appId: target.id, serverId: box.id, replicaIndex: 0 } })
    return target
  }

  test('an image app PULLS the image its source names, and builds nothing', async () => {
    const target = await aContainerApp({ kind: 'image', image: 'nginx:alpine' })
    const release: any = await deployments().create({ appId: target.id, workspaceId: ws.id })

    expect(await stepNames(release.id)).toEqual(
      ['Validate', 'Pull image', 'Stop previous', 'Start container', 'Health check'])
    // Released the way the app screen releases one, `{ appId }` alone — the
    // runner asks the machine for `toImage`, and the app's name otherwise.
    expect(release.toImage).toBe('nginx:alpine')
  })

  test('a git app is refused until something builds its image', async () => {
    // The build steps were a command-less /exec that reported success, and the
    // start step then pulled the app's NAME from Docker Hub.
    const target = await aContainerApp({ kind: 'git', repo: 'git@host:a/b.git' })
    await expect(deployments().create({ appId: target.id, workspaceId: ws.id }))
      .rejects.toThrow(/names no image/)
  })

  test('the release records the files that were live when it was queued, not the ones there now', async () => {
    const target  = await anInlineApp()
    const release: any = await deployments().create({ appId: target.id, workspaceId: ws.id })

    await apps().patch(target.id, { source: inline([{ path: 'index.html', content: '<h1>edited</h1>' }]) })

    const stored = await (env.system as any).deployment.findUnique({ where: { id: release.id } })
    expect(stored.configSnapshot.source.files[0].content).toBe(PAGE)
  })

  test('a rollback runs the pipeline the TARGET\'s bytes need, not the app\'s current kind', async () => {
    const sys    = env.system as any
    const target = await anInlineApp()

    // Two shipped releases of the pasted files, then the app is switched to a
    // container. Rolling back to the inline release through the container
    // pipeline would ask a machine to start an image nobody ever built.
    // A Deployment is born `pending`, even for the system, so a shipped one walks there.
    const shipped = async (data: Record<string, unknown>) => {
      const row = await sys.deployment.create({ data: {
        appId: target.id, workspaceId: ws.id, finishedAt: new Date().toISOString(), ...data } })
      await sys.deployment.transition(row.id, 'build')
      return sys.deployment.transition(row.id, 'succeed')
    }

    const first   = await shipped({
      builtImage: 'sha256:' + 'a'.repeat(64),
      configSnapshot: { source: inline(), runtime: {} } })
    const current = await shipped({
      builtImage: 'sha256:' + 'b'.repeat(64), previousDeploymentId: first.id,
      configSnapshot: { source: inline(), runtime: {} } })

    await sys.app.update({ where: { id: target.id }, data: {
      type: 'container', source: { kind: 'image', image: 'nginx:alpine' } } })

    const replacement: any = await deployments().call('rollback', current.id, {})
    expect(await stepNames(replacement.id)).toEqual(['Validate', 'Upload files', 'Activate', 'Health check'])
  })
})

describe('deleting one takes it off the air', () => {

  test('a removed inline app is retired from the machine, and a machine that cannot be reached does not block the delete', async () => {
    // Files do not stop when nothing restarts them: a row deleted from this
    // console and a page still answering on the internet is the failure this
    // path exists for. There is no machine in this suite — the stub answers —
    // so what is asserted here is the half that must hold either way: the
    // operator's decision goes through, and the retire is best effort.
    const target = await anInlineApp()

    await apps().remove(target.id)

    await expect(apps().get(target.id)).rejects.toThrow(/not found/i)
  })
})
