// src/jobs/outpost-run.ts
// What running a command on a machine needs beyond the request itself: a bound
// on what comes back, and a line in the server's own history.
//
// Shared by `recipe-run` and `cleanup-run`, which are one shape — resolve the
// outpost, send one request, record what came back on the run row, tell the
// open screens. What differs is the safeguard around each, and that lives in
// the services (`recipes` is admin to author, `cleanup` names declared
// targets): by the time work reaches a handler the decision has been made and
// the row exists.

import type { BasecampApp } from '../basecamp.types.ts'

/** Output kept per run, per stream. An outpost that cats a log file can answer
 *  megabytes, and a row nothing can render is a row nobody reads — the tail is
 *  what a person wants anyway, so the head is what gets cut. */
const OUTPUT_LIMIT = 32_000

export function tail(text: unknown): string | null {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text)
  if (!s) return null
  if (s.length <= OUTPUT_LIMIT) return s
  return `… ${s.length - OUTPUT_LIMIT} earlier characters dropped …\n` + s.slice(-OUTPUT_LIMIT)
}

/**
 * A line in one machine's history.
 *
 * Through the servers service rather than `asSystem()` (`FJS-384`): both
 * handlers that call this run as whoever asked for the work, `ServerEvent` is
 * create-at-USER, and going through the caller's own client is what refuses a
 * line against a machine in another workspace. It never throws — a run that
 * finished is not a run to fail over a history line, and the row itself is
 * already written.
 */
export async function recordServerEvent(
  app: BasecampApp,
  serverId: string,
  kind: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await app.service('servers').call('logEvent', serverId, { kind, message, metadata })
  } catch (err) {
    app.logger.child('outpost-run').warn('server event not recorded', {
      server_id: serverId, kind, error: (err as Error).message,
    })
  }
}
