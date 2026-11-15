// api/index.ts — the entry.
//
//   bun run example:api        (from packages/sierra)
//
// It starts the app; src/app.ts exports a builder and never starts one, so
// anything that wants to describe this app can import it without binding 8130.

import { buildApp, PORT } from './src/app.ts'

const app = await buildApp()
await app.start()

console.log(`
  ─────────────────────────────────────────────
    API   http://localhost:${PORT}/api/leads
    UI    bun run example        → http://localhost:8030

    curl http://localhost:${PORT}/api/leads
    curl -X POST http://localhost:${PORT}/api/leads \\
         -H 'content-type: application/json' \\
         -d '{"name":"From curl"}'      # 401 — @@gate says writes need a user
  ─────────────────────────────────────────────
`)
