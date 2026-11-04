// ─── the container's stop grace ──────────────────────────────────────────────
// How long a stopped container gets to finish its work before docker SIGKILLs
// it, handed over ONCE as `--stop-timeout` and as `FRONTIER_STOP_GRACE`, which
// Junction fits its drain and plugin budgets inside (`FJS-D1841`). Every
// `docker stop` then reads the container's own number, so an operator's stop
// or a daemon shutdown waits the same time a release does.
//
// The same two flags as Outpost's `run` (`packages/outpost/src/docker.js`,
// `DEFAULT_STOP_GRACE_S`); the default is kept equal by hand because the cli
// does not import outpost.

export const DEFAULT_STOP_GRACE_S = 40

/**
 * The `docker run` arguments for an app's stop grace, from its deploy block.
 *
 *   (absent)               → 40 seconds
 *   stopGrace: 25          → 25 seconds
 *
 * @param {object|undefined} deployConf  the `deploy` block of frontier.config.js
 * @returns {string[]} argv fragments
 */
export function stopGraceArgs(deployConf) {
  const grace = deployConf?.stopGrace ?? DEFAULT_STOP_GRACE_S
  // Under 2 s Junction has no room left for a drain once it keeps its margin.
  if (!(Number.isInteger(grace) && grace >= 2))
    throw new Error(`deploy.stopGrace must be a whole number of seconds, at least 2 — got '${grace}'`)
  return [`--stop-timeout ${grace}`, `--env FRONTIER_STOP_GRACE=${grace}`]
}
