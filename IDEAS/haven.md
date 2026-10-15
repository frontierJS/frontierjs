---
id: haven
status: proposed
dated: 2026-10-14
---

# Idea — Haven: a place in the terminal anyone with `fli` installed can walk into

**Status: PROPOSED. Phases 0, 1, 2 and 4 are built — the schema, the API, the signed login, the square and the tavern in color and motion, and `fli haven` in front of them, which installs the server's own Haven on a machine with no checkout (3.1); nothing is published yet. Phase 5 is built but for the editor in VS Code (5.4): a scene is a component tree over a stage (5.5, `FJS-D997`), its picture committed beside it and pinned; a browser tab and a terminal stand in one room (5.2, 5.6); and `fli haven:scenes` places pieces on a page and writes the tree back byte for byte (5.7). Phase 6 is begun: the view follows a figure across a square wider than a screen (6.1); 6.2–6.5 and Phases 7–9 — a Haven that lives, inhabitants, building and play — are proposed. The deploy is the last step (10.1, by the owner); Phase 11, the workshop placed before it, is built; Phase 12, the world as data, is proposed, and a box that says **Needs 12.x** waits on that step; and every open question is ruled, so each step cites its ruling. Work the plan from the first open box.** Dated 2026-10-13. The
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
- [x] 3.2 The mod standing, a ban exercised end to end (`FJS-D998`). A mod is
  a nick in `HAVEN_MODS`, written to `Member.role` (`@guarded`) by the login on
  every run, both ways; what a mod may do is two predicates in the schema —
  the row policy admits a mod to every member's row and the field policy admits
  a mod to `bannedAt` — so the ban is an ordinary `members.patch`, and
  `/ban <nick>` / `/unban <nick>` in the input line send one. Proof:
  `db/test/schema.test.js` (a mod bans and lifts, a member's same patch writes
  nothing), `api/test/room.test.ts` (the ban over a mod's socket takes the
  member out of the room on the next write; the lift puts them back), and
  `verify:explore` (Sam types `/ban ana`, Ana's `--frame /` has no square;
  `/unban ana` and it has Sam again).
  Found: a field `@allow('write')` DROPS the key rather than refusing
  (`FJS-D22`), so a member's `/ban` resolves with nothing written — the client
  reads the answered row's `bannedAt` to say *only a mod bans*. And the session
  carried `role: 'user'`, so every member graded USER(4) where the schema and
  `CLAUDE.md` said CREATOR(3); it carries none now and the row's `role` is
  the standing.
- [x] 3.3 The history pane, and Message retention. PageUp opens a room's
  lines over the art, oldest first and signed by nick, and pages back through
  them, growing the store by a page at the oldest line loaded (`more()`);
  PageDown pages forward and closes it past the newest line, Esc closes it —
  a terminal's own scrollback, in every room and proved in the tavern
  (`verify:explore`) and the square (`verify:browser`). Retention is a COUNT
  per room, not a window of days (`FJS-D748`; `IDEAS/forgetting.md` says a
  clock that is a query is a job, not a word): `api/src/retention.ts` keeps a
  room's newest 500 lines and `app.scheduler` sweeps every hour through
  `asSystem()`, so each dropped line reaches the trail. A count is what 7.5's
  board needs — its pins outlive the tavern's chatter for as long as nothing
  newer pushes them off, where a window would erase them on a date.
  Found: Litestone's `retention` is per DATABASE, every model with a
  `createdAt`, so declared on `main` it would sweep members and rooms with the
  lines; `main` declares none and the schema's "removed only by retention"
  names the sweep. A burst stamps several lines on one millisecond, so the
  edge is ordered by `createdAt` then `id` and the test keeps exactly three.

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
- [~] 5.4 The editor in VS Code — parked: it waits on 5.7 being used enough
  to want it beside the file, and comes back as a new step at the end when
  it is. The same page in a webview from `frontierjs-vscode`, opened from a
  scene file.
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
Nothing in the drawing pipeline needs that to be true. A stage's size is its
claims' extent (`web/src/stage.js`, 5.5), `stage.look()` answers one cell at a
tick, and `at()` places a box on a cell, so a world larger than the screen is a
slice and an offset. The 26-row
cap in Haven's traps is the VIEWPORT's, from `--frame`'s 100×30, and stays;
a scene's art is bounded only by the server's `MAX_CELL` (255) in `api/src/rooms.ts`.
FJS-D985's "never a forked world" holds: both targets show the same viewport.

- [x] 6.1 The camera is the stage's `view` (`web/src/stage.js`): the slice a
  screen draws, `VIEW` (97×26) cells at most, following the figure the scene
  tells it to with `EDGE` (8 columns, 4 rows) of slack, so it pans only when
  the figure nears a side and a stage no bigger than a screen never pans. It
  lives on the stage rather than being handed to `paint()` as an offset, so a
  pan is a `changed()` like a moved piece and both paint twins keep their one
  subscription. A figure is placed at its cell less the view's corner, one
  outside the view is not drawn, and a speaker outside it is their line pushed
  to the edge they are past with the way to them, `(over here)>`. The square
  is 160 cells wide — three more houses, a well, a stall and a signpost east
  of the first screen, its frame its own `framed(159, 26)` — and the editor
  asks for the whole stage (`showAll()`). `scenes.test.js` draws each
  picture's slice from the spawn and from the far corner and pins `follow()`;
  `verify:explore` walks Sam past the edge, reads Ana's frame from the spawn
  with Sam's line as a marker on its right edge, and a third terminal walks
  the same way and sees Sam where the first screen never reached. Found: a
  bubble kept inside the view is pushed off its figure's cell near the right
  edge, so the drive reads it where the figure stands inside the slack.
- [x] 6.2 Borders. The square opens onto a road, the docks and the woods, each
  its own scene and its own Room (`FJS-D990`). A border is a `<Door>` with a
  `w` or an `h`: one mark, a run of door cells along an edge sharing one
  `to`, and the scene across has the run back on its facing edge. A step
  onto any door is `goto(to, { from, x, y })` — the route left and the cell
  stepped on — and the next scene's `arrival()` (`stage.js`) stands the
  figure beside its door whose `to` is `from`, nearest that cell: a border
  is crossed at the matching row, and a door is come out of rather than
  spawned away from, which closes the tavern's door dropping a figure at the
  square's spawn. `scenes.test.js` pairs every door with a door back and
  every run's cell with one across at its row, and `arrival()` with the
  cell beside it. Measured (`verify:explore`): the crossing — a new route,
  the socket cycled into the road's room, presence synced, the road drawn
  with the figure in it — took 202 and 336 ms from the key over two runs, with the API in the same
  process; the reconnect is most of it. The doors are claimed after the
  scene's script runs, so the move to the arrival is a presence update at
  mount: one made in `$.onMount` has no owning scope and its leave never
  runs, which `verify:browser` caught as a Mesa warning. Found: a drive that
  took `doors[0]` as the tavern's door broke when the borders claimed first;
  a door is found by its `to`.
- [x] 6.3 Light and fog. A figure sees `SIGHT` (7 rows, 14 columns — a cell
  is twice as tall as it is wide) round itself, the line cast over
  `walkable`, and an opaque cell is seen when a floor cell beside it is,
  since a line skimming along a hedge meets the hedge's own nearer cells
  first. A palette entry with `light: r` is a source and its halo is seen
  from anywhere in the room — the lamps' `Y` (4), a window's `y` (1), the
  hearth (6), the cart's lantern (3) — through walls, where sight is not:
  the hearth is ringed by its own frame cells, and a fire nobody could see
  is no fire. A cell lit once and not now is dim — its glyph at the clock's
  first step at two fifths of its color, a memory that does not move — and
  one never lit is blank. `litAt(stage, x, y, from)` in `stage.js` is the
  pure answer, with no tick: light is steady, and nothing read one. The
  stage caches it as `visible` and `seen` when the scene says who sees
  (`see(x, y)`, beside `follow`), `look()` answers through it, and both
  paints draw a pacer on lit cells only; a figure standing in the dark is
  not drawn, its line still is, until 7.1 says who hears whom. With no seer
  every cell is lit — the picture, the editor, `scenes.test.js`'s frame —
  so `picture()` and the pinned frames are the art whoever stands where.
  `scenes.test.js` pins the sight radius, the wall rule and a light on a
  probe, lit → dim → dark through `look()`, and that every scene is fogged
  from its spawn; `verify:explore` reads a blank wall, a lamp lit from
  across the square, a hedge drawn from memory out of sight, and Sam listed
  and not drawn in Ana's frame of the road, nine rows beyond her sight;
  `verify:browser` reads the tab's bottom row as a part of the terminal's,
  cell for cell, and the top wall blank on both. Found: a drive's `cellOf`
  anchored on the art's top row, which fog blanks — it anchors on the room's
  status line under the art now; and the square's `y` was the lamps' bulb
  and every house window, so sixty-eight windows flooded the facades at a
  lamp's radius — the lamp's bulb is `Y`, its own key.
- [x] 6.4 The map. `/map` draws every scene this machine has walked into, at
  one glyph per 5×5 cells, with the figure's block marked `@` and moving as it
  walks; Esc closes. What a machine has seen is kept on that machine
  (`FJS-D991`): `~/.fli/haven/seen/<slug>.json` in the terminal, a record in
  IndexedDB (`haven-seen`) in a browser, a `#seen` twin. Built: a scene is
  kept as a snap (`coarse()` in `web/src/map.js` — the picture at `SCALE`, its
  size, its doors, its route) when it is walked into, and the map is those
  snaps plus the live stage of the scene the figure is in. Where a scene sits
  is derived, never stored: a border puts its neighbor on that side with the
  two doors' rows or columns agreeing, so the docks hang under the square at
  the gap they share; a scene reached only by single-cell doors — the tavern,
  the workshop — stands in a row under the streets. The key is not `m`: the
  line input holds the letters, as 11.4 found, so the map is a command
  beside `/ban`. The fog is off in the tree (`FOG`, `stage.js`), so a scene is
  seen whole on arrival and a snap is written once, at mount; with fog back
  on, a visit's exploration would have to be merged into the file and written
  on leaving, which nothing does yet. `map.test.js` pins the layout on the
  real scenes; `verify:map` is a pty in a HOME of its own — the square alone,
  then the tavern too with `@` in its block, a second terminal in the same
  HOME drawing the tavern it never walked into, a third HOME drawing only the
  square; `verify:browser` reads the same off the tab and its IndexedDB.
- [x] 6.5 Secrets: the cellar. A hidden door is `<Door hidden>`: it keeps the
  glyph and paint of the cell it is on, so nothing drawn says it is there, and
  stepping on it is `goto` like any door. The tavern's rug has one, at its
  middle, to a cellar under the tavern (`Cellar.mesa`, racks, barrels, crates,
  a chest, a ladder in the top wall). The map leaves a hidden door out of a
  snap, so `/map` neither draws it nor places a scene by it; the cellar stands
  in the row of houses once it has been walked into. Built: `hidden` on the
  stage's `door()`, `Door.mesa` and `doorAt()`/`doors` (`hidden: true` only
  when set); `scenes.test.js` holds that the rug is the one way down, drawn
  as rug, and that a figure coming up stands beside the hole; `verify:cellar`
  walks down and up, and reads the hole off a frame as rug. The spawn's
  flood-fill rule for a hidden door reached only through another was not
  needed and is not written. The editor places no hidden door: a new `<Door>`
  tag has no `hidden`, and a moved one keeps it.
- [x] 6.6 More secrets. A plank in the woods' fence to a scene of its own, and
  a door that is there only at night (7.2) -- a hidden door whose `hidden`
  is a function of the clock, so 7.2 comes first. Built: the woods' west wall
  is the fence, and its cell at the path's end is a hidden door to the glade
  (`Glade.mesa`: a pond, standing stones, a fairy ring, the old oak), whose
  way back is a plain door in its east wall. The night door is not `hidden` as
  a function: a hidden door is still a door, found by stepping, so one that
  is "there only at night" is `<Door night>` -- a door at full night
  (`isNight`) and, by day, the cell it replaced, drawn and bumped as that.
  `hidden` stays orthogonal: it says how a door is drawn, `night` when it is
  one. The oak's foot and the cellar's west wall are each other's night door,
  a tunnel from the woods into the cellar under the tavern. The clock is the
  caller's (`doorAt(x, y, ms)`, `look`), `stage.doors` lists a night door
  whatever the hour so `arrival()` finds the way back, the picture and the
  map's snap are the day's, and an indoor stage holding one redraws on the
  sky's step. `scenes.test.js` holds the plank drawn as fence, the tunnel by
  day and night, and a probe night door; `verify:glade` walks a pty pinned to
  day through the plank and against the shut oak, and one pinned to night
  down the tunnel and back (`clock-at.mjs`, a preload through `BUN_OPTIONS`).
  Found: `verify:explore` walks Sam into the square's hedge expecting a wall,
  and the hedge is floor, so 36 of its checks fail from the wrong cell
  (`FJS-2875`).

### Phase 7 — Haven lives

Goal: Haven looks and sounds lived in, including with nobody else on.
Done when: two terminals on one shared clock draw the same sky and the same
footprints, and a line said at one end of the square does not reach the other.

- [x] 7.1 Hearing by distance. A line said is heard within a radius of the
  speaker, `!` before it shouts to the whole scene, and `/w <nick>` whispers
  to one member. This is what makes walking over to someone mean something.
  The server filters who hears a line, and a whisper is a Message row with a
  `toId` and a read policy (`FJS-D992`). Built: `api/src/hearing.ts` holds the
  rule once -- `EARSHOT` 16×6 cells, a box about the speaker -- and the
  messages service's `channel:` returns the room's channel filtered by it
  against presence; `Message.toId` and the read policy make a whisper private
  to its two members in `find` as well as in the fan-out, a mod included.
  `Scene.mesa` asks the same `hears()` of the lines it loaded, so a bubble is
  drawn only for a speaker heard from where each stands now (walk away and it
  goes); `/w <nick> <line>` saves with a `toId` and draws `(psst: …)`. A
  listener with no cell hears nothing and a speaker with none is heard by the
  room, which a booth's lines are. `hearing.test.ts`, `schema.test.js` and
  `verify:hearing`. Left as ruled: `messages.find` returns the room's
  history, so the PageUp pane shows lines the figure did not hear. Found: a
  bubble's off-screen marker (`>`) now shows only for a shout, since a
  speaker past the view is past earshot; and `verify:explore` and
  `verify:browser` fail on the fog checks while `FOG` is off, as before.
- [x] 7.2 Night and day. The wall clock the pacers already share runs a cycle
  (an hour of real time is a day, to start): a palette entry gains a night
  `fg`, the lamps light at dusk, and 6.3's radius shrinks after dark. Nothing
  is sent, so every terminal sees the same sky. Built: `web/src/sky.js`, a pure
  function of the clock -- `darkness(ms)` in thirds (half the hour is day, a
  tenth dusk, three tenths night, a tenth dawn), `isNight(ms)` for 6.6's door,
  `shade()` toward moonlight. A palette entry gains no `night` field: the night
  color is derived from the day one, so no scene is edited to have one.
  `stage.look()` shades every outdoor cell except a light source (an entry with
  `light`), and a cell inside a light's radius keeps half the day, so a lamp
  and each window pool on the facade as dusk comes; `stage.tint()` does it for
  a pacer in both paints. `<Scene indoors>` (tavern, cellar, workshop) has no
  sky; the stage redraws on the sky's own step (`SKY_MS`, two minutes) when
  nothing else moves it. Not done: the sight radius does not shrink at night,
  because `FOG` is off and `SIGHT` acts on nothing -- it comes back with the
  fog. `sky.test.js` holds the curve, a probe stage and the real scenes; no
  drive reads a night color, since the drives read glyphs. Found: 7.1's
  `Scene.mesa` imports `hearing.ts` by a relative path the editor drive's copy
  did not have, so `verify:scenes` opened no scene (the copy mirrors the
  package layout now); and `verify:browser` read a tab's color against the
  palette's, which is the sky's by night (it asks the stage at `Date.now()`).
  `verify:scenes` still fails two checks, on the tavern table's candle drawn
  `.` where the drive expects `i` -- the unoccupied candle, not the sky.
- [x] 7.3 Weather. Rain and snow as an overlay drawn over the art and under the
  figures, hashed from the clock the way `flicker` is, so a storm falls on the
  same cells everywhere. The real weather at the server is a later door, not
  a first one. Built: `web/src/sky.js` -- a spell of weather is ten minutes
  of the clock (`scheduleAt`: half clear, three tenths rain, a fifth snow), and
  a drop is a function of the clock and the cell (`fallAt`: a drop a column a
  period, a row lower each step; snow drifts a column every few steps). A drop
  replaces a BLANK outdoor cell in `stage.look()`, so it never hides a wall, a
  door or a piece, a canopy's cells take none, an `indoors` stage has none, and
  the night shades it like any other color; the figures are boxes a layer up,
  so they walk in front of it. Both paints draw `look()`, so the two targets
  agree. `tickOf(ms)` now answers for the weather and the paints ask it again
  after every draw, with the edge of a spell a step of its own. `HAVEN_WEATHER`
  pins a kind (the one option, and why: rain changes glyphs, so a drive that
  reads a blank cell would pass or fail by the clock) -- `stage.mjs` pins
  `clear`, and the two Vite configs bake the name in at start. `sky.test.js`
  holds the schedule, the pin, the fall, the density, rain on blank outdoor
  cells only, the tick, and the square's terminal frame in the rain.
  Not done: a drive that reads rain off a live screen or a tab, and the sight
  radius in a storm (the fog is off).
- [x] 7.4 Footprints. Where somebody walked in the last few minutes, fading.
  An empty square at 3am still says somebody went into the woods ten minutes
  ago. A move is never a row, so this is the room's memory of moves and not
  a model: the API keeps the recent moves per room in memory (`FJS-D993`).
  Built: a step is a move of one cell from where the figure stood
  (`stepped()` in `api/src/memory.ts`), so a join, a door's arrival and a
  booth's stand lay none. The server lays one per step in `app.memory`,
  keyed by the room's channel, from `presenceMeta` -- which Junction now
  hands `{ channel, conn, was }` (`FJS-1744`) -- and `rooms.traces` gives a
  joiner the room's backlog once; after that `Scene.mesa` lays its own step
  and each step presence shows it, by the same `stepped()`, so a step costs
  no frame of its own. `stage.tread()` keeps the newest footprint per cell,
  and the `steps` layer draws it as a `.` on a blank lit cell, fading through
  `STEP_FG` in thirds of `TRACES.step` (five minutes), under a falling drop
  and shaded by the night; each third is a tick of the stage's clock.
  `steps.test.js`, `memory.test.ts`, `room.test.ts` § footprints and
  `verify:steps` (two ptys and a late `--frame`). Not done: footprints in
  the browser are drawn but no drive reads one there.
- [ ] 7.5 The notice board. A board on the square's wall: stand beside it, press
  `e`, read what is pinned and pin a line. This is the part of Haven that
  works when nobody is on. A first cut is the board's own Room and its
  Messages, with no new model; check it against 3.3's retention, since a
  board's lines are meant to outlive the tavern's.
  - Needs 12.4: the board's `e` is a verb in reach, which is how the line
    input stops holding every letter.

### Phase 8 — Inhabitants

Goal: something in Haven besides members, and members doing more than
standing.
Done when: a member waves and sits on a bench where a second terminal sees it,
and the crier announces a new member's first walk-in.

- [ ] 8.1 Emotes. `/wave`, `/sit`, `/dance` animate the figure for a few
  ticks. A bench piece names its seats, so `/sit` beside one sits on it. An
  emote is a presence field beside `{ x, y }`, so `position()` in
  `api/src/rooms.ts` widens by one named key and still cuts everything else.
  - Needs 12.3 (`/sit` finds a seat as a spot) and 12.4 (an emote is a verb).
- [ ] 8.2 A pet follows its member, one cell behind on the path walked. It is
  drawn from the figure's own recent cells on every screen, so nothing is
  sent for it.
  - Needs 12.7: the pet's place is state carried from tick to tick, not a
    function of the clock.
- [ ] 8.3 Haven's crier: a system member who announces a member's first
  walk-in and a release. Its lines are Messages said through `asSystem()`.
  The repo's state reaches Haven only at deploy (`FJS-D996`), so a push to
  `main` is announced when the deploy that carries it lands, not live.
- [ ] 8.4 The barkeep, behind the bar: "ask the barkeep about row policies"
  makes Haven the framework's help desk. No model (`FJS-D994`): it answers
  from a search over `docs/`, `VOCABULARY.md` and the package READMEs,
  quoting the passage and its path, and counts the questions it could not
  answer, since that count is what would justify a model later.
  - Needs 12.4: the barkeep's question is a verb in reach of the bar.
- [x] 8.5 Booths. Two members on the stools of one tavern table are walked, by
  their own clients, into a room of their own: them on the left, you on the
  right, the conversation between, each line a bubble that stays and the next
  under it. A booth is a Room row naming its pair (`pairLoId`, `pairHiId`), so
  privacy is the Room and Message read policies and the channel, the history
  and retention are the ones every room has; `rooms.booth` finds or makes the
  row. A piece names its `seats`, which pair up; Esc stands up beside the stool,
  not on it, so the pair are not seated again at once. The pair's lines
  persist in the room, newest 500. `verify:booth` and `api/test/booth.test.ts`.
  Left open: `rooms.booth` is rate-limited but a member can still make a
  row per member; a sweep of booths nobody has spoken in is not written.
- [x] 8.6 The board behind the bar. A member who sits on a stool of the tavern's
  bar has the machine's latest activity chalked up over the shelves: the
  runner's pattern (`#errand`) a second time — `HAVEN_BAR`, else
  `~/.fli/haven/bar`, a command printing `[{ text, when? }]` newest first, run
  when the figure sits and kept a minute. Haven knows no source: Jordan's is
  `basecamp timeline me`. A stool is a `solo` seat (a seat with no mate, so it
  is never a booth); `components/Bar.mesa`, placed by the tavern's route, reads
  the figure's cell. Drawn on this screen only. Left open: a row is not a link —
  the terminal's `linked()` draws no link on a text Mesa binds in an `{#each}`
  (the same call on a literal text works), so the URL a row came with is dropped.
  `verify:bar`, `bar.test.js`.

### Phase 9 — Building and play

Goal: members change Haven and play in it.
Done when: two members finish a game at a tavern table, a house one of them
drew stands in a scene where the other walks into it, and a bolt one fires
knocks the other back on both screens and removes neither.

- [ ] 9.1 Tavern games. Dice first: `/roll 2d6` is a Message the server rolls,
  so nobody can roll their own number. Then checkers on a table piece: sit
  down and the board draws over the table, a move is a call, and the game is
  a row a service owns. This is live shared state at a small scale, which is
  the hardest thing in the framework to get right.
  - Needs 12.4: `/roll` and a table game are verbs, the game a mode while
    seated.
- [ ] 9.2 The framework quarter. A scene where each building is a package —
  the Litestone quarry, the Junction crossroads, the Mesa workshop, the
  Caravan stables. Inside, a wall reads its `PROJECT_STATE.md`; a red CI run
  is a storm over its roof and a release is a festival day in the square.
  Walking the quarter is walking the repo. The state is baked in at deploy:
  `PROJECT_STATE.md` headlines and the last CI result (`FJS-D996`).
- [ ] 9.3 Plots. A member claims an empty lot, places their house in 5.7's
  editor, and the house is a Room they own — a row of placements and a
  palette, never a stranger's glyphs (`FJS-D995` as `FJS-D997` amends it). Strangers drawing art is a
  moderation surface, so this waits on 3.2's mod standing.
  - Needs 12.1 (a plot is placements in a row) and 12.9 (the editor it is
    placed in).
- [ ] 9.4 The home row. The left hand acts while the right walks on `h j k l`:
  `a s d f` in NORMAL, each keeping what the key means in vim. A figure
  gains a facing, the way it last stepped, as one more presence key beside
  `{ x, y }` (8.1's widening of `position()`). A struck piece and a mark are
  the room's memory, the same in-memory store 7.4's footprints keep
  (`FJS-D993`), so 7.4 comes first and no step here adds a model. Check
  first: in NORMAL a letter types nothing (`Shell.mesa`), so the scene can
  read it, which may also reopen 7.5's `e` and 11.4's key; the browser's
  line has no NORMAL yet.
  - Needs 12.4: `a s d f` are key verbs, delivered along the facing.
- [ ] 9.5 `d` deletes: a bolt. It flies about 8 cells the way the figure
  faces, drawn `-` or `|`, as one event on the room's channel that each
  client animates; the server resolves what it hit, so there is one answer.
  A piece shatters and is gone for everyone for about five minutes, then
  grows back. The cat yowls and runs at double speed. A wall takes a `,`
  scorch that fades. A member is knocked back two cells and flickers `x` for
  a second, and is never removed: Haven has strangers on it, and a bolt
  that deletes a person is a griefing tool. `dd` fires all four ways on a
  longer cooldown. The cooldown, about 3 s, is the server's.
  - Needs 12.2: what a bolt hits is resolved on the server's world, not the
    caller's.
  - Server half built: `rooms.bolt` resolves a bolt or `dd` against
    `world.json`, holds the cooldown (`app.cooldowns`), lays the scorch and the
    shattered piece in `app.memory`, wipes chalk crossed, and sends one `bolt`
    event to the room (`api/test/bolt-service.test.ts`). Left open: nothing on
    the client fires it, draws the flight, moves the struck figure, flickers
    `x`, hides a shattered piece or sends a joiner the live `struck` and
    `scorch` traces; a grown-back piece is only a trace expiring.
  - Client half so far: `Scene.mesa` reads `home-row.js` and `d`, `d` + a way and `dd` call
    `rooms.bolt` (`web/test/verify-home-row.mjs` proves the cooldown refusal reaches the
    screen), and hears the `bolt` event: the flight is drawn cell by cell, the struck
    figure is moved by its own screen and flickers `x` on every screen, a broken piece
    draws as nothing and is walkable until it grows back, a struck wall takes a `,` that
    fades, and a joiner reads both from `rooms.traces` (`web/test/verify-bolt.mjs`,
    `scars.test.js`). Left open: the cat running at double speed -- it paces on the
    shared clock the server also reads, so only the yowl note is done -- and a piece
    breaking is proved by unit tests but not by a drive.
- [ ] 9.6 `f` finds. `f` and a letter walks the figure to the nearest member
  whose nick starts with it, by the flood fill the door-reach check already
  does; with nobody in the scene, an arrow at the edge points at the door
  toward them. A step or Esc cancels. This is what makes "come find me" a
  thing a member can do.
  - Built: `f` + a letter walks to the nearest lit member (`Scene.mesa`, `paths.js`),
    re-planned each step, cancelled by a step or Esc. Left open: the arrow at the edge
    toward a member in another room, and whether `f` should see through the dark.
- [ ] 9.7 `s` substitutes: a shapeshift. `s` and a character draws the figure
  as that character for 60 s, a presence key like the facing. One printable
  character only, so nothing is spelled with it. Hide-and-seek comes free:
  a `T` standing still among the trees.
- [ ] 9.8 `a` appends: chalk. `a` and a character leaves a mark on the cell
  behind the figure that fades over ten minutes: trails, `>` arrows, an X for
  a treasure hunt. A cap per member drops the oldest, and a `d` bolt wipes
  chalk it crosses. A shapeshift character and chalk are strangers' text, so
  a ban clears a member's, and a mod needs a wipe; that waits on 3.2's mod
  standing as 9.3 does.
  - Needs 12.2 (the server places chalk on its world) and 12.6 (chalk is
    drawn as a layer).

### Phase 11 — The workshop

Numbered 11 because a number is issued once, and placed before Phase 10 so the
deploy stays the last step.

Goal: every Claude session running on this machine stands in the workshop at
the bench of the package it is editing, so two sessions in one package are
seen before they collide in the shared tree.
Done when: two sessions editing one package draw as two workers at one bench
on a terminal's screen, a session that goes quiet leaves its bench, and nothing
about a worker reaches the server.

The pattern is the tavern's runner (`web/src/components/Runner.mesa`, `#errand`,
built outside the plan): something on THIS machine becomes a figure drawn on
this screen only and never sent. The workshop is its second use. A general
map of places to commands waits for a third, since two uses do not yet show
its shape.

- [x] 11.1 The scene. A workshop off the square with a bench per package, each
  bench labelled with its name; its own Room and route like the others, and a
  door from the square. The benches are pieces, so the picture is pinned like
  every scene's. Built: `Workshop.mesa`, through the house beside the
  tavern's; 28 benches in rows by name — every `packages/*`, `example` and
  `frontierjs` for the rest of the tree, which fills the one screen. A name is
  a light, so a bench is read from the door, and `scenes.test.js` fails when a
  package has no bench.
- [x] 11.2 The feed. A Claude Code `PostToolUse` hook on `Edit`, `Write` and
  `NotebookEdit` writes `~/.fli/haven/workers/<session>.json` — the file
  touched, its package, the time. A session silent past a few minutes is gone.
  Read through a `#workers` twin, the way `#errand` is: the terminal reads the
  directory, a browser has none. Transcripts in `~/.claude/projects/` are the
  other source, rejected because their shape is Claude Code's to change.
  Built: `.claude/hooks/haven-worker.mjs` hands its input to `recordWorker` in
  `web/src/workers.js`, which also reads — one owner of the shape. Quiet is ten
  minutes, since a session reading and testing goes that long between edits;
  an edit outside the repo writes nothing.
- [x] 11.3 Workers at their benches. A figure per live session at the bench of
  its package, moving when the session moves to another; two at one bench is
  the collision, drawn so it is seen from the door. The directory is read on
  walking in and watched while the member stays. Built: `Workers.mesa`, a `✻`
  per session drawn whatever the fog, three seats a bench and `(! N here)`
  beside them; the directory is read every second.
- [x] 11.4 Reading a worker. Standing beside one reads it: the session, the
  file it last touched and how long ago. Not a key, as planned: the line input
  holds the keys, so a letter pressed beside a worker is typed into the line —
  7.5's `e` meets the same problem. Its last status line needs a `Stop` hook
  as well, and comes after the file alone has been used.
- [x] 11.5 The record and the proof. Two fake worker files draw two figures at
  one bench in a drive, and the workers directory leaves no trace in any frame
  another terminal draws; Haven `CLAUDE.md` layout, `DRIVES.md` row. Built:
  `verify:workshop` — the files written through the real hook, a walk from
  the square, the reading, a `--frame` from another HOME showing the figure
  and none of the workers, then a move and a quiet session leaving.
- [x] 11.6 A raised hand. A session stopped on a permission prompt or a
  question is drawn `?`, seated first at its bench, and the bench says
  `(? N waiting on you)` — it stays past quiet, since it is waiting on you.
  The hook takes `Notification` (`notification_type` in `ASKS`; an
  `idle_prompt` is ignored) and lowers the hand on the next `PostToolUse`,
  now on every tool, or `UserPromptSubmit`; `SessionEnd` removes the file.
  Every entry is `async` but SessionEnd's. `verify:workshop`.
- [x] 11.7 Last words. A `Stop` writes `last_assistant_message`'s first line
  with words in it; the worker is `✓` and reading it gives those words. Both
  fields are the hook's documented input, not the transcript (11.2).
  `verify:workshop`.

### Phase 12 — The world as data

Numbered 12 because a number is issued once, and placed before Phase 10 so the
deploy stays the last step. Its steps are not taken in plan order: a box in
Phases 7–9 that says **Needs 12.x** waits until that step is done, and the
step is taken then. The rest of this phase follows 12.1.

Goal: everything a scene is (where its pieces stand, where it can be walked,
what each piece does and how it is lit) is data. The server, the tests and a
web world builder then all read one shape, built first for the owner over
the repo and then for members over Room rows (9.3).
Done when: the editor makes a new scene with a door to the square and a
behavior attached by form, saves it to source, and the server refuses a move
into one of its walls; the same placements loaded from a Room row draw the
same frame.

The shapes are borrowed, and the reason for each is written in its step:
Rapier keeps colliders apart from what is drawn; Threlte has `injectPlugin`
(behavior added to a subtree from outside it), `interactivity()` (events
delivered nearest first along a ray) and `useTask` (one clock, ordered
stages); Evennia and MOO keep commands on the objects in reach. Phase 11
deferred a general map of places to commands until a third use; the
Taskmaster and the bar's board are the third and fourth.

- [ ] 12.1 One placement format (`FJS-D1015`). A Room row holds `{ placements:
  [{ piece, x, y, id?, props }], doors, spawn, palette, layers }`, and one
  generic `<Placements>` mounts it as the same `<Piece>` and `<Door>` tree an
  owner's `.mesa` scene is, so an owner's scene and a member's plot are the
  same thing loaded two ways and the mounted tree still stamps (`FJS-D997`
  unamended). A row names a piece by key from `pieces/index.js`; an owner's
  scene may still define one inline. Source is the truth for the owner's
  scenes, a row for a member's (`FJS-D995` as amended). A row's world is
  derived by mounting it headlessly when it is saved, and a key the registry
  lacks or an overlap is refused by name there. Pinned by a test: the
  placements read off a scene built only from registry pieces, mounted
  through `<Placements>`, draw that scene's `.frame.txt` byte for byte.
- [ ] 12.2 `world.json`. `bun run frames` also writes, per scene, what can be
  walked, the doors, the seats and the spots, plus the graph of doors
  between scenes. It is pinned the way a `.frame.txt` is. The API reads it
  as it shares `hearing.ts`: a move onto a cell that is not walkable, or more
  than a step from the last, is dropped, as an over-rate move is, and a bolt
  is resolved on the server's world rather than the caller's `at(x, y)`. The
  editor's `problems` and `scenes.test.js` check through it, so their rules
  have one home. `ROOMS` in `api/src/rooms.ts` is read from it, so a new
  scene is no longer written in four places.
  - Half built: `bun run frames` writes `scenes/<slug>.world.json` (walkable
    rows, doors, solid pieces by id, pacers), `scenes.test.js` pins it, and
    `api/src/world.ts` reads it for the bolt and for a move: `presenceMeta`
    in `rooms.ts` refuses a cell that is not floor, or a piece the room does
    not remember broken (`standable()`), as `presence_meta_refused` naming the
    cell -- `room.test.ts`, `world.test.ts`. A room with no scene, a booth,
    has no walls. Left open: more than a step from the last cell is not
    refused, since a door's arrival and a bolt's knock-back are both jumps and
    the rate (10 a second) is all that bounds one; the editor's `problems`
    keep their own rules; and `ROOMS` is still written by hand, its names
    having no home in a scene file.
- [x] 12.3 Spots. `piece()` names cells of its own, `spots: { keeper: { dx, dy
  } }`, and `seats` and `burns` become spots of two kinds. A placement is found
  by its `id` or its piece by import, never by `piece.name === 'bar'`, and an
  actor reads a spot rather than an offset (`desk.x + 7` in
  `Taskmaster.mesa`, `b.x + 2` in `Workers.mesa`).
  Built: a spot is `{ dx, dy }` with an optional `kind` -- `seat` (`stand`, and
  a `mate` naming the seat across, else `solo`) or `burn` -- and a piece
  refuses a malformed one by name; `spotsOf(piece, kind)` lists them,
  `mark.spot(name)` is one as a cell of the stage, `stage.placed(piece)` finds a
  piece by import. A seat's mate is the seat it names, so the pairing no longer
  rests on the order of an array. The bar moved to `pieces/bar.js` so
  `Bar.mesa` can import it; the taskmaster's `keeper` and a bench's `slot-0`
  to `slot-3` replace the offsets. `spots.test.js`. Left open: `HomeBoard.mesa`
  and `world.js`'s `FRAGILE` still find a piece by `piece.name`, and an id
  (`piece@x,y`) is not yet a way to find a placement.
- [ ] 12.4 Verbs in reach. `$context.commands` grows into the one registry:
  an actor contributes its verbs, `{ word?, key?, help, run, reach? }`, and
  what a member can say is the merge of their own, the room's and those of
  every placement within reach. A mode (the history pane, `/map`, a booth)
  replaces the arrows and Esc while it is open, in place of the `pane` and
  `charting` flags. Tab, the hints and the help for an unknown command are
  read from the merge. A key action is an event delivered along the figure's
  facing or reach, nearest first, which is what `fly()` already does for a
  bolt. `Scene.mesa` is cut down to the stage, the presence and the input,
  and `/w`, `/ban`, `/map`, the history pane, the bubbles, the nameplates and
  the booth each become an actor of the Taskmaster's shape.
  - Half built: `commands.js` is the registry (`createCommands()`: `add`,
    `words`/`helps`/`find` by reach, `press`, and `open`/`modeKey` for a mode)
    and `Scene.mesa` reads it for the line, Tab, the hints, the keys and the
    unknown-command help. `Whisper`, `Mod`, `WorldMap`, `History`, `Bubbles`,
    `Nameplates` and `Sitting` are actors placed by the scene; `Taskmaster`
    and `Ledger` add to the same registry, the desk's `/yes` and `/no` now
    only in Tab and the help within two cells of him (`commands.test.js`,
    `crowd.test.js`). Left open: the home row, the bolt and `find` are still
    in `Scene.mesa` and take their keys by hand (9.4/9.5 are the key verbs
    along the facing), a verb has no `reach` along the facing yet, and the
    booth route's Esc is its own rather than a mode. `verify:explore`,
    `verify:bolt` and `verify:workshop` fail on screens that now draw
    footprints and scorches over the cells they read; they were not
    re-pinned here.
- [ ] 12.5 Behaviors with a schema. A behavior (the bar's board, the
  Taskmaster, the runner) declares its props as a schema and is attached to
  a placement by `id`, so the editor draws a form for it. The code is still
  written by hand; the GUI only places it and fills its fields. A behavior
  that runs a command on this machine is still placed by a route, never by a
  scene, so a scene's picture runs nothing. Taken after 12.4 and right
  before 12.9, so it is built when a builder asks for it.
- [x] 12.6 Layers. `stage.look()` is a fold over the layers a scene names:
  the sky, fog, light, a seat's candle, 7.3's weather (built into `look()`
  before this step and moved out by it) and next 7.4's footprints. `indoors`
  and `FOG` become "that layer is not named". Mostly this shrinks `stage.js`
  back to cells and claims. Built: `LAYERS` -- `candle`, `weather`,
  `steps`, `sky`, `fog`, folded in that order whatever order a scene names
  them -- each one rule over a cell's look and, where it moves, a tick of
  its own for `tickOf`. `<Scene layers={INDOORS}>` replaces `indoors`
  (`OUTDOORS` is the default and names no fog); a name not in `LAYERS` is
  refused at `createStage`. Light stayed inside the sky: a lamp's pool is the
  sky's rule about light, not a layer of its own.
- [x] 12.7 One clock. `stage.task(key, fn, { after })` with phases simulate,
  light, paint, and a redraw only when something invalidates it, in place of
  the runner's `setTimeout`, the Taskmaster's poll and the pacers' own time.
  A test steps it by hand, so a scene with state is pinned at tick N the way
  `look(x, y, ms)` pins one without. Built: `stage.task(key, fn, { phase,
  every, after })`; `phase`, not stage, since the Stage is the noun it hangs
  on. `every` is on the wall's clock, so two screens poll on one beat. A
  paint runs on a change (at once, as before, so a drive reads a step the
  moment it is taken) and on the look's next tick; both `#paint`s are paint
  tasks, and the runner, the Taskmaster, the workers and the bar's scroll are
  simulate tasks. `createStage({ manual: true })` keeps no timer, and
  `stage.frame(ms)` steps it -- `clock.test.js`. Left on their own timers: the
  booth's one-shot waits (a candle's smoke, the typing flag), which follow
  a key rather than the clock, and `Scene.mesa`'s find-walk; the fog's
  relight still runs in the change that needs it, so the `light` phase holds
  no task yet.
- [x] 12.8 A piece's palette. A piece carries the palette entries it needs
  (the lamp's `Y` and its `light`) and a scene's palette overrides them, so a
  piece placed in a scene that lacks one still draws. A check fails on a
  paint letter that neither defines.
  Built: `piece(…, { palette })`; the stage reads a letter through
  `stage.entryOf`, the scene's entry first and the placed pieces' after, and
  refuses two pieces giving one letter different entries when the scene does
  not settle it (`stage.defaults` lists what pieces brought). The lamp carries
  `Y` (light 4); the square, lane and docks dropped their copy and the cellar
  keeps its 5. `scenes.test.js` fails a scene whose piece uses a letter
  neither defines; `spots.test.js`. The editor's palette panel lists only the
  scene's own entries, so a piece's default is not editable there.
- [ ] 12.9 The world editor. The editor grows from one scene at a time to the
  world: the door graph from 12.2 drawn and edited, with an unpaired door shown
  while it is placed; a behavior's form from 12.5; the layers from 12.6
  toggled; the clock from 12.7 scrubbed; a new scene made. It saves to source.
  The members' builder is 9.3, over the same format through rows.

### Phase 13 — Homes

Goal: the people who work here each have a home in the haven, and their own
Basecamp is on its walls — pinned projects, the inbox, pings and what is due —
drawn on their screen alone.
Done when: Jordan, Vlad and Colin each walk into their own home and read their
own board, and none of them sees another's.

The homes are hand-built in source, ahead of 9.3's plots: a plot is a member
building their own, and these three are the shape it will produce.

- [x] 13.1 The lane and three homes. `Lane.mesa`, east across the road's
  border, with a cottage per member (`cottage(name, roof)` in
  `pieces/home.js`), a mailbox at each gate; `Jordan.mesa`, `Vlad.mesa` and
  `Colin.mesa` inside, each a Room in `ROOMS`. Every home has the board's
  furniture in the same places — cork board, screen, desk and chair, calendar,
  bell, mat — and its own decor beside it. Pinned by `scenes.test.js`.
- [x] 13.2 The board. `HAVEN_HOME` (else `~/.fli/haven/home`), the third
  opt-in beside the errand and the bar: a command printing `{ home, pins,
  inbox, pings, due }`, read by `#errand`'s `homeBoard()` and held a minute.
  The board NAMES its home and `HomeBoard.mesa` draws it there alone, so a
  visitor's account never lands on the host's walls. Pins on the cork board
  (how long since each moved, how much moved today), the inbox on the screen —
  its count and the newest standing, all of it sat at the desk — what is due on
  the calendar, a letter on the mat per thing unread, the bell ringing for a
  fresh ping and its pings read out beside it, a flag on the lane's mailbox.
  `scripts/basecamp-home.mjs <home>` is the one source, over the `basecamp`
  CLI. `home-board.test.js`; proved live by `--frame`s of the lane and two
  homes through a real API (a visitor's frame bare).
- [ ] 13.3 Vlad's and Colin's boards. Each runs `basecamp-home.mjs vlad` (or
  `colin`) on their own machine, under their own `basecamp auth login`; nothing
  in Haven changes. Asks them, not the code.
- [ ] 13.4 A drive: `verify:home`, a pty sitting at the desk (the inbox
  scrolling), standing by the bell (the pings pane), and a second HOME's pty
  in the same home drawing none of it.
- [ ] 13.5 The board in a browser. `errand.browser.js` has no board, as it has
  no bar, since a page runs no command. A board pushed from the member's
  machine to their own Room would reach the page, and would also be a
  member's data on a server for the first time — a ruling first.
- [ ] 13.6 Whose home it is. Today a home is its board's by name; with 9.3 a
  Room has an owner, and the board draws where the viewer is the owner.
  - Needs 9.3.

### Phase 10 — Hosted

Goal: Haven answers at a public address, so a stranger needs no `--api`.
Done when: `bunx @frontierjs/cli haven` on a machine that has never seen this
repo shows a figure that a second machine can see. (`fli` on npm is somebody
else's package.)

- [ ] 10.1 Deploy through outpost at `haven.maverickmade.tech` (the apex is on
  Cloudflare; the subdomain has no record yet), with Haven's API serving
  `web/dist` (5.2). `web/config/sierra.config.js` moves to it when a server
  answers there, not before. The machine is not named.

## Ideas past the plan

Not steps. Each becomes one at the end of the plan when it is wanted. The
first group is the runner's pattern: from this machine, drawn on this screen
only. The second is shared, so it is rows or presence. The third is scenes,
each tagged with the mechanism it would add, cheapest first.

**This machine's**

- **CI as the square's weather.** Clear when `.cache/ci-last.txt` is green,
  rain when a phase failed, a storm when several did. 7.3 draws the overlay;
  this picks it. Distinct from 9.2's roof storm, which is baked in at deploy
  (`FJS-D996`) and is the framework's, not this machine's.
- **Ships at the docks.** A ship pulls in when a deploy lands, and one stuck at
  sea is a deploy that hung. Pairs with 8.3's crier, which announces the same
  landing.
- **The petition board.** The town hall pins the owner's open decisions
  (`fli decisions`); read one, pick an option, and the ruling is written.
- **The woods as `ISSUES.md`.** The more open issues, the denser and darker the
  woods; walking in is triage, and closing issues clears the path.
- **A customer at the bar.** When the `support` skill finds an ELA customer
  waiting, a figure stands at the bar with the conversation and the drafted
  reply.
- **Signposts on the road.** One per client site, its lantern lit while the site
  answers, flickering when the analytics check flags a drop.
- **The clock tower** rings before the next meeting on the member's calendar.

**Shared**

- **A lit window.** A member deep in work lights their house's window in the
  square, so others see who is working without interrupting. A presence field,
  as 8.1's emote is.
- **The pairing table.** Two members sit at a tavern table and one shows the
  other a terminal's `fli` output scrolling on the tabletop, read only, shown
  by choice.

**Scenes**

What's built already carries these:

- **The library.** A quiet room: a line is heard a stool away, and a shout is
  answered with a hush. The shelves are `DECISIONS.md`, and standing at one
  reads a ruling. The one change is `EARSHOT` (`api/src/hearing.ts`) becoming
  the scene's rather than Haven's. The first to build: it makes 7.1 felt and
  ties Haven to the repo as 9.2 does.
- **The graveyard.** Past the glade, behind a night door (6.6). A stone per
  closed issue or deleted package, its epitaph from `ISSUES_ARCHIVE.md`.
- **The market.** Each stall is a booth (8.5), so two members at one stall share
  a conversation. A stall a member rents is plots (9.3) at a smaller scale, and
  could come before 3.2's mod standing does.
- **Rooftops.** A ladder in a house, there at night only. A narrow run where a
  step off the edge is a door back to the square at the cell you fell from.

One mechanism each:

- **The lighthouse,** at the docks' far end. Its beam is a light that turns on
  the clock. Light is steady today (`litAt` takes no tick), so this is a moving
  light, still a pure function of the clock and so still sent nowhere.
- **The mine,** under 9.2's quarry. Pitch dark, and a figure carries a lantern —
  a light that moves with its member, so the others are seen by theirs. This is
  what gives `FOG` a reason to come back on.
- **The hedge maze.** Generated from the date, so every terminal walks the same
  maze and it changes at midnight with nothing stored, as the sky does (7.2).
  The first member to reach the middle is announced by 8.3's crier.
- **The amphitheater.** A member on the stage is heard by the whole scene, which
  is earshot turned inside out: hearing becomes a property of the cell as well
  as of the speaker. For demos and office hours.
- **The frozen pond.** The glade's pond when 7.3's weather is snow: a step onto
  the ice slides until a wall stops it, which is room for small puzzles.

These need server state:

- **The post office.** A mailbox per member. A whisper sent while its member is
  offline waits there until they sign in — 7.1's `toId` row with a read flag.
- **The ferry.** The ship at the docks sails on a timetable, and its door is
  there only while it is docked — 6.6's night door on a schedule. It runs to
  an island, which is Haven's far, quiet place.

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
