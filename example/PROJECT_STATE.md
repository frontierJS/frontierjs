# PROJECT_STATE — `example/` (the kitchen sink)

**As of 2026-08-06**, and the **Verified** row below is dated separately
(2026-08-26) and lists 27 drives — root `DRIVES.md`'s drive table now names
over 30 for this app, so both dates and the per-drive counts here need a
re-run before they are trusted; nothing here has been re-verified since. Read
`README.md` first for what the app *is*; this file is what was built, what was
proven as of that run, and what to pick up next.

Everything below was verified by running it, at the time it was written. Where
it was not, it says so.

---

## Status

| | |
| --- | --- |
| **Runs** | yes — `bun run api` + `bun run web`, two terminals |
| **Verified** | 938 assertions across 27 drives, all passing against one database, 0 console errors (2026-08-26). Per-drive counts and what each covers: `docs/drives.md` |
| **Builds** | yes — `bun run build` → `web/dist/client/` + robots.txt + sitemap (5 URLs). The built page is now driven too; until 2026-08-04 it loaded no JavaScript at all. `bun run build:site` → `site/dist/`, the prerendered public site, driven by `verify:site` |
| **Phase** | 1 (spine), **all of 2** (state machine + live updates), **deferred work** (caravan), **outbound + notifications** (conduit, notifications), **static + islands** (the public catalog, proven interactive in the built output), the `@frontierjs/ui` re-skin, the four screens that drive the kit's behavioral components, and the shop: a catalog with variants and photographs, a basket a stranger owns, a currency toggle, **inventory with reservations**, **an order that records what was bought**, and a **`widgets/` surface** whose buy button runs on a page the shop does not own |
| **Committed** | yes — 308 tracked files under `example/` |

The app is a shop: `Product`, `Customer`, `Order`, one `db/schema.lite`, real
auth with a gate ladder, and an order state machine driven from the UI.

Packages exercised: **every one of them** — litestone, junction, auth, sierra,
mesa, css, ui, caravan, conduit, notifications and **email-kit**. Out of scope
by design: jetty (a different container) and the VS Code extension.

---

## What is proven

Each claim, and the drive that asserts it: `docs/proven.md`. Running the drives against the production build: `docs/drives.md`.

---

## Layout

Directory map of `db/`, `api/`, `web/`, `site/`: `docs/layout.md`.

`bun run api` (:8110) · `bun run web` (:8010) · `bun run dev:site` (:8610) ·
`bun run verify` · `bun run verify:ui` ·
`bun run verify:live` · `bun run verify:jobs` · `bun run verify:notify` ·
`bun run email:preview` ·
`bun run build` · `bun run verify:build` · `bun run build:site` ·
`bun run verify:site` · `bun run reset`

Sign in: `sam@shop.test` (level 4), `alex@shop.test` (level 5) or `kit@shop.test`
(level 7, the only one who may reset somebody's lost second factor), password
`correct-horse-battery`. The header buttons do it.

---

## Framework changes this app forced

Thirty-two defects found and fixed, in four waves: `../docs/changes-archive/example.md`.

---

## Known-imperfect, deliberately

- **Anonymous callers get 403 on a custom action, not 401.** CRUD answers 401.
  Not chased; the affordance is disabled either way.
- ~~**The store refreshes by re-issuing `find()` after an action.**~~ Gone
  2026-08-06 — it re-grades from the broadcast now. That refetch turned out to
  be the *mask* over the live-updates gap, not merely wasteful: it made the
  acting tab look right while every other tab went stale (`FJS-033`).
- **`bun run verify` signs in twice per run** against a 10-per-15-min limit, so
  and the other drives sign in once each (`verify:notify` twice, to show two
  users) — a full sweep of all five costs 7 logins. The example raises its own
  limit to 100 in `api/src/app.ts` for exactly that reason, and says why. Both drives now say so plainly rather than timing out (`FJS-086`,
  closed 2026-08-06) — the limiter is a per-IP in-process `Map`, so restarting
  the API resets it.
- **Transition names are written twice** — in `@@transitions` and as service
  action names. A mismatch is a clean 404/400, not a silent no-op, but it is a
  seam worth watching.

---

## Working notes for a cold start

- **Two processes.** With the API down, Vite answers `/api`
  with an empty-bodied 502 and the app says which process is missing rather than
  rendering plausible empty tables.
- **`bun run reset`** deletes everything derived and runs `bun run db:seed`. A
  boot no longer seeds — the seed is a script, so nothing writes to the database
  by being imported.

  **It clears `db/public/` too, and that one is about size rather than
  correctness.** Object storage for `File` columns is content-addressed, so every
  seed run uploads the same eight images from `db/seed-media/` under fresh keys
  and nothing removed the old ones. Measured before it was added to the list:
  **3,871 files and 817MB on disk against 19 rows the shop actually
  references** — 99.5% orphaned, accumulated over roughly two hundred seed runs.
  Nothing was broken by it; it was 800MB of dead bytes in every working tree,
  and a fresh clone earned its own within a week of running the drives.
  Do this if a run leaves the data changed — `verify` itself is idempotent.

  **It deletes `db/jobs.db` too, and that is not tidiness.** The queue is a
  separate SQLite file and it used to survive a reset, so a `courier-book` row
  enqueued by an earlier run stayed `pending` with *no such principal* — the
  staff member it recorded went with the reseeded database. Caravan's `unique`
  is a lock on work that is still owed, so `courier-book:5` held its key against
  every later run, and `ship` on order 5 dispatched nothing at all. What that
  reads as is `verify:jobs` failing `job.wroteTracking` **while `job.record`
  passes**, because the row the drive finds is the previous run's. The same
  thing took `verify:notify`'s `payment-announce` down. Both are green from a
  reset that includes the queue.
- **The browser drives default to `http://localhost:8010` — check who is
  answering it.** Another app on this machine wanted the same port, and a drive
  pointed at somebody else's dev server reports `home.heading: "Sign in"` and an
  empty nav, which reads exactly like this app being broken. Every drive takes
  `UI_URL=`, so start Vite on a free port (`bun run web -- --port 5284
  --strictPort`) and pass it. `verify:site` is unaffected — it serves the
  built directory itself.
- **The drive is the spec.** If you change a screen, `web/test/verify.mjs` is
  where the claim lives. Never return a bare `null` from a probe (CDP omits
  `value`, so it reads back as `undefined`), and never start an evaluated
  expression with `return` followed by a newline (ASI makes it `return;`).
- **`bun install` copies workspace deps.** Edits to a package's source are
  invisible here until reinstall. That is the thing most likely to fool you
  while changing the framework and watching this app.
- **The API is the source of truth for a gate.** `x-gate`, `x-transitions` and
  `can()` are affordances; every one of them is graded again on arrival.
