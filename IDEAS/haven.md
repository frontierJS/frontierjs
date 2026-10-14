---
id: haven
status: proposed
dated: 2026-10-13
---

# Idea — Haven: a place in the terminal anyone with `fli` installed can walk into

**Status: PROPOSED. Phases 0, 1, 2 and 4 are built — the schema, the API, the signed login, the square and the tavern in color and motion, and `fli haven` in front of them, which installs the server's own Haven on a machine with no checkout (3.1); nothing is published yet. Phase 5 is built but for the editor in VS Code (5.4): a scene is a component tree over a stage (5.5, `FJS-D997`), its picture committed beside it and pinned; a browser tab and a terminal stand in one room (5.2, 5.6); and `fli haven:scenes` places pieces on a page and writes the tree back byte for byte (5.7). Phases 6–9 — exploration, a Haven that lives, inhabitants, building and play — are proposed and none is started.** Dated 2026-10-13. The
probe below is now `packages/mesa/test/terminal/specs/haven.spec.mjs`; everything
past Phase 0 is argument. Do not cite this file as describing behavior — see
`VERIFYING.md`.

**The ask.** `fli haven` draws Haven in the terminal. Every person online
has a figure in it. Arrow keys walk, a door enters the tavern, a typed line
appears as a bubble over your figure until the next one. Anyone who has `fli`
installed can join — it is the framework's own chat place, not a workspace tool.

**The claim.** This is one hosted FJS application with a terminal client, and
nearly every piece already has an owner. Presence, rooms, graded broadcast and
rate limiting are Junction's. The client is a `web/` surface compiled for the
terminal, which `fli dev:tui` already does for any app (`FJS-D809`). What is
new is small: a schema of three models, an identity for a machine with no
browser, one terminal lowering, and the deploy. It is also the first FJS app
with strangers on it, which makes it the best dogfood this repo could run —
`basecamp` has one tenant and `example` has none.

---

## What the probe found

Run on `test/terminal/run.mjs`'s headless renderer, 40x12, a `<pre>` of three
houses and three figures, one moved by arrow keys and given a bubble by Enter.
Kept as `specs/haven.spec.mjs` over `fixtures/Haven.mesa`.

- **A figure is an absolute box over the art, and it lands on the cell asked
  for.** `<pre>` keeps its columns, the figure paints over it, and when the
  figure moves the art under its old cell is drawn again. Nothing clears.
- **`style:` cannot place it.** The terminal paints no CSS, pinned by
  `specs/style.spec.mjs`, so `style:left` is inert. Placement went through
  `{@attach}` writing the engine's own `position`, `left`, `top` and `zIndex`
  on the renderable.
- **The attach must be a factory the template calls** — `{@attach at(p.x, p.y)}`
  — so the template reads the coordinates. An action that reads `p` only inside
  its body is never re-run when a keyed `{#each}` replaces the item, and the
  figure stays where it was mounted while its bubble, a fresh `{#if}` node,
  appears at the new place.
- **A bubble's spaces are transparent.** `(hi all)` painted as `(hi;all)` with
  the hedge showing through until the box was given a background. The engine
  draws a cell only where there is a character. Since 0.3 a box of
  `@frontierjs/css`'s surface lineage (`surface`, `card`, `dialog`, `popover`,
  …) blanks its own cells, unless `outlined` or `ghost` — the two variants a
  browser paints transparent — rides beside it.
- **`<mesa:window on:keydown>` hears the arrows as `ArrowRight` and friends**,
  the DOM names, through the engine's key table. Enter reaches the same handler.

So the UI half is a day of `.mesa`: placement is an attach in the app
(`FJS-D978`), and the opaque box is the surface class (`FJS-D979`).

## The shape

```
packages/haven/              an FJS app, the basecamp shape: db/ api/ web/ tests/
  db/schema.lite           Member · Room · Message
  api/                     services, presence per room, rate limit on, the mods
  web/src/routes/          the square and the tavern, compiled for the terminal
fli haven                 runs that web/ in this terminal against the hosted API,
                           the way fli dev:tui runs an app's own against localhost
```

**Member** is a nick and a public key, claimed once per machine. **Room** is a
scene — the square, the tavern, a door per topic — and each is one Junction
channel, so presence per room is `presence.ts` with nothing added. **Message** is
a row: the bubble is the newest one per member, the tavern's history pane is the
rest, and the audit trail comes free. A move is a presence update on the room's channel, never a row.

**Identity without a browser** (`FJS-D981`). First run writes an Ed25519 key
pair under `~/.fli/`. `fli haven` signs `POST /haven/login` with
`signRequest({ privateKey })`. The server verifies it against the public key in
the body, makes the member on the first login, and mints a `Session` (a Grant
row). The WebSocket carries that token as an ordinary bearer, read back by
Haven's own `IAuth`, so no principal resolver is new. GitHub sign-in is a later door, not a first one: it needs a
device flow the auth package does not have, and a nick behind a key is enough to
be the same person tomorrow.

**Strangers.** A public CLI is a spam bot within the hour. Rate limit middleware
on from the first deploy, `Message` at the signed-in level, a `banned` row
policy on `Member` so a ban is a gate and not a hook (Invariant 6), and a mod
standing that can set it. Nothing here is a new mechanism.

**Version skew.** Fifty clients on ten `fli` versions against one server. The
server states the Haven version it runs and `fli haven` installs that one
(`FJS-D982`), the direction junction's build id already takes: the server
states, the client acts. So the frame shapes never cross versions, and the
contract across `fli` versions is only the door's: `GET /haven/client` and what
`web/src/sign-in.js` exports.

## The nine

Answered before the first edit, 2026-10-13.

1. **Origin.** Presence, rooms, grading, the session, the rate limit are read
   from Junction and auth; the client is the app's own `web/` compiled by the
   lowering `fli dev:tui` already runs. The one thing written twice would be the
   frame shapes, in the client and the server, and both sit in one package.
2. **Concept.** One new noun, Haven. Room is `channel` wearing a scene; Member
   is `User` with a key; a bubble is a Message. No noun for "online" — that is
   presence. The word itself is Q1.
3. **Complexity.** The problem's: a stranger on a public endpoint needs identity,
   moderation and a version floor, and every chat system has those three. The
   complexity the design would add is a second client runtime inside `fli`, and
   the shape above avoids it.
4. **Predictability.** Haven is an app, laid out like every app (Invariant 3),
   deployed like `basecamp`, run in a terminal like any `web/`. Knowing one FJS
   app teaches this one.
5. **Derived.** The client is derived from `web/` by the terminal target; the
   presence list is derived from channel membership; the bubble is derived from
   the newest Message. The hand-maintained part is the art.
6. **Owner.** Presence: `transport/presence.ts`. Session minting:
   `bearerClaim`. Signing: `toolbelt/signature`. Terminal lowering:
   `runtime-terminal.js`. Haven adds owners only for its own models. The
   signature principal is a new element of an existing list, not a second
   resolver.
7. **Boundary.** The frame shapes, typed in the package and sent through
   `wsSend()`; a build the server refuses is refused by name. The client needs
   to know nothing about how a room grades.
8. **Failure.** A dropped frame is a figure one cell behind, and a reconnect is a
   gap the client already refetches (`FJS-701`). A failed login is a refusal with
   the reason. A ban is an empty room, which is what a gate does.
9. **Silence.** What must stay true: two clients in one room see each other's
   moves and bubbles, and a banned member sees nothing. What fails: a
   `@frontierjs/testing` test mounting two clients over one app, and a terminal
   drive on the headless renderer with two mounted square routes. Until Phase 1
   lands both: `none`.

**Adjudications.** *Batteries vs. smallness*: Haven is an app, severable from
`fli` by being its own package; `fli haven` is a thin door. *Familiarity vs.
precision*: the ecosystem word for a federated chat protocol is Matrix, and
`fli matrix` would read as joining one — Q1. No other row is in tension.

**Tier.** Assessment. Q1–Q4 are ruled: `FJS-D976` the noun, `FJS-D977` the
package, `FJS-D978` placement by attach, `FJS-D979` the opaque treatment.

## Plan

### Phase 0 — Groundwork

Goal: the name, the package shape and the two lowerings decided; the probe kept.
Done when: the opaque treatment is lowered and the probe is a spec in
`test/terminal/specs/`.

- [x] 0.1 Probe sprites on the headless renderer — § What the probe found.
- [x] 0.2 Rule Q1–Q4 — `FJS-D976` to `FJS-D979`.
- [x] 0.3 Lower the opaque treatment (`FJS-D979`) in `runtime-terminal.js`, with
  the probe rewritten as its spec: a figure placed by attach over `<pre>` art, moved
  by arrows, and a bubble that hides the art under it.

### Phase 1 — The app

Goal: two Junction clients in one room see each other.
Done when: a `@frontierjs/testing` test joins two clients, moves one, says one
line, and the other receives both; a third, banned, receives nothing.

- [x] 1.1 `db/schema.lite` — Member, Room, Message, gates and the `banned` policy.
  `packages/haven/db/test/schema.test.js`. The ban is `bannedAt`, a claim off
  the `@@auth` model; the session grant `mint()` writes is 1.3's model.
- [x] 1.2 Services, a channel per room, `move` and `say` frames, rate limit on.
  `packages/haven/api/` — `api/test/room.test.ts`, real sockets. A move is a
  presence update on `room:{id}`, bound by `channels({ rooms })`, so a joiner's
  `presence:sync` carries every figure; a say is `messages.create`, graded per
  recipient. A room is entered at the upgrade (`/ws?room=<slug>`) and a door is
  a reconnect: a socket call cannot reach its own connection (`FJS-2834`). The
  ban is read per call and per frame, not off the session. Hit and fixed
  `FJS-1737`.
- [x] 1.3 The signed login and the minted session (`FJS-D981`). `signRequest`
  was HMAC only, so toolbelt gained the key-pair form, `v1-ed25519=`.
  `api/src/login.ts` verifies with it directly. An unknown key is no principal,
  so the login does not go through `credentials`. `api/src/auth.ts` is an
  `IAuth` over `Session`, because a `bearerClaim` principal has no id and a
  socket's member comes only from `verifySession`. `api/test/login.test.ts`;
  `room.test.ts` signs every member in for real.

### Phase 2 — The square

Goal: the square walkable in a terminal against a local API.
Done when: a terminal drive mounts the square route twice over one app and the
second frame shows the first client's figure where it walked.

- [x] 2.1 The square route — art, figures, bubbles, the input line.
  `packages/haven/web/` — `src/routes/index.mesa` reads the square's row and
  mounts `components/Scene.mesa`: the art from `src/scenes/square.js` (a space
  is walkable, so the drawing is the wall map), a figure per member from
  `presence()`, a bubble from the newest Message per member, an input line
  that arrows walk past while it is empty. Placement is `src/cell.js`
  (`FJS-D978`). The token arrives as `HAVEN_TOKEN`, read in `src/walk-in.js`,
  which is the hand-over 2.3 makes. `bun run verify:explore` is the Phase 2
  drive: a pty shell walks and speaks, a second `--frame /` sees it, and each
  sees the other. Found `FJS-2836`, and a ui-hazard: a `const` calling
  `presence()` with a `let` is re-made on every step.
- [x] 2.2 Doors — a second scene and the room change behind it. The Junction
  client gained `socketQuery` / `setSocketQuery()`: the upgrade's search, kept
  across a reconnect, and a change cycles the open socket as `setToken` does.
  Chosen over the context naming its connection (`FJS-2834`, closed by its
  README half), because a room a method joined is lost on every reconnect.
  `/tavern/` is a route; `components/WalkIn.mesa` sets the query, then the
  token, then reads the row. A door is a cell the scene names over an `n` in
  the art (`src/scenes/index.js`), and stepping on it is `goto`. The drive
  walks Sam through the left house and back; `room.test.ts` pins the door
  and a room the server has not laid out.
- [x] 2.3 `fli haven` — the door, the keypair, `--api` for a private server.
  Decide here whether the token hand-over stays the app's `HAVEN_TOKEN` or
  becomes the terminal shell's, beside the browser's `tokenStorage`: one
  terminal app with a session is a workaround, a second is a ruling.
  `packages/cli/commands/haven/walk.md`, alias `haven`: it finds Haven beside
  the running `fli`, imports Haven's own `web/src/sign-in.js` (the key at
  `~/.fli/haven/key.json`, made 0600 on the first run; a signed login on every
  run, so no session is kept on disk), then runs Sierra's shell in Haven's
  `web/` with the token as `HAVEN_TOKEN`. The default origin is Haven's
  `sierra.config.js`, so 3.1 moves it in one place. The hand-over stays
  `HAVEN_TOKEN`: Haven is still the one terminal app with a session.
  `verify:explore` walks Ana in through `fli haven` three times from one HOME
  and checks it is one member, and that a second HOME cannot take the nick.

### Phase 3 — Strangers

Goal: a fresh machine joins a Haven server it names, and a stranger can be
kept out.
Done when: `bun run verify:fresh` walks a bare container in, and a ban is
exercised end to end (3.2). The hosted Haven is Phase 10.

- [x] 3.1 The client the server names (`FJS-D982`), so there is no build floor.
  `GET /haven/client` (`api/src/client.ts`) states `{ package, version }` from
  Haven's own `package.json`. With no checkout's Haven beside it, `fli haven`
  asks that, installs exactly that version into `~/.fli/haven/<version>/` with
  `bun add` (so it honors the registry bun is pointed at), then signs in as
  before. The door installs only `@frontierjs/haven`: a server `--api` names
  chooses the version and never the package, or a stranger's server could name
  any package on npm and have it run. Until 10.1 a machine with no checkout
  must pass `--api`. `bun run verify:fresh` is the rehearsal, and it publishes
  nothing to npm: this tree's packages go into a Verdaccio that never proxies
  `@frontierjs/*`, and a bare `oven/bun` container walks in twice and is one
  member. Haven stays `private: true`; only the drive's copy drops it.
  Found: the installed Haven could not draw. `@opentui/core` is an optional peer
  of mesa, so a terminal app declares it, and Haven now does. Publishing to
  npm is the owner's call, after use.
- [~] 3.1a The deploy — moved to 10.1, the last step (owner, 2026-10-14).
- [ ] 3.2 The mod standing, a ban exercised end to end.
- [ ] 3.3 The history pane in the tavern, and what `forgetting.md` says about retention.

### Phase 4 — Scenery

Goal: a scene drawn in color and moving, with no new dependency.
Done when: the square and the tavern draw in their palettes, the water and the
hearth move, and the explore drive still walks both.

- [x] 4.1 Paint. A scene is its art plus a `paint` grid the same shape, one
  letter per cell naming a `palette` entry (`src/scenes/index.js` `look()`).
  Mesa's terminal tags lower to text and boxes only, so `src/paint.js` is an
  attach that puts OpenTUI's `FrameBufferRenderable` in the scene's box and
  sets every cell; the `<pre>` is gone. `floor` names the glyphs a figure may
  stand on, a space by default, so a drawn floor no longer has to be blank.
  `web/test/scenes.test.js` pins the paint to the art's shape. A palette is
  content, like an image's pixels, so it is hex (`FJS-D984`).
- [x] 4.2 Motion. A palette entry with `ms` cycles its `fg` and `chars`;
  `wave` rolls it across the row (the fountain), `flicker` hashes it per cell
  (the windows, the tavern's new hearth). One timer per scene, unref'd so a
  `--frame` render exits. OpenTUI's `FlamesEffect` was read and passed over:
  it tints the background of a whole buffer from the bottom, which is a
  full-screen effect rather than a hearth.
- [x] 4.4 Size. Both scenes are 96×26 cells, about 800×450 px at VS Code's
  default font: the most a 100×30 terminal holds with the status and input
  lines under the art, which is also `--frame`'s headless size. The square
  gained a tavern sign, chimney smoke, trees, lamps, benches and flowers; the
  tavern a rug, barrels, stairs and candlelit tables. Both were composed by a
  throwaway stamp script so art and paint line up.
- [x] 4.5 The tavern cat. A scene's `pacers` walk a row back and forth, sit,
  and walk back (`pacerAt()` in `src/scenes/index.js`), drawn by `paint()`
  over the art and under every figure. The clock is the wall's, so every
  terminal in the room sees the cat on the same cell; nothing is sent.
  `scenes.test.js` holds a pacer to floor cells and to both ends of its row.
- [~] 4.3 Import art from REXPaint (`.xp`, `rexpaintjs`) or Durdraw's JSON —
  dropped: its trigger was the paint grid typed by hand, and 5.1 removes the
  paint grid. An import becomes a stamp the editor (5.3) makes, if ever.

**Done 2026-10-13.** Color and motion cost no dependency: OpenTUI's frame
buffer under mesa's boxes, one unref'd timer per scene on the wall clock. What
it cost instead was a second 96×26 grid per scene that nothing but a test keeps
aligned with the first, and both scenes were in the end composed by a stamp
script rather than typed. That script is what Phase 5 promotes.

### Phase 5 — Pieces, the browser, the editor

Goal (amended by `FJS-D997`): a scene is a component tree — `<Scene>` and
the pieces, doors and pacers inside it — and its picture is a frame rendered
from the tree and committed beside it, so a scene is still read as a picture
in a diff; the same `.mesa` routes run in a browser; and a scene is edited on
a page by placing pieces, never in a column count.
Done when: both scenes render byte for byte the art they were typed as, from
components alone (5.5); `fli haven` and a browser tab stand in one room and
see each other; and a scene edited on the page round-trips to the same
`.mesa` text (5.7).

The goal before `FJS-D997` was the opposite — art as the source, with paint
RECOGNIZED from it — and 5.1–5.3 below are that, landed and then overturned:
art held only what sits still, recognition grew with every glyph, and both
scenes were stamped by a script anyway. Their *Landed* notes stay as the
record of what the tree replaces.

**The reading.** The critique that prompted this (2026-10-13) was right about
one thing — two grids drift — and wrong about the fix: a glyph→material map
fails because `|`, `-` and `o` are wall, bar, table and stool in one scene; a
hand-written `points: { entrance: { x, y } }` is the column count `doorCell`
exists to avoid; and a load-time validator restates `scenes.test.js`. A piece
LIST as the document (`at(8, 13, table)`) kills the drift and the picture with
it. So the big text block stays the document and pieces are the small text
blocks it is made of: paint is RECOGNIZED, never typed at scene scale.

- [x] 5.1 Pieces. A piece is a small `art` + `paint` pair the same shape,
  aligned by eye at three rows (`src/pieces/table.js`, `house.js`, `tree.js`,
  `lamp.js`, `bench.js`, `barrel.js`; one-offs like the bar and the hearth stay
  in their scene file). `compose(scene)` in `src/scenes/index.js` scans the
  scene's `art` for each piece's non-space glyphs — interior spaces are
  wildcards, so the frame is only its border — largest piece first, each cell
  claimed once, and emits the `paint` grid `look()` reads today, plus the
  matches `[{ piece, x, y }]`. A one-cell piece (`*` flower, `~` smoke) is the
  glyph→material map as the degenerate case, claimed after every larger match
  so a table's `|` is never a wall. `doorCell`, `spawn`, `floor` and `pacers`
  are unchanged. The scene's hand `PAINT` is deleted from both files. Three
  rules make it hold, and `web/test/scenes.test.js` is each one's test: a cell
  claimed twice fails naming the cell; a non-space glyph no piece claims fails
  naming the cell and glyph (this replaces "paint is the art's shape"); and a
  scene states its match counts (`tables: 5`, `hearth: 1`) so a false match
  fails by number. Added: the spawn is walkable and every door is reachable
  from it by flood fill over `walkable`. `look()`, `paint()` and `walkable`
  read composed output and do not change.
  Landed: `web/src/pieces/` and `piece()` + `compose()` in
  `src/scenes/index.js`; `look()` composes once per scene, and both composed
  grids equal the deleted hand `PAINT` cell for cell. Found: no house is one
  piece — the square's four are four sizes and match exactly or not at all,
  and a roof `_` and a wall `_` differ only by what is above them — so
  `house.js` is the parts every house is drawn from: chimney (smoke with it),
  roof ends, roof columns that take the shingle under the eave, window, door,
  and `|`/`_` as one-cell walls. The frame is `frame(...doors)`: a door
  `doorCell` found in the border is an `n` painted as a door. "Largest first" means a smaller match over a cell a
  larger one holds is not a match; `twice` is two matches of one size on a
  cell. Counts are stated for every piece of more than one cell, in the test
  beside its scene rather than in the scene file, which 5.3 writes back.
- [x] 5.2 The browser Haven. `FJS-D38`: the routes are the same `.mesa`, the
  browser is a second target. `Scene.mesa` is target-neutral but for two
  attaches, so each gets a browser twin chosen by target: `paint()` draws
  `look()` and `pacerAt()` — pure functions — as a `<pre>` of spans (or a
  canvas) in `ch`/`lh` cells, and `at()` sets `left`/`top` in the same units.
  Identity is the same signed login over a WebCrypto Ed25519 key kept in
  IndexedDB, `sign-in.js`'s browser twin. Version skew is Junction's existing
  `x-fjs-build`, since the server serves the bundle. Scenes stay 96×26 on both
  targets — the row cap is the terminal's, a bigger browser is a bigger font,
  never a forked world. Needs Q7. Proved by a drive that puts a pty `fli haven`
  and a CDP browser tab in one room and reads each from the other.
  Landed (Q7 ruled A, `FJS-D985`): the per-target choice is the package's
  `imports` map — `#paint`, `#cell`, `#sign-in`, each a `browser` condition
  on a `.browser.js` twin and `default` on the terminal's file — the
  mechanism litestone's `#host` already is (`FJS-D305`); Vite takes `browser`
  and Bun does not, so neither the terminal loader nor the Vite config names
  a twin. `Scene.mesa` imports `#cell` and `#paint` and is otherwise
  untouched. `walk-in.js` is target-neutral and async: `sessionToken()` is
  `HAVEN_TOKEN` in the terminal and a signed login once per page load in the
  browser, over toolbelt's own `generateSigningKeys`/`signRequest`, which are
  WebCrypto already. A browser's first nick is `?nick=`, else `guest-` and
  six characters of its key. `WalkIn.mesa` renders `status.stale`. The web
  surface gained `index.html`, `src/main.js`, `src/App.mesa` and
  `config/vite.config.js` on 5506 (`havenWeb`, the global block's next slot),
  proxying the three services, `/haven` and `/ws` to 5505. Proved by
  `verify:browser`: Sierra's shell under a pty and a CDP tab in one room, the
  tab read by `elementFromPoint` at each cell's center — 23 checks, both
  ways, through a reload and the tab's own walk through the door; both
  `verify:explore` and `bun run test` still pass. Found: the scenes are 97
  columns, not 96 — the drive reads the size off the art. The server does
  not serve the bundle yet: the stale line is proved with the two builds set
  by hand, and serving `web/dist` from Haven's API (an SPA fallback
  Junction's static handler lacks) is 10.1's deploy. `fli check` warns that
  the three twins, like the four terminal modules before them, sit loose in
  `web/src/` rather than in `web/src/lib/<area>/` (`FJS-D625`).
- [x] 5.3 The scene editor. A browser Mesa page served by `fli haven:scenes`,
  the way Studio is served beside an app, never a Haven route — the terminal
  cannot host it and a stranger should not see it. Its document is the scene
  file's `art` text: edit the text, `compose` runs live, an unclaimed cell is
  marked, a piece is stamped by writing its glyphs into the text at a cell, a
  door and the spawn and a pacer's row are placed by click, and the preview
  is 5.2's browser `paint()` on the wall clock. Export writes the `.js` back —
  `art`, `pieces`, `pacers` — so a round trip is byte-equal, which only a text
  document can promise. Palette editing is a hex per key, content by
  `FJS-D984`.
  Landed: `packages/haven/editor/`, served by `fli haven:scenes` (or `bun run
  scenes`) on 5507, `havenScenes` in the global block. The page is
  `Editor.mesa` over plain mesa — no Sierra, no router — and the document is
  the textarea's art; every key composes the scene again and marks a cell
  claimed twice, a glyph unclaimed, a spawn or pacer row off the floor, a
  door the spawn cannot reach, and a paint letter the palette lacks — the
  rules `scenes.test.js` holds, asked while drawing (`editor/doc.js`). A
  click puts the caret, stamps a piece (a shared one the scene does not list
  yet is imported and listed on save), moves the spawn, or moves a pacer's
  row and span. Export is `editor/source.js`'s splice: only what changed is
  written into the file's own text, so a scene saved untouched is its own
  bytes, and the tests prove it over both real scenes and import every
  splice. ~~**Doors stay text**~~ (ruled 2026-10-13, by the owner, over door by
  click; **amended by `FJS-D997`** — a door is placed, `<Door x y to>`, and
  replaces the wall cell under it): a door was the `n` typed in the art, `doorCell(ART, row)` is run
  again against the art being typed and the frame built around what it
  finds, and a door it no longer finds refuses the save — `doorCell` would
  throw as the scene loads — rather than being moved by a guess about the
  glyph it left. Each door is marked on the preview, because on the square's
  row of four `n`s a deleted one moves the door to the next in silence. Proved by `bun run verify:scenes`: a CDP tab
  works the tavern by clicks and keys over a copy of the scene files, and
  Save is read back from the copy and imported. Found: `paint()` fits its
  scene to the whole window, so the editor sets the preview's font for a
  pane beside a sidebar; a scene file is read in one shape (a `const ART =
  String.raw` block, numeric pacer fields on the `name:` line, one palette
  entry per line) and another is refused by name, never guessed at.
  Undo: Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) over one history for keys and
  clicks alike, so the textarea's own undo — blind to a stamp — never runs;
  a typed run is one step until a pause or a caret move. A save hot-swaps the
  editor (Vite) and wipes its state, so the history crosses in
  `sessionStorage`, kept only when the file is still the text it was saved
  with.
- [ ] 5.4 The editor in VS Code. The same page in a webview from
  `frontierjs-vscode`, opened from a scene file. Only once 5.7 is used enough
  to want it beside the file.
- [x] 5.5 The stage (`FJS-D997`). `web/src/stage.js` is `createStage({ slug,
  palette, spawn })`: a registry of claims — `stamp(name, x, y, cells,
  { floor })` answering a handle with `move` and `remove`, `door(x, y, to)`,
  `pace(spec)` — and the pure reads over it that `scenes/index.js` holds
  today: `look(x, y, ms)`, `walkable`, `doorAt`, `tickOf`, `pacerAt`, plus
  `picture()`, the rows of glyphs. Two pieces on one cell throw naming the
  cell and both pieces; a door is the one claim allowed over another and
  replaces that cell. Width and height are the claims' extent.
  `components/Scene.mesa` makes one, provides it as `$context.scene`, draws
  it with `#paint` (both twins take a stage in place of a scene) and, when
  `$context.room` is set by `WalkIn`, keeps the room — presence, figures,
  bubbles, the input line — as today; with no room it is a picture, which is
  what the test renders. `Piece.mesa` (`of`, `x`, `y`: a `piece()` block
  stamped), `Row.mesa` (one piece `n` times, `step` apart), `Door.mesa`,
  `Pacer.mesa`. `scenes/Square.mesa` and `Tavern.mesa` are the trees, the
  four houses and the tavern's one-offs as `piece()` blocks in their
  `<script>`; `pieces/` keeps the shared blocks and `piece()` moves there.
  Routes are `<WalkIn slug="square"><Square /></WalkIn>`. `compose()`,
  `house.js`'s parts, `doorCell` and the scene `.js` files go.
  Proof: `scenes.test.js` mounts each scene headless (Sierra's terminal
  loader, mesa's headless renderer), and `picture()` equals
  `scenes/<name>.frame.txt`, seeded from today's `ART` so the migration is
  byte-equal; one test reads the headless FRAME too, so `paint.js` is
  proved. `bun run frames` rewrites the files. The walkability, door-reach
  and pacer rules stay over the stage.
  Landed as written, with three things found. A handle a component takes from
  the stage is a `var`: `const mark = scene.stamp(…)` reads a prop, so the
  compiler makes it lazy, and a door read only in its teardown was never
  placed. The square's tavern door is at column 20, which `doorCell` had
  found and nobody had typed. The frame is a plain piece again (no doors in
  it); a `<Door>` replaces the wall cell. Both frames seeded from the old
  `ART` and both scenes render them byte for byte; `scenes.test.js` is 15
  tests over the two stages and the stage's own rules.
- [x] 5.6 The drives over the stage. `web/test/stage.mjs` mounts a scene
  headless and answers its stage; `terminal.mjs`'s `cellOf` takes the
  picture's first row as the corner, and `verify-explore` and
  `verify-browser` read spawn, doors, `look` and `tickOf` off the stage
  rather than a scene object. Both drives pass unchanged in what they check.
  Landed. Found: `stageOf` must keep its mount — a piece frees its cells
  when it is destroyed, so a disposed scene is an empty stage — and a
  presence made in a lazy `const` is made inside the effect that first reads
  it, so `here` is a `var` too.
- [x] 5.7 The placement editor. The document is the scene's `.mesa` file:
  the page mounts the real component in the preview, a click selects the
  piece on that cell, arrows or a drag move it, a palette hex is edited by
  key, a piece from `pieces/` or the scene's own blocks is added at a cell,
  a door's `to` is typed, and Save splices only the changed `x`/`y`/`to`
  attributes and palette hexes into the file's own text — a scene saved
  untouched is its own bytes. Paste-art import: `compose()` lives on in
  `editor/import.js` and turns a block of art into `<Piece>` lines. Undo is
  one history as today. `verify:scenes` is rewritten over the tavern.
  Landed: the file's tags are bound one to one to the stage's `marks`, in
  order (`doc.js` `bind`), so the preview is the real component and an edit
  is a mark moved; Save is `editsOf` against the parsed file — an attribute,
  a removed line, an added tag with its import, the spawn, a palette hex —
  spliced by `source.js`. Found: an element's id is its tag's position, and
  a save renumbers the file, so a history kept across a save is rekeyed
  (`remapOf`/`rekeyHistory`) or a step moves the wrong tags; the marks
  overlay takes the scene box's font or a mark sits on the wrong cell; the
  drive's copy sits inside the package, since `#paint` resolves through the
  nearest `package.json`. Proved by `verify:scenes`, 53 checks.
- [x] 5.8 The record. Haven `CLAUDE.md` layout and traps, `DRIVES.md` rows,
  `fli haven:scenes`'s description, this file's status line, and
  `FJS-D995`'s row shape (placements) wherever 9.3 names it.

### Phase 6 — Exploration

Goal: Haven is bigger than the screen and is found by walking.
Done when: a drive walks a figure off the first screen and the view follows, a
second terminal sees it in the part the first screen never showed, and a cell
nobody has walked near is drawn blank.

**The reading** (2026-10-14). Haven feels static because a scene is the
screen: 97×26, all of it drawn at once, so there is nothing past the edge.
Nothing in the drawing pipeline needs that to be true. `compose()` recognizes
a scene once, `look()` answers one cell at a tick, and `at()` places a box on a
cell, so a world larger than the screen is a slice and an offset. The 26-row
cap in Haven's traps is the VIEWPORT's, from `--frame`'s 100×30, and stays;
a scene's art is bounded only by the server's `MAX_CELL` (255) in `api/src/rooms.ts`.
FJS-D985's "never a forked world" holds: both targets show the same viewport.

- [ ] 6.1 The camera. A scene's art may exceed 97×26; `Scene.mesa` draws the
  viewport's slice of it, and the camera follows the figure with a deadzone
  (about 8 columns and 4 rows from an edge) so it pans rather than jitters.
  `paint()` takes the camera as an offset, `at(x - cam.x, y - cam.y)` places a
  figure, and a figure or bubble outside the slice is not drawn. A speaker off
  the edge is a marker on the edge facing them, so a line is never lost.
  `scenes.test.js`'s rules are unchanged; a drive walks past the first edge.
- [ ] 6.2 Borders. The square opens onto a road, the docks and the woods, each
  its own scene. Crossing a border cell is a door with no
  `n`: the client walks into the next scene at the matching cell on its
  facing edge. Needs Q8. Measure the reconnect at a border, since a door hides
  it behind a scene change and a border cannot.
- [ ] 6.3 Light and fog. A figure sees a radius around itself, line of sight
  cast over `walkable`; a cell seen before and out of sight now is drawn dim,
  a cell never seen is blank. A palette entry with `light: r` is a source —
  the lamps, the hearth, the tavern's candles — so a lit corner is seen from
  across the room and the tavern's back corners are dark. A pure function
  beside `look()` (`litAt(scene, x, y, from, tick)`), so both targets and a
  `--frame` agree; the terminal drive reads characters, so it reads the blank.
- [ ] 6.4 The map. `m` draws every scene this machine has seen, at one glyph
  per few cells, with the figure's position marked. Needs Q9.
- [ ] 6.5 Secrets. A cellar under the tavern behind a door in the floor, a
  plank in the woods' fence, a door that is there only at night (7.2). A
  hidden door is one the spawn's flood fill in `scenes.test.js` reaches only
  through another hidden door, so the test learns the word rather than
  excusing the cell.

### Phase 7 — Haven lives

Goal: Haven looks and sounds lived in, including with nobody else on.
Done when: two terminals on one shared clock draw the same sky and the same
footprints, and a line said at one end of the square does not reach the other.

- [ ] 7.1 Hearing by distance. A line said is heard within a radius of the
  speaker, `!` before it shouts to the whole scene, and `/w <nick>` whispers
  to one member. This is what makes walking over to someone mean something.
  Needs Q10.
- [ ] 7.2 Night and day. The wall clock the pacers already share runs a cycle
  (an hour of real time is a day, to start): a palette entry gains a night
  `fg`, the lamps light at dusk, and 6.3's radius shrinks after dark. Nothing
  is sent, so every terminal sees the same sky.
- [ ] 7.3 Weather. Rain and snow as an overlay drawn over the art and under the
  figures, hashed from the clock the way `flicker` is, so a storm falls on the
  same cells everywhere. The real weather at the server is a later door, not
  a first one.
- [ ] 7.4 Footprints. Where somebody walked in the last few minutes, fading.
  An empty square at 3am still says somebody went into the woods ten minutes
  ago. A move is never a row, so this is the room's memory of moves and not
  a model. Needs Q11.
- [ ] 7.5 The notice board. A board on the square's wall: stand beside it, press
  `e`, read what is pinned and pin a line. This is the part of Haven that
  works when nobody is on. A first cut is the board's own Room and its
  Messages, with no new model; check it against 3.3's retention, since a
  board's lines are meant to outlive the tavern's.

### Phase 8 — Inhabitants

Goal: something in Haven besides members, and members doing more than
standing.
Done when: a member waves and sits on a bench where a second terminal sees it,
and the crier announces a new member's first walk-in.

- [ ] 8.1 Emotes. `/wave`, `/sit`, `/dance` animate the figure for a few
  ticks. A bench piece names its seats, so `/sit` beside one sits on it. An
  emote is a presence field beside `{ x, y }`, so `position()` in
  `api/src/rooms.ts` widens by one named key and still cuts everything else.
- [ ] 8.2 A pet follows its member, one cell behind on the path walked. It is
  drawn from the figure's own recent cells on every screen, so nothing is
  sent for it.
- [ ] 8.3 Haven's crier: a system member who announces a member's first
  walk-in, a release, a push to `main`. Its lines are Messages said through
  `asSystem()`; where a push comes from is Q13's question.
- [ ] 8.4 The barkeep, an agent behind the bar: "ask the barkeep about row
  policies" makes Haven the framework's help desk, through `mcpPlugin()`
  with the gate as its permission model. A librarian in the square is the same
  agent with `docs/` on its shelf. Needs Q12.

### Phase 9 — Building and play

Goal: members change Haven and play in it.
Done when: two members finish a game at a tavern table, and a house one of them
drew stands in a scene where the other walks into it.

- [ ] 9.1 Tavern games. Dice first: `/roll 2d6` is a Message the server rolls,
  so nobody can roll their own number. Then checkers on a table piece: sit
  down and the board draws over the table, a move is a call, and the game is
  a row a service owns. This is live shared state at a small scale, which is
  the hardest thing in the framework to get right.
- [ ] 9.2 The framework quarter. A scene where each building is a package —
  the Litestone quarry, the Junction crossroads, the Mesa workshop, the
  Caravan stables. Inside, a wall reads its `PROJECT_STATE.md`; a red CI run
  is a storm over its roof and a release is a festival day in the square.
  Walking the quarter is walking the repo. Needs Q13.
- [ ] 9.3 Plots. A member claims an empty lot, places their house in 5.7's
  editor, and the house is a Room they own — a row of placements and a
  palette, never a stranger's glyphs (`FJS-D995` as `FJS-D997` amends it). Strangers drawing art is a
  moderation surface, so this waits on 3.2's mod standing. Needs Q14.

### Phase 10 — Hosted

Goal: Haven answers at a public address, so a stranger needs no `--api`.
Done when: `bunx @frontierjs/cli haven` on a machine that has never seen this
repo shows a figure that a second machine can see. (`fli` on npm is somebody
else's package.)

- [ ] 10.1 Deploy through outpost at `haven.maverickmade.tech` (the apex is on
  Cloudflare; the subdomain has no record yet), with Haven's API serving
  `web/dist` (5.2). `web/config/sierra.config.js` moves to it when a server
  answers there, not before. The machine is not named.

## Open questions

- ~~**Q8 — Whether a scene beside a scene is its own Room.**~~ **Answered 2026-10-14 (`FJS-D990`): A — each scene is its own Room and channel, and crossing a border reconnects the way a door does today (`setSocketQuery`, `FJS-2834`).**
  - **A** — each scene is its own Room and channel, and crossing a border
    reconnects the way a door does today (`setSocketQuery`, `FJS-2834`).
  - **B** — one world channel: every figure's move goes to every member online,
    and each client draws only what is in its viewport.
  - **Recommend A** — presence per room comes free and a move fans out only to
    its scene. B sends every move to everyone, and Junction's 10-per-second
    presence cap is per member, so the frames per member grow with how many
    are online. A's cost is a reconnect at every border, which 6.2 measures.
- ~~**Q9 — Where what a machine has seen is kept.**~~ **Answered 2026-10-14 (`FJS-D991`): A — on the machine: `~/.fli/haven/seen/<room>` in the terminal and IndexedDB in a browser, a `#seen` twin in the package's `imports` map (`FJS-D985`).**
  - **A** — on the machine: `~/.fli/haven/seen/<room>` in the terminal and
    IndexedDB in a browser, a `#seen` twin in the package's `imports` map
    (`FJS-D985`).
  - **B** — a row per member per scene holding a bitmap of seen cells.
  - **Recommend A** — a member IS a machine's key (`FJS-D981`), so a row
    remembers nothing a file does not. B's cost is a write on every step that
    uncovers a cell.
- ~~**Q10 — Where distance is decided.**~~ **Answered 2026-10-14 (`FJS-D992`): A — the server: it filters a line's fan-out by the speaker's and each listener's positions in presence. A whisper is a Message with a `toId` and a read policy, because a row is readable through `messages.find` by anyone in the room whatever its fan-out did.**
  - **A** — the server: it filters a line's fan-out by the speaker's and each
    listener's positions in presence. A whisper is a Message with a `toId`
    and a read policy, because a row is readable through `messages.find` by
    anyone in the room whatever its fan-out did.
  - **B** — the client: every socket receives every line and draws the ones
    in range. A whisper is a Message with a `toId`, as in A.
  - **Recommend A** — under B any modified client hears the whole square.
    Distance is fan-out only in both, so the one privacy promise, the whisper,
    has to be a policy either way. Note that `say` reads a position from
    presence, a frame a client sends and the server bounds only to `MAX_CELL`.
- ~~**Q11 — Where footprints live.**~~ **Answered 2026-10-14 (`FJS-D993`): A — the API keeps a ring buffer of recent moves per room in memory and sends it on join. A restart loses it, which scenery can afford.**
  - **A** — the API keeps a ring buffer of recent moves per room in memory and
    sends it on join. A restart loses it, which scenery can afford.
  - **B** — each client remembers the moves it saw, so a newcomer sees no
    footprints.
  - **Recommend A** — it is the only option where the empty square at 3am
    shows anything, and a move stays out of the database. B is what a single
    terminal already has for free and does not answer the ask.
- ~~**Q12 — What the barkeep costs.**~~ **Answered 2026-10-14 (`FJS-D994`): A — no model: the barkeep answers from a search over `docs/`, `VOCABULARY.md` and the package READMEs, quoting the passage and its path.** A public Haven with a model behind the bar
  is a bill any stranger can run up.
  - **A** — no model: the barkeep answers from a search over `docs/`,
    `VOCABULARY.md` and the package READMEs, quoting the passage and its path.
  - **B** — a model with a budget per member per day, enforced by the rate
    limit Haven already runs.
  - **C** — a model only for members with a standing above the default.
  - **Recommend A** — cut one level simpler. It is a help desk with no bill
    and no prompt to inject into, and it says what the docs fail to answer
    before a model is paid to paper over them. B waits until A's misses are
    counted.
- ~~**Q13 — Where the framework quarter's state comes from.**~~ **Answered 2026-10-14 (`FJS-D996`): A — the deploy bakes it in: `PROJECT_STATE.md` headlines and the last CI result, current as of the deploy.** Haven runs on a
  server, not in a checkout.
  - **A** — the deploy bakes it in: `PROJECT_STATE.md` headlines and the last
    CI result, current as of the deploy.
  - **B** — the server polls the repository's host.
  - **C** — CI posts each result to a Haven endpoint, signed with
    `signRequest` the way a login is.
  - **Recommend C** — the signed request is already toolbelt's and the
    login's, the weather is current the moment CI finishes, and Haven
    learns no credential for the repository's host. A is a first cut while
    there is no deploy.
- ~~**Q14 — A scene a member draws.**~~ **Answered 2026-10-14 (`FJS-D995`): A — a scene becomes data: its art and palette are a row, and the editor writes to the API. The built-in scenes stay `.js` files.** Amended by `FJS-D997`: the row holds placements and a palette, and the built-in scenes are `.mesa` trees.
  - **A** — a scene becomes data: its art and palette are a row, and the
    editor writes to the API. The built-in scenes stay `.js` files.
  - **B** — a member's house is a scene file sent as a pull request, reviewed
    like any other change.
  - **Recommend B for a first cut** — review is the moderation, and nothing
    new is built. A is the real feature, but it gives a stranger's art a live
    path to every screen, so it waits on 3.2 and on B's queue being the
    bottleneck.


- ~~**Q7 — Where the browser Haven's routes live.**~~ **Answered 2026-10-14 (`FJS-D985`): A — one `web/`, two targets: the terminal build `fli dev:tui` runs today and a browser build `fli dev` runs, from the same routes and `sierra.config.js`, with the two attaches and `sign-in.js` resolved per target. `FJS-D38` already says a surface is a compiler backend over one authoring model, and Invariant 3 gains the sentence that one directory may build for more than one target.** `FJS-D977` put the client in
  a `web/` "compiled for the terminal and never for a browser"; that ruled
  WHERE the client lives, not against a browser. 5.2 wants the same routes in
  both, and Invariant 3 reads a surface as a directory.
  - **A** — one `web/`, two targets: the terminal build `fli dev:tui` runs
    today and a browser build `fli dev` runs, from the same routes and
    `sierra.config.js`, with the two attaches and `sign-in.js` resolved per
    target. `FJS-D38` already says a surface is a compiler backend over one
    authoring model, and Invariant 3 gains the sentence that one directory may
    build for more than one target.
  - **B** — a second surface, `site/` or `browser/`, holding its own routes
    that import the shared `Scene.mesa` and scenes. Invariant 3 unchanged.
  - **Recommend A** — B's routes are three one-line files that re-export the
    first's, a copy whose only job is to satisfy a reading of a layout rule;
    and the per-target attach is the mechanism `FJS-D978` already chose for
    placing a figure, so A adds a resolver where B adds a directory.

- ~~**Q6 — How a machine with no checkout gets the client, and how it stays the server's version.**~~ **Answered 2026-10-14 (`FJS-D982`): A — publish `@frontierjs/haven`. The server states the version it runs at `GET /haven/client` (`{ package, version }`, read from its own `package.json`). `fli haven` installs exactly that version into `~/.fli/haven/<version>/` on first sight, then imports its `web/src/sign-in.js` as it does now. A checkout's sibling Haven still wins, the way `dev:tui` runs the app in front of it. There is no floor: the client is always the server's. A version npm does not have is refused by name.** 3.1 names "the build floor the server refuses", and § Version skew has the client send `x-fjs-build` for the server to refuse. Junction's protocol is the reverse, on purpose: the server STATES its build and the client compares (`junction/src/core/build-id.ts`), and that build is a browser bundle's hash, which a terminal client never has. Today `fli haven` runs only the Haven found beside it in a checkout.
  - **A** — publish `@frontierjs/haven`. The server states the version it runs at `GET /haven/client` (`{ package, version }`, read from its own `package.json`). `fli haven` installs exactly that version into `~/.fli/haven/<version>/` on first sight, then imports its `web/src/sign-in.js` as it does now. A checkout's sibling Haven still wins, the way `dev:tui` runs the app in front of it. There is no floor: the client is always the server's. A version npm does not have is refused by name.
  - **B** — publish `@frontierjs/haven`. `fli haven` installs `latest`, sends its version on `POST /haven/login`, and the server refuses a client below a declared floor by name.
  - **C** — the server serves its own client source, and `fli haven` downloads and runs it.
  - **Recommend A** — it keeps junction's direction (the server states, the client acts), derives the version from the deployed package instead of keeping a floor by hand, and closes the version gap rather than refusing it. B adds a floor someone has to remember to raise. C runs code from whatever `--api` names, which gives a private server's operator code execution on every visitor's machine. A's trust is npm's, the same as `bunx fli` itself.

- ~~**Q5 — How a machine proves it is the same member.**~~ **Answered 2026-10-13 (`FJS-D981`): A — an Ed25519 key pair.**
  - **A** — an Ed25519 key pair: toolbelt's `signRequest`/`verifyRequest` gain
    the key-pair form over the same canonical string, and the login mints a
    session that expires.
  - **B** — no signature: the first run is answered a long-lived token, and the
    token is the identity.
  - **Recommend A** — one key is one identity on every server (2.3's `--api`),
    a session can expire because the key mints the next one, and the private key
    never travels. B's token can never expire, because losing it loses the nick.

- ~~**Q1 — The noun.**~~ **Answered 2026-10-14 (`FJS-D976`): B — `haven`, which is what the screen draws and gives the rooms their words: square, tavern, door.**
  - **A** — `matrix`, the name it was asked for.
  - **B** — `haven`, which is what the screen draws and gives the rooms their
    words: square, tavern, door.
  - **Recommend B** — Matrix is the ecosystem's federated chat protocol and
    `fli matrix` reads as a client for it, which is *familiarity vs. precision*
    resolved the way § IV resolves it.
- ~~**Q2 — Where the client lives.**~~ **Answered 2026-10-14 (`FJS-D977`): B — a package that is an FJS app, `web/` and all, and `fli haven` runs its `web/` the way `fli dev:tui` runs an app's own, against a hosted `--api`.**
  - **A** — inside `packages/cli`, which then gains mesa, OpenTUI and the
    Junction client as optional peers.
  - **B** — a package that is an FJS app, `web/` and all, and `fli haven` runs
    its `web/` the way `fli dev:tui` runs an app's own, against a hosted `--api`.
  - **Recommend B** — the cli declares no framework package today and `dev:tui`
    already resolves the runtime from the app it runs; B keeps that and versions
    the client with its server.
- ~~**Q3 — Placing a figure on a cell.**~~ **Answered 2026-10-14 (`FJS-D978`): A — leave it to the app: an attach helper in Haven's `web/`.** The probe placed it through `{@attach}`
  writing the engine's own fields.
  - **A** — leave it to the app: an attach helper in Haven's `web/`.
  - **B** — lower `style:position|left|top` in `runtime-terminal.js`, which
    `specs/style.spec.mjs` currently pins as inert.
  - **Recommend A** — placement by cell is a thing only a game wants, and an
    attach is the escape hatch for exactly that.
- ~~**Q4 — A box that hides what is under it.**~~ **Answered 2026-10-14 (`FJS-D979`): B — one opaque treatment lowered in `runtime-terminal.js`, so no color is written in a `.mesa`.** The probe made the bubble opaque
  with a background color written in the `.mesa`.
  - **A** — leave it to the app, the same attach helper as Q3.
  - **B** — one opaque treatment lowered in `runtime-terminal.js`, so no color
    is written in a `.mesa`.
  - **Recommend B** — every dialog and dropdown on a terminal needs it, and a
    color in a `.mesa` is Invariant 13's failure.
