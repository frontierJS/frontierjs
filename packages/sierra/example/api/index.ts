// api/index.ts — the entry.
//
//   bun run example:api        (from packages/sierra)
//
// It starts the app; src/app.ts builds one and exports it unstarted, so
// anything that wants to describe this app can import it without binding 8130.

import app, { PORT } from './src/app.ts'

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
