// api/config/junction.config.js
//
// What this app DECLARES, as opposed to what it computes at boot. Anything
// derived from a port broker or a resolved path stays in `api/src/app.ts`; a
// standing statement about the app lives here, where it can be read without
// running it.
//
// Note the precedence: `createApp({ config })` beats this file, so a key
// belongs in exactly one of the two places or the one here is decoration.

export default {
  // ── Where the services are ────────────────────────────────────────────
  // Stated rather than inferred. Junction's default is `services/` beside the
  // ENTRY (`dirname(Bun.main)`), which is the flat layout — with the entry at
  // api/index.ts and the services under api/src/, the default resolves to a
  // directory that is not there. Nothing fails: the app boots, answers /health,
  // and every route those services would have mounted is a 404.
  services: {
    dir: './api/src/services',
  },

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
    db:      './db/jobs.db',
    jobsDir: './api/src/jobs',
    admin:   true,
    queues: {
      default:    { concurrency: 2 },
      // One at a time: the courier's API is rate limited in the story, and a
      // single worker makes the queue's behaviour observable in a drive.
      fulfilment: { concurrency: 1 },
    },
  },
}
