// api/index.ts
// Haven's entry point. It starts the app; src/app.ts builds one.

import { buildHavenApp } from './src/app.ts'
import type { HavenApp } from './src/app.ts'
import { HAVEN_CLIENT } from './src/client.ts'
import { ensureRooms }  from './src/rooms.ts'

// PORT, else the global tooling slot that web/config/sierra.config.js names
// (cli core/ports.js GLOBAL.haven), which is where `fli haven` in a checkout
// knocks. Never `fli dev`'s FLI_PORT_BE: that slot moves between roots, and
// the door's default cannot.
const port = Number(process.env.PORT ?? 5505)

const app = await buildHavenApp({ port }) as HavenApp
await ensureRooms(app.db as { asSystem: () => any })
await app.start()
await app.crier.release(HAVEN_CLIENT.version)
