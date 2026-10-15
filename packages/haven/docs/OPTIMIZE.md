---
status: active
---

# Haven — optimization plan

A read-only review of the whole package (2026-10-15), three slices: render core, UI and client, api/db/agents/editor. Not filed as `FJS-###` on purpose — this file is the ledger until a step is fixed or promoted. Line numbers are from the tree at review time; re-find by name before editing. Each finding says **measured**, **read** (confirmed by reading code and `rg`), or **plausible**.

Benches that mount real scenes through `web/test/stage.mjs` were written to a session scratchpad and not kept; one full view is 97×26 = 2522 `look()` calls, timings in bun, ±20%.

## Phase 0 — Baseline

Goal: know what costs what before cutting.
Done when: every finding below carries a measurement or a read.

- [x] 0.1 Review the three slices
- [x] 0.2 Measure step, door and paint cost on Square and Workshop
  - One step on Square: 12 ms, 3.52 full repaints.
  - Door: Square teardown 194 ms (113k `look` calls, ~45 repaints) + mount 52 ms; Workshop 189 + 90 ms.
  - One paint: 2.6–3.3 ms.

**Done 2026-10-15.**

## Phase 1 — Bugs found on the way

Goal: the five defects the review tripped over.
Done when: each has a fix and the package's own suite passes.

- [x] 1.1 The map snap folds held weather — `web/src/map.js` `glyphOf` calls `look(x, y, 0)`, which still applies a held `/weather`; under `hold('weather', 'snow')` 8 Square blocks were written to `~/.fli/haven/seen` as `*`. Measured. Count over the day's picture plus a door check instead (also 13 ms → less per walk-in).
- [x] 1.2 A held errand carries its first caller's AbortSignal — `web/src/errand.js` `homeBoard` shares one promise across callers, built with the first one's signal; leave the lane mid-run and a home sharing it shows "the board is blank: …aborted". Plausible.
- [x] 1.3 `taskmaster.js` leaks a file descriptor per loop started — `openSync(log)` is handed to `spawn` and never closed in the parent. Read.
- [x] 1.4 The Vite proxy misses `/votes` and `/barkeep` — `web/config/vite.config.js` `API_PATHS` lists three of five services; an HTTP fallback (Assembly's `tally` before the socket opens) gets the SPA's HTML. Read; derive the list from `api/src/services/`.
- [x] 1.5 The Session table grows without bound — `api/src/auth.ts` mints a row per login and per agent reconnect, nothing deletes; dev db held 109 sessions for 5 members. Read; sweep expired and revoked rows in the hourly job in `api/src/app.ts`.

**Done 2026-10-15.**
- 1.1: `coarse()` counts over `stage.picture()`, read once per snap. A probe held snow and got the same rows, and a snap now takes 1.3 ms where it took 13.
- 1.2: `homeBoard()` takes no signal. `HomeBoard.mesa` drops an answer that arrives after it is destroyed.
- 1.3: `closeSync` after `spawn`. A probe started five loops: the log fd is gone, and the pidfds free when the children exit.
- 1.4: `API_PATHS` is read from `api/src/services/*.service.ts`; all five are proxied.
- 1.5: `sweepSessions(db)` in `auth.ts` deletes expired rows, revoked ones included once they expire. The hourly job runs it.

Checks: `bun run test` failed only the 6 outdoor `scenes.test.js` frames, which the moon (7.9) in flight in another session draws as `)`. `verify:browser` failed only its fog check, which `IDEAS/haven.md` says fails while `FOG` is off.

## Phase 2 — Per-step cost

Goal: a step costs one paint and re-renders only what moved.
Done when: a Square step measures ≤ 4 ms and one repaint, two where it pans.

- [x] 2.1 Cache `stage.view` — `web/src/stage.js` `get view()` returns a fresh object per read; mesa compares with `Object.is`, so every `tell()` re-renders Scene and nine slot components (Notices, Taskmaster, Bar, Assembly, Workers, HomeBoard, Barkeep, Runner, Profile) on every other member's step. Keep one object until x/y/w/h changes. Read.
  - Done: one object, replaced only when x/y/w/h moves. A probe on Square: the same object across `see`/`touch`, a new one after a pan and after a `fit`. `verify:view` passes. `verify:explore` fails 6, none from this: 4 fog checks (fog off), and 2 that expect an off-screen marker for a plain line, which 7.1 limited to a shout — the drive is stale.
- [x] 2.2 Paint only when the art changed — measured 3.5 repaints per step:
  - `see()` relights and tells, but no scene names `fog`; notify, and invalidate only under fog.
  - `occupy()` repaints on every figure move; invalidate only if a changed cell `crumbles` or is a seat of a `burns` piece.
  - `follow`/`fit` go through `changed()`, re-running extent + relight; set `eye` and tell.
  - Split `relight` into light sources (claim change) and fog (seer change).
  - Done: `relight` is `lightUp` (claims) and `fogUp` (seer); `see` without fog only notifies; `occupy` invalidates when a plank starts or stops shaking or a `burns` seat changes hands (`burnSeats`, dropped with the lights); `follow`/`fit` set `eye` and tell. A bench on Square in Scene's order (tread, follow, see, occupy): 3.31 → **1.00** paints per step inside the slack, **1.31** on a walk east across the square and back, where 31% of steps pan. A probe: a floor step paints 0, taking and leaving a table's stool 1 each with the candle `i`/`.`, `see` 0 paints and 1 notify, `see` under `fog` 1. `crumble`/`clock`/`steps`/`scars` tests pass; `verify:view` and `verify:booth` pass. `verify:explore` fails 7: the 6 from 2.1, plus *Ana's frame of the square no longer shows Sam* (a `.` footprint on the cell before the tavern door), which fails in a worktree of this tree with the 2.2 hunks taken out too.
  - A step that pans still paints twice, the footprint and the pan, because each change outside a frame paints at once. Accepted: pans are rare in play, and 2.3 cuts the cost of each paint. Phase 2's target is now one paint a step and two on a pan.
- [x] 2.3 Per-frame context in `look()` — each outdoor cell calls `sky.js` `almanacAt` 2–3× (~250 ns each, two `new Date`s and an env read), builds ~5 string keys, and runs `layers.includes` ×7. A row builder that computes the sky once per frame, numeric keys `y*4096+x`, and an active-fold list measured 2.6–3.3 → 1.2–1.6 ms per paint. A ms-keyed memo inside `almanacAt` goes stale across `hold()` at the same ms, so the context lives in the builder.
  - Done: `stage.grid(view, ms)` is every cell of a view as `look()` answers it, with the clock asked once (`skyAt`: the almanac, the sky's darkness, the bolt on the sky, the moon's column, and each struck tree's age as its cells ask it). `look()` makes the same context for one cell. Both `#paint`s draw `grid()`. A cell's key is `y * 4096 + x`, so `claim` now refuses a cell left of or above 0,0, or 4096 or more across, by name: such a key would name a cell in the row above. The folds a scene names are one list. A profile had `almanacAt` at 35% of a paint, `cellAt` 13% and `key` 6%.
  - Checks: a fingerprint of every cell of 10 scenes, under each weather held and none, at 6 clocks (day, dusk, night, dawn, a storm's flash), through `look()` and `grid()`, matched the tree before the change on all 240. One view: Square 6.9 → **0.76** ms by day, 7.9 → **1.5** at night, 11.3 → **2.1** in a storm; Tavern 2.2 → 0.8; Workshop 2.6 → 0.6. A Square step in Scene's order measures **1.58** ms inside the slack and **3.08** on a pan (medians, under load 12), so Phase 2's target holds. `bun run test`: 3 fail, none from this. Two are the night-light checks in `sky.test.js` from the lamp rework, whose night output the fingerprint pins as unchanged. The third, an `agents.test.js` regulars check, passes on its own. The editor's `source.test.js`, `verify:view`, `verify:booth` pass. `verify:browser` fails only its fog check. `verify:explore` fails 35: the in-flight Square edit puts the hedge one row under the spawn where the drive expects two, so *a hedge is a wall* fails, and every walk after it starts from the wrong cell. The scenes are being edited in another session, so the drive is stale.
  - 2.5's first half is in: both targets build their grid from `grid()`. The pacer compositing is still two copies.
- [ ] 2.4 Door cost — `remove()` repaints once per removed piece; each `stamp()`/door re-runs `extent()` and `relight()` over every claim with `split(',').map(Number)`, plus `tickOf`. Incremental extent, lazy lights behind a dirty flag, one paint at close (a `stage.close()` Scene's onDestroy calls first). Measured ~250 ms per door on Square/Workshop. Risk: drives rely on *a change outside a frame paints at once*, so defer only mount and teardown paints, never a step's.
- [ ] 2.5 One grid builder for both targets — `paint.js` and `paint.browser.js` build the grid and composite pacers separately, and already disagree on a pacer cell's bg (`CLEAR` vs `cell.bg`; latent, no palette sets `bg`). Do with 2.3. Read.

## Phase 3 — Network and polling

Goal: an idle screen makes no calls; a door makes only the calls it needs.
Done when: a screen standing still for a minute sends nothing to the API.

- [ ] 3.1 Profile polls `members.inventory` every 3 s on every screen, drawn or not, full or not (`Profile.mesa`). Compute regen on the client from `ITEMS.regenMs`; re-ask on its own `bolt`/`pickup`, or use the `shot.arrows` HomeRow already gets back. Read.
- [ ] 3.2 Cache standing behind `claims` — `api/src/rooms.ts` `claims` → `standingOf` reads one Member per person; with a claims resolver installed Junction's reach cache is off (`junction/src/transport/channels.ts`), so every committed write re-grades every room and a line said costs ~2 × (online) reads. Per-member cache cleared by `db.$tapEvents` on a Member write keeps a ban immediate. Read.
  - Q1: drop the resolver altogether (the policies read only `bannedAt`) so the reach cache comes back on? A Data-realm change; needs a ruling.
- [ ] 3.3 One nick cache and one room cache — Scene `askNicks`, `Notices.mesa` `askNames`, `Booth.mesa`, `Whisper.mesa`, `Mod.mesa` each fetch members their own way, full rows for a nick; `WalkIn.mesa` fetches the Room by slug before the scene mounts, `Notices.mesa` the board room every visit. A `web/src/nicks.js` (module-level Map, batched `find` with `select`) and rooms cached by slug. Read.
- [ ] 3.4 `votes.tally` reads the whole Vote table, once per screen, per vote (`votes.service.ts`; `Assembly.mesa` re-asks on `tallied`). Count with `groupBy`; read `mine` by `memberId`. Unchecked: whether the row policy applies to `groupBy`.
- [ ] 3.5 Timers that tick for nothing:
  - Taskmaster spawns `fli next` (1.1 s measured) on every workshop walk-in and every ledger change (`{#key ledger}` remounts it); its 1 s `running()` task runs with no `root`. Hold proposals in `taskmaster.js` at module level.
  - Workers polls every 1 s, and in the browser always gets `[]` and re-renders anyway. Skip in the browser; `fs.watch` or mtime cache in the terminal.
  - HomeBoard sets `now` every 600 ms; its text changes by the minute. Tick only `ring` at 600 ms.
- [ ] 3.6 One held-command helper — `Bar.mesa` caches `HAVEN_BAR` per component, `errand.homeBoard` 60 s at module level, Taskmaster not at all. One `held(cmd, ms)` in `errand.js`, the fetch bound to no caller's signal (closes 1.2 for good).

## Phase 4 — Smaller performance

Goal: idle CPU and per-move server cost.
Done when: Colin idles at its placed tick and a move skips the struck set on plain floor.

- [ ] 4.1 `tickOf` counts palette letters nobody placed — Colin's copied home palette carries the fire `h` (110 ms), so Colin redraws at 110 ms instead of 250 ms. Min `ms` over claimed keys; a night-door counter instead of `[...claims.values()].some(…)` per paint. Measured.
- [ ] 4.2 The open WorldMap re-runs `coarse()` over the whole stage per step — compute the layout once in `show()`. Read.
- [ ] 4.3 The browser `replaceChildren`s the whole `<pre>` per paint — one element per row, replace rows whose signature changed. Plausible; needs Chrome to measure.
- [ ] 4.4 Repaint only animated cells on a tick-only frame (fire at 110 ms is ~9 full repaints/s indoors). Plausible; after Phase 2.
- [ ] 4.5 Server move cost — `rooms.ts` builds `new Set(memory.live(…, 'struck'))` before `standable` returns early on plain floor; `memory.ts` `lasting`/`dropOldest` re-filter the room's trace list 2–3× per `add`. Build `gone` lazily; store traces per kind in insertion order so expiry is a shift. Measured 34 → 20 µs per move from the Set alone.
- [ ] 4.6 IndexedDB `store()` opens a connection per call and never closes one (`seen.browser.js`, `sign-in.browser.js`); `remember()` writes per door walk. One db promise per database.
- [ ] 4.7 `figures()` runs three times per presence update (Scene, Nameplates, Emotes). Compute once in Scene and pass it down. Plausible.
- [ ] 4.8 Retention visits every room, booths included (`retention.ts`). One `groupBy` naming the rooms over `keep`. Small; hourly.
- [ ] 4.9 The barkeep loads 2654 passages on the first question (110 ms) and scans all per answer (2.4 ms). Load at boot; index term → passages. Measured.
- [ ] 4.10 `ensureRooms` makes one query per room at boot — one `findMany({ where: { slug: { in } } })`.
- [ ] 4.11 The browser loads all of `@frontierjs/css` (~92 KB min) for `.surface`, `.app`, `.theme-dark`. Plausible; import the foundation pieces.

## Phase 5 — Lines cut

Goal: one place for each repeated shape, ~250 lines gone.
Done when: `rg` finds each helper once.

- [ ] 5.1 Jordan, Vlad and Colin `PALETTE` blocks are byte-identical (21 entries); `f` is in 13/13 scenes, `d` in 12/13. Put furniture letters on the pieces in `pieces/home.js` (12.8's `adopt` route); each home keeps its decor. Closes the cause of 4.1.
- [ ] 5.2 One-off pieces repeated in scenes: `signpost` ×4 (text differs), `shroom` ×2, `flower` ×2. Export from `pieces/`, a `signpost(text)` factory.
- [ ] 5.3 Flood fill — `editor/doc.js` and `web/test/scenes.test.js` keep their own `reach` with O(n²) `queue.shift()`; import `web/src/paths.js`, numeric keys there (Square `reach` 3.0 ms, re-run every 120 ms during an `f` walk).
- [ ] 5.4 Small helpers repeated: `ago()` ×3, `wrap` ×2 (`Barkeep.mesa`, `booth.js`), Chebyshev `away` ×3, `client.on('event')` + filter + `off` ×4, bar stools derived twice, `Season`/`Weather` the same shape, the `.pane p` rule ×6.
- [ ] 5.5 Per-target halves: `signIn` identical in `sign-in.js` and `sign-in.browser.js` (a third copy in `api/test/sign-in.ts`); IndexedDB `request()`/`store()` identical in `seen.browser.js` and `sign-in.browser.js`. A target-neutral `login.js` and `idb.js`. `cli/commands/haven/walk.md` imports `KEY_FILE`, `machineKeys`, `signIn` from `sign-in.js` by path — keep them exported there.
- [ ] 5.6 API boilerplate: the caller-id cast ×5 → `callerId()` in `principal.ts`; four ad-hoc App casts (`RoomApp`, `ChannelApp`, `PlayApp`, `HallApp`) that Junction's `App` already types; `HAVEN_MODS` parsed ×3 → one `parseMods`.
- [ ] 5.7 `stage.js` `tread` and `scorch` are one method on two maps → `lay(map, traces)`; `look`/`dyeAt` repeat the style lookup.
- [ ] 5.8 `agents.js` hand-rolls ~80 lines of Junction's socket client (call ids, ping, presence diff). `createJunctionClient()`. Risk: reconnect and 4001 behavior must match. Plausible.
- [ ] 5.9 Editor: the imported-ident regex twice (`Editor.mesa`, `source.js`); `watch()` re-fetches every scene's source per HMR update because `/__scenes` only lists all.
- [ ] 5.10 Half-wired: `memory.forget()` is called only by tests though CLAUDE.md says a ban forgets; no server path lays `chalk`; `lasting()` leaves an empty `[]` per channel; `workers.browser.js` `QUIET_MS` unused. Wire or cut.
- [ ] 5.11 `Row.mesa` builds `{ name, cells, floor }` and drops the piece's `palette`, `spots`, `crumbles`… → `{ ...of, cells }`. Latent.

## Checked clean

Message `@@index([roomId, createdAt])` serves history and retention; Vote `@@unique([memberId, idea])` serves `cast`; `world.ts`, `townhall.ts` and `client.ts` read their files once; `townhall.data.json` loads only with the townhall route; every route is lazy in both targets; every component is reached.

## Doc drift seen

- `CLAUDE.md` says `presenceMetaBytes` is 100; `rooms.ts` says 120.
- `web/config/sierra.config.js` and `web/config/vite.config.js` say three per-target modules; there are eight.
