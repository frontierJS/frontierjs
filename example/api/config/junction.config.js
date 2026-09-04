// api/config/junction.config.js
//
// What this app DECLARES, as opposed to what it computes at boot. Anything
// derived from a port broker or a resolved path stays in `api/src/app.ts`; a
// standing statement about the app lives here, where it can be read without
// running it.
//
// Note the precedence: `createApp({ config })` beats this file, so a key
// belongs in exactly one of the two places or the one here is decoration.
//
// Every path below is anchored to THIS FILE. A relative one is resolved
// against the process's working directory, so the queue opened `db/jobs.db`
// beside whatever directory the command was typed in — a second, empty queue
// on every run from anywhere but the app root, with nothing said (`FJS-449`'s
// class). `api/src/app.ts` states `configPath` for the same reason.
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

export default {
  // ── Caravan — the durable job queue ───────────────────────────────────
  // A SQLite queue in its own file: nothing about it touches db/shop.db, so a
  // wiped queue loses no shop data and a wiped shop loses no jobs.
  //
  // `admin: true` mounts GET /jobs, GET /jobs/schedules, GET /jobs/{id} and the
  // retry/cancel posts — under this app's apiPrefix like everything else, so
  // the URLs are /api/jobs/… and one proxy entry in web/config/vite.config.js
  // covers them. No secret because this is a demo shop on localhost;
  // `admin: { secret }` is the option that stops it being public.
  caravan: {
    db:      here('../../db/jobs.db'),
    jobsDir: here('../src/jobs'),
    admin:   true,
    queues: {
      default:    { concurrency: 2 },
      // One at a time: the courier's API is rate limited in the story, and a
      // single worker makes the queue's behavior observable in a drive.
      fulfillment: { concurrency: 1 },
    },
  },
}
