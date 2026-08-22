// src/providers/executor.ts
// Who actually carries out a release — resolved in ONE place, asked by both
// the service that accepts the request and the job that runs it.
//
// Until FJS-257 there was no such question. `deployment-run.job.ts` looked for a
// placement, found none, returned early from every step, and the caller marked
// each one `success` — a release that finished green in 23ms having issued no
// command, with the App left reading `running`. The early return was labelled
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
      const reply = await app.conduit!.send({
        target,
        method: 'POST',
        path,
        body,
        ...(opts?.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}),
      })
      return reply as ExecutorReply
    },
  }
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
  const db = app.data.asSystem() as any

  const placements = await db.appServer.findMany({
    where:   { appId },
    include: { server: true },
    orderBy: { replicaIndex: 'asc' },
  })

  if (!placements.length)
    return { kind: 'none', reason: 'This app is not placed on any server — place it on one first' }

  // A machine that is draining or unreachable still holds the app; it is not a
  // machine to send a release to. `ready` is a server that has an outpost and
  // has not yet reported for work, which is exactly what a first deploy targets.
  const usable = placements.find((p: any) => ['online', 'ready'].includes(p.server?.status))
  if (!usable) {
    const states = [...new Set(placements.map((p: any) => p.server?.status ?? 'missing'))].join(', ')
    return { kind: 'none', reason: `No server holding this app can take a release (${states})` }
  }

  const serverId = usable.serverId as string
  const target   = `outpost:${serverId}`

  // Conduit is optional on the app type, and an app configured without it can
  // reach no machine at all — which is a refusal rather than a crash five steps
  // into a release.
  if (app.conduit) {
    const registered = await app.conduit.resolve(target).catch(() => null)
    if (registered) return outpostExecutor(app, serverId, target)
  }

  if (stubAllowed()) return stubExecutor(serverId)

  return {
    kind:   'none',
    reason: `No outpost is registered for '${usable.server?.name ?? serverId}' — it has never reported a URL`,
  }
}
