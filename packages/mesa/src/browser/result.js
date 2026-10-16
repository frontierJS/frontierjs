/*
 * result.js — what an action returns: `{ ok, via, reason? }`.
 *
 * `via` names the path that ran, so a fallback is reported to the caller and
 * never silent — a share button that copied instead says so. An action
 * RETURNS a failure rather than throwing it, because a throw makes every
 * caller write the fallback branch the kit owns (`FJS-D1097` Q7). Every
 * action builds its answer here, so the shape is spelled once.
 */

/** The path `via` ran and did what was asked. */
export const succeeded = (via) => ({ ok: true, via })

/** The path `via` was tried and refused; `reason` is the platform's word for
 *  it when it gave one (`'NotAllowedError'`, `'AbortError'`). */
export const failed = (via, reason) => ({ ok: false, via, reason })

/** No path exists in this browser. */
export const unsupported = (via) => failed(via, 'unsupported')
