// api/index.ts
// Workbench's entry point. It starts the app; src/app.ts builds one.

import { buildWorkbenchApp } from './src/app.ts'

// PORT, else the global tooling slot (cli core/ports.js GLOBAL.workbench) that
// web/config/vite.config.js proxies to. Never `fli dev`'s FRONTIER_PORT_BE: that
// slot moves between roots and this app is one per machine.
const port = Number(process.env.PORT ?? 5501)

const app = await buildWorkbenchApp({ port })
await app.start()
