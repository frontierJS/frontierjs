/*
 * config.js — what this Outpost needs to know, and where it refuses to start.
 *
 * Every value is an environment variable because an Outpost is installed on a
 * machine by something else (ring 1 in `IDEAS/deploy-plane.md`) and has no
 * config file of its own to edit. Five of them have no safe default and the
 * process exits rather than starting half-configured: an Outpost that cannot
 * name its server reports as nobody, one with no secret would either refuse
 * every command or — far worse — accept every one, and one with no certificate
 * would take commands in the clear.
 */

/** Ports are derived, not chosen: `packages/cli/core/ports.js`, project id 8,
 *  category `be`. dev 8180, test 7180. */
const DEFAULT_PORT = 8180
/** The origin inline apps answer on — dev 8181, test 7181, same row, service
 *  slot 1. It is a SECOND listener rather than a path on the first because a
 *  pasted page is a stranger's script and a port is an origin: sharing one with
 *  the signed command protocol would put the fleet inside every prototype. */
const DEFAULT_STATIC_PORT = 8181

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
    /** THIS machine's own key, handed over at enrollment. Signs what this
     *  sends, verifies what arrives. Basecamp holds no key that opens every
     *  machine, so another machine's key is refused here too. */
    secret:     need('OUTPOST_SECRET'),
    /** Where Basecamp answers. No default — a wrong guess reports into a void. */
    basecampUrl: need('BASECAMP_URL')?.replace(/\/$/, ''),
    /** The command port's certificate and key — `cert.js`. No default and no
     *  plain-HTTP fallback: that port carries every deploy's decrypted env, and
     *  Basecamp refuses a machine whose URL is not https (`FJS-1603`). */
    tlsCert:    need('OUTPOST_TLS_CERT'),
    tlsKey:     need('OUTPOST_TLS_KEY'),

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
    publicUrl:   env.OUTPOST_PUBLIC_URL ?? `https://localhost:${env.OUTPOST_PORT ?? DEFAULT_PORT}`,
    /** Where a git build is checked out. One directory per app. */
    workDir:     env.OUTPOST_WORK_DIR ?? '/var/lib/outpost/apps',
    /** Where published static releases live. One directory per app, one
     *  subdirectory per digest, plus the `hosts/` links the server resolves. */
    staticDir:   env.OUTPOST_STATIC_DIR ?? '/var/lib/outpost/static',
    /** 0 turns the static origin off entirely — a machine that runs containers
     *  and nothing else has no reason to hold a public port open. */
    staticPort:  Number(env.OUTPOST_STATIC_PORT ?? DEFAULT_STATIC_PORT),
    /** The address the WORLD reaches a published app at. Stated rather than
     *  derived for `publicUrl`'s reason — this process cannot see how it is
     *  reached — and it is what a release step writes into its own output, so
     *  the answer to *where is it* comes off the machine that put it there
     *  rather than being assembled by a console that is guessing. */
    staticUrl:   (env.OUTPOST_STATIC_URL ?? `http://localhost:${env.OUTPOST_STATIC_PORT ?? DEFAULT_STATIC_PORT}`)
                   .replace(/\/$/, ''),
    /** Caddy's admin API — `ingress.js`. Loopback-only by Caddy's default, and
     *  nothing else on the machine speaks to it. */
    caddyAdmin:  env.OUTPOST_CADDY_ADMIN ?? 'http://127.0.0.1:2019',
  }

  if (missing.length) {
    throw new Error(
      `outpost: ${missing.join(', ')} must be set.\n` +
      `  OUTPOST_SERVER_ID  the id of this machine's Server row in Basecamp\n` +
      `  OUTPOST_SECRET     this machine's own key, from enrolling\n` +
      `  BASECAMP_URL       where Basecamp answers, e.g. https://basecamp.internal\n` +
      `  OUTPOST_TLS_CERT   the command port's certificate, from enrolling\n` +
      `  OUTPOST_TLS_KEY    its private key`
    )
  }
  // Basecamp would never register it, so every command would be refused with
  // the machine looking healthy.
  if (!/^https:\/\//i.test(config.publicUrl))
    throw new Error(`outpost: OUTPOST_PUBLIC_URL must be https, got '${config.publicUrl}'`)
  return config
}
