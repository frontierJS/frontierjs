// src/core/hooks.ts
// Basecamp-specific hooks — used across Basecamp services.
// Framework hooks (authenticate, requireRole, etc.) imported from '@frontierjs/junction'.

import { BadRequest, Forbidden, NotFound, Unauthorized, MEMBERSHIP, signedRequest, $ } from '@frontierjs/junction'
import { authenticate } from '@frontierjs/junction/hooks'
import type { Hook, ILogger, ServiceContext, CredentialVerifier, InboundRequest }  from '@frontierjs/junction'
import { actsAsApp } from './gate.ts'
import { workspaceChannelName }       from './channels.ts'
import type { BasecampDb }                 from './db.ts'
import { grantsFor, grantsWithin }         from './capabilities.ts'

// ─── The session ─────────────────────────────────────────────────────────
// Junction puts the caller on ctx.user as a SessionContext — camelCase
// (id, authMethod), not the snake_case user_id these hooks used to read.
// Every one of those reads was undefined, which is why role checks silently
// passed for everyone.

interface Session {
  id?: string; authMethod?: string; workspaceId?: string
  // Put here by @frontierjs/auth for a caller holding an API key.
  credentialId?: string
  // Put here by basecampSessionFields (core/session-auth.ts) off this app's own
  // User columns, not by @frontierjs/auth.
  isSystemAdmin?: boolean; status?: string; kind?: string
  // Put here by applyStanding() below, per request, off the WorkspaceMember row
  // for the workspace being addressed. Never a column on `user`.
  memberRole?: string
}

interface MemberRow { role?: string; capabilities?: string[] | null; workspace?: { status?: string } }

function userOf(ctx: ServiceContext): Session | undefined {
  return ctx.user as Session | undefined
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
 * Headers live on ctx.caller.headers — Junction splits the context into
 * auth / client / route / locals. There is NO ctx.params: the previous version
 * read ctx.params.headers and wrote ctx.params.workspace_id, and both threw
 * "undefined is not an object" on the first call.
 */
export function resolveWorkspaceId(ctx: ServiceContext): string | undefined {
  return (ctx.caller?.headers?.['x-workspace-id'] as string | undefined) ||
         (ctx.reserved?.workspace_id as string | undefined)              ||
         (userOf(ctx)?.workspaceId as string | undefined)
}

/** The service whose id names its workspace. Its `name:` reads this, so a
 *  rename cannot leave `workspaceOrKeys` grading the header in silence. */
export const WORKSPACES_SERVICE = 'workspaces'

/**
 * `tenantFrom` for the principal resolver: the workspace the request names,
 * else the one an API key belongs to.
 *
 * A key is bound to one workspace — `apiKeyGuard` refuses it anywhere else — so
 * a key naming none can only mean its own. Without this, every key caller had
 * to send `X-Workspace-Id` with an id it could not be told, and a CLI signed in
 * with one was refused on its first command for naming nothing (`FJS-D399`).
 * A session still names its workspace: a person belongs to several.
 *
 * The workspaces service is the one whose subject IS the tenant, so there the
 * id names it and the header does not. The header is the workspace on screen,
 * and grading against it carried an admin of the workspace a person was LOOKING
 * AT into a patch or a roster write on any other they could name (`FJS-2858`).
 * Answered here because the gate reads the level this resolves, and the gate
 * runs before every hook.
 */
export async function workspaceOrKeys(ctx: ServiceContext): Promise<string | undefined> {
  if (ctx.service === WORKSPACES_SERVICE && ctx.id != null) return String(ctx.id)
  const named = resolveWorkspaceId(ctx)
  const user  = userOf(ctx)
  if (named || user?.authMethod !== 'apiKey' || !user.credentialId) return named
  const db  = $.db as { asSystem(): any } | undefined
  const key = await db?.asSystem().apiKey.findFirst({ where: { credentialId: user.credentialId }, select: { workspaceId: true } })
  return key?.workspaceId ?? undefined
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
  return function requireWorkspace(ctx: ServiceContext): void {
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
 * A protected environment is the production guard: a developer may deploy to
 * it but not reshape it — its own columns, or the variables set on it.
 *
 * The rule is the schema's — `Environment` and `Variable` each `@@deny` a caller
 * under level 5 — and it holds for every writer. A policy FILTERS an update and
 * a delete, so a developer reaching it unhooked gets a 200 and no change; this
 * is the sentence for the two services a person reaches it through (`FJS-1087`,
 * `FJS-2354`).
 */
export function refuseProtectedForDeveloper(env: { isProtected?: boolean }, ctx: ServiceContext) {
  if (env.isProtected && roleOf(ctx) === 'developer')
    throw new Forbidden('Protected environments require admin or owner role to modify')
}

// ─── scopeToWorkspace ────────────────────────────────────────────────────
// Verifies the authenticated user is a member of the requested workspace, and
// turns *not a member* into a SENTENCE.
//
// Tenancy already makes a non-member's reads answer nothing and their writes be
// refused, which is correct and is not an explanation. This hook exists so the
// screen says why. The membership row is already in hand — `membershipClaim()`
// resolved it once for this request and parked it.

export function scopeToWorkspace(): Hook {
  return async function scopeToWorkspace(ctx: ServiceContext): Promise<void> {
    const userId      = userOf(ctx)?.id
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || actsAsApp(userOf(ctx)) || !workspaceId) return

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
// A SECOND ladder, and it is not the gate's. The sentence a person needs —
// *Requires admin role in this workspace* — is app.ts's error mapper turning
// the gate's two numbers back into a role, so a method needs no hook once a
// gate grades it: the model's `@@gate` where it writes through the caller's own
// client, a `gate:` in `methods:` where it writes through `asSystem()` or acts
// on a machine or a provider first. This one is for what no gate grades yet.
//
// Reads the membership row `membershipClaim()` already resolved — no extra query.

const ROLE_LEVEL: Record<string, number> = {
  viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4,
}

export function requireWorkspaceRole(...roles: string[]): Hook {
  const minLevel = Math.min(...roles.map(r => ROLE_LEVEL[r] ?? 99))

  return async function requireWorkspaceRole(ctx: ServiceContext): Promise<void> {
    const userId      = userOf(ctx)?.id
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || actsAsApp(userOf(ctx)) || !workspaceId) return

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
// writes standing. `requireWorkspaceRole('admin', 'owner')` answers *may
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
// a job, a hub screen, `fli db:repl`. This covers the one a person walks
// through. Measured, not assumed.
//
// Equal is allowed: an admin appointing an admin is what the role is for. It is
// the step OUTWARD that nobody may take on their own authority.
//
// Registered per method rather than on `all` — `role` is a word two other
// models use (a Server has one), and a hook that grades every payload carrying
// the key would refuse a fleet write for holding the wrong kind of role.

export function refuseGrantAboveOwn(): Hook {
  return function refuseGrantAboveOwn(ctx: ServiceContext): void {
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
// writes — `DeploymentStep`, `JobRun`, `RecipeRun`, `MaintenanceRun` — are gated at
// SYSTEM for update (`@@gate(2.4.8.8)`, `2.8`). That is the schema saying a
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
  return function internalOnly(ctx: ServiceContext): void {
    if (ctx.transport !== 'internal') throw new NotFound('Not found')
  }
}

// ─── requireSystemAdmin ──────────────────────────────────────────────────
// The hub tier. One hook, one service — deliberately not a role a workspace
// can grant.
//
// It reads `isSystemAdmin` off the session, which core/session-auth.ts puts
// there from the User column of the same name. That name is the one
// sessionGateLevel() grades SYSADMIN(7) on, so this hook and the @@gate are
// asking the same question of the same field. The hook stays because a gate
// answers 403: dropping it tells a workspace member the surface exists.
//
// 404, not 403: the hub is not a screen a workspace member is being refused,
// it is a surface they have no business knowing exists. Same reason the
// workspaces service answers 404 for a workspace you are not in.

export function requireSystemAdmin(): Hook {
  return function requireSystemAdmin(ctx: ServiceContext): void {
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

export function sessionScope(opts: { except?: string[] } = {}): Hook {
  const except = new Set(opts.except ?? [])
  const workspace = requireWorkspace()
  const scope     = scopeToWorkspace()

  return async function sessionScope(ctx: ServiceContext): Promise<void> {
    if (except.has(ctx.method)) return
    authenticate(ctx)
    workspace(ctx)
    await scope(ctx)
  }
}

// ─── workspaceChannel ────────────────────────────────────────────────────
// The channel announce target for the current workspace — the value a service
// DECLARES, never a hook it runs:
//
//   createService({ name: 'apps', model: 'App', channel: workspaceChannel })
//
// As `after: { all: [announce(...)] }` it broadcast every `find` to every
// browser in the workspace, because `all` means all (FJS-031). Junction decides
// what to announce in one place — `callService` — and that place excludes reads
// by name, which no per-service hook list can do for itself. Declaring both is
// refused at construction rather than broadcasting twice.
//
// The ROW's workspace first: a write outside any service call -- a job, an
// outpost report, `asSystem()` -- calls this with ctx null, and reading only
// the request's workspace sent it nowhere (`FJS-1741`).
export const workspaceChannel: import('@frontierjs/junction').ChannelFn = (data, ctx) => {
  const row  = (Array.isArray(data) ? data[0] : data) as { workspaceId?: unknown } | null | undefined
  const wsId = (typeof row?.workspaceId === 'string' ? row.workspaceId : undefined)
    ?? ctx?.locals.workspaceId as string | undefined
  return wsId ? workspaceChannelName(wsId) : null
}

// ─── outpostCredential · outpostScope ─────────────────────────────────────────────────
// The three endpoints an OUTPOST calls, and the only ones exempted from
// `sessionScope`: `servers.heartbeat`, `volumes.report`, `cleanup.report`. A
// machine holds no session, so those exemptions are right — what was missing is
// the credential that replaces one. It is `createApp({ credentials })`: the
// transport verifies the signature and the machine becomes a principal
// (`outpostCredential`), and `outpostScope` is the grade that says which
// methods that principal may reach.
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
// `ctx.raw.rawBody`: re-serializing `ctx.data` to hash it would mean both sides
// agreeing on key order and spacing forever.
//
// ─── Which key ───────────────────────────────────────────────────────────
//
// Every machine signs with an Ed25519 pair of its OWN, made at enrollment, and
// this app holds only the public half (`Server.outpostPublicKey`, `FJS-D1604`).
// A provisioned machine enrolls during cloud-init; an imported one runs the
// command `servers.issueEnrollment` prints. A machine that has not enrolled is
// REFUSED — see `outpostKeyFor` below. There is no fleet-wide key: one string
// every machine held let any compromised box forge any other's check-in.
//
// Replay protection is the app's own database and therefore survives a restart
// and is shared between replicas (`OutpostNonce`, `FJS-376`).

/**
 * What the credential reads. It is built BEFORE `createApp` returns — the
 * transport takes its verifiers at construction — so it holds the pieces
 * rather than the app.
 */
type OutpostDeps = { db: BasecampDb, logger: ILogger }

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
async function rememberNonce(app: OutpostDeps, nonce: string, windowMs: number): Promise<boolean> {
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

/** What a machine's principal is named, so the id survives into `ctx.user.id`. */
const OUTPOST_PRINCIPAL = 'outpost:'

/**
 * Which machine is this request about?
 *
 * One entry per outpost endpoint, and a table rather than a header for a
 * reason: the id is already in each of these requests, so a header carrying it
 * again would be a second place it can be wrong and nothing would compare them.
 * A new outpost endpoint adds a row here, and is then graded, signed for and
 * exempted in one place.
 *
 * Asked twice and the two must agree. `fromRequest` runs at the transport,
 * before routing, so it reads the wire — `X-Service-Method`, the path, the
 * body — and names the machine whose key to verify against. `fromCall` runs in
 * the hook pipeline and reads what the router decided. `outpostScope` compares
 * them, which is what stops a path that this table and the router read
 * differently from being signed for one machine and executed for another.
 *
 * `servers.heartbeat` addresses the machine in the path; the two `report`
 * methods carry it in the body as `server_id`, which is the OUTPOST's
 * snake_case contract and not this app's.
 */
const OUTPOST_ENDPOINTS: Record<string, {
  fromRequest: (req: InboundRequest) => string | null
  fromCall:    (ctx: ServiceContext) => string | null
}> = {
  'servers.heartbeat': {
    fromRequest: req => addresses(req, 'heartbeat', 'servers', 2) ? decodeSegment(req.path.split('/').filter(Boolean).at(-1)) : null,
    fromCall:    ctx => (ctx.id as string) ?? null,
  },
  'volumes.report': {
    fromRequest: req => addresses(req, 'report', 'volumes', 1) ? serverIdInBody(req.body) : null,
    fromCall:    ctx => ((ctx.data as { server_id?: string })?.server_id) ?? null,
  },
  'cleanup.report': {
    fromRequest: req => addresses(req, 'report', 'cleanup', 1) ? serverIdInBody(req.body) : null,
    fromCall:    ctx => ((ctx.data as { server_id?: string })?.server_id) ?? null,
  },
  'posture.report': {
    fromRequest: req => addresses(req, 'report', 'posture', 1) ? serverIdInBody(req.body) : null,
    fromCall:    ctx => ((ctx.data as { server_id?: string })?.server_id) ?? null,
  },
}

/**
 * Is this the POST that calls `method` on `service`: the header names the
 * method, and the service is the path segment `fromEnd` back from the end
 * (the last for a collection route, the one before the id for a record route).
 */
function addresses(req: InboundRequest, method: string, service: string, fromEnd: number): boolean {
  if (req.method.toUpperCase() !== 'POST' || req.headers['x-service-method']?.trim() !== method) return false
  return req.path.split('/').filter(Boolean).at(-fromEnd) === service
}

function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null
  try { return decodeURIComponent(segment) } catch { return null }
}

function serverIdInBody(body: string | Uint8Array): string | null {
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body)
    const id   = (JSON.parse(text) as { server_id?: unknown } | null)?.server_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * The public key this machine signs with. `null` is a refusal: a request that
 * names no machine, names one that does not exist, or names one that has not
 * enrolled.
 */
async function outpostKeyFor(
  app: OutpostDeps, serverId: string | null,
): Promise<{ publicKey: string; workspaceId: string } | null> {
  if (!serverId) return null
  const server = await (app.db.asSystem() as any).server.findFirst({ where: { id: serverId } })
  if (!server?.outpostPublicKey) return null
  return { publicKey: server.outpostPublicKey as string, workspaceId: server.workspaceId as string }
}

/**
 * The signature as a credential: the transport asks this before the bearer path
 * and a good one becomes the machine's principal, `outpost:<serverId>`.
 *
 * ONE sentence for every refusal on this door, because *no such machine* and
 * *that signature is wrong* must not be distinguishable from outside — the
 * caller is unauthenticated by definition, and telling the two apart tells them
 * which server ids are real. `REFUSE` answers a bare 401 and the reason is
 * logged, never returned. A request with no signature header is not this
 * credential's and falls through to `outpostScope`, which refuses an outpost
 * endpoint that arrives with no machine behind it.
 */
export function outpostCredential(app: OutpostDeps): CredentialVerifier {
  const TOLERANCE_S = 300

  return signedRequest({
    window: TOLERANCE_S,
    // WHICH machine, then WHICH key — see `outpostKeyFor` above. A null is a
    // refusal and never a fall-through.
    keyFor: async (req) => {
      const serverId = Object.values(OUTPOST_ENDPOINTS).map(e => e.fromRequest(req)).find(Boolean) ?? null
      const keyed    = await outpostKeyFor(app, serverId)
      if (!serverId || !keyed) {
        app.logger.warn('outpost signature refused', {
          path: req.path,
          reason: serverId ? 'that machine is unknown or has not enrolled' : 'the request names no machine',
        })
        return null
      }
      return {
        publicKey: keyed.publicKey,
        // The machine's own workspace rides on the principal: every service is
        // row-scoped and `tenantClaimGuard` refuses a signed-in caller who
        // holds no claim, and nothing here may let it name another one.
        session: { id: `${OUTPOST_PRINCIPAL}${serverId}`, userType: 'service', authMethod: 'outpost', workspaceId: keyed.workspaceId },
      }
    },
    // A throw here reaches the transport as a refusal, so a broken database
    // would read as a caller's bad signature. Logged first, where it can be told apart.
    seenNonce: async (nonce) => {
      try {
        // Twice the tolerance: a timestamp accepted at the limit ahead stays fresh
        // for another full tolerance, and a nonce forgotten sooner replays (FJS-1833).
        return await rememberNonce(app, nonce, 2 * TOLERANCE_S * 1_000)
      } catch (err) {
        app.logger.error('outpost nonce store failed', { error: err instanceof Error ? err.message : String(err) })
        throw err
      }
    },
  })
}

/**
 * The grade on a machine principal, and the only place that decides what it
 * may reach. A signed principal arrives at EVERY service method, so this is the
 * hook that keeps a check-in from being a `servers.drain`.
 *
 *   a machine, anywhere but its own three endpoints   -> 403
 *   a machine, an endpoint naming a different machine -> 401
 *   an outpost endpoint with no machine behind it     -> 401
 *
 * The middle row is the router and `OUTPOST_ENDPOINTS.fromRequest` disagreeing
 * about the same request. An in-process call has no principal and is refused by
 * the last: an app that needs to write a heartbeat for itself uses the system
 * client, not this door.
 */
export function outpostScope(): Hook {
  // One sentence, as in `outpostCredential`.
  const REFUSED = 'This endpoint requires a signed outpost request'

  return function outpostScope(ctx: ServiceContext): void {
    const name     = `${ctx.service}.${ctx.method}`
    const user     = userOf(ctx)
    const endpoint = OUTPOST_ENDPOINTS[name]
    const machine  = user?.authMethod === 'outpost'

    if (!endpoint) {
      if (machine) throw new Forbidden('An outpost may only call its own endpoints')
      return
    }
    const subject = user?.id?.startsWith(OUTPOST_PRINCIPAL) ? user.id.slice(OUTPOST_PRINCIPAL.length) : undefined
    if (!machine || endpoint.fromCall(ctx) !== subject) throw new Unauthorized(REFUSED)
  }
}

// ─── getPagination ───────────────────────────────────────────────────────
// `$limit` / `$offset` are TRANSPORT syntax. The bridge parses them off the
// query string and puts them on ctx.directives; nothing past the bridge ever
// sees a `$` (Invariant 10). ctx.query is filters only: a plain `limit` there
// is a column no model has, and the find's autoFilter refuses it by name.

export function getPagination(
  defaults: { limit?: number; max?: number } = {}
): { limit: number; offset: number; after?: string } {
  const d = ($.directives ?? {}) as { limit?: number; offset?: number; after?: string }

  const limit  = Math.min(Number(d.limit ?? defaults.limit ?? 20), defaults.max ?? 200)
  const offset = Number(d.offset ?? 0)

  return {
    limit:  Number.isNaN(limit)      ? (defaults.limit ?? 20) : Math.max(1, Math.trunc(limit)),
    offset: Number.isFinite(offset)  ? Math.max(0, Math.trunc(offset)) : 0,
    // `$after` is the third thing a caller can ask for and it is one of these,
    // not a filter: a hand-written find that reads limit and offset and drops
    // the cursor answers page one to every press of "load more" (`FJS-D145`).
    after:  typeof d.after === 'string' && d.after !== '' ? d.after : undefined,
  }
}
