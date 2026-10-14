// api/src/app.ts
// Builds Haven's API and never starts it; api/index.ts is the entry that
// calls start(), so a snapshot tool can import this without binding a port.

import { createApp, channels } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { createClient } from '@frontierjs/litestone'

import { createHavenAuth }          from './auth.ts'
import { clientRoute, CLIENT_PATH } from './client.ts'
import { loginRoute, LOGIN_PATH }  from './login.ts'
import type { LoginOptions }       from './login.ts'
import { banned }                  from './principal.ts'
import { roomChannels }            from './rooms.ts'

const SCHEMA = new URL('../../db/schema.lite', import.meta.url).pathname

export interface HavenAppOptions {
  /** A Litestone client over db/schema.lite. A test hands its own. */
  db?:         { asSystem: () => any }
  /** The secret a session token is digested under. Default `HAVEN_SESSION_KEY`. */
  sessionKey?: string
  port?:       number
  /** The login's clock, in seconds. A test states it. */
  now?:        LoginOptions['now']
}

export async function buildHavenApp (opts: HavenAppOptions = {}): Promise<App> {
  const db = opts.db ?? await createClient({ path: SCHEMA, resolveFrom: 'schema' }) as { asSystem: () => any }

  const auth = createHavenAuth(db, { key: opts.sessionKey ?? process.env.HAVEN_SESSION_KEY ?? '' })

  const app = createApp({
    db,
    auth,
    // Stated, not probed: under a test runner the entry file is the test.
    autoload:   new URL('./services', import.meta.url).pathname,
    configPath: new URL('../config', import.meta.url).pathname,
    principal:  banned(db),
    config: {
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      http: {
        // One `fli haven` per machine; a few is a second terminal. Moves are
        // bounded again, per room, by the presence rate in rooms.ts.
        ws: { maxConnectionsPerIp: 4, maxFramesPerSecond: 20 },
      },
    },
  } as Parameters<typeof createApp>[0])

  const { setup, options } = roomChannels(db)
  app.configure(channels(setup as never, options))
  // Inside configure() so it registers during start(), after the router is patched.
  const login = loginRoute(db, auth, { now: opts.now })
  app.configure(a => {
    a.get(CLIENT_PATH, clientRoute())
    a.post(LOGIN_PATH, login)
  })
  return app
}
