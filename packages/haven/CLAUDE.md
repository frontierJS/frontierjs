# Haven — Project Context

An FJS app laid out like `basecamp` (`FJS-D977`): `db/`, `api/`, and one `web/`
built for two targets (`FJS-D985`) — the terminal (`fli haven`, `fli dev:tui`)
and a browser (`bun run web`, `fli dev`). Three modules differ per target and
nothing else: `#paint`, `#cell` and `#sign-in`, the package's `imports`, whose
`browser` condition Vite takes and Bun does not. The plan, and the first open
box, is `IDEAS/haven.md`.

## Layout

| Path | What |
| --- | --- |
| `db/schema.lite` | Member · Room · Message · Session — gates, the `bannedAt` policy, the audit trail |
| `db/test/schema.test.js` | each access rule admitted once and refused once through a real scoped client |
| `api/index.ts` | starts the app on `PORT`, else 5505 (the global tooling block's `haven` slot), after creating any of `ROOMS` the database lacks |
| `api/src/app.ts` | builds the app, never starts it; the session key is `HAVEN_SESSION_KEY` or `sessionKey` |
| `api/src/login.ts` | `POST /haven/login` — an Ed25519-signed `{ publicKey, nick }`; the first login makes the member (`FJS-D981`) |
| `api/src/client.ts` | `GET /haven/client` — the package and version this server runs, read from `package.json`; what `fli haven` installs on a machine with no checkout (`FJS-D982`) |
| `api/src/auth.ts` | Haven's `IAuth`: mints a `Session` (Grant) and reads a token back to its member |
| `api/src/rooms.ts` | the room channel's one spelling, `ROOMS` (a row per scene), the `{ x, y }` move, the join at the upgrade — the frame shapes `web/` imports |
| `api/src/principal.ts` | the one read of `bannedAt`, for a call (`principal:`) and a socket frame (`channels({ claims })`) |
| `api/src/services/` | `messages` (find/get/create, rate-limited per member), `rooms`, `members` |
| `api/test/room.test.ts` | real sockets: two members see each other, a door moves a figure between rooms, a banned one sees and is seen by nothing |
| `api/test/login.test.ts` | the signed login — forged, tampered, replayed and stale make nothing; a dead session closes 4001 |
| `api/test/client.test.ts` | the stated version is the manifest's, answered with no session |
| `api/test/sign-in.ts` | a test's machine walking in, with the signed request's parts kept for a test that tampers with them |
| `web/src/routes/` | `index.mesa` the square, `tavern.mesa` the tavern — each one `WalkIn` around its scene |
| `web/src/components/WalkIn.mesa` | a route's body: asks the socket for the scene's room, reads its Room row, then provides it as `$context.room` and lets the scene in |
| `web/src/components/Scene.mesa` | one room drawn (`FJS-D997`): makes a stage, provides it as `$context.scene`, paints it with `#paint`; and with a `$context.room`, a figure per `presence()` member, a bubble per member's newest line, the input line; a step onto a door is `goto`. With no room it is a picture |
| `web/src/components/Piece.mesa` · `Row.mesa` · `Door.mesa` · `Pacer.mesa` | what a scene is made of — each claims cells on the stage it is inside and draws nothing itself: a piece at `x, y`, a piece `n` times `step` apart, a door that replaces the wall cell under it, a sprite pacing a row |
| `web/src/stage.js` | `createStage()`: the cells a scene's pieces claim, one owner per cell (two pieces on one cell throw naming both), `walkable`, `doorAt`, `look()` — how a cell is painted at a tick — `pacerAt()`, `picture()`, and `marks`, every placed thing in order, which the editor moves; `stages` by slug, for a test or a drive |
| `web/src/scenes/Square.mesa` · `Tavern.mesa` | each scene as a tree: its one-off piece blocks and palette in `<script>`, its `<Scene>` of placed tags after |
| `web/src/scenes/*.frame.txt` | each scene's picture, rendered from the tree and pinned by `scenes.test.js`; `bun run frames` rewrites them, and the diff is the review |
| `web/src/pieces/` | `piece()` and the pieces any scene may use, each a small art and its paint: `frame`, `tree`, `lamp`, `bench`, `table`, `barrel` |
| `web/src/paint.js` | `#paint` in the terminal: `paint(stage)` — the attach that draws the stage and its pacers into an OpenTUI frame buffer in color, on the wall clock, redrawn on the shortest step and on any claim changing |
| `web/src/paint.browser.js` | `#paint` in a browser: the same `look()` and `pacerAt()` as a `<pre>` of color runs, in a box laid out in `ch`/`lh` cells — the stage's size at every window, the font scaled to fit |
| `web/src/cell.js` | `#cell` in the terminal: `at(col, row)` — the attach that places a box on a cell (`FJS-D978`) |
| `web/src/cell.browser.js` | `#cell` in a browser: `left`/`top` in `ch`/`lh`, margin and padding zeroed so a bubble's glyph lands on its cell |
| `web/src/sign-in.js` | `#sign-in` in the terminal: the key at `~/.fli/haven/key.json` (made 0600 on the first run), a signed login on every run, and `sessionToken()` — the `HAVEN_TOKEN` `fli haven` handed over. `fli haven` imports this file by path, so the door versions with the server |
| `web/src/sign-in.browser.js` | `#sign-in` in a browser: the same signed login over a WebCrypto key kept in IndexedDB, once per page load; a first login's nick is `?nick=`, else `guest-` and the key's first six characters |
| `web/src/walk-in.js` | `walkIn(slug)`: `#sign-in`'s token, the room as the socket's query, then the token — target-neutral |
| `web/src/main.js` · `App.mesa` · `web/index.html` | the browser's entry and root; the terminal shell mounts a route itself and never reads them |
| `web/config/vite.config.js` | the browser build: 5506 (`havenWeb`) or `WEB_PORT`/`FLI_PORT_FE`, `strictPort`, the API's paths proxied to 5505 or `API_PORT` |
| `web/src/resources/` | `rooms`, `members`, `messages` |
| `web/test/stage.mjs` | a scene mounted headless through Sierra's terminal loader: its stage and the frame the terminal drew — `scenes.test.js`'s and both drives' |
| `web/test/scenes.test.js` | each scene's picture is its `.frame.txt`, and the terminal draws it; a glyph and a color at every tick; every door reached from the spawn; a pacer walks floor only; the stage's own rules — a cell claimed twice refused, a door over a wall, a moved piece freeing its cells |
| `web/test/frames.mjs` | `bun run frames`: every scene's picture rewritten |
| `tests/verify-fresh.mjs` | a machine with no checkout: this tree packed into a Verdaccio that never proxies `@frontierjs/*`, then a bare `oven/bun` container runs `bunx @frontierjs/cli haven` twice — installed, drawn, one member |
| `web/test/verify-explore.mjs` | two terminals: a pty shell walks and speaks, a `fli haven --frame /` sees it, each sees the other; then the door to the tavern and back, and the key is the member |
| `web/test/verify-browser.mjs` | a pty terminal and a CDP tab on this package's own Vite server in one room, each read off the other's screen — figures, lines, the art row for row and the palette, the stale-build line; then a reload is the same member and the tab's door empties the terminal's square |
| `web/test/terminal.mjs` | the pty shell, its screen replayed from cursor moves, and a scene cell read off it against a stage's picture — both drives' |
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
  every member out.
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
- **A scene is at most 26 rows of art.** `--frame` renders headless at 100×30
  (`sierra/src/terminal/shell.js`), and the status and input lines sit under
  the art; a taller scene loses its top rows there, and on a short terminal
  the input line. The drive's `--frame` checks are what fail.
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
- **The ban is read per call and per frame, never off the session.** With a
  `claims` resolver installed every committed write re-grades every room, so a
  write costs one `Member` read per person standing in a room.

## Proving a change

**By hand:** `bun run api` (or `fli dev`) here, then `fli haven` anywhere in the
checkout. The script supplies a dev session key; `bun run start`, which a
deploy runs, refuses to boot without `HAVEN_SESSION_KEY`.

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
(Chrome; it starts its own server over a copy of `web/src`). A change to
`web/src/sign-in.js` or `packages/cli/commands/haven/` is proved by
`verify:explore` too, and `api/src/client.ts`, the door's installer or this
manifest's `dependencies` by `bun run verify:fresh` (Docker, network).
