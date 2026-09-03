// ─── the container's log flags ───────────────────────────────────────────────
// What a started container is told to do with its own stdout.
//
// Docker's default `json-file` driver sets NO size limit, so a container that
// logs on every request writes until the disk does — and the failure is not the
// log, it is the machine: a full disk stops the database writing before anybody
// looks at `/var/lib/docker`. Nothing in this repo capped it, in any of the four
// places a container is started.
//
// **Four call sites and this is the owner, because they disagree by default.**
// `06-swap` starts the deploy's container, `_steps-rollback/02-rollback-api`
// starts the previous one, `deploy:local` starts a test one, and the Outpost
// starts every app on a fleet machine. A cap written into three of them is the
// shape where the fourth is the one that fills the disk.
//
// **The driver is not forced, and that is the point of the config key.** An
// operator who has pointed the daemon at journald or at a log shipper has
// already answered this question, and `--log-opt max-size` is refused outright
// by a driver that does not take it — so emitting it unasked breaks exactly the
// machine that was set up correctly. `logs: false` is the way to say *I manage
// this*, and naming a driver hands the whole decision over.

const DEFAULT_MAX_SIZE  = '10m'
const DEFAULT_MAX_FILES = 5

/**
 * The `--log-*` arguments for a `docker run`, from an app's deploy block.
 *
 *   logs: false                          → nothing; the daemon's default stands
 *   (absent)                             → json-file, 10m × 5
 *   logs: { max_size, max_files }        → json-file, as stated
 *   logs: { driver: 'journald' }         → that driver, and no size options
 *   logs: { driver, options: { … } }     → that driver, with those options
 *
 * @param {object|undefined} deployConf  the `deploy` block of frontier.config.js
 * @returns {string[]} argv fragments, already shell-safe — every value is
 *   matched against a conservative pattern rather than quoted, because these
 *   are interpolated into a script that reaches a machine over stdin.
 */
export function dockerLogArgs(deployConf) {
  const logs = deployConf?.logs

  // Explicitly declined. The operator has configured the daemon and a flag here
  // would override it for this container alone, which is the worst of both.
  if (logs === false) return []

  // A named driver is the operator answering the whole question. Size options
  // are json-file's spelling and journald refuses them, so they are not carried
  // across — an option for a named driver has to be stated for that driver.
  if (logs?.driver) {
    const out = [`--log-driver ${safe(logs.driver)}`]
    for (const [k, v] of Object.entries(logs.options ?? {}))
      out.push(`--log-opt ${safe(k)}=${safe(v)}`)
    return out
  }

  return [
    '--log-driver json-file',
    `--log-opt max-size=${safe(logs?.max_size ?? DEFAULT_MAX_SIZE)}`,
    `--log-opt max-file=${safe(logs?.max_files ?? DEFAULT_MAX_FILES)}`,
  ]
}

// Same rule as the deploy lock's: a value that reaches a shell by interpolation
// may carry neither a quote nor a space. Config an operator wrote is not
// hostile and is not validated either.
const safe = (v) => String(v ?? '').replace(/[^A-Za-z0-9._:=+/-]+/g, '-').slice(0, 60)

export const DOCKER_LOG_DEFAULTS = { maxSize: DEFAULT_MAX_SIZE, maxFiles: DEFAULT_MAX_FILES }
