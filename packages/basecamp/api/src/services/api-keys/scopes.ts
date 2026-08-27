// src/services/api-keys/scopes.ts
// What an API key is allowed to do, and the two hooks that hold it to that.
//
// Separate from the service because these run at APP level — before any
// service hook, on every request — while the service only serves /api-keys.
// Same file so that granting a scope and checking one cannot drift: the string
// the screen shows in a checkbox is the string the guard tests for.

import { Forbidden, $ } from '@frontierjs/junction'
import type { Hook, ServiceContext } from '@frontierjs/junction'
import type { BasecampApp } from '../../basecamp.types.ts'
import { resolveWorkspaceId } from '../../core/hooks.ts'

// ─── The vocabulary ──────────────────────────────────────────────────────
// A scope is `<service>:<read|write>`, and the resource half IS the service
// name — not a mapping table beside it. A table is a second list to keep in
// step, and the failure of it drifting is a scope that reads as if it grants
// something and grants nothing.
//
// So it is derived from the registry at call time, which also means a service
// added tomorrow is scopeable tomorrow without an edit here.

/** Services a key may never reach, whatever it was issued with. */
const OFF_LIMITS = new Set([
  // A key that can mint keys can escalate past its own scopes, and there is no
  // use for one that a session does not cover.
  'api-keys',
  // Conduit's own management service — operational, not a workspace resource.
  'conduit-targets',
])

const READ_METHODS = new Set(['find', 'get'])

export interface Scope { id: string; group: string; label: string }

/** Typed once. asSystem() answers `unknown`, so every accessor off it would
 *  otherwise be its own diagnostic — the class Invariant 14 is counting. */
const sysOf = (app: BasecampApp): any => app.db.asSystem()

export function scopeVocabulary(app: BasecampApp): Scope[] {
  const services = app.services.list().filter(n => !OFF_LIMITS.has(n)).sort()
  return [
    ...services.flatMap(name => [
      { id: `${name}:read`,  group: name, label: `Read ${name}` },
      { id: `${name}:write`, group: name, label: `Create, change and act on ${name}` },
    ]),
    { id: 'admin', group: 'admin', label: 'Everything, including services added later' },
  ]
}

/**
 * The scope a call needs. One definition, used to grant and to explain — the
 * screen names the same string the guard tests.
 *
 * A custom method counts as a write. Reads are `find` and `get` only, which is
 * the same line Junction draws for announcing on a channel and the audit hook
 * draws for what to record: three places, one rule.
 */
export function scopeFor(service: string, method: string): string {
  return `${service}:${READ_METHODS.has(method) ? 'read' : 'write'}`
}

// ─── apiKeyGuard ─────────────────────────────────────────────────────────
// App-level before hook. A session passes straight through; a key is held to
// what it was issued with.

export function apiKeyGuard(app: BasecampApp): Hook {
  return async (ctx: ServiceContext): Promise<void> => {
    const user = $.auth?.user as
      { authMethod?: string; scopes?: string[]; credentialId?: string } | undefined

    if (user?.authMethod !== 'apiKey') return

    if (OFF_LIMITS.has($.service))
      throw new Forbidden(`An API key cannot reach ${$.service}`)

    // asSystem(): whether this key may act is what DECIDES the caller's
    // access, so it cannot be read through a client already scoped by it.
    const sys = sysOf(app)
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

    const needed = scopeFor($.service, $.method)
    const held   = user.scopes ?? []
    if (!held.includes('admin') && !held.includes(needed))
      throw new Forbidden(`This API key needs the '${needed}' scope`)

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

export function apiKeyUsage(app: BasecampApp): Hook {
  return async (): Promise<void> => {
    const id = $.locals.apiKeyId as string | undefined
    if (!id) return

    const today = new Date().toISOString().slice(0, 10)

    try {
      const sys = sysOf(app)
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
