// api/src/app.ts
// Builds Haven's API and never starts it; api/index.ts is the entry that
// calls start(), so a snapshot tool can import this without binding a port.

import { createApp, channels } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { createClient } from '@frontierjs/litestone'

import { createHavenAuth, sweepSessions } from './auth.ts'
import { clientRoute, CLIENT_PATH } from './client.ts'
import { createCooldowns }         from './bolt.ts'
import { createCrier }             from './crier.ts'
import { createDice }              from './dice.ts'
import type { Dice }               from './dice.ts'
import type { Crier }              from './crier.ts'
import { createCasts }             from './fishing.ts'
import type { Casts }              from './fishing.ts'
import { createInventories }       from './inventory.ts'
import type { Inventories }        from './inventory.ts'
import { loginRoute, LOGIN_PATH }  from './login.ts'
import { createRoomMemory }        from './memory.ts'
import type { RoomMemory }         from './memory.ts'
import type { LoginOptions }       from './login.ts'
import { standing }                from './principal.ts'
import { sweepRooms, KEEP }        from './retention.ts'
import { FIRST_ROOM, roomChannels } from './rooms.ts'
import { createSetlist }           from './setlist.ts'
import type { Setlist }            from './setlist.ts'

const SCHEMA = new URL('../../db/schema.lite', import.meta.url).pathname

export interface HavenAppOptions {
  /** A Litestone client over db/schema.lite. A test hands its own. */
  db?:         { asSystem: () => any }
  /** The secret a session token is digested under. Default `HAVEN_SESSION_KEY`. */
  sessionKey?: string
  port?:       number
  /** The login's clock, in seconds. A test states it. */
  now?:        LoginOptions['now']
  /** The nicks that walk in as mods. Default `HAVEN_MODS`, comma-separated. */
  mods?:       string[]
  /** The Frontier post's public key a chain login's row is signed under. Default `HAVEN_POST_KEY`. */
  postKey?:    string
  /** Sockets one IP may hold. Default `HAVEN_WS_PER_IP`, else 4. */
  wsPerIp?:    number
}

/** The app a service is handed: `memory` is the room's memory (`FJS-D993`) and `cooldowns` the bolt's wait (`bolt.ts`) and `inventory` what a member carries (`inventory.ts`) and `crier` the square's announcer (`crier.ts`) and `setlist` the loft's song requests (`setlist.ts`), all owned here. */
export type HavenApp = App & { memory: RoomMemory, cooldowns: ReturnType<typeof createCooldowns>, inventory: Inventories, crier: Crier, dice: Dice, casts: Casts, setlist: Setlist }

export async function buildHavenApp (opts: HavenAppOptions = {}): Promise<App> {
  const db = opts.db ?? await createClient({ path: SCHEMA, resolveFrom: 'schema' }) as { asSystem: () => any }

  const auth = createHavenAuth(db, { key: opts.sessionKey ?? process.env.HAVEN_SESSION_KEY ?? '' })

  const app = createApp({
    db,
    auth,
    // Stated, not probed: under a test runner the entry file is the test.
    // services/ beside this file, ../config above it (`FJS-D1080`).
    root:       import.meta.url,
    principal:  standing(db),
    config: {
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      http: {
        // One `fli haven` per machine; a few is a second terminal. The agents
        // (`agents/agents.js`) are a socket each from the owner's machine, so
        // the server that hosts them raises it. Moves are bounded again, per
        // room, by the presence rate in rooms.ts.
        ws: { maxConnectionsPerIp: opts.wsPerIp ?? (Number(process.env.HAVEN_WS_PER_IP) || 4), maxFramesPerSecond: 20 },
      },
    },
  } as Parameters<typeof createApp>[0])

  const memory = createRoomMemory()
  app.own('memory', memory)
  app.own('cooldowns', createCooldowns())
  const inventory = createInventories()
  app.own('inventory', inventory)
  const crier = createCrier(app, db, FIRST_ROOM)
  app.own('crier', crier)
  app.own('dice', createDice(app, db))
  app.own('casts', createCasts())
  app.own('setlist', createSetlist())
  const { setup, options } = roomChannels(db, memory, inventory)
  app.configure(channels(setup as never, options))
  // Inside configure() so it registers during start(), after the router is patched.
  const mods  = opts.mods ?? (process.env.HAVEN_MODS ?? '').split(',').map(n => n.trim()).filter(Boolean)
  const login = loginRoute(db, auth, { now: opts.now, mods, welcome: crier.welcome, postKey: opts.postKey ?? process.env.HAVEN_POST_KEY })
  app.configure(a => {
    a.get(CLIENT_PATH, clientRoute())
    a.post(LOGIN_PATH, login)
  })
  // Startup is not a schedule (`$retain()`): a server that stays up for a
  // month sweeps nothing after its first hour unless something ticks. The
  // app's scheduler is armed by `start-work`, so a one-shot boot ticks nothing.
  app.scheduler.every('1 hour', async () => {
    for (const { roomId, removed } of await sweepRooms(db))
      console.log(`[haven] retention: room ${roomId} dropped ${removed} lines past its newest ${KEEP}`)
    const expired = await sweepSessions(db)
    if (expired) console.log(`[haven] retention: ${expired} expired sessions dropped`)
  })
  return app
}
