// src/providers/outpost.ts
// Reaching the agent on a machine — the half every fleet job shares.
//
// An outpost is registered as a Conduit target on heartbeat, so a server that
// has never checked in with a URL resolves to nothing. That is a fact about the
// fleet rather than an error, and the answer is `null` for the caller to record.
//
// WHO carries a RELEASE is a different and larger question — three answers, one
// of them a refusal — and it lives in `executor.ts` beside this file.

import type { BasecampApp } from '../basecamp.types.ts'

/** The outbound boundary, or a throw. Every fleet job is nothing but a request
 *  to a machine, so an app configured without conduit cannot run one — and
 *  `app.conduit` is optional on the type, which is what makes this one function
 *  rather than a non-null assertion at every call. */
export function outbound(app: BasecampApp) {
  if (!app.conduit) throw new Error('Outbound delivery is not configured — no conduit plugin')
  return app.conduit
}

/** The conduit target for a server's outpost, or null when it has never
 *  registered one. */
export async function outpostFor(app: BasecampApp, serverId: string): Promise<string | null> {
  const target = `outpost:${serverId}`
  return await outbound(app).resolve(target).catch(() => null) ? target : null
}
