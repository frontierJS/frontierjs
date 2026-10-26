# Haven — Project Context

An FJS app laid out like `basecamp` (`FJS-D977`): `db/`, `api/`, and one `web/`
built for two targets (`FJS-D985`) — the terminal (`fli haven`, `fli dev:tui`)
and a browser (`bun run web`, `fli dev`). Ten modules differ per target and
nothing else: `#paint`, `#cell`, `#sign-in`, `#errand`, `#workers`, `#taskmaster`, `#ledger`, `#seen`, `#sound` and `#study`, the
package's `imports`, whose `browser` condition Vite takes and Bun does not.
**A `#name` import is a target seam and nothing else**: use it only where the map swaps the file per target (`x.js` default, `x.browser.js` browser). Everything else stays relative or `@/`. The plan, and the first open
box, is `IDEAS/haven.md`.

## Where things are

`docs/layout.md` is the file-by-file map. The owners that matter on most turns:

- `db/schema.lite` — Member · Room · Message · Game · Vote · Miss · Session; every gate and the ban policy live here, `db/test/schema.test.js` admits and refuses each rule once.
- `api/src/app.ts` builds the app; `rooms.ts` is presence, moves and footprints; `login.ts` + `keyless.ts` the two doors (`HAVEN_POST_KEY`); `messages`, `votes`, `hearing.ts`, `barkeep.ts`, `townhall.ts` and `services/` are the rest; `agents/` the stand-in actors.
- `web/src/lib/scene/stage.js` is the stage (cells, doors, `viewFor`/`fit`/`follow`), `paint.js` beside it draws, `cells.js` measures glyphs, `paths.js` walks the floor, `map.js` the world map; `web/src/lib/hash/taskmaster.js` the taskmaster; `editor/` at the package root is the scene editor; `scenes/*.mesa` each with a `*.frame.txt` + `*.world.json`; `#name` imports are the ten target seams (`x.js` terminal, `x.browser.js` browser).
- `packages/cli/commands/haven/` is `fli haven`; drives are `web/test/verify-*.mjs` over `stage.mjs`.

## Traps

The ones that bite most; every trap is `docs/traps.md`, read it before touching
the stage, the editor, lighting, weather or presence.

- **A ban is a POLICY, so it answers empty rather than 403.** Assert the rows an unbanned member still sees beside it, or the test passes for the wrong reason. The ban is read per call and per frame, never off the session.
- **A member grades 3 (CREATOR), not 4**; a mod is a nick in `HAVEN_MODS`, read at build and written at next login. A member's `/ban` is not refused, it writes nothing.
- **`Message.update` is `9`**, so no client, `asSystem()` included, edits a line. A move is a presence update and is never answered.
- **A room is entered at the upgrade, `/ws?room=<slug>`**; the query is set before the token. A socket `service_call` carries filters in `params: { query }`.
- **The login is not a `credentials` verifier**, and `asSystem()` reads `Session.tokenHash` because `@guarded` hides it from everyone else.
- **`fli haven` runs a checkout's Haven when one sits beside it**; a runtime the installed Haven needs must be in `dependencies`, and no `HAVEN_POST_KEY` means every chain login is a 503.
- **A handle a component takes from the stage is a `var`, never a `const`**; a piece's cells are claimed once, a border claims first, and a disposed scene is an empty stage.
- **A per-target module is a `#` import, never `@/`.** A browser cell is `1ch` by `1lh` of the PLACED element's font; the browser's ground is the dark theme on `<html>`.
- **A screen shows as many cells as its terminal holds (`VIEW` 97×26)**, a bubble is kept inside the view, and a wide glyph under the terminal's overhead is blanked whole.
- **The explore drive reads characters, never colors**; a light is a palette key and passes through walls, sight does not; weather changes GLYPHS, so a drive pins `HAVEN_WEATHER`/`HAVEN_SEASON` and `clock-at.mjs` `ms=0` is day.
- **A save writes a module Vite is serving**, so the editor hot-swaps; a drive's copy of `web/src` sits inside this package (`editor/.copy-<pid>/`).
- **Litestone `retention` is per DATABASE**, every model with a `createdAt`.
- **A task starts the fix loop on this machine, on the owner's bill.** Drives never run the real loop or the real `claude`.
- **HOME is read once**, so a drive's terminal with no HOME of its own writes `~/.fli/haven/seen/`.

---

## Proving a change

**By hand:** `bun run api` (or `fli dev`) here, then `fli haven` anywhere in the
checkout. The script supplies a dev session key and 16 sockets per address
(`HAVEN_WS_PER_IP`; the app's own default of 4 refuses `bun run agents`' seven
with a 503, which the agent reads as a 1002 close); `bun run start`, which a
deploy runs, refuses to boot without `HAVEN_SESSION_KEY`. `HAVEN_MODS=<nick>`
before either makes that nick a mod on its next login, so `/ban` and
`/unban` can be tried on a second terminal.

`bun run test` from this directory — `scenes.test.js` pins each scene's
picture, and `bun run frames` rewrites the pictures when a scene was meant to
change — and `bun run verify:explore` for anything under `web/` (bun,
util-linux `script`; it starts its own API). Anything a
browser loads — a `.browser.js` twin, `Scene.mesa`, `WalkIn.mesa`,
`walk-in.js`, `main.js` or the Vite config — is proved by `bun run
verify:browser` as well (Chrome too; it starts its own API and Vite server).
`bun run tui` runs the routes by hand with a token you hold
(`HAVEN_TOKEN=<a session> bun run tui -- --api <url>`); `fli haven --api <url>`
signs this machine in first. `bun run web` beside `bun run api` serves the
browser Haven on 5506, and `bun run dev` runs both. `editor/` and `fli haven:scenes` are proved by `bun run verify:scenes`
(Chrome; it starts its own server over a copy of `web/src`). `Workers.mesa`, `#workers`, the workshop or the hook are proved by `bun run verify:workshop` (bun, util-linux `script`; it starts its own API). `Ledger.mesa`, `#ledger` or the workshop route by `bun run verify:ledger` (the same; it never writes this tree's `ledger.data.js`). `Assembly.mesa`, `TownHall.mesa`, `pieces/townhall.js` or the votes service by `bun run verify:townhall` (the same). `Barkeep.mesa` and the tavern route by `bun run verify:bar` (the same), which does not ask him anything; `barkeep.ts` has no test of its own yet. `Taskmaster.mesa`, `taskmaster.js`, `commands.js` or any actor on `$context.commands` are proved by `bun run verify:taskmaster` (the same); it never runs the real loop, which spends money. `HomeRow.mesa`, `home-row.js` or `Scene.mesa`'s keydown are proved by `bun run verify:home-row` and `bun run verify:bolt` (the same). `map.js`, `WorldMap.mesa`, `#seen` or `/map` are proved by `bun run verify:map` (the same) and, for the browser twin, `verify:browser`. `hearing.ts`, the messages service's channel or `/w` are proved by `bun run verify:hearing` (the same). `cells.js`, or the width of anything said — a bubble, the history, the booth — by `bun run verify:emoji` (Chrome too). Footprints — `stepped()`, `rooms.steps`, `presenceMeta` in `rooms.ts`, `tread` or the `steps` layer — by `bun run verify:steps` (the same). The view's size — `viewFor`, `fit()`, `follow()` in `stage.js`, the fit in `paint.js` — by `bun run verify:view` (the same; it resizes its pty). `hidden` in `Door.mesa` or `stage.js`, or `Cellar.mesa`, is proved by `bun run verify:cellar` (the same); `night` there, `Glade.mesa`, the woods' plank or `clock-at.mjs` by `bun run verify:glade` (the same). `Runner.mesa`, `errand.js` or the tavern route are proved by `bun run verify:errand` (the same). A change to
`agents/` is proved by `agents/test/agents.test.js` in `bun run test`, which
never runs the real `claude`; its live halves are skipped until an agent can
walk in ([FJS-3471](../../ISSUES.md#fjs-3471)). A change to
`web/src/lib/session/sign-in.js` or `packages/cli/commands/haven/` is proved by
`verify:explore` too, `sign-in.browser.js` by `verify:browser`, and `api/src/client.ts`, the door's installer or this
manifest's `dependencies` by `bun run verify:fresh` (Docker, network).

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
ace.md agents.js agents.test.js answer.js App.mesa app.ts archery.js ask-claude.js Assembly.mesa 
auth.ts band.js Band.mesa band.service.ts Barkeep.mesa barkeep.service.ts barkeep.ts Bar.mesa 
bar.test.js basecamp-home.mjs basecamp-reports.mjs bell.js board.js bolt-service.test.ts 
bolt.test.ts bolt.ts booth.js booth.mesa Booth.mesa booth.ts Brigade.mesa Bubbles.mesa campfire.js 
camp.js canal.mesa Canal.mesa Carousel.mesa carousel.ts cellar.mesa Cellar.mesa cell.browser.js 
cell.js cells.js charles.md checkers.js checkers.ts CLAUDE.md client.test.ts client.ts clock-at.mjs 
clock.test.js colin.mesa Colin.mesa commands.js commands.test.js Crier.mesa crier.ts crowd.js 
crowd.test.js Desk.mesa Dice.mesa dice.service.ts dice.ts doc.js docks.mesa Docks.mesa Door.mesa 
Editor.mesa emoji.test.js Emotes.mesa errand.browser.js errand.js errands.json face.js facing.ts 
Fishing.mesa fishing.service.ts fishing.ts fix-loop.mjs flip.js frames.mjs frame.txt 
frontier-network.md furniture.js games.service.ts glade.mesa Glade.mesa growth.js haven.md 
haven-worker.mjs hearing.test.ts hearing.ts History.mesa home-board.js HomeBoard.mesa 
home-board.test.js home.js home-row.js HomeRow.mesa home-row.test.js hud.js Hush.mesa images.js 
import.js index.html index.js index.mesa index.ts inventory.ts island.mesa Island.mesa ISSUES.md 
jordan.mesa Jordan.mesa kept.js key.json keyless.ts keys.md kitchen.js kitchen.mesa Kitchen.mesa 
lane.mesa Lane.mesa ledger.browser.js ledger.data.js ledger.js Ledger.mesa ledger.mjs 
ledger.test.js login.test.ts login.ts main.js map.js map.test.js market.mesa Market.mesa marks.js 
marrow.md memory.test.ts memory.ts menu.json messages.service.ts meta.test.ts mine.mesa Mine.mesa 
Mod.mesa modules.js Nameplates.mesa nell.md Notices.mesa overview.md Pacer.mesa pacer.ts 
package.json paint.browser.js paint.js paths.js paths.test.js pet.js Pets.mesa Piece.mesa pike.md 
plan.js play.ts postoffice.mesa PostOffice.mesa principal.ts Profile.mesa range.mesa Range.mesa 
ravine.mesa Ravine.mesa README.md retention.test.ts retention.ts road.mesa Road.mesa rooms.ts 
room.test.ts Row.mesa rows.js Runner.mesa said-frame.mjs scars.test.js Scene.mesa scenes.test.js 
schema.lite schema.test.js scope.js Scores.mesa seen.browser.js seen.js session.js setlist.ts 
shape.ts sign-in.browser.js sign-in.js sign-in.ts Sitting.mesa sky.js sky.test.js snoozed.json 
snooze.js sound.browser.js sound.js source.js source.test.js Square.mesa stage.js stage.mjs 
steps.test.js stone.js Stops.mesa storage.js study.browser.js study.js study.json study.md 
Study.mesa tabs.js tam.md taskmaster.browser.js taskmaster.js taskmaster.json Taskmaster.mesa 
taskmaster.test.js tavern.mesa Tavern.mesa terminal.mjs townhall.data.json townhall.js 
townhall.mesa TownHall.mesa townhall.mjs townhall.test.js townhall.ts town.js transcript.js 
traps.md upstairs.mesa Upstairs.mesa verify-bar.mjs verify-bolt.mjs verify-booth.mjs 
verify-browser.mjs verify-cellar.mjs verify-emoji.mjs verify-explore.mjs verify-fresh.mjs 
verify-glade.mjs verify-hearing.mjs verify-home-row.mjs verify-ledger.mjs verify-map.mjs 
verify-nameplate.mjs verify-scenes.mjs verify-steps.mjs verify-taskmaster.mjs verify-townhall.mjs 
verify-view.mjs verify-workshop.mjs vite-ask.js vite.config.js vlad.mesa Vlad.mesa VOCABULARY.md 
votes.service.ts votes.test.ts walk-in.js WalkIn.mesa wall.js water.js Whisper.mesa wick.md 
woods.mesa Woods.mesa workers.browser.js workers.js Workers.mesa workers.test.js working.js work.js 
Work.mesa workshop.frame.txt workshop.js workshop.mesa Workshop.mesa world.js world.json 
WorldMap.mesa world.test.ts world.ts 
-->
