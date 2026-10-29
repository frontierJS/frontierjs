// A caller acting for somebody without being them.
//
// Two do: an operator inside a support episode resolves as the subject
// (`SessionContext.support`), and an agent over `/mcp` holds the person's
// session (`FJS-D258`). Reading through either is what an episode is for. A
// write that OUTLIVES the episode is not — a key minted, a password changed, a
// browser subscribed to the person's push — because the ceiling the episode
// set has then been escaped for good, and the trail shows an ordinary write
// (`FJS-1795`, `FJS-D628`).
//
// One owner, here beside the two fields it reads: a hand copy of the test is
// the copy a new door forgets.

import { Forbidden } from '../core/errors.ts'

/**
 * Throws 403 when `user` is a support episode or the call came over `/mcp`.
 * `what` completes "Cannot …" for the person refused. A caller who is neither
 * passes, which is what every test of a refusal asserts beside it (`FJS-351`).
 */
export function refuseDelegated(
  // `user` keeps a TransportContext (which has no `transport`) assignable.
  ctx:  { transport?: string, user?: unknown },
  user: { support?: unknown } | null | undefined,
  what: string,
): void {
  if (user?.support) throw new Forbidden(
    `Cannot ${what} while acting as another user — it would outlive the support ` +
    'session. End the episode first; this account is not yours to change.'
  )
  if (ctx.transport === 'mcp') throw new Forbidden(
    `Cannot ${what} from an agent's tool call — it would outlive the session the agent ` +
    'was handed. The person signed in to the app can do it there.'
  )
}
