/*
 * config.js — what this Outpost needs to know, and where it refuses to start.
 *
 * Every value is an environment variable because an Outpost is installed on a
 * machine by something else (ring 1 in `IDEAS/deploy-plane.md`) and has no
 * config file of its own to edit. Two of them have no safe default and the
 * process exits rather than starting half-configured: an Outpost that cannot
 * name its server reports as nobody, and one with no secret would either
 * refuse every command or — far worse — accept every one.
 */

/** Ports are derived, not chosen: `packages/cli/core/ports.js`, project id 8,
 *  category `be`. dev 8180, test 7180. */
const DEFAULT_PORT = 8180

export function readConfig(env = process.env) {
  const missing = []
  const need = name => {
    const value = env[name]
    if (!value) missing.push(name)
    return value
  }

  const config = {
    /** Which `Server` row this machine IS. Every report names it. */
    serverId:   need('OUTPOST_SERVER_ID'),
    /** The fleet secret. Signs what this sends, verifies what arrives. */
    secret:     need('OUTPOST_SECRET'),
    /** Where Basecamp answers. No default — a wrong guess reports into a void. */
    basecampUrl: need('BASECAMP_URL')?.replace(/\/$/, ''),

    port:       Number(env.OUTPOST_PORT ?? DEFAULT_PORT),
    /** How often to check in. Basecamp reads `lastHeartbeatAt` to decide
     *  whether a machine is reachable, so this is also the resolution of that
     *  answer. */
    heartbeatMs: Number(env.OUTPOST_HEARTBEAT_MS ?? 30_000),
    /** Disk and volumes are asked of Docker, which walks the filesystem — far
     *  more expensive than a heartbeat, and it changes far more slowly. */
    reportMs:    Number(env.OUTPOST_REPORT_MS ?? 300_000),
    version:     env.OUTPOST_VERSION ?? '0.1.0',
    /** The URL Basecamp should send commands to. Stated rather than derived:
     *  this process cannot see the address the world reaches it at. */
    publicUrl:   env.OUTPOST_PUBLIC_URL ?? `http://localhost:${env.OUTPOST_PORT ?? DEFAULT_PORT}`,
    /** Where a git build is checked out. One directory per app. */
    workDir:     env.OUTPOST_WORK_DIR ?? '/var/lib/outpost/apps',
  }

  if (missing.length) {
    throw new Error(
      `outpost: ${missing.join(', ')} must be set.\n` +
      `  OUTPOST_SERVER_ID  the id of this machine's Server row in Basecamp\n` +
      `  OUTPOST_SECRET     the fleet secret Basecamp signs with\n` +
      `  BASECAMP_URL       where Basecamp answers, e.g. https://basecamp.internal`
    )
  }
  return config
}
