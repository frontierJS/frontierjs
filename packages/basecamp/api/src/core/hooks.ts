// src/core/hooks.ts
// Basecamp-specific hooks — used across Basecamp services.
// Framework hooks (authenticate, requireRole, etc.) imported from '@frontierjs/junction'.

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import { BadRequest, Forbidden, NotFound, Unauthorized, authenticate, applyClaims, MEMBERSHIP, $} from '@frontierjs/junction'
import type { Hook, AroundHook, ServiceContext }  from '@frontierjs/junction'
import { env }                             from './env.ts'
import { channelManager, workspaceChannelName } from '../channels.ts'
import type { BasecampApp }                from '../basecamp.types.ts'
import { grantsFor, grantsWithin }         from './capabilities.ts'

// ─── The session ─────────────────────────────────────────────────────────
// Junction puts the caller on ctx.auth.user as a SessionContext — camelCase
// (userId, authMethod), not the snake_case user_id these hooks used to read.
// Every one of those reads was undefined, which is why role checks silently
// passed for everyone.

interface Session {
  userId?: string; authMethod?: string; workspaceId?: string
  // Put here by basecampSessionFields (core/session-auth.ts) off this app's own
  // User columns, not by @frontierjs/auth.
  isSystemAdmin?: boolean; status?: string; kind?: string
  // Put here by applyStanding() below, per request, off the WorkspaceMember row
  // for the workspace being addressed. Never a column on `user`.
  memberRole?: string
}

interface MemberRow { role?: string; workspace?: { status?: string } }

function userOf(ctx: ServiceContext): Session | undefined {
  return ctx.auth?.user as Session | undefined
}

// ─── requireWorkspace ────────────────────────────────────────────────────
// Ensures ctx.locals.workspaceId is populated before the service method.
//
// Precedence:
//   1. X-Workspace-Id header
//   2. ?workspace_id= query param
//   3. the session's own default workspace

/**
 * Which workspace a request is for.
 *
 * Exported because two hooks need the answer and they must not each work it
 * out: apiKeyGuard runs at app level, before any service hook has stamped
 * ctx.locals, and a second copy of this precedence is a second thing to keep
 * in step.
 *
 * Headers live on ctx.client.headers — Junction splits the context into
 * auth / client / route / locals. There is NO ctx.params: the previous version
 * read ctx.params.headers and wrote ctx.params.workspace_id, and both threw
 * "undefined is not an object" on the first call.
 */
export function resolveWorkspaceId(ctx: ServiceContext): string | undefined {
  return (ctx.client?.headers?.['x-workspace-id'] as string | undefined) ||
         (ctx.reserved?.workspace_id as string | undefined)              ||
         (userOf(ctx)?.workspaceId as string | undefined)
}

/**
 * The query key the fallback above reads, declared where a service can claim it.
 *
 * `?workspace_id=` is not a filter — no model has that column — so junction
 * graded it against the model and answered a 400 naming it, before this hook
 * ever ran. Every workspace-scoped service reserves it, which moves it to
 * `ctx.reserved` and leaves `ctx.query` as columns alone.
 *
 * One constant rather than twenty literals: the spelling is read here and
 * declared there, and those must not drift.
 */
export const WORKSPACE_QUERY = ['workspace_id'] as const

export function requireWorkspace(): Hook {
  return (ctx: ServiceContext): void => {
    const workspaceId = resolveWorkspaceId(ctx)

    if (!workspaceId)
      throw new BadRequest(
        'workspace_id required — pass X-Workspace-Id header or ?workspace_id= query param'
      )

    ctx.locals.workspaceId = workspaceId
  }
}

// ─── Standing ────────────────────────────────────────────────────────────
// Who the caller is IN THE WORKSPACE this request is for.
//
// The resolution itself is the framework's now: `createApp({ principal })` in
// app.ts, through `membershipClaim()`, which reads the WorkspaceMember row
// once per request and puts `workspaceId` and `memberRole` on a fresh principal
// before the Data boundary scopes the client from it (`FJS-D113`). What used to
// be `applyStanding` + `withWorkspaceStanding` here — the read, the fresh
// object, the `$setAuth`, and the ordering against junction's own scoping hook
// — is all of it gone.
//
// Two readers of the result, and they are not the same reader:
//
//   the hooks below      read the membership row and answer 403 with a
//                        sentence naming the role you would need.
//   @@gate + tenancy     read `memberRole` and `workspaceId` off the PRINCIPAL,
//                        at the Data boundary — which is where Invariant 6 says
//                        access is decided, and which covers every path a hook
//                        does not: a job calling a service in-process, a custom
//                        method nobody wired a role hook onto, a query built by
//                        hand in a method.

/** The membership row the resolver parked, for a hook that needs the rest of
 *  it. `null` where the caller named no workspace or belongs to none. */
export function memberOf(ctx: ServiceContext): MemberRow | null {
  return (ctx.locals[MEMBERSHIP] as MemberRow | undefined) ?? null
}

/** The caller's role in the workspace this request is for. */
export function roleOf(ctx: ServiceContext): string | undefined {
  return memberOf(ctx)?.role as string | undefined
}

/**
 * Re-resolve the standing against a DIFFERENT workspace, mid-call.
 *
 * One caller: the workspaces service, where the workspace IS the id being
 * addressed. The request's own resolution ran against `X-Workspace-Id` — the
 * workspace the UI is currently showing — and that is a different workspace
 * from the one being renamed or left whenever a person acts on one from a list.
 * Without this an admin of the workspace they are LOOKING AT would carry
 * ADMINISTRATOR(5) into a patch of any other workspace they can name.
 *
 * A no-op where the caller is not a member: no claim, which the gate grades a
 * visitor and tenancy answers nothing for — the same shape as naming a
 * workspace you do not belong to on the way in.
 */
export async function restandingFor(
  app:         BasecampApp,
  ctx:         ServiceContext,
  workspaceId: string,
): Promise<MemberRow | null> {
  const user = userOf(ctx)
  if (!user?.userId) return null

  const sys: any = app.db.asSystem()
  const member: MemberRow | null = await sys.workspaceMember.findFirst({
    where:   { workspaceId, userId: user.userId },
    include: { workspace: true },
  })

  ctx.locals[MEMBERSHIP]   = member
  ctx.locals.workspaceId   = workspaceId

  applyClaims(ctx, app.db, member
    ? { workspaceId, memberRole: member.role }
    : {})

  return member
}

// ─── scopeToWorkspace ────────────────────────────────────────────────────
// Verifies the authenticated user is a member of the requested workspace, and
// turns *not a member* into a SENTENCE.
//
// Tenancy already makes a non-member's reads answer nothing and their writes be
// refused, which is correct and is not an explanation. This hook exists so the
// screen says why. The membership row is already in hand — `membershipClaim()`
// resolved it once for this request and parked it.

export function scopeToWorkspace(app: BasecampApp): Hook {
  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    const member = memberOf(ctx)

    if (!member) throw new Forbidden('You are not a member of this workspace')

    // Suspension is enforced HERE, not in each service, because this is the one
    // hook every workspace-scoped service already runs — nineteen of the
    // twenty. A suspended workspace that only looked suspended on the hub
    // screen would be a button that reports success and revokes nothing.
    //
    // Checked after membership, so a stranger still gets "not a member" rather
    // than learning that a workspace they cannot see is suspended.
    if (member.workspace?.status === 'suspended')
      throw new Forbidden('This workspace is suspended. Ask a system administrator to restore it.')
  }
}

// ─── requireWorkspaceRole ────────────────────────────────────────────────
// Enforces a minimum role level in the current workspace.
//
// Role hierarchy: viewer(1) = billing(1) < developer(2) < admin(3) < owner(4)
//
// A SECOND ladder, and it is not the gate's. This one exists to answer with a
// sentence — *requires admin or owner role in this workspace (you have:
// developer)* — which a 403 out of the Data boundary cannot say, since @@gate
// knows levels and not the words a person picked in a members screen. It is
// derived from the same WorkspaceMember row, so the two cannot disagree about
// WHO the caller is; they can only differ in what they say when refusing.
//
// Reads the membership row `membershipClaim()` already resolved — no extra query.

const ROLE_LEVEL: Record<string, number> = {
  viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4,
}

export function requireWorkspaceRole(app: BasecampApp, ...roles: string[]): Hook {
  const minLevel = Math.min(...roles.map(r => ROLE_LEVEL[r] ?? 99))

  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    // No re-read: the request's own resolution already ran against this
    // workspace, and the one case where a service addresses a DIFFERENT one
    // calls `restandingFor` before this hook sees it.
    const role = roleOf(ctx)

    const userLevel = ROLE_LEVEL[role ?? ''] ?? 0
    if (userLevel < minLevel)
      throw new Forbidden(
        `Requires ${roles.join(' or ')} role in this workspace (you have: ${role ?? 'none'})`
      )
  }
}

// ─── refuseGrantAboveOwn ─────────────────────────────────────────────────
// Nobody hands out authority they do not hold themselves.
//
// `WorkspaceMember.role` is the column every gate in this app is graded from
// (core/gate.ts) and `WorkspaceMember.capabilities` is the grid beside it
// (core/capabilities.ts), so a method that writes either is a method that
// writes standing. `requireWorkspaceRole(app, 'admin', 'owner')` answers *may
// you manage the team* and has nothing to say about WHAT is being handed out,
// so an administrator could name `role: 'owner'` — on somebody else's
// membership, or on an invitation to an address they own and can then sign in
// as. Either way level 5 mints level 6, which is `FJS-410` by a second door.
//
// ─── Two axes, because authority has two ─────────────────────────────────
//
// This compared `ROLE_LEVEL[granted] > ROLE_LEVEL[mine]` and nothing else for
// most of its life, and an ordinal comparison cannot see a SIDEWAYS move:
// `billing` and `developer` are both READER-and-above on one axis while *reads
// everything, writes only billing* and *apps, deploys, jobs* are two sets
// neither of which contains the other. A developer therefore passed while
// granting authority that is not a subset of their own (`FJS-529`).
//
// The subset rule is what sees that, and it does not REPLACE the ladder — it
// sits beside it, the same way the grid sits beside the gate (`FJS-D146`).
// Neither axis subsumes the other here, and the proof is in this app: `admin`
// and `owner` hold the same grid, because what separates them is the WORKSPACE
// (delete it, remove the last administrator) and that is the gate's business.
// So a subset test cannot tell an admin minting an owner from an admin
// appointing an admin, which is the original `FJS-410` escalation. Drop either
// check and a real refusal goes with it — measured, in the suite, both ways.
//
// ─── Why it is here and not at the Data boundary ─────────────────────────
//
// All three writers go through `asSystem()` — a membership decides access, so
// it cannot be read through the caller it is deciding about — and `asSystem()`
// has no principal at all, so *what you hold* is undefined there rather than
// merely skipped. `WorkspaceMember.capabilities` carries the column guard
// litestone puts on a `Capability[]`, and that guard covers every OTHER door:
// a job, a hub screen, `fli tinker`. This covers the one a person walks
// through. Measured, not assumed.
//
// Equal is allowed: an admin appointing an admin is what the role is for. It is
// the step OUTWARD that nobody may take on their own authority.
//
// Registered per method rather than on `all` — `role` is a word two other
// models use (a Server has one), and a hook that grades every payload carrying
// the key would refuse a fleet write for holding the wrong kind of role.

export function refuseGrantAboveOwn(): Hook {
  return (ctx: ServiceContext): void => {
    const data = (ctx.data ?? {}) as Record<string, unknown>

    // No membership is `requireWorkspaceRole`'s refusal, and `asSystem()` paths
    // (setup, the hub) run no hooks at all.
    const mine = roleOf(ctx)
    if (!mine) return

    // ── the ladder ──────────────────────────────────────────────────────
    // Kept, and it is not redundant with the set rule below. What separates
    // `owner` from `admin` in this app is the WORKSPACE — delete it, remove the
    // last administrator — which is the gate's business, so the two roles hold
    // the SAME grid and a subset test cannot tell them apart. An admin handing
    // out `owner` is an escalation the grid is blind to, exactly as a sideways
    // grant is one the ladder is blind to. Two axes, both checked.
    const granted = data.role
    // Absent or malformed is not this hook's refusal: each caller runs the
    // vocabulary through its own `toRole()`, which names the legal values.
    if (typeof granted === 'string' && granted in ROLE_LEVEL) {
      if (ROLE_LEVEL[granted]! > (ROLE_LEVEL[mine] ?? 0))
        throw new Forbidden(
          `You cannot grant the ${granted} role — you hold ${mine}. Ask an owner of this workspace.`
        )
    }

    // ── the grid ────────────────────────────────────────────────────────
    // `ROLE_LEVEL` is ordinal, and an ordinal comparison cannot see a SIDEWAYS
    // move: `billing` and `developer` are peers on the ladder while *reads
    // everything, writes only billing* and *apps, deploys, jobs* are two sets
    // neither of which contains the other, so a developer passed the check
    // above while granting authority that is not a subset of their own
    // (`FJS-529`). The subset rule is exact and needs no ladder: may you grant
    // it → do you hold it.
    //
    // Both spellings a payload can use are graded here — a role, which is
    // shorthand for the set it stands for, and capabilities named directly —
    // so the two cannot drift.
    const held   = new Set(grantsFor(mine))
    const wanted = new Set<string>()
    if (typeof granted === 'string' && granted in ROLE_LEVEL)
      for (const c of grantsFor(granted)) wanted.add(c)
    if (Array.isArray(data.capabilities))
      for (const c of data.capabilities) wanted.add(String(c))

    const over = grantsWithin(wanted, held)
    if (!over.length) return

    // The sentence names what is being reached for rather than the two roles:
    // with a sideways grant the roles are the confusing half, because *you hold
    // developer and cannot grant billing* reads as a mistake about seniority.
    throw new Forbidden(
      `You cannot grant ${over.slice(0, 3).map(c => `'${c}'`).join(', ')}` +
      `${over.length > 3 ? ` and ${over.length - 3} more` : ''} — you do not hold ` +
      `${over.length === 1 ? 'it' : 'them'} yourself. Ask an owner of this workspace.`
    )
  }
}

// ─── internalOnly ────────────────────────────────────────────────────────
// A method the ENGINE calls and a person does not.
//
// A job handler has to reach the rows its run is about, and the four models it
// writes — `DeploymentStep`, `JobRun`, `RecipeRun`, `CleanupRun` — are gated at
// SYSTEM for update (`@@gate("2.4.8.8")`, `2.8`). That is the schema saying a
// run's OUTCOME is written by the machine and not by the person who asked for
// it, so no standing a workspace can grant reaches them: `owner` is 6.
//
// So the write stays `asSystem()` and what moves is the REFUSAL. A method
// carrying this hook reads its parent through the caller's own client first,
// which is what confines the write to the tenant the job was queued for; and
// this hook is what keeps that method off the wire, because `methods:` is one
// list and a name in it is served to every transport (junction answers 405 to
// a name left out, in-process included, so an unlisted method cannot be called
// at all).
//
// `ctx.transport` is `'internal'` for an in-process call and names the wire
// otherwise — measured, not assumed.

export function internalOnly(): Hook {
  return (ctx: ServiceContext): void => {
    if (ctx.transport !== 'internal') throw new NotFound('Not found')
  }
}

// ─── requireSystemAdmin ──────────────────────────────────────────────────
// The hub tier. One hook, one service — deliberately not a role a workspace
// can grant.
//
// It reads `isSystemAdmin` off the session, which core/session-auth.ts puts
// there from the User column of the same name. That name is the one
// sessionGateLevel() grades SYSADMIN(7) on, so this hook and the @@gate that
// eventually replaces it are asking the same question of the same field.
//
// 404, not 403: the hub is not a screen a workspace member is being refused,
// it is a surface they have no business knowing exists. Same reason the
// workspaces service answers 404 for a workspace you are not in.

export function requireSystemAdmin(): Hook {
  return (ctx: ServiceContext): void => {
    authenticate(ctx)
    if (userOf(ctx)?.isSystemAdmin !== true) throw new NotFound('Not found')
  }
}

// ─── sessionScope ────────────────────────────────────────────────────────
// authenticate + requireWorkspace + scopeToWorkspace as one named hook, with
// an escape hatch for methods that are not called by a person.
//
// This exists because `before: { all: [authenticate, ...] }` applies to EVERY
// method, outpost endpoints included. servers.heartbeat carried a comment saying
// it was exempt ("HMAC auth at Conduit transport level — no session hook")
// while sitting behind that `all`, so the outpost could never check in: every
// heartbeat 401'd. A comment is not an exemption.

export function sessionScope(app: BasecampApp, opts: { except?: string[] } = {}): Hook {
  const except = new Set(opts.except ?? [])
  const workspace = requireWorkspace()
  const scope     = scopeToWorkspace(app)

  return async (ctx: ServiceContext): Promise<void> => {
    if (except.has(ctx.method)) return
    authenticate(ctx)
    workspace(ctx)
    await scope(ctx)
  }
}

// ─── workspaceChannel ────────────────────────────────────────────────────
// Returns the channel publish target for the current workspace — the value a
// service DECLARES, never a hook it runs:
//
//   createService({ name: 'apps', model: 'App', channel: workspaceChannel(app) })
//
// It was `after: { all: [publishToChannels(workspaceChannel(app))] }` on all
// seventeen services, and `all` means all: a `find` broadcast every row it had
// just read to every browser in the workspace (FJS-031). Junction decides what
// to announce in one place — `callService` — and that place excludes reads by
// name, which no per-service hook list can do for itself. Declaring both is
// refused at construction rather than broadcasting twice.

export function workspaceChannel(app: BasecampApp): import('@frontierjs/junction').PublishFn {
  return (_data, ctx) => {
    const wsId    = ctx.locals.workspaceId as string | undefined
    if (!wsId) return null
    // Typed as what a PublishFn may answer, rather than `unknown`: the manager
    // is reached through a cast because `app.channels` is the plugin's, and a
    // cast that lands on `unknown` makes the return type unassignable to the
    // very signature this function declares.
    type Channel  = ReturnType<import('@frontierjs/junction').PublishFn> & object
    const manager = channelManager(app) as { channel: (name: string) => Channel } | undefined
    if (!manager?.channel) return null
    return manager.channel(workspaceChannelName(wsId))
  }
}

// ─── requireOutpostSignature ─────────────────────────────────────────────────
// The three endpoints an OUTPOST calls, and the only ones exempted from
// `sessionScope`: `servers.heartbeat`, `volumes.report`, `cleanup.report`. A
// machine holds no session, so those exemptions are right — what was missing is
// the credential that replaces one.
//
// Until 2026-08-19 there was none. The comment beside the exemption said the
// request was *HMAC-authenticated at the transport*, and no such verification
// existed anywhere in the repo: conduit signs what it SENDS and nothing checked
// what arrived. Measured — a POST carrying nothing but `X-Service-Method:
// heartbeat` answered 200, moved a server to `online`, and registered the
// Conduit target `outpost:<serverId>` at an address the caller chose, which
// points every later `/exec`, `/deploy` and `/system/prune` for that machine at
// a host the caller owns, signed with this app's own secret (`FJS-349`).
//
// The scheme is `@frontierjs/toolbelt/signature` — the same module conduit signs
// with, so this cannot be a second reading of it. What it needs from the
// request is the body as BYTES, which junction now carries as
// `ctx.$raw.rawBody`: re-serializing `ctx.data` to hash it would mean both sides
// agreeing on key order and spacing forever.
//
// One secret for the fleet (`OUTPOST_SECRET`), which is what conduit already
// signs outbound with. The limit is worth stating: a machine that is compromised
// can forge any other machine's check-in. Per-server secrets need a mint and a
// hand-over at install time — ring 1 in `IDEAS/deploy-plane.md`, which is not
// built.
//
// Replay protection is the app's own database and therefore survives a restart
// and is shared between replicas (`OutpostNonce`, `FJS-376`). It used to be a
// module-level Map, which was neither.

/**
 * Has this nonce been spent inside the freshness window — and claim it if not.
 *
 * The store is `OutpostNonce`, a table, because replay protection is only as
 * good as the memory behind it and this used to be a module-level `Map`: per
 * PROCESS, so two replicas each held their own set and a request captured at
 * one replayed at the other passed, while a restart forgot everything still
 * inside the window (`FJS-376`).
 *
 * **The claim is the INSERT.** Asking whether the row exists and then writing
 * it is a race between exactly the two replicas this exists for — both would
 * find it absent. `nonce` is the primary key, so a duplicate is refused by
 * SQLite atomically and that refusal IS the replay.
 *
 * Anything OTHER than a key collision propagates. Reporting a broken database
 * as *replayed* would refuse the request, which is the safe direction, and it
 * would also hide the breakage behind a 401 that reads as a caller's problem.
 *
 * Swept on write rather than on a timer: no clock to own, and the table only
 * grows while signed requests are arriving.
 */
async function rememberNonce(app: BasecampApp, nonce: string, windowMs: number): Promise<boolean> {
  const sys    = app.db.asSystem() as any
  const cutoff = new Date(Date.now() - windowMs).toISOString()

  await sys.outpostNonce.deleteMany({ where: { seenAt: { lt: cutoff } } })

  try {
    await sys.outpostNonce.create({ data: { nonce } })
    return false
  } catch (err) {
    if ((err as { name?: string }).name === 'UniqueConflictError') return true
    throw err
  }
}

/** The raw search string of a request URL, `''` when there is none or it will not parse. */
function searchOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).search } catch { return '' }
}

export function requireOutpostSignature(app: BasecampApp, { only = [] }: { only?: string[] } = {}): Hook {
  const guarded = new Set(only)
  const TOLERANCE_S = 300

  return async (ctx: ServiceContext): Promise<void> => {
    if (!guarded.has(`${ctx.service}.${ctx.method}`)) return

    // `env`, not `process.env`: this app's env module is where a default is
    // applied and a too-short value is refused at boot, and reading the raw
    // variable answers undefined for every developer running the default —
    // which this hook would report, correctly and uselessly, as *no secret is
    // configured on this side*.
    const secret = env.OUTPOST_SECRET
    const raw    = (ctx as {
      $raw?: {
        rawBody?: string
        headers?: Record<string, string>
        method?:  string
        path?:    string
        $raw?:    { url?: string }
      }
    }).$raw

    // Fail closed, and say which half is missing. An in-process call has no
    // `$raw` at all — the jobs call these methods through the app — so this
    // refuses those too rather than letting the absence of a transport read as
    // permission. An app that needs to write a heartbeat for itself uses the
    // system client, not this door.
    if (!raw) throw new BadRequest(`${ctx.service}.${ctx.method} is the outpost's endpoint and is only reachable over HTTP`)

    const result = await verifyRequest({
      secret,
      method:    raw.method ?? 'POST',
      path:      raw.path ?? '',
      // The query is part of the canonical string since `FJS-678`, and it is
      // read off the RAW url rather than off `ctx.$raw.query`, which is the
      // PARSED bag — a signature is over the bytes the sender put on the wire,
      // and a re-serialization of a parsed query is a different string.
      query:     searchOf(raw.$raw?.url),
      body:      raw.rawBody ?? '',
      headers:   raw.headers ?? {},
      toleranceSeconds: TOLERANCE_S,
      // The clock is this side's, stated: the kit is pure and takes no ambient
      // state, which is what lets litestone and mesa import it.
      now:       Math.floor(Date.now() / 1000),
      seenNonce: (n: string) => rememberNonce(app, n, TOLERANCE_S * 1_000),
    })

    if (!result.ok) {
      // The reason is logged and never returned: a caller learns that the
      // signature was refused, not whether the clock or the secret was wrong.
      app.logger.warn('outpost signature refused', {
        service: ctx.service, method: ctx.method, reason: result.reason,
      })
      throw new Unauthorized('This endpoint requires a signed outpost request')
    }
  }
}

// ─── The application audit trail ──────────────────────────────────────────────
// Two hooks, because a diff needs a before and an `after` hook has only the
// after. `basecampAuditPreImage` goes in the app's `before: { all }` and
// `basecampAuditLog` in its `after: { all }`; both take the same exceptions and
// both ask `recordable()` so they cannot disagree about what counts.
//
// Failures are swallowed — an audit write must never break the request.
//
// `except` is `service.method` names that mutate but must not be recorded. The
// entries today are outposts on a timer: fifty machines reporting every minute
// would bury every action a person took. It is deliberately NOT
// `ctx.dispatch = false` — that would also silence the channel, and the live
// status pill on the server screen is fed by exactly that publish.

/** What counts as a recordable mutation. Decided once, asked by both hooks. */
function recordable(ctx: ServiceContext, skip: Set<string>): boolean {
  if (skip.has(`${ctx.service}.${ctx.method}`)) return false
  // What counts as a mutation is decided the same way Junction decides what to
  // announce on a channel: everything except `find`/`get`, and a read-shaped
  // custom method opts out with `ctx.dispatch = false`.
  //
  // It used to be a literal `['create','patch','remove']`, which meant the
  // trail recorded a server being CREATED and not a server being DRAINED —
  // and drain, cancel, deploy, trigger and heartbeat are most of what an
  // operator actually does here. An audit trail that misses the verbs is
  // worse than none, because it reads as complete.
  if (ctx.method === 'find' || ctx.method === 'get') return false
  if (ctx.dispatch === false) return false
  return true
}

/** The litestone accessor for a service's model. Model names are PascalCase
 *  singular by repo invariant, and the accessor is the same word with a lower
 *  first letter — `model App` is `db.app`.
 *
 *  Read off `app.services`, the REGISTRY, and not off `app.service(name)`:
 *  that answers a ServiceCaller — the thing you make calls with — which
 *  carries no `model` at all, so asking it produced `undefined` and every
 *  audit row was written with no diff and nothing saying why. */
function accessorFor(app: BasecampApp, service: string): string | null {
  const registry = (app as unknown as { services?: { get?: (n: string) => { model?: string } | undefined } }).services
  const model    = registry?.get?.(service)?.model
  if (!model) return null
  return model[0].toLowerCase() + model.slice(1)
}

// A value written into `AuditEvent.diff`. Long text is cut, because a trail row
// is read on a screen and a 40KB script pasted into a recipe would push every
// other field off it — the point of a diff entry is that something changed and
// what it changed to, not a second copy of the column.
const DIFF_VALUE_LIMIT = 500

function diffValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return v.length <= DIFF_VALUE_LIMIT ? v : `${v.slice(0, DIFF_VALUE_LIMIT)}… +${v.length - DIFF_VALUE_LIMIT} chars`
}

/**
 * What changed, field by field: `{ field: { before, after } }`.
 *
 * `protectedFields` comes from `db.$protectedFields(accessor)` — litestone's
 * own reading of the schema, never a list written down here, which is the whole
 * reason that capability exists. A protected column still appears (that it
 * changed is the fact an operator needs) and its values never do.
 */
function diffRows(
  before:    Record<string, unknown> | null,
  after:     Record<string, unknown> | null,
  protectedFields: Record<string, string>
): Record<string, unknown> | null {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const diff: Record<string, unknown> = {}

  for (const key of keys) {
    // `updatedAt` moves on every single write and says nothing about what the
    // write did. The audit row carries its own timestamp.
    if (key === 'updatedAt') continue

    const from = before?.[key]
    const to   = after?.[key]
    // JSON compare, not ===: `config` and `labels` are Json columns and come
    // back as fresh objects, so identity would report every one of them as
    // changed on every write.
    if (JSON.stringify(from) === JSON.stringify(to)) continue

    diff[key] = protectedFields[key]
      ? { before: from === undefined ? undefined : '[redacted]', after: to === undefined ? undefined : '[redacted]' }
      : { before: diffValue(from), after: diffValue(to) }
  }

  return Object.keys(diff).length ? diff : null
}

/**
 * The BEFORE half. Reads the row as it stands and parks it on `ctx.locals`,
 * which is per-call and does not propagate — a nested service call gets its own
 * pre-image rather than inheriting the outer one's.
 *
 * asSystem(): the trail must be able to describe a change the caller could not
 * read for themselves, and a scoped read would silently answer nothing for a
 * row a policy hides — which reads as "nothing changed", the one wrong answer.
 */
export function basecampAuditPreImage(app: BasecampApp, { except = [] }: { except?: string[] } = {}): Hook {
  const skip = new Set(except)

  return async (ctx: ServiceContext): Promise<void> => {
    if (!recordable(ctx, skip)) return
    // No id is `create` and the bulk paths: there is nothing there yet to read.
    if (ctx.id === undefined || ctx.id === null) return

    try {
      const accessor = accessorFor(app, ctx.service as string)
      if (!accessor) return
      const db  = app.db.asSystem() as any
      const row = await db[accessor]?.findUnique?.({ where: { id: ctx.id } })
      if (row) (ctx.locals as Record<string, unknown>).auditBefore = row
    } catch {
      // A model with no such accessor, or a read that failed — the trail then
      // records the action with no diff, which is what it did before this
      // existed. Never the request's problem.
    }
  }
}

export function basecampAuditLog(app: BasecampApp, { except = [] }: { except?: string[] } = {}): Hook {
  const skip = new Set(except)

  return async (ctx: ServiceContext): Promise<void> => {
    if (!recordable(ctx, skip)) return

    // Two result shapes reach here. CRUD answers the envelope, so the row is
    // under `.data`; a custom method answers the row itself. Reading only the
    // first recorded every action against subjectId 'unknown', which is a trail
    // entry that cannot be joined back to the thing it happened to.
    const raw     = ctx.result as Record<string, unknown> | null
    const result  = (raw?.data as Record<string, unknown> | undefined) ?? raw
    const session = userOf(ctx)
    const before  = (ctx.locals as Record<string, unknown>).auditBefore as Record<string, unknown> | null ?? null

    try {
      const sys = app.db.asSystem() as any

      // What changed. `AuditEvent.diff` was `Json?` and nothing wrote it, so
      // the trail could say a server was drained and not what state it was in
      // (FJS-154). A remove has a before and no after; a create the reverse.
      let diff:     Record<string, unknown> | null = null
      let subject:  Record<string, unknown> | null = null
      let accessor: string | null = null
      try {
        accessor = accessorFor(app, ctx.service as string)
        if (accessor) {
          // Both sides are read the same way, through the system client, and
          // the after side is RE-READ rather than taken from `ctx.result`. Two
          // reasons, and the second is the one that bites: a service is free to
          // answer a projection, and a scoped read strips every protected
          // column — so a patch that changed an `@encrypted` value produced a
          // before with the field and an after without it, which is the diff
          // for a column that was REMOVED. Redaction is then applied on
          // purpose, to both sides, rather than falling out of what the caller
          // happened to be allowed to see.
          const id    = (result?.id as string | undefined) ?? (before?.id as string | undefined) ?? (ctx.id as string | undefined)
          const after = ctx.method === 'remove' || id === undefined
            ? null
            : await sys[accessor]?.findUnique?.({ where: { id } }) ?? result ?? null
          subject = after ?? before
          diff = diffRows(before, after, sys.$protectedFields(accessor))
        }
      } catch {
        // A diff that cannot be computed is a diff that is not written. The
        // action is still recorded, which is the half that was already true.
      }

      // Whose workspace, and a null here is a claim rather than a shrug: it says
      // this row belongs to NO workspace and only the hub may read it
      // (`FJS-D141`). `ctx.locals.workspaceId` is set by sessionScope, so a
      // method that legitimately runs outside it wrote null and meant nothing
      // by it — `jobs.startRun`/`finishRun` are `internalOnly()` and exempt
      // from the scope hook, and filed twelve runs of a workspace's own `Job`
      // under nobody, where its own feed can never show them. So the subject's
      // own column answers second, and a Workspace is its own workspace.
      const subjectWorkspace = (subject?.workspaceId as string | undefined)
        ?? (accessor === 'workspace' ? subject?.id as string | undefined : undefined)

      // `Session` here is the generated ROW type, which knows nothing about the
      // principal junction builds — `support` lives on `SessionContext`.
      const support = (session as { support?: { operatorId?: string } } | undefined)?.support

      // asSystem(): the trail must record actions the actor could not write
      // for themselves. AuditEvent create is a system-only concern.
      await sys.auditEvent.create({
        data: {
          workspaceId: (ctx.locals.workspaceId as string | undefined) ?? subjectWorkspace ?? null,
          // Support mode inverts the actor. Inside an episode the session
          // resolves to the SUBJECT — that is what bounds an operator at the
          // subject's own standing — so `session.userId` answers who the write
          // was made AS and nobody answers who made it. Filing it under the
          // person it was done to is `FJS-142`'s complaint stated exactly, and
          // is what Laravel Nova does today.
          actorId:     support?.operatorId ?? session?.userId ?? null,
          ...(support ? { onBehalfOfId: session?.userId } : {}),
          // No session is not an anonymous user — it is a job or an
          // outpost acting for itself. `AuditEvent.actorType` defaults to 'user',
          // so leaving it unstated would file every machine write under people.
          actorType:   session
            ? (support ? 'support' : session.authMethod === 'api_key' ? 'api_key' : 'user')
            : 'system',
          action:      `${ctx.service}.${ctx.method}`,
          subjectType: ctx.service,
          subjectId:   (result?.id as string | undefined) ?? (before?.id as string | undefined) ?? 'unknown',
          ...(diff ? { diff } : {}),
        },
      })
    } catch {
      // Intentionally swallowed — the audit write must never break the request.
      // Note this is the APPLICATION trail; @@log(audit) captures row-level
      // changes separately and does not depend on this hook running.
    }
  }
}

// ─── getPagination ───────────────────────────────────────────────────────
// `$limit` / `$offset` are TRANSPORT syntax. The bridge parses them off the
// query string and puts them on ctx.directives; nothing past the bridge ever
// sees a `$` (Invariant 10). ctx.query is filters only, so the old
// `q.$limit ?? ctx.$raw.query.$limit` chain read fields that are never there.
// ctx.query.limit is still honored for internal callers that pass it plainly.

export function getPagination(
  defaults: { limit?: number; max?: number } = {}
): { limit: number; offset: number; after?: string } {
  const q = $.query as Record<string, unknown>
  const d = ($.directives ?? {}) as { limit?: number; offset?: number; after?: string }

  const limit  = Math.min(
    parseInt(String(d.limit ?? q.limit ?? defaults.limit ?? 20), 10),
    defaults.max ?? 200
  )
  const offset = parseInt(String(d.offset ?? q.offset ?? 0), 10)

  return {
    limit:  isNaN(limit)  ? (defaults.limit ?? 20)  : Math.max(1, limit),
    offset: isNaN(offset) ? 0 : Math.max(0, offset),
    // `$after` is the third thing a caller can ask for and it is one of these,
    // not a filter: a hand-written find that reads limit and offset and drops
    // the cursor answers page one to every press of "load more" (`FJS-D145`).
    after:  typeof d.after === 'string' && d.after !== '' ? d.after : undefined,
  }
}
