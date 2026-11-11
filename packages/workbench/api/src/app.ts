// api/src/app.ts
// Builds Workbench's API and never starts it; api/index.ts is the entry that
// calls start(), so a snapshot tool can import this without binding a port.

import { createApp, health, channels } from '@frontierjs/junction'
import { caravan }           from '@frontierjs/caravan'
import { notifications, ntfy } from '@frontierjs/notifications'
import type { App } from '@frontierjs/junction'
import { createClient } from '@frontierjs/litestone'

import { createWorkbenchAuth, sweepSessions } from './auth.ts'
import { env, DEV_ENCRYPTION_KEY, DEV_WORKBENCH_KEY } from './core/env.ts'
import { createWorkbench }                    from './domain/workbench/workbench.ts'
import { workbenchTerminal }                  from './plugins/workbench-terminal.ts'
import { loginRoute, logoutRoute, meRoute, LOGIN_PATH, LOGOUT_PATH, ME_PATH } from './login.ts'
import { standing }                           from './principal.ts'
import { resolvePush }                        from './push.ts'
import { notificationChannelName }        from './core/channels.ts'
import { peerKeys, peerRoute, PEER_PATH }     from './peer.ts'
import { createBasecamp }                     from './domain/peer/basecamp.ts'
import { conduitSend, type SendFor }          from './domain/servers/servers.ts'
import { resolveBasecamp, DEV_BASECAMP, DEV_BASECAMP_ORIGIN } from '@frontierjs/cli/core/basecamps.js'
import './workbench.types.ts'

const SCHEMA = new URL('../../db/schema.lite', import.meta.url).pathname
// The queue's own file, beside the main one, so `db:reset` takes both.
const JOBS_DB = new URL('../../db/workbench-jobs.db', import.meta.url).pathname

export interface WorkbenchAppOptions {
  /** A Litestone client over db/schema.lite. A test hands its own. */
  db?:   { asSystem: () => any }
  /** The pass-phrase and the session digest's secret. Default `WORKBENCH_KEY`. */
  key?:  string
  port?: number
  /** How a push leaves. A test hands a stub so a report never reaches the real ntfy.sh under the developer's own topic. */
  deliver?: typeof fetch
  /** How the Servers screen reaches a provider. A test hands a stub so a list never dials Hetzner or DigitalOcean. */
  serversSend?: SendFor
}

// A machine that never ran `fli basecamp:create` still has the dev Basecamp;
// any other name missing from the index is a typo that
// would otherwise send previews somewhere unintended, so it stops the boot.
function previewBasecamp (name: string): { name: string, url: string, peerKeyId?: string | null } {
  try { return resolveBasecamp(name) } catch (err) {
    if (name === DEV_BASECAMP) return { name, url: DEV_BASECAMP_ORIGIN, peerKeyId: null }
    throw err
  }
}

export async function buildWorkbenchApp (opts: WorkbenchAppOptions = {}): Promise<App> {
  if (env.NODE_ENV === 'production' && env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY)
    throw new Error('Workbench refuses to boot in production on the public dev ENCRYPTION_KEY. Set one: openssl rand -hex 32')
  if (env.NODE_ENV === 'production' && (opts.key ?? env.WORKBENCH_KEY) === DEV_WORKBENCH_KEY)
    throw new Error('Workbench refuses to boot in production on the public dev WORKBENCH_KEY. Set one.')
  const db  = opts.db ?? await createClient({ path: SCHEMA, resolveFrom: 'schema', encryptionKey: env.ENCRYPTION_KEY }) as { asSystem: () => any }
  const key = opts.key ?? env.WORKBENCH_KEY

  const auth = createWorkbenchAuth(db, { key })

  const app = createApp({
    db,
    auth,
    // Stated, not probed: under a test runner the entry file is the test.
    // services/ beside this file, ../config above it (`FJS-D1080`).
    root:      import.meta.url,
    principal: standing(db),
    // Loopback by default: this API can start a shell on the machine.
    config:    { hostname: env.HOST, ...(opts.port !== undefined ? { port: opts.port } : {}) },
  } as Parameters<typeof createApp>[0])

  // One instance for every service that sends to it, as Basecamp's was.
  app.own('workbench', createWorkbench({ dir: env.WORKBENCH_DIR || undefined, bin: env.CLAUDE_BIN, env }))
  // The peer a preview is cut in; the key pair is read on the first call, not here.
  const entry    = previewBasecamp(env.BASECAMP)
  const basecamp = createBasecamp({ name: entry.name, url: entry.url, keyId: entry.peerKeyId ?? null, keys: () => peerKeys() })
  app.own('basecamp', basecamp)
  app.own('servers', { sendFor: opts.serversSend ?? conduitSend })

  const login = loginRoute(db, auth, { key })
  app.configure(a => {
    a.post(LOGIN_PATH, login)
    a.get(ME_PATH, meRoute(db))
    a.get(PEER_PATH, peerRoute({ basecampUrl: basecamp.url, keyId: basecamp.keyId }))
    a.post(LOGOUT_PATH, logoutRoute(auth))
  })
  app.configure(health())

  // Phone pings. In-app plus push and no mail: Workbench has no mailer, so the
  // plugin declares none and an `email` formatter is never reached. Nothing
  // above it is resolved by a transport (ntfy is a bare fetch), so its place
  // is only before the jobs that send.
  const push = resolvePush()
  app.own('push', push)
  app.configure(notifications({
    db,
    transports: { push: ntfy({ url: push.url, token: push.token, ...(opts.deliver ? { deliver: opts.deliver } : {}) }) },
  }))

  // The socket. A connection joins its own member's channel and nothing else:
  // the inApp driver publishes `notifications created` to
  // `notifications:user:<id>`, and the bell listens there.
  app.configure(channels((a) => {
    a.channels?.on('connection', (session: unknown, conn) => {
      const s = session as { id?: string } | null
      if (s?.id) a.channel?.(notificationChannelName(s.id)).join(conn)
    })
  }))

  // Jobs under api/src/jobs register themselves; the app's scheduler arms their crons.
  app.configure(caravan({ db: JOBS_DB }))

  // A shell in a pinned checkout or the home folder, behind the door's one member (plugins/workbench-terminal.ts).
  app.configure(function terminalRoute () { workbenchTerminal(app) })

  // The app's scheduler is armed by `start-work`, so a one-shot boot ticks nothing.
  app.scheduler.every('1 hour', async () => {
    const expired = await sweepSessions(db)
    if (expired) console.log(`[workbench] retention: ${expired} expired sessions dropped`)
  })
  return app
}
