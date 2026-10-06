// src/providers/executor.ts
// Who actually carries out a release — resolved in ONE place, asked by both
// the service that accepts the request and the job that runs it.
//
// Until FJS-257 there was no such question. `deployment-run.job.ts` looked for a
// placement, found none, returned early from every step, and the caller marked
// each one `success` — a release that finished green in 23ms having issued no
// command, with the App left reading `running`. The early return was labeled
// "log only, don't fail (supports local/stub mode)", which is the shape this
// module exists to replace: a stub nobody asked for and nothing named.
//
// Three answers, and a caller must handle all three:
//
//   outpost — a machine holding this app has registered a Conduit target.
//             The real path: every call leaves the process.
//   stub    — explicitly asked for, by env, and refused in production. Answers
//             the protocol without doing anything, and says so in every step's
//             output so a release run this way cannot be mistaken for one that
//             shipped.
//   none    — nothing can carry this release. A refusal, never a quiet pass.
//
// The Outpost protocol itself lives at the top of `deployment-run.job.ts`; this
// module only decides who speaks it.

import type { BasecampApp } from '../basecamp.types.ts'

/**
 * How long a release's two long commands may take, read off the machine's own
 * bounds: Outpost cuts a pull at 15 minutes and a build at 30, and `/deploy`
 * then stops the old container and waits on the new one's health — and, when
 * that fails, on the old one's once it is put back (`FJS-1765`). Sent at
 * conduit's 10s default, a deploy that was still working read as a failed one.
 */
export const PULL_TIMEOUT_MS   = 15 * 60_000 + 30_000
export const DEPLOY_TIMEOUT_MS = 32 * 60_000

/** Set to '1' to allow the stub. Refused under NODE_ENV=production regardless. */
const STUB_ENV = 'BASECAMP_STUB_OUTPOST'

export interface ExecutorReply {
  data?:  Record<string, unknown>
  error?: { message: string }
}

export interface Executor {
  kind:      'outpost' | 'stub'
  serverId:  string
  /** Present only for `outpost`, and it is the Conduit target, not a URL. */
  target:    string | null
  call(path: string, body: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ExecutorReply>
}

export interface NoExecutor {
  kind:   'none'
  /** Said to the operator verbatim, so it names the thing they can fix. */
  reason: string
}

export function isExecutor(r: Executor | NoExecutor): r is Executor {
  return r.kind !== 'none'
}

/** Whether the stub is available at all. Two switches, and production wins. */
export function stubAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env[STUB_ENV] === '1'
}

/**
 * The stub. It answers the protocol and does nothing — the one honest use is a
 * laptop with no machine in the fleet, which is most of this app's own
 * development.
 *
 * `digest: null` is the point of the shape: a stub cannot know which bytes ran,
 * so it says so rather than inventing a plausible sha256 that would then be
 * recorded on the Deployment as the thing that shipped.
 */
function stubExecutor(serverId: string): Executor {
  return {
    kind:     'stub',
    serverId,
    target:   null,
    async call(path) {
      return { data: { stubbed: true, healthy: true, digest: null, note: `stub executor — no ${path} was issued` } }
    },
  }
}

function outpostExecutor(app: BasecampApp, serverId: string, target: string): Executor {
  return {
    kind:   'outpost',
    serverId,
    target,
    async call(path, body, opts) {
      const sent = await app.conduit!.send({
        target,
        method: 'POST',
        path,
        body,
        ...(opts?.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}),
      })
      const said  = sent.error ? machineSaid(sent.error.raw) : null
      const reply = sent as ExecutorReply
      return said ? { ...reply, error: { message: said } } : reply
    },
  }
}

/**
 * The sentence an Outpost refused with. It answers a failed command with
 * `{ error: <sentence> }`, and conduit keeps that body as `raw` behind a message
 * naming only the status — so without this, *config.port is not set* reached
 * the release as *Server error: 500*, with the reason left in the machine's log.
 */
export function machineSaid(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const body = JSON.parse(raw)
    return typeof body?.error === 'string' && body.error ? body.error : null
  } catch {
    return null
  }
}

/** The outpost on this one machine, when it holds a pinned target. */
async function reachable(app: BasecampApp, serverId: string): Promise<Executor | null> {
  if (!app.conduit) return null
  const target = `outpost:${serverId}`
  return (await app.conduit.resolve(target).catch(() => null))?.pinned_cert
    ? outpostExecutor(app, serverId, target)
    : null
}

/**
 * Who speaks for one named machine — for a command every placement must get
 * rather than the one a release picks, such as a route (`FJS-1610`). The same
 * rules as `resolveExecutor`, asked of one server: its pinned outpost, else the
 * stub where it is allowed, else a refusal naming the machine.
 */
export async function executorOn(app: BasecampApp, serverId: string, name = serverId): Promise<Executor | NoExecutor> {
  const reached = await reachable(app, serverId)
  if (reached) return reached
  if (stubAllowed()) return stubExecutor(serverId)
  return { kind: 'none', reason: `No outpost is registered for '${name}' — it has not reported an https URL since it enrolled` }
}

/**
 * Who runs this app's next release.
 *
 * Asked twice on purpose: `deployments.create` asks it to refuse the request
 * where the operator can see the refusal, and the job asks it again because
 * a placement can go away between the click and the job — the two must not be
 * able to disagree, which is why the rule is here rather than in either.
 */
export async function resolveExecutor(app: BasecampApp, appId: string): Promise<Executor | NoExecutor> {
  const db = app.db.asSystem() as any

  const placements = await db.appServer.findMany({
    where:   { appId },
    include: { server: true },
    orderBy: { replicaIndex: 'asc' },
  })

  if (!placements.length)
    return { kind: 'none', reason: 'This app is not placed on any server — place it on one first' }

  // A machine that is draining or unreachable still holds the app; it is not a
  // machine to send a release to. `online` is the whole of what can take one:
  // a machine that is up and has not been drained.
  const online = placements.filter((p: any) => p.server?.status === 'online')
  if (!online.length) {
    const states = [...new Set(placements.map((p: any) => p.server?.status ?? 'missing'))].join(', ')
    return { kind: 'none', reason: `No server holding this app can take a release (${states})` }
  }

  // The first online placement that can be REACHED, not the first online one.
  // A machine that has not heartbeated since the API restarted has no target
  // yet, and refusing on it refuses a release a second replica could carry —
  // naming the machine that cannot take it rather than the one that can.
  //
  // Conduit is optional on the app type, and an app configured without it can
  // reach no machine at all — which is a refusal rather than a crash five steps
  // into a release.
  //
  // An unpinned target is no target: a release carries decrypted secrets, and
  // without the pin they cross the network in the clear (`FJS-1603`). The
  // heartbeat registers none, so this refuses whatever put one there anyway.
  for (const p of online) {
    const reached = await reachable(app, p.serverId as string)
    if (reached) return reached
  }

  if (stubAllowed()) return stubExecutor(online[0].serverId as string)

  const names = online.map((p: any) => `'${p.server?.name ?? p.serverId}'`).join(', ')
  return {
    kind:   'none',
    reason: online.length === 1
      ? `No outpost is registered for ${names} — it has not reported an https URL since it enrolled`
      : `No outpost is registered for any of ${names} — none has reported an https URL since it enrolled`,
  }
}
