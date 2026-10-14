# Haven — Project Context

An FJS app laid out like `basecamp` (`FJS-D977`): `db/`, `api/`, and one `web/`
built for two targets (`FJS-D985`) — the terminal (`fli haven`, `fli dev:tui`)
and a browser (`bun run web`, `fli dev`). Six modules differ per target and
nothing else: `#paint`, `#cell`, `#sign-in`, `#errand`, `#workers` and `#seen`, the
package's `imports`, whose `browser` condition Vite takes and Bun does not. The plan, and the first open
box, is `IDEAS/haven.md`.

## Layout

| Path | What |
| --- | --- |
| `db/schema.lite` | Member · Room · Message · Session — gates, the `bannedAt` policy, the mod standing (`role`, `@guarded`, and the two predicates that say what a mod may do — `FJS-D998`), the audit trail |
| `db/test/schema.test.js` | each access rule admitted once and refused once through a real scoped client |
| `api/index.ts` | starts the app on `PORT`, else 5505 (the global tooling block's `haven` slot), after creating any of `ROOMS` the database lacks |
| `api/src/app.ts` | builds the app, never starts it; the session key is `HAVEN_SESSION_KEY` or `sessionKey` |
| `api/src/login.ts` | `POST /haven/login` — an Ed25519-signed `{ publicKey, nick }`; the first login makes the member (`FJS-D981`), and every login writes `role` from `HAVEN_MODS`, both ways |
| `api/src/client.ts` | `GET /haven/client` — the package and version this server runs, read from `package.json`; what `fli haven` installs on a machine with no checkout (`FJS-D982`) |
| `api/src/auth.ts` | Haven's `IAuth`: mints a `Session` (Grant) and reads a token back to its member |
| `api/src/rooms.ts` | the room channel's one spelling, `ROOMS` (a row per scene, the workshop's included), the `{ x, y }` move, the join at the upgrade — the frame shapes `web/` imports |
| `api/src/retention.ts` | `sweepRooms(db, { keep })` — a room keeps its newest `KEEP` (500) lines; `app.ts` puts it on `app.scheduler` every hour, through `asSystem()` so each dropped line reaches the trail. A count per room, never a window of days (`FJS-D748`) |
| `api/src/principal.ts` | the one read of the standing — `bannedAt` and `role` — for a call (`principal:`) and a socket frame (`channels({ claims })`) |
| `api/src/services/` | `messages` (find/get/create, rate-limited per member), `rooms`, `members` |
| `api/test/room.test.ts` | real sockets: two members see each other, a door moves a figure between rooms, a banned one sees and is seen by nothing |
| `api/test/login.test.ts` | the signed login — forged, tampered, replayed and stale make nothing; a dead session closes 4001 |
| `api/test/retention.test.ts` | seven lines in one burst keep exactly three, a room under the count is untouched, a second sweep finds nothing, and the app has the sweep on its clock |
| `api/test/client.test.ts` | the stated version is the manifest's, answered with no session |
| `api/test/sign-in.ts` | a test's machine walking in, with the signed request's parts kept for a test that tampers with them |
| `web/src/routes/` | `index.mesa` the square, `tavern.mesa`, `road.mesa`, `woods.mesa`, `docks.mesa`, `workshop.mesa` — each one `WalkIn` around its scene; the tavern's passes its scene a `<Runner />`, the workshop's a `<Workers />` |
| `web/src/components/WalkIn.mesa` | a route's body: asks the socket for the scene's room, reads its Room row, then provides it as `$context.room` and lets the scene in |
| `web/src/components/Scene.mesa` | one room drawn (`FJS-D997`): makes a stage, provides it as `$context.scene`, paints it with `#paint`; and with a `$context.room`, a figure per `presence()` member, a bubble per member's newest line, the input line — a line beginning `/` is a command, `/ban <nick>` and `/unban <nick>`, an ordinary patch of `bannedAt`, and `/map`, which opens `WorldMap` (Esc closes) and keeps this scene's snap at mount; a step onto a door is `goto`; PageUp opens the room's history over the art and pages back through it, PageDown forward and closed past the newest, Esc closes. With no room it is a picture |
| `web/src/components/Piece.mesa` · `Row.mesa` · `Door.mesa` · `Pacer.mesa` | what a scene is made of — each claims cells on the stage it is inside and draws nothing itself: a piece at `x, y`, a piece `n` times `step` apart, a door that replaces the wall cell under it — with a `w` or an `h` a run of door cells, a border along an edge — a sprite pacing a row |
| `web/src/components/Runner.mesa` | a boy who runs in through a door with `#errand`'s answer, drawn on this screen only and never sent; placed by a route, inside the scene's `<slot />`, so a scene's picture and its test run no command |
| `web/src/components/Workers.mesa` | the Claude sessions editing on this machine (`#workers`), a `✻` each at the bench of its package whatever the fog, `(! N here)` beside a bench with two or more, and the one beside this figure read out — session, file, how long ago; read every second, drawn on this screen only and never sent (`IDEAS/haven.md` Phase 11) |
| `web/src/stage.js` | `createStage()`: the cells a scene's pieces claim, one owner per cell (two pieces on one cell throw naming both), `walkable`, `doorAt`, `look()` — how a cell is painted at a tick, through the fog — `see(x, y)`, the figure that sees, and `seer`, where it stands, `light(x, y)` → `lit`/`dim`/`dark`, `lights`, and the pure `litAt(stage, x, y, from)` under them (`SIGHT`, a palette entry's `light: r`), `arrival()`, where a figure stands having come through a door (beside the door back to `from`, nearest the cell crossed, so a border is crossed at its row), `pacerAt()`, `picture()`, and `marks`, every placed thing in order, which the editor moves; `view`, the slice a screen draws (`VIEW`, 97×26, at most), `follow(x, y)`, which pans it when the figure comes within `EDGE` of a side, and `showAll()`, the editor's; the pure `follow()` a drive mirrors a terminal's view with; `stages` by slug, for a test or a drive |
| `web/src/scenes/Square.mesa` · `Tavern.mesa` · `Road.mesa` · `Woods.mesa` · `Docks.mesa` · `Workshop.mesa` | each scene as a tree: its one-off piece blocks and palette in `<script>`, its `<Scene>` of placed tags after. The square is 160 cells wide, a screen and two thirds, its frame its own `framed(159, 26)`, with borders east onto the road, west into the woods and south down to the docks; every other scene one screen. The workshop is a `namedBench` per `packages/*`, `example` and `frontierjs`, through the house beside the tavern's, and full at 28 |
| `web/src/scenes/*.frame.txt` | each scene's picture, rendered from the tree and pinned by `scenes.test.js`; `bun run frames` rewrites them, and the diff is the review |
| `web/src/pieces/` | `piece()` and the pieces any scene may use, each a small art and its paint: `frame`, `tree`, `lamp` (its bulb is `Y`, the light), `bench` and `namedBench` (the workshop's, its name a light), `table`, `barrel` |
| `web/src/paint.js` | `#paint` in the terminal: `paint(stage)` — the attach that draws the stage's `view` and its pacers into an OpenTUI frame buffer in color, on the wall clock, redrawn on the shortest step and on any claim or pan changing |
| `web/src/paint.browser.js` | `#paint` in a browser: the same `look()` and `pacerAt()` as a `<pre>` of color runs, in a box laid out in `ch`/`lh` cells — the view's size at every window, the font scaled to fit |
| `web/src/cell.js` | `#cell` in the terminal: `at(col, row, layer, size)` — the attach that places a box on a cell (`FJS-D978`); with a `[cols, rows]` size it is a pane over that many |
| `web/src/cell.browser.js` | `#cell` in a browser: `left`/`top` in `ch`/`lh`, margin and padding zeroed so a bubble's glyph lands on its cell |
| `web/src/sign-in.js` | `#sign-in` in the terminal: the key at `~/.fli/haven/key.json` (made 0600 on the first run), a signed login on every run, and `sessionToken()` — the `HAVEN_TOKEN` `fli haven` handed over. `fli haven` imports this file by path, so the door versions with the server |
| `web/src/sign-in.browser.js` | `#sign-in` in a browser: the same signed login over a WebCrypto key kept in IndexedDB, once per page load; a first login's nick is `?nick=`, else `guest-` and the key's first six characters |
| `web/src/errand.js` | `#errand` in the terminal: `nextErrand()` runs `HAVEN_ERRAND` through `sh -c` for one `{ id, title, url }` (unset, none), and `markDelivered(id)` keeps it in `~/.fli/haven/errands.json` for a day |
| `web/src/errand.browser.js` | `#errand` in a browser: no errand, since a page runs no command on its machine |
| `web/src/workers.js` | `#workers` in the terminal: `recordWorker(input, { root })`, what the `PostToolUse` hook `.claude/hooks/haven-worker.mjs` calls after every edit — `~/.fli/haven/workers/<session>.json` at the bench `benchOf()` names, nothing for a file outside the repo, files a day old deleted — and `readWorkers()`, every session that edited within `QUIET_MS` (ten minutes) |
| `web/src/workers.browser.js` | `#workers` in a browser: no workers, since a page reads no directory on its machine |
| `web/src/map.js` | the map (`IDEAS/haven.md` 6.4), target-neutral: `coarse(stage, route)` — a scene as a snap, its picture at `SCALE` (5×5 cells a glyph), size, doors and route — `remember`/`recall` over `#seen`, `layoutOf(snaps)` placing each scene from its borders (houses in a row under the streets), `drawn()` the rows with `@` on the figure's block |
| `web/src/seen.js` | `#seen` in the terminal: a snap per scene at `~/.fli/haven/seen/<slug>.json` (`FJS-D991`), a slug that is a path writes nothing, a torn file reads as none |
| `web/src/seen.browser.js` | `#seen` in a browser: a record per scene in IndexedDB, database `haven-seen` — its own, since a store added to `haven` is a version bump of the member's key |
| `web/src/components/WorldMap.mesa` | the map pane, placed by `Scene.mesa` while `/map` is open: the kept snaps less this scene's, plus this scene's live stage, drawn over the art and following the figure |
| `web/src/walk-in.js` | `walkIn(slug)`: `#sign-in`'s token, the room as the socket's query, then the token — target-neutral |
| `web/src/main.js` · `App.mesa` · `web/index.html` | the browser's entry and root; the terminal shell mounts a route itself and never reads them |
| `web/config/vite.config.js` | the browser build: 5506 (`havenWeb`) or `WEB_PORT`/`FLI_PORT_FE`, `strictPort`, the API's paths proxied to 5505 or `API_PORT` |
| `web/src/resources/` | `rooms`, `members`, `messages` |
| `web/test/stage.mjs` | a scene mounted headless through Sierra's terminal loader: its stage and the frame the terminal drew — `scenes.test.js`'s and both drives' |
| `web/test/scenes.test.js` | each scene's picture is its `.frame.txt`, and the terminal draws its view's slice of it from the spawn and from the far corner; `follow()` pans only near an edge and stays inside the stage; a glyph and a color at every tick; from the spawn a figure sees part of the scene and every light, and `litAt` on a probe — the radius, a wall seen and the cell behind it not, a lamp from across the stage, lit then dim then dark through `look()`; every door reached from the spawn, leading to a scene with a door back, and every border cell paired with one across at its row; a pacer walks floor only; the stage's own rules — a cell claimed twice refused, a door over a wall, a door run as one mark, `arrival()`, a moved piece freeing its cells |
| `web/test/workers.test.js` | `#workers` over a directory handed in: the bench of a path, a move, quiet, the day's sweep, a torn file, a session id that is a path; and the real hook run as Claude Code runs it, silent and 0 on input it cannot use |
| `web/test/map.test.js` | a snap is its picture at `SCALE` with a door where one is; the real scenes laid out — woods west, road east, docks under the square at the door both name, houses in a row apart; an unwalked scene not drawn; `@` once, in its own scene; a smaller pane cuts; `#seen` round trip, a torn file, another shape and a path slug |
| `web/test/verify-map.mjs` | the map: a pty in a HOME of its own opens `/map` in the square — the square alone, Sam's `@` on the spawn's block — walks through the tavern's door and sees both with `@` in the tavern's block and a file per scene; a second terminal in that HOME draws the tavern it never walked into, a third HOME draws the square alone |
| `web/test/verify-workshop.mjs` | the workshop: three sessions seated through the real hook in a HOME of Sam's, Sam's pty walks from the square through the door, two workers and their count at one bench and one alone, standing beside one reads it; a `--frame /workshop/` from another HOME draws Sam and none of it; a session moving benches and one going quiet |
| `web/test/frames.mjs` | `bun run frames`: every scene's picture rewritten |
| `tests/verify-fresh.mjs` | a machine with no checkout: this tree packed into a Verdaccio that never proxies `@frontierjs/*`, then a bare `oven/bun` container runs `bunx @frontierjs/cli haven` twice — installed, drawn, one member |
| `web/test/verify-explore.mjs` | two terminals: a pty shell walks and speaks, a `fli haven --frame /` sees it, each sees the other; the wall nobody has walked near is blank on both, the lamp lit from across the square, the hedge walked past drawn from memory, and a figure nine rows beyond a frame's sight listed and not drawn; then the door to the tavern and back out beside it, the key is the member, a mod bans; then east off the first screen — the view follows, the frame from the spawn carries the line as a marker on its edge, and a third terminal walking the same way sees the figure where the first screen never reached; then over the border into the road at the matching row, the crossing timed, and back |
| `web/test/verify-browser.mjs` | a pty terminal and a CDP tab on this package's own Vite server in one room, each read off the other's screen — figures, lines, the art cell for cell where the tab's figure sees it and blank on both where nobody has walked, the palette, the stale-build line; then a reload is the same member and the tab's door empties the terminal's square |
| `web/test/terminal.mjs` | the pty shell, its screen replayed from cursor moves, and a scene cell read off it through the view that screen has, counted up from the room's status line under the art — both drives' |
| `editor/` | the scene editor (`IDEAS/haven.md` 5.7), served by `fli haven:scenes` or `bun run scenes` on 5507 (`havenScenes`) — a tool on this machine, never a Haven route |
| `editor/source.js` | a scene FILE as text: `readScene`, the `<Scene>` and its placed tags, and `writeScene`, which splices only what changed — an attribute, a removed tag's line, a tag added before `</Scene>` with its import, the spawn, a palette entry's hexes — so a file saved untouched is its own bytes |
| `editor/doc.js` | the scene as edited: `bind`, the file's tags one to one with the stage's `marks`; `hit`, `cellsOf`, `placeOf`; `problems` (the rules `scenes.test.js` holds, asked while placing); `editsOf`; `record`/`undo`/`redo`, the one history every edit goes through, `packHistory`/`unpackHistory` across a save, and `remapOf`/`rekeyHistory`, since a save renumbers the tags |
| `editor/import.js` | `recognize()`: a pasted block of art as the pieces at hand, largest first — recognition's one home now (`FJS-D997`) |
| `editor/Editor.mesa` · `modules.js` · `main.js` · `index.html` | the page: the scene's own component mounted as the preview, a click that selects, places or moves the spawn, arrows and Delete on the selection, a door's target and a color typed, art pasted in; Ctrl+Z / Ctrl+Shift+Z; `modules.js` is the scene components and `pieces/` Haven evaluates, from the Vite config's `virtual:haven-scenes` |
| `editor/vite.config.js` | the editor's server: mesa's plugin, `@` as the surface's `src/`, and `/__scenes` (GET every scene file, PUT one back), `virtual:haven-scenes`, the scene and piece modules out of `SCENES_DIR` (a drive's copy of `web/src`, inside the package) |
| `editor/test/source.test.js` | the round trip byte-equal over both real scenes, each splice, another shape of file refused by name, the tags bound to a real stage, a click's hit, the problems named, the recognizer, a history rekeyed across a save |
| `editor/test/verify-scenes.mjs` | a CDP tab works the tavern by clicks and keys over a copy of `web/src`, and Save is read back from the copy and mounted headless; after it and a reload Ctrl+Z still undoes; a pasted block of art is placed |

## Traps

- **A ban is a POLICY, so it answers empty rather than 403.** A test asserting
  a banned member is refused will see `[]` and pass for the wrong reason —
  assert the rows an unbanned member still sees beside it.
- **A member grades 3 (CREATOR), not 4.** A member has no `role`, and the
  stock grader reads `role` for presence (`FJS-D197`). A gate written `4` locks
  every member out. A mod has `role = 'mod'` and so grades 4 — but what a mod
  MAY DO is said by predicate (`auth().role == 'mod'`), never by a `4` in a gate.
- **A mod is a nick in `HAVEN_MODS`, read when the app is built and written at
  every login** (`FJS-D998`). A nick added to the list is a mod on their next
  `fli haven`, not at once, and a nick struck from it keeps the standing until
  theirs; the session carries no `role`, so there is nothing to revoke.
- **A member's `/ban` is not refused — it writes nothing.** A field
  `@allow('write')` drops the key (`FJS-D22`) and the row policy filters another
  member's row to no row, so the patch resolves either way. The client reads
  the answered row's `bannedAt` to say *only a mod bans*; a test asserts the
  column, never the promise.
- **`Message.update` is `9`**, so no client — `asSystem()` included — can
  rewrite a line. A fixture that needs to is `asSystem().sql`.
- **A move is a presence update, so it is never answered.** Past 10 a second
  it is dropped in silence (Junction's presence rule); a shape other than
  `{ x, y }` is refused by name with an `error` frame, and extra keys are cut.
- **A room is entered at the upgrade, `/ws?room=<slug>`.** No service method can
  move its caller between rooms (`FJS-2834`), so a door is a reconnect: the
  client's `setSocketQuery`, which a reconnect after a drop keeps. A slug the
  server has no row for joins nothing and says nothing, so the route reads the
  row first and says so on the screen.
- **The query is set before the token.** A client with no socket opens one at
  `setToken`, and set the other way round the first socket asks for the
  square and is cycled at once.
- **The login is not a `credentials` verifier.** That door turns a signature
  into a principal, and an unknown key is no principal yet. It verifies with
  toolbelt directly and keeps its own nonce memory (`FJS-D981`).
- **`asSystem()` reads `Session.tokenHash`.** `@guarded` hides it from every
  scoped client, not from the system, so a test asserting it is absent there
  fails for the right reason.
- **A scene's `presence()` is seeded from the spawn, never from `x`/`y`.** A
  top-level `const` that reads a `let` is derived, so it is made again on every
  step: a second subscribe and an empty roster until the next sync.
- **The scene mounts after the shell's first `focusNext`**, since it waits for
  the room's row, so the input focuses itself by an attach.
- **`fli haven` runs a checkout's Haven when one sits beside it, and the
  server's otherwise.** Beside means `global.fliRoot/../haven` outside any
  `node_modules`; anywhere else it installs the version `GET /haven/client`
  states into `~/.fli/haven/<version>/`. So a change here reaches a stranger only
  when the server runs it, and the package's `version` is what tells two
  deploys apart: two deploys under one version install once.
- **A runtime the installed Haven needs must be in `dependencies`.** The
  checkout's hoisted `node_modules` hides a missing one: `@opentui/core` is an
  optional peer of mesa, present in the workspace and absent from a fresh
  install, and only `verify:fresh` sees the difference.
- **A nick is read only on a key's first login.** `--nick` on a later run
  changes nothing, and a default nick is the machine's user name, which the
  schema's `@regex` can refuse — the refusal is the server's message.
- **A handle a component takes from the stage is a `var`, never a `const`.**
  `const mark = scene.stamp(of, x, y)` reads a prop, so the compiler makes it
  lazy — computed when first read — and a `<Door>` whose mark is read only in
  its teardown is never placed, with nothing failing but the picture. The
  same for `Scene.mesa`'s `stage` and `here`: a presence made in a lazy const
  is made inside the effect that first reads it, and again on every step.
- **A step onto a door carries `from`, `x` and `y` in the query, and the next
  scene reads them at mount.** `arrival()` finds the door back by `to ===
  from`, so a scene reached by a path its doors do not spell (`/road` for
  `/road/`) spawns the figure instead, with nothing said; `page.pathname` is
  the spelling. The move to the arrival is a presence update at mount, after
  the pieces have claimed, so another screen may draw the figure at the spawn
  for one frame first; a drive reads it where it arrives.
- **A border's two runs are two statements, one per scene.** A run that
  stops short of the other's drops a crossing figure beside the nearest cell
  of it; `scenes.test.js` pairs every cell of a run with one across at its
  row, which is the only thing that says so.
- **`stage.doors` is in claim order, and a border claims first.** A drive
  that wants the tavern's door finds it by its `to`.
- **A piece's cells are claimed once; a second piece on a cell throws at
  mount, naming the cell and both.** A door is the one claim allowed over
  another. A scene that mounts is therefore a scene with no overlap, and the
  picture test is what catches a piece on the wrong free cell.
- **A disposed scene is an empty stage.** A piece frees its cells when it is
  destroyed, so a drive or a test reads a stage while its mount is alive
  (`stage.mjs` keeps it); a stage read after `dispose()` has no cells and no
  doors, and a check against it fails in the wrong place.
- **The editor binds tags to marks by position**, the i-th placed tag to the
  i-th mark, so a scene file is a flat list of `<Piece>`, `<Row>`, `<Door>`
  and `<Pacer>` tags under one `<Scene>`: a block in the markup or a tag the
  stage does not know is refused by name. A save renumbers the tags, so the
  undo history is rekeyed before it is kept (`remapOf`).
- **A screen shows 97×26 cells of a scene, and a scene may be bigger.** `VIEW`
  in `stage.js` is `--frame`'s headless 100×30 (`sierra/src/terminal/shell.js`)
  less the status and input lines under the art; the stage's `view` is the
  slice drawn, and it follows the screen's own figure. So two screens in one
  room show different cells, and a cell is read off a screen THROUGH ITS VIEW:
  a `--frame` from the spawn through the stage's own, which a drive never
  pans, and a terminal that walked through the view the drive followed
  beside it (`walk`'s `eye` in `verify-explore.mjs`). A `--frame` of a tall
  scene shows the view round its spawn and nothing above it.
- **A bubble is kept inside the view**, so a figure within a line's length of
  the right edge has its line pushed left of its cell, and a speaker outside
  the view has it on the edge with a marker. A drive reads a line over its
  figure only where the figure stands inside the view's slack (`EDGE`).
- **The editor shows the whole stage** (`showAll()`), and sizes its font to
  the stage's columns rather than a screen's; `paint.browser.js` sets its
  font once, at the attach, so a redraw never takes the editor's back.
- **A per-target module is a `#` import, never `@/`.** `@/` is one directory
  on both targets; a module that differs gets a `browser` twin in the
  package's `imports` and is imported by its `#` name. A twin the map does not
  name is never loaded, and the terminal's would reach the browser build as
  an `@opentui/core` import.
- **A browser cell is `1ch` by `1lh` of the PLACED element's own font.** The
  scene's box sets the font and line height and `cell.browser.js` makes a
  placed box inherit them; a box styled with its own font size or a
  paragraph's line height is placed in the wrong units and looks almost right.
- **A browser's ground is the dark theme, written on `<html>` in
  `web/index.html`.** A palette's default ink is drawn for a dark terminal,
  and `theme:` in sierra.config.js would also be read by the terminal shell.
- **The explore drive reads characters, never colors.** A palette change is
  proved by OpenTUI's `createTestRenderer` and `captureSpans()`, or by eye.
  So a dim cell and a lit one read the same, and a drive proves memory by
  reading a glyph where the figure no longer sees — never by its color.
- **A screen is fogged for its own figure, so no row of its art is sure to
  be drawn.** `cellOf` counts up from the room's status line (`· N here`),
  which a frame with no room lacks: a banned member's frame reads `null`.
  Two screens in one room draw different cells, and a cell is read off a
  screen where THAT screen's figure sees it, or has — `litAt(stage, x, y,
  from)` says which; a `--frame` sees from the spawn and remembers nothing.
- **A light is a palette key, so every glyph painted with it is a source.**
  The square's `y` is its windows; the lamp's bulb is `Y`. A scene that
  places a `lamp` names `Y` in its palette or the bulb is drawn in the
  terminal's own ink with no halo, and nothing says so but the picture.
- **Light passes through walls; sight does not.** A lamp inside a house
  facade lights the square outside it. A figure standing in the dark is
  not drawn and a pacer there is not either; their line still is.
- **The stage relights on every claim**, so a mount of thirty pieces is
  thirty sweeps of the stage — cheap with no seer, since only the lights
  are gathered, and a seer is set after the pieces have claimed.
- **The editor reads one shape of scene file.** A `<Scene slug spawn={{ x, y }}>`
  after the last `</script>`, placed tags one per line inside it, and
  `const PALETTE = {` with one entry per line in the script; a file written
  another way is refused by name when it is opened or saved, never guessed at.
- **The editor's marks overlay is laid out in the scene box's own font.** A
  mark positioned in `ch`/`lh` of another font sits on the wrong cell, and
  the drive reads marks by geometry, so it names the cell it expected.
- **A drive's copy of `web/src` sits inside this package** (`editor/.copy-<pid>/`),
  never under `/tmp`: `#paint` and `#cell` resolve through the nearest
  `package.json`, and a copy with none above it draws nothing.
- **A save writes a module Vite is serving, and Vite answers with a hot
  swap of `Editor.mesa`, not a reload** — its script runs again with fresh
  state, so anything the editor holds across a save goes through
  `sessionStorage` (the undo history does). A drive that saves points
  `SCENES_DIR` at a copy's `scenes/`; the page evaluates the copy, so the
  swap happens there as in the tree.
- **Litestone's `retention` is per DATABASE, every model with a `createdAt`.**
  Declared on `main` it sweeps members and rooms with the lines, so `main`
  declares none and `api/src/retention.ts` is Message's retention: a count
  per room through `asSystem()`. Its `deleteMany` reaches the `messages`
  channel with no row, which Junction says in a warning once per sweep that
  dropped something; a line nobody's screen still holds is announced to nobody.
- **A worker is read from the HOME of the process drawing it, and Bun reads
  HOME once.** `homedir()` ignores a later change to `process.env.HOME`, so a
  test that wants other workers runs a child with its own HOME
  (`verify-workshop.mjs`), and the unit tests hand `dir` in.
- **A package with no bench is a session with nowhere to stand**, drawn
  nowhere and said nowhere; `scenes.test.js` holds the bench set against
  `packages/*`. The workshop is full at 28, so the next package widens it.
- **The ban is read per call and per frame, never off the session.** With a
  `claims` resolver installed every committed write re-grades every room, so a
  write costs one `Member` read per person standing in a room.

- **The map is a command, not `m`.** The line input holds every letter, so a bare
  key is typed into the line (the workshop's reading met it too). A scene opens in
  NORMAL, so a drive types `i` before `/map`.
- **A snap is written once, at mount, and the fog is off.** `FOG` in `stage.js`
  makes a scene seen whole on arrival. With it on, what a visit uncovered would
  have to be merged into the file and written on leaving; nothing does that,
  and nothing says so.
- **The map is laid out from the doors, so a scene needs a border back.** A
  neighbor is placed by the border that leads to it, aligned on the two doors'
  rows or columns; with no border back it is placed by the one door, unaligned.
  A scene reached by single-cell doors only goes in the bottom row.
- **A map wider than the pane is cut at its right and bottom**, not scaled; the
  current world is 72×21 glyphs in a 94×24 pane.
- **A drive's terminal with no HOME of its own writes `~/.fli/haven/seen/` on
  the machine running it** — `verify-explore` and `verify-browser`'s do. The
  files are the real scenes' pictures, so it is harmless, but a map drive sets a HOME.

## Proving a change

**By hand:** `bun run api` (or `fli dev`) here, then `fli haven` anywhere in the
checkout. The script supplies a dev session key; `bun run start`, which a
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
(Chrome; it starts its own server over a copy of `web/src`). `Workers.mesa`, `#workers`, the workshop or the hook are proved by `bun run verify:workshop` (bun, util-linux `script`; it starts its own API). `map.js`, `WorldMap.mesa`, `#seen` or `/map` are proved by `bun run verify:map` (the same) and, for the browser twin, `verify:browser`. A change to
`web/src/sign-in.js` or `packages/cli/commands/haven/` is proved by
`verify:explore` too, and `api/src/client.ts`, the door's installer or this
manifest's `dependencies` by `bun run verify:fresh` (Docker, network).
