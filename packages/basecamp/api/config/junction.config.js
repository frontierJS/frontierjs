// api/config/junction.config.js
//
// What this app DECLARES about its API, as opposed to what it derives at boot.
// The split is the point: anything computed from `env` or from a path resolved
// at runtime stays in `api/src/app.ts`, and everything that is a standing
// statement about the app lives here where it can be read without running it.
//
// It was missing for the whole life of the app, and `loadConfig` treated the
// absent directory exactly like an absent file — so the read below took its
// default every boot and nothing said so (`FJS-415`).
//
// Paths here are anchored to THIS FILE. A cwd-relative one is only correct
// when the command was typed at the package root, so a tool run from `api/` —
// which is where the API's own snapshots live — resolved it to nothing
// (`FJS-449`'s class). `api/src/app.ts` states `configPath` for the same
// reason.
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

export default {
  // ── Middleware ────────────────────────────────────────────────────────
  // The SPA's dev origin (project 2, frontend — packages/cli/core/ports.js).
  // A deployment names its own through CORS_ORIGINS, which wins over this:
  // the origin an app is served from is not a fact about the app.
  //
  // `*` was the effective value here until this file existed, because the read
  // in app.ts pointed at a key nothing writes.
  middleware: {
    cors: {
      origins:     ['http://localhost:8020'],
      // The SPA sends its session cookie, so the browser needs this to accept
      // the response at all.
      credentials: true,
    },
  },

  // ── Caravan — the durable job queue ───────────────────────────────────
  // Explicit options in app.ts always win over this block, so a key must live
  // in exactly one of the two places or the file is decoration. `db` stays in
  // code: it is derived from the resolved database path, so that the queue
  // follows a test that redirects the main database instead of writing jobs
  // into the developer's own.
  caravan: {
    // A job file names the job, declares its own queue and retry budget, and
    // is the dispatch handle every service imports.
    jobsDir:      here('../src/jobs'),
    pollInterval: 1_000,
    queues: {
      default:     { concurrency: 2 },
      deployments: { concurrency: 3 },
      jobs:        { concurrency: 5 },
      sync:        { concurrency: 2 },
      // Recipes and disk sweeps. Held low on purpose: both run a command on a
      // real machine through its outpost, and twenty at once is twenty machines
      // busy at the same moment rather than a fleet that stays serving.
      fleet:       { concurrency: 2 },
    },
  },
}
