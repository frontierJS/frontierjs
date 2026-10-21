// src/services/api-keys/scopes.ts
// What an API key and an agent are allowed to do, and the hooks that hold them
// to it.
//
// Separate from the service because these run at APP level — before any
// service hook, on every request — while the service only serves /api-keys.
// Same file so that declaring a scope and granting one cannot drift: the
// string the screen shows in a checkbox is read off the declarations junction
// refuses by.

import { Forbidden, $ } from '@frontierjs/junction'
import type { App, Hook, ServiceContext } from '@frontierjs/junction'
import { resolveWorkspaceId } from '../../core/hooks.ts'

// ─── The vocabulary ──────────────────────────────────────────────────────
// A scope is `<service>:<read|write>`, declared on each workspace service by
// `keyScope` and refused by junction at the call (`FJS-D916`). What a key may
// be issued is read back off those declarations, so a scope the picker shows
// is one a service names, and a service declaring none is offered to no
// scoped key.

/** Services a key may never reach, whatever it was issued with. */
const OFF_LIMITS = new Set([
  // A key that can mint keys can escalate past its own scopes, and there is no
  // use for one that a session does not cover.
  'api-keys',
  // Conduit's own management service — operational, not a workspace resource.
  'conduit-targets',
  // A key acts unattended, and a send here runs Claude Code on the operator's
  // machine with every permission bypassed.
  'workbench',
  // A start runs a command from the workspace's own tree on the operator's
  // machine, and a view reads a file there.
  'pages',
  // A discuss is a workbench send, and a decide writes two tracked files.
  'registers',
])

/**
 * Services an agent over `/mcp` is never handed, whoever it acts for.
 *
 * The workbench: a send is `claude -p` with permissions bypassed in a checkout
 * on this machine, so an agent holding the tool reaches the operator's shell,
 * which no level in a workspace describes. Pages: a start runs a command on
 * that machine. Registers: a discuss is a workbench send. `agentGuard` refuses the call and `narrowForAgent` withholds
 * the tool, off this one set.
 */
const NOT_FOR_AGENTS = new Set(['workbench', 'pages', 'registers'])

/** The scope a workspace service declares: read for `find`, `get` and a declared read, write for the rest. */
export const keyScope = (service: string) => ({ read: `${service}:read`, write: `${service}:write` })

/** The picker's word for a key issued whole: minted with no scopes, so held to none. */
export const WHOLE_KEY = 'admin'

/** Typed once. asSystem() answers `unknown`, so every accessor off it would
 *  otherwise be its own diagnostic — the class Invariant 14 is counting. */
const sysOf = (app: App): any => app.db!.asSystem()

export interface Scope { id: string; group: string; label: string }

export function scopeVocabulary(app: App): Scope[] {
  const declared = new Map<string, string>()
  for (const name of app.services.list()) {
    if (OFF_LIMITS.has(name)) continue
    const scopes = (app.services.get(name) as { describe?(): { scopes: Record<string, string | false> } } | undefined)
      ?.describe?.().scopes ?? {}
    for (const id of Object.values(scopes)) if (id) declared.set(id, name)
  }
  return [
    ...[...declared].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => ({
      id, group,
      label: id.endsWith(':read') ? `Read ${group}` : `Create, change and act on ${group}`,
    })),
    { id: WHOLE_KEY, group: 'admin', label: 'Everything, including services added later' },
  ]
}

/** The principal fields a key's standing is read off. */
interface KeyPrincipal { authMethod?: string; scopes?: string[]; credentialId?: string }

/**
 * Whether a key may reach `service` at all. A session is not a key and is held
 * to nothing here; a key's scopes are junction's to grade, at the call and in
 * the agent's tool list alike.
 */
export function keyAllows(user: KeyPrincipal | null | undefined, service: string): boolean {
  return user?.authMethod !== 'apiKey' || !OFF_LIMITS.has(service)
}

/**
 * `mcp({ narrow })`: no caller's list holds a service in
 * `NOT_FOR_AGENTS`, and no key's holds one in `OFF_LIMITS`. A key's scopes
 * withhold the rest in mcp itself (`FJS-D916`); the record checks — revoked,
 * another workspace — stay the guard's, at the call.
 */
export function narrowForAgent(tool: { service: string; method: string }, principal: unknown): boolean {
  if (NOT_FOR_AGENTS.has(tool.service)) return false
  return keyAllows(principal as KeyPrincipal | null, tool.service)
}

// ─── agentGuard ──────────────────────────────────────────────────────────
// App-level before hook. `narrowForAgent` only withholds the tool, and a
// withheld tool is an affordance (Invariant 6); this is the refusal. Read off
// `ctx.transport`, which mcp sets on every call (`FJS-D609`).

export function agentGuard(): Hook {
  return function agentGuard(ctx: ServiceContext): void {
    if (ctx.transport === 'mcp' && NOT_FOR_AGENTS.has($.service))
      throw new Forbidden(`${$.service} is not offered to an agent`)
  }
}

// ─── apiKeyGuard ─────────────────────────────────────────────────────────
// App-level before hook. A session passes straight through; a key is held to
// what it was issued with.

export function apiKeyGuard(): Hook {
  return async function apiKeyGuard(ctx: ServiceContext): Promise<void> {
    const user = $.user as KeyPrincipal | undefined

    if (user?.authMethod !== 'apiKey') return

    if (OFF_LIMITS.has($.service))
      throw new Forbidden(`An API key cannot reach ${$.service}`)

    // asSystem(): whether this key may act is what DECIDES the caller's
    // access, so it cannot be read through a client already scoped by it.
    const sys = sysOf(ctx.app)
    const key = user.credentialId
      ? await sys.apiKey.findFirst({ where: { credentialId: user.credentialId } })
      : null

    // auth verified the credential, so the token is real — but Basecamp has no
    // record of it, which means it was issued outside this app or its record
    // was deleted. Fail closed: a key nothing can revoke is worse than no key.
    if (!key)
      throw new Forbidden('This API key has no record in Basecamp and cannot be used')

    if (key.revokedAt) throw new Forbidden('This API key has been revoked')

    // The key belongs to a workspace and may not be pointed at another one.
    // The user behind it may well be a member of both — that is exactly the
    // case this stops, because a CI token scoped to staging should not become
    // a production token by changing one header.
    const workspaceId = resolveWorkspaceId(ctx)
    if (workspaceId && workspaceId !== key.workspaceId)
      throw new Forbidden('This API key belongs to a different workspace')

    // For the usage hook, so it does not repeat the lookup.
    $.locals.apiKeyId = key.id
  }
}

// ─── apiKeyUsage ─────────────────────────────────────────────────────────
// App-level after hook. One write per authenticated key request, which is what
// "last used" costs — there is no cheaper way to answer it that is still true.
//
// After, not around: a refused call is not something the key did. A key that
// is being rejected all day shows up as a key that stopped being used, which
// is the same signal read from the other end.

export function apiKeyUsage(): Hook {
  return async function apiKeyUsage(): Promise<void> {
    const id = $.locals.apiKeyId as string | undefined
    if (!id) return

    const today = new Date().toISOString().slice(0, 10)

    try {
      const sys = sysOf($.app)
      const key = await sys.apiKey.findUnique({ where: { id } })
      if (!key) return

      await sys.apiKey.update({
        where: { id },
        data: {
          lastUsedAt: new Date().toISOString(),
          totalUses:  (key.totalUses ?? 0) + 1,
          usageDate:  today,
          // The counter carries the day it counts, so the rollover is a
          // comparison rather than a scheduled job that has to run.
          usesOnDate: key.usageDate === today ? (key.usesOnDate ?? 0) + 1 : 1,
        },
      })
    } catch {
      // Swallowed for the same reason the audit hook swallows: a usage counter
      // must never be the thing that fails somebody's deploy.
    }
  }
}
