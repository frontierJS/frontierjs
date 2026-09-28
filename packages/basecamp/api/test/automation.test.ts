/*
 * automation.test.ts — a workspace's automation, run by orion inside basecamp.
 *
 * `IDEAS/orion-port.md` phase 7's second half. The flow is the one an operator
 * actually wants: **when a release fails, page the workspace's ops channel.**
 * People are already told (`deployment-run.job.ts` sends `deploy_failed`); a
 * channel was reached only by a metric alert rule, so a failed release reached
 * no Slack, no PagerDuty and no webhook at all.
 *
 * Nothing here stands in for the app. The release fails through the real job —
 * created by the service, refused by `resolveExecutor` because its only machine
 * started draining between the click and the job, finished by `finishRun` —
 * and the page leaves through `core/delivery.ts` and conduit to a receiver on a
 * real port. So a flow that says `completed` over a page nobody received is the
 * failure this is shaped to catch: the receiver's own log is the assertion.
 *
 * Every claim is a pair — a failed release beside a successful one, the owner's
 * channel beside another workspace's — because a flow that pages on every write
 * and a flow that pages on the right one are the same observation from one side.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }              from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'

// A release is only accepted onto a machine something can reach, and this
// suite has none. The stub is the shape a laptop with no fleet runs in.
process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, other: any, admin: any, developer: any, outsider: any
let box: any, environment: any, channel: any, theirChannel: any, flowId: string
let receiver: ReturnType<typeof Bun.serve>
const received: Array<{ path: string; body: any }> = []
const uniq = () => Math.random().toString(36).slice(2, 8)

const lit = (value: unknown) => ({ type: 'literal', value })
const ref = (path: string) => ({ type: 'ref', path })

/** The flow, as an operator writes it. */
const pageOnFailure = (channelId: string) => ({
  name:  'Page ops when a release fails',
  nodes: {
    t:    { id: 't', type: 'trigger.model', config: { model: lit('Deployment'), on: lit(['update']) } },
    page: { id: 'page', type: 'basecamp.page', config: {
      channelId: lit(channelId),
      title:     { type: 'template', parts: [lit('Release failed: '), ref('$.trigger.record.toImage')] },
      severity:  lit('critical'),
      // What a receiver de-duplicates on, so a release that fails twice over is
      // one incident rather than two.
      dedupKey:  { type: 'template', parts: [lit('basecamp:deploy:'), ref('$.trigger.record.id')] },
    } },
  },
  // Every finished release is an update to `status`; only a failed one pages.
  edges: [{ id: 't-page', from: 't', to: 'page',
    condition: { type: 'fn', name: 'eq', args: [ref('$.trigger.record.status'), lit('failed')] } }],
})

beforeAll(async () => {
  receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) })
      return new Response('ok')
    },
  })

  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
  const mk   = async () => sys.user.create({ data: { email: `u-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  const a = await mk(), d = await mk(), o = await mk()

  ws    = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}`, ownerId: a.id } })
  other = await sys.workspace.create({ data: { accountId: acct.id, name: 'Other', slug: `o-${uniq()}`, ownerId: o.id } })
  const member = (w: any, u: any, role: string) => sys.workspaceMember.create({ data: {
    workspaceId: w.id, userId: u.id, role, capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })
  await member(ws, a, 'admin')
  await member(ws, d, 'developer')
  await member(other, o, 'admin')

  admin     = session({ userId: a.id, workspaceId: ws.id })
  developer = session({ userId: d.id, workspaceId: ws.id })
  outsider  = session({ userId: o.id, workspaceId: other.id })

  box = await sys.server.create({ data: { workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
  box = await sys.server.transition(box.id, 'checkIn')
  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment   = await sys.environment.create({ data: { workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })

  const hook = (w: any, name: string) => sys.notificationChannel.create({ data: {
    workspaceId: w.id, name, kind: 'webhook', config: { url: `http://127.0.0.1:${receiver.port}/${name}` } } })
  channel      = await hook(ws, 'ops')
  theirChannel = await hook(other, 'theirs')

  // The admin authors it through orion's own services, as the screen would.
  const flows   = env.as(admin).service('flows')
  const created = await flows.create({ name: 'Page ops when a release fails' })
  flowId = created.id
  await flows.call('save', flowId, { definition: pageOnFailure(channel.id) })
  await flows.call('activate', flowId, {})
})

afterAll(async () => {
  receiver?.stop(true)
  await env?.close?.()
})

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A placed app, so `deployments.create` accepts a release onto `box`. */
async function placedApp() {
  const sys  = env.system as any
  const slug = `app-${uniq()}`
  const made = await sys.app.create({ data: { workspaceId: ws.id, environmentId: environment.id, name: slug, slug, type: 'container', config: {} } })
  await sys.appServer.create({ data: { appId: made.id, serverId: box.id, replicaIndex: 0 } })
  return made
}

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (done(v) || Date.now() > end) return v
    await new Promise(r => setTimeout(r, 50))
  }
}

const runsOf = () => (env.system as any).run.findMany({
  where:   { flowVersion: { is: { flowId } } },
  include: { steps: true },
})

const release = (appId: string, image: string) =>
  env.as(developer).service('deployments').create({ appId, environmentId: environment.id, toImage: image })

// ─── the automation ──────────────────────────────────────────────────────────

describe('a release that fails pages the channel the flow names', () => {

  test('the release fails through the job, and the ops channel receives one page naming it', async () => {
    const sys   = env.system as any
    const app   = await placedApp()
    const queue = env.app.jobs.queue('deployments')
    const image = `shop:${uniq()}`
    const runsBefore = (await runsOf()).length
    const pagesBefore = received.length

    // The release is accepted while the machine can take it; the machine then
    // starts draining before the job runs, which is what `resolveExecutor`
    // refuses. Paused so the order is the test's rather than the poll's.
    queue.pause()
    const deployment = await release(app.id, image)
    await sys.server.update({ where: { id: box.id }, data: { status: 'draining' } })
    queue.resume()

    try {
      const failed = await until(() => sys.deployment.findUnique({ where: { id: deployment.id } }), (d: any) => d?.status === 'failed')
      expect(failed.status).toBe('failed')

      // **One release is SEVERAL runs.** The trigger is every `update` to a
      // Deployment and a release moves through `building` before it lands, so
      // the flow starts once per move and the edge condition skips all but the
      // last. Waiting for *a* terminal run finds the `building` one, whose
      // `page` step is correctly `skipped` — which is the automation working
      // and reads as it failing.
      const run = await until(
        async () => (await runsOf()).find((r: any) =>
          r.trigger?.record?.id === deployment.id && r.trigger?.record?.status === 'failed'),
        (r: any) => ['completed', 'failed'].includes(r?.status))
      expect(run?.status).toBe('completed')
      // Run as the flow's owner, in the workspace the release belongs to.
      expect(run?.actorId).toBe(admin.userId)
      expect(run?.steps.find((s: any) => s.nodeId === 'page')?.output).toEqual({ channel: 'ops', sent: true })
      expect((await runsOf()).length).toBeGreaterThan(runsBefore)

      // The receiver's own log: one page, to the ops channel, naming the release.
      const pages = await until(async () => received.slice(pagesBefore), (p) => p.length >= 1)
      expect(pages.map(p => p.path)).toEqual(['/ops'])
      expect(JSON.stringify(pages[0].body)).toContain(`Release failed: ${image}`)
      expect(JSON.stringify(pages[0].body)).toContain(`basecamp:deploy:${deployment.id}`)

      expect((await sys.notificationChannel.findUnique({ where: { id: channel.id } })).lastDeliveryAt).not.toBeNull()
    } finally {
      // In a `finally` because the machine is shared: a failure here would
      // otherwise leave every later release refused for a reason that belongs
      // to this test.
      await sys.server.update({ where: { id: box.id }, data: { status: 'online' } })
    }
  }, 30_000)

  test('a release that succeeds starts the flow and pages nobody', async () => {
    const sys  = env.system as any
    const app  = await placedApp()
    const runsBefore  = (await runsOf()).length
    const pagesBefore = received.length

    const deployment = await release(app.id, `shop:${uniq()}`)
    const done = await until(() => sys.deployment.findUnique({ where: { id: deployment.id } }), (d: any) => ['success', 'failed'].includes(d?.status))
    expect(done.status).toBe('success')

    const runs = await until(runsOf, (r: any[]) => r.some(x => (x.trigger as any)?.record?.id === deployment.id && ['completed', 'failed'].includes(x.status)))
    const ours = runs.filter((r: any) => (r.trigger as any)?.record?.id === deployment.id)
    expect(ours.length).toBeGreaterThan(0)
    expect(runs.length).toBeGreaterThan(runsBefore)
    // The condition held the page back on every one of them.
    expect(ours.every((r: any) => !r.steps.some((s: any) => s.nodeId === 'page' && s.status === 'completed'))).toBe(true)
    await new Promise(r => setTimeout(r, 200))
    expect(received.slice(pagesBefore)).toEqual([])
  }, 30_000)
})

describe('a flow reaches only what its owner can', () => {

  test("another workspace's channel is not found, and nothing is sent to it", async () => {
    const flows = env.as(admin).service('flows')
    const trigger = { model: 'Deployment', event: 'update', record: { id: 'd-1', status: 'failed', toImage: 'shop:x' } }

    const mine = await flows.call('dryRun', flowId, { trigger })
    expect(mine.status).toBe('completed')
    expect(mine.nodeStates.page?.output ?? mine.nodeStates.page?.data).toEqual({ channel: 'ops', sent: false })

    // Saved as a new version pointing at the OTHER workspace's channel, and
    // dry-run: the owner's read of the channel is what refuses it.
    const pagesBefore = received.length
    await flows.call('pause', flowId, {})
    await flows.call('save', flowId, { definition: pageOnFailure(theirChannel.id) })
    const theirs = await flows.call('dryRun', flowId, { trigger })
    expect(JSON.stringify(theirs)).toContain(`No channel '${theirChannel.id}' this flow's owner can page`)
    expect(received.slice(pagesBefore)).toEqual([])

    await flows.call('save', flowId, { definition: pageOnFailure(channel.id) })
  })

  test("the other workspace's members read none of the flow", async () => {
    const found = await env.as(outsider).service('flows').find({})
    const rows  = Array.isArray(found) ? found : found?.data ?? []
    expect(rows.some((f: any) => f.id === flowId)).toBe(false)
  })
})

// ─── one name per workspace ──────────────────────────────────────────────────

describe('orion\'s own uniques are per workspace', () => {

  test('both workspaces name a credential `crm`, and neither may name it twice', async () => {
    // `FJS-1159`, in the app that found it. `db/orion.lite` declares
    // `name String @unique` and cannot name this app's tenant column; the
    // `tenancy` block prepends it, so the index is `(workspaceId, name)`.
    // Without that the second workspace is refused, by a message naming a value
    // it may not read.
    const sys = env.system as any
    const mk  = (w: any, name: string) => sys.flowCredential.create({ data: {
      workspaceId: w.id, name, provider: 'http', address: 'https://crm.example', auth: 'none' } })

    await mk(ws, 'crm')
    await mk(other, 'crm')
    // The pair: still one per workspace, or the rewrite is indistinguishable
    // from dropping the constraint.
    await expect(mk(ws, 'crm')).rejects.toThrow()
  })

  test('…and a flow\'s key-value store is the same shape', async () => {
    const sys = env.system as any
    const mk  = (w: any) => sys.kvEntry.create({ data: {
      workspaceId: w.id, scope: 'global', key: 'last-release', value: { at: 1 } } })

    await mk(ws)
    await mk(other)
    await expect(mk(ws)).rejects.toThrow()
  })
})
