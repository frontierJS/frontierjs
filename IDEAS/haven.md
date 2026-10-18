---
id: haven
status: proposed
dated: 2026-10-14
---

# Idea — Haven: a place in the terminal anyone with `fli` installed can walk into

**Status: PROPOSED. Phases 0, 1, 2 and 4 are built — the schema, the API, the signed login, the square and the tavern in color and motion, and `fli haven` in front of them, which installs the server's own Haven on a machine with no checkout (3.1); nothing is published yet. Phase 5 is built but for the editor in VS Code (5.4): a scene is a component tree over a stage (5.5, `FJS-D997`), its picture committed beside it and pinned; a browser tab and a terminal stand in one room (5.2, 5.6); and `fli haven:scenes` places pieces on a page and writes the tree back byte for byte (5.7). Phase 6 is begun: the view follows a figure across a square wider than a screen (6.1); 6.2–6.5 and Phases 7–9 — a Haven that lives, inhabitants, building and play — are proposed. The deploy is the last step (10.1, by the owner); Phase 11, the workshop placed before it, is built; Phase 12, the world as data, is proposed, and a box that says **Needs 12.x** waits on that step; Phase 17, a kit of pieces, is begun (17.1–17.2); and every open question is ruled, so each step cites its ruling. Work the plan from the first open box.** Dated 2026-10-13. The
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
`web/src/lib/session/sign-in.js` exports.

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
  the running `fli`, imports Haven's own `web/src/lib/session/sign-in.js` (the key at
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
  Found: a field `@allow(write)` DROPS the key rather than refusing
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
- [x] 5.5 The stage (`FJS-D997`). `web/src/lib/scene/stage.js` is `createStage({ slug,
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
claims' extent (`web/src/lib/scene/stage.js`, 5.5), `stage.look()` answers one cell at a
tick, and `at()` places a box on a cell, so a world larger than the screen is a
slice and an offset. The 26-row
cap in Haven's traps is the VIEWPORT's, from `--frame`'s 100×30, and stays;
a scene's art is bounded only by the server's `MAX_CELL` (255) in `api/src/rooms.ts`.
FJS-D985's "never a forked world" holds: both targets show the same viewport.

- [x] 6.1 The camera is the stage's `view` (`web/src/lib/scene/stage.js`): the slice a
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
  kept as a snap (`coarse()` in `web/src/lib/scene/map.js` — the picture at `SCALE`, its
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
  is sent, so every terminal sees the same sky. Built: `web/src/lib/scene/sky.js`, a pure
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
  a first one. Built: `web/src/lib/scene/sky.js` -- a spell of weather is ten minutes
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
  `STEP_FG` in thirds of `TRACES.step`, under a falling drop
  and shaded by the night; each third is a tick of the stage's clock.
  `steps.test.js`, `memory.test.ts`, `room.test.ts` § footprints and
  `verify:steps` (two ptys and a late `--frame`). Not done: footprints in
  the browser are drawn but no drive reads one there.
- [x] 7.5 The notice board. A board on the square's wall: stand beside it, press
  `e`, read what is pinned and pin a line. This is the part of Haven that
  works when nobody is on. A first cut is the board's own Room and its
  Messages, with no new model; check it against 3.3's retention, since a
  board's lines are meant to outlive the tavern's.
  - Needs 12.4: the board's `e` is a verb in reach, which is how the line
    input stops holding every letter.
  - Built: `pieces/board.js` (`noticeBoard`, its `middle` spot) stands right
    of the fountain at (64, 13), and `components/Notices.mesa`, placed by the
    square's route in a new `<slot />`, owns it. `e` (a key verb answering
    false unless the shell took the letter as NORMAL), `/board` (the same, for
    a browser, which has no NORMAL) and `/pin <line>` all reach 5 cells round
    the board's middle; a figure there reads a hint under it. The pane is the
    registry's mode, newest first, PageUp/PageDown, Esc closes. The board is
    `board` in `ROOMS` and a pin a Message in it: no schema change, the read
    policy, the rate and 3.3's count of 500 a room are every room's, and the
    count is what lets a quiet board outlive the tavern. The pins are asked of
    `messages.service` and never loaded into the store the bubbles read, so a
    pin is no bubble over its author. Nobody stands in the board's room, so a
    pin reaches no screen live; the board is read each time it opens. Proved
    by a throwaway two-pty probe (pinned, read, `e` in NORMAL, out of reach
    refused, no bubble on either screen) -- no drive kept, as the owner asked.
- [x] 7.6 The almanac. One `almanacAt(ms)` in `sky.js` answering `{ darkness,
  season, moon, weather, wind, temp }`, and every layer reads that record
  instead of asking `darkness`, `weatherAt` and `worn.season` separately.
  The rule it holds: what the WORLD causes is a pure function of the clock
  and is sent nowhere; what a MEMBER causes is a trace in `api/src/memory.ts`.
  Each element in 7.7–7.10 says which side it is on, and all four are on the
  clock's. A screen override (`/weather`, `/season`, `HAVEN_WEATHER`) replaces
  one field of the record and nothing else.
  - Built: `almanacAt(ms)` is `{ darkness, season, weather }` -- `moon`,
    `wind` and `temp` are each added by its own step, since a field with no
    reader is not built. `weatherAt` is gone; `skyDarkness`, `flashAt`,
    `isNight` and the stage's `weather` layer, tick and struck tree read the
    record. `hold(field, value)` is the one override, `null` handing a field
    back to the clock, and `heldOf(field)` what is held (`HAVEN_WEATHER` under
    a screen's hold). `SEASONS` moved to `sky.js` and `seasonAt(ms)` is
    `summer` until 7.7; `/season` is now a hold with an `auto` like
    `/weather`'s, and a stage is made in the almanac's season, so `worn`
    carries the ink alone -- 7.7's override clause is done here. `sky.test.js`
    holds one field held and the rest the clock's. `verify:glade` and
    `verify:scenes` pass; `verify:browser` fails only its fog check, as before.
- [x] 7.7 The calendar. The season is the real one at the server, by UTC date
  and meteorological months (Dec–Feb winter), northern hemisphere -- the
  owner's choice, over a game year of a few real days. The day stays an hour.
  The season changes pieces' art, so a scene's pinned frame would flip with
  the month: `stage.mjs` pins it as it pins `clear` weather. Each
  season weights `scheduleAt`'s spells: no snow outside winter, storms mostly
  summer, rain mostly spring and fall. A stage is made in the almanac's season
  (7.6 made `/season` a hold and the stage take the almanac's season, so
  this step is `seasonAt` reading the date). A piece with no `seasons` is
  unchanged.
  - Built: `seasonAt(ms)` reads the UTC month; `SPELLS` is ten spells per
    season (winter 6 clear, 1 rain, 3 snow, no storm; summer 7/1/0/2; spring
    and fall 5/4/0/1), drawn by the CLOCK's season, so a screen holding winter
    sees no snow the clock did not send. `HAVEN_SEASON` is the second pin
    beside `HAVEN_WEATHER` -- a hold cannot reach a drive's pty or Vite
    children, an environment can -- read through one `pinned(field)`, with
    both Vite configs baking it in. `stage.mjs` sets it to `summer`, the
    season every frame was drawn in, so no frame moved. `sky.test.js` holds
    the month boundaries in UTC, the weights over 600 spells a season, and a
    bad pin falling back to the clock; an unpinned process draws fall today.
    Suite 512/512, `verify:glade` and `verify:scenes` pass; `verify:browser`
    fails only its fog check. Not done: a scene open across midnight UTC on
    the first of a season's month keeps the season it was made in until the
    next door, since nothing turns a live stage on the date.
- [x] 7.8 Wind. A direction and a strength per weather spell, from the clock's
  `hash`, stronger in a storm. The rain's slant, snow's drift and the clouds'
  drift each read it instead of their own numbers, so they agree. Later
  readers: smoke from a chimney, fire spreading to the next tree downwind.
  - Built: `windAt(ms)` is `{ dx, strength }` -- `dx` 1 east or -1 west,
    `strength` an index into `GUST` (`[0, 5, 2, 1]`, steps of a fall per
    column of drift; 0 is calm) -- and the almanac's `wind`. A storm blows 2
    or 3, any other spell 0 to 2. It is drawn by the CLOCK's spell, so a
    screen holding a storm keeps the clock's wind (7.6's rule: a hold
    replaces one field); a held storm over a calm clock falls straight.
    `FALL` lost its `drift`: `fallAt` and `cloudAt` take the wind, a cloud
    drifting a column every `GUST × CLOUD_MS`, so it keeps pace with the
    rain under it. Rain and storm lean (`\` east, `/` west) at GUST 2 or
    less, else draw `'`; snow stays `*`. `DROPS` is every drop glyph, which a
    test reads a wet cell by. Horizontal only: smoke rises and needs no `dy`.
    Suite 515/515; `verify:glade` and `verify:scenes` pass; `verify:browser`
    fails only its fog check; `verify:explore` fails only FJS-2877's fog
    checks, once its `over here` line got the `i` NORMAL mode needs.
- [x] 7.9 The moon. The real lunar phase on the date (a 29.53-day cycle), to
  match 7.7's real calendar. A full moon lightens `shade()`'s night and a new
  moon darkens it; `SIGHT` reads it when the fog returns. Drawn as a glyph in
  the sky row at night where a scene has open sky.
  - Built: `moonAt(ms)` is `{ phase, light, ch, arc }` and the almanac's
    `moon` -- the mean synodic phase counted from the new moon of 2000-01-06,
    `light` the lit part in quarters (a shaded color is cached per step, as
    darkness is in thirds), `ch` by eighth (`)` `D` `O` `O` `O` `C` `(`, lit on
    the right while waxing; none at new moon) and `arc` 0 to 1 through full
    night, a step every `SKY_MS`, null otherwise. It is the clock's side and
    not holdable: no screen asked to hold it, and a test hands `ms`. `shade(hex,
    level, light)` takes the moon: the night's kept channels run from
    `NEW_NIGHT` to `FULL_NIGHT`, a half moon being the old `NIGHT`, so the
    1970 test clocks (a half moon) drew the colors they did. The `sky` layer
    draws the glyph in `MOON_FG` on `MOON_ROW` (row 1, inside the top wall),
    crossing east to west inside the side walls, on a blank lit cell only, so a
    chimney, a cloud or a drop hides it; the stage's sky tick now lands on the
    clock's `SKY_MS` steps rather than `SKY_MS` after the last paint, so the
    moon and the dusk move on time. `sky.test.js` holds the real dates (full
    2026-10-26, new 2026-10-10), the arc, the shade either side of half, and
    the square's moon one cell on its sky row by night and none by day, at new
    moon or in the tavern. Not done: `SIGHT` does not read the moon, since the
    fog is off; the moon is a glyph a drive reading row 1 at a real night
    meets, unpinned, as rain was before `HAVEN_WEATHER`.
- [x] 7.10 Temperature and aftermath. `tempAt(ms)`, derived from season, hour
  and weather and never stored, decides what falls: a cold rain spell is snow
  (the frozen pond, past the plan, reads it too). Aftermath is what a spell
  leaves on blank outdoor cells after it ends, read from the spells before
  `ms`, so it is still the clock's: puddles for some minutes after rain, snow
  cover that builds during a snow spell and melts by temperature. A struck
  tree's burn and char are aftermath by this rule already; which tree is the
  stage's, since the almanac knows no geometry.
  - Built: `tempAt(ms)` is whole degrees Celsius -- the clock's season
    (`WARMTH`: spring 8, summer 21, fall 9, winter -1 at dusk), four up by
    day and four down by night through `darkness`, the spell's clouds
    (`CHILL`: rain -2, storm -4) and a swing of three either way per spell;
    the almanac's `temp`, not holdable. `SPELLS` schedule no snow any more
    (winter is 6 clear, 4 rain): a rain spell at or below 0 falls as snow,
    so a winter day is about a quarter snow, a cold spring night may snow,
    and a summer never does. `groundAt(ms)` is `{ wet, snow }`, 0 to 1, the
    almanac's `ground`: the last `GROUND_MS` (an hour-long day) replayed a
    `SKY_MS` step at a time from bare -- rain or a storm wets in two steps
    and a dry step dries a quarter, so puddles last eight minutes; snow
    covers a third a step and nothing thaws while it falls, else a tenth per
    degree above 0. The ground follows a HELD weather, as though it always
    had it: a held `clear` is bare ground, which is what keeps every pinned
    frame and drive as it was. The stage's new `ground` layer, after `steps`
    in `LAYERS` and in `OUTDOORS`, draws `groundOn()`: a `~` puddle on up to
    one blank lit cell in twelve, a `·` cover on up to one in two, fewer as
    each fades, a drop and a footprint in front. `/weather` says the
    degrees. `almanacAt` keeps its last answer, since a paint asks it once a
    cell at one `ms` and the extra fields put the scenes' every-tick test
    over its 30 s. Suite 525/525; `verify:glade` and `verify:scenes` pass;
    `verify:steps` fails only its Rex check, filed as FJS-2883 (a
    `--frame` walking in gets no footprints from the server). Not done: snow
    melting leaves no puddle, a puddle does not freeze, and the dusk's
    darkness steps sit half a `SKY_MS` off the sky tick, so a rain turning to
    snow at dusk is drawn up to a minute late.

### Phase 8 — Inhabitants

Goal: something in Haven besides members, and members doing more than
standing.
Done when: a member waves and sits on a bench where a second terminal sees it,
and the crier announces a new member's first walk-in.

- [x] 8.1 Emotes. `/wave`, `/sit`, `/dance` animate the figure for a few
  ticks. A bench piece names its seats, so `/sit` beside one sits on it. An
  emote is a presence field beside `{ x, y }`, so `position()` in
  `api/src/rooms.ts` widens by one named key and still cuts everything else.
  - Needs 12.3 (`/sit` finds a seat as a spot) and 12.4 (an emote is a verb).
  - Built: `emote` is a presence key (`EMOTES`, `emoteOf`, `EMOTE_MS` in
    `api/src/shape.ts`; `roomMeta` drops anything else, and
    `presenceMetaBytes` is 120 so the fullest meta still fits).
    `components/Emotes.mesa` says the three verbs and draws them for every
    figure in view: a wave is a hand beside the figure, a dance an arm either
    side, turning over every 300 ms for four seconds and ended by its own
    timer; a sitting figure is its initial in lower case on other screens. A
    bench names three solo seats (`seat-0`..`seat-2`), so `/sit` beside any
    seat of any placed piece -- a bench, a bar stool, a table's stool -- within
    a cell sits on the nearest free one, else where the figure stands, and
    stepping onto a seat sits too. A step (`moveTo`) ends any emote. Proved by
    the same throwaway probe: a wave seen and turning over on the other
    screen, `/sit` onto the bench in lower case, a step standing up, a dance.
    Not done: a knock-back from a bolt moves the figure without ending its
    emote, and the bench's seat cells are now walkable in `world.json`.
- [x] 8.2 A pet follows its member, one cell behind on the path walked. It is
  drawn from the figure's own recent cells on every screen, so nothing is
  sent for it.
  - Needs 12.7: the pet's place is state carried from tick to tick, not a
    function of the clock.
  - Built (owner: opt-in, the kind by id in the owner's ink): `/pet` calls it
    and sends it home, and `pet: true` is the one presence key it adds
    (`roomMeta`; `presenceMetaBytes` 128, since the fullest meta with an emoji
    shape is 123). `web/src/lib/scene/pet.js`: `PETS` (dog `ö`, cat `ɷ`, snail `&`,
    mouse `ε` -- no letter, since a figure is one), `petOf(id)`, and
    `trail(was, at, facing, free)` -- a step puts the pet on the cell left,
    anything else (a first sight, a door, a knock-back) behind the facing or
    on the first free neighbor. `components/Pets.mesa` walks every trail on
    `stage.task('pets', …, { every: 100 })` and draws under the figures, never
    on one, in view and in the light; `worn.pet` keeps it out across doors.
    Proved by a throwaway two-pty probe: beside Sam on both screens after
    `/pet`, on the cell he left after four steps east on both, a late
    `--frame` drawing it at the same cell, gone on both when sent home.
  - Not done: two screens disagree until the figure's first step they both
    see; the server knows nothing of a pet, so a bolt flies through it.
- [x] 8.3 Haven's crier: a system member who announces a member's first
  walk-in and a release. Its lines are Messages said through `asSystem()`.
  The repo's state reaches Haven only at deploy (`FJS-D996`), so a push to
  `main` is announced when the deploy that carries it lands, not live.
  - Landed, amended: the crier is a Member row with no key (`api/src/crier.ts`,
    made on first asking; a first login asking for the nick is refused as
    taken) that speaks through `messages.create` inside `app.runAs(itsId)`, not
    as the system: the service call is the one place a write is broadcast, so
    an `asSystem()` row would be history on nobody's screen. Speaking as a
    member puts it under the five-in-ten-seconds line limit, which is the guard
    against a key minted in a loop crying a welcome each time; a welcome past
    it is dropped. The login awaits the welcome, so a newcomer's client loads
    their own. The release is `api/index.ts` after `start()`: `Haven <version>
    has landed.` in the square unless the square already holds that line.
    `components/Crier.mesa`, placed by the square's route, draws the crier's
    newest line across row 1 for `CRY_MS` (8 s) after it was said. Proved by a
    throwaway probe (live welcome to a second socket, a second login silent,
    the nick refused, a release cried once, a burst cut at the limit) and a
    pty one (Sam reads his own welcome and it goes; Rex's `--frame /` carries
    his; Sam's screen hears Rex's live); no drive kept.
  - Not done: a release says only the version — no headline of what changed,
    which 10.1's deploy would have to bake in. A version whose cry has rolled
    past the square's 500 lines is cried again at the next restart. Nothing
    kept fails if a welcome stops reaching the room or a release is cried
    twice -- the probes were thrown away; a test is owed when this settles.
- [x] 8.4 The barkeep, behind the bar: "ask the barkeep about row policies"
  makes Haven the framework's help desk. No model (`FJS-D994`): it answers
  from a search over `docs/`, `VOCABULARY.md` and the package READMEs,
  quoting the passage and its path, and counts the questions it could not
  answer, since that count is what would justify a model later.
  - Needs 12.4: the barkeep's question is a verb in reach of the bar.
  - Landed: `/ask <question>` is a verb per bar stool (`Barkeep.mesa`, placed
    by the tavern's route); `barkeep.ask` searches the books server-side
    (`api/src/barkeep.ts`: passages by heading, the question's words weighed
    by rarity, an answer only above `COVER`) and a question it cannot answer
    is a `Miss` row, so the count is `SELECT count(*) FROM Miss` and the rows
    say what the docs lack. `docs/*-archive` is left off the shelf. Proved by
    a pty probe (answer, miss, out of reach, Esc), not a kept drive.
  - Not done: the server reads the books from a checkout (`HAVEN_BARKEEP_ROOT`,
    else the repo it sits in), so 10.1's deploy must ship them or the
    barkeep says he has none. The misses reach the owner only through the
    database; beside the town hall's count in `fli next` (15.4) is the place.
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
  - [x] 9.1a Dice. `/roll 2d6` is said by the dice, a keyless member, so a
    roll is whatever they say; a mod's `pike, roll 2d6` makes an agent throw.
  - [x] 9.1b Checkers. Sit across a table and the booth is the board: `/checkers`
    begins a game, `/move c3 d4` (a capture chain `c3 e5 g7`) moves, `/resign`
    gives it up. The game is a `Game` row per booth, written only by
    `games.service.ts` as the system after `checkers.ts` has checked the path
    -- a client never says what the board is -- and read by the pair alone. The
    board draws in the booth's middle column from the viewer's side, the
    conversation under it; each move is told to the pair as a `checkers` event
    and each screen reads the game again. American rules, a capture compulsory
    and a chain continued. Left open: the agents do not play (they stand in the
    tavern, not in a booth); a booth's game has no clock, so one walked away
    from stays on until `/resign`.
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
- [ ] 9.5 `d` deletes: an arrow. It flies the way the figure faces until it
  hits something, drawn as one head (`>` `<` `^` `v`) moving a cell at a time, as one event on the room's channel that each
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
- [ ] 9.9 Inventory. What a member carries, in the API's memory beside the
  room's (`app.inventory`, `api/src/inventory.ts`), never a row and gone on a
  restart. A count per item; `ITEMS` states each one's start, cap and how
  often a short count earns one back. Built: the arrow -- ten to start, `d`
  spends one, `dd` four, an empty quiver is refused before the cooldown
  starts, one comes back every 20 s below ten -- and `/inv` lists what is
  held (`members.inventory`). Picking up is built: a floor piece with
  `pickup: { item, n }` is named in every `world.json` (`pickups`, pinned by
  `scenes.test.js`), the server hands the item when a figure stands on it and
  lays a `taken` trace (`TRACES.taken`, two minutes) that is the piece gone for
  the whole room until it expires, told as a `pickup` event that `Scene.mesa`
  hides it by; a full quiver leaves it lying. Five quivers of five arrows lie in
  the woods. Left open: a drive of it on a screen (`verify-bolt.mjs` fires, none
  walks onto one), and items beyond the arrow.

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
  `web/src/lib/hash/workers.js`, which also reads — one owner of the shape. Quiet is ten
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
- [ ] 11.8 Git at the benches. Each bench reads its package's last commit
  (`git log -1 -- packages/<pkg>`: subject, author, how long ago) and its
  uncommitted files (`git status --porcelain -- packages/<pkg>`), so a bench
  dirty with no worker at it is work a session left behind. It needs no
  opt-in, because it reads only the repo Haven runs from, which is no
  stranger's command. A `#git` twin, the way `#workers` is: the terminal runs
  `git`, a browser has none. Read on walking in and held a minute.
- [ ] 11.9 GitHub at the benches. Open PRs and the last CI run per package,
  from `gh pr list --json` and `gh run list --json`. These go through the
  member's own `gh auth`, so this is a command opt-in: a stranger's `gh` must
  not run. The errand, bar and home board are already three opt-ins, each
  with its own env var and file, and this phase's general map of places to
  commands was waiting for a third. So GitHub is the map's first entry, not a
  fourth env var.
  - Needs a ruling on the map: one file naming each place's command, which
    `errandCommand`, `barCommand` and the home board move into.
  - Already possible with no code: `HAVEN_BAR` set to `git log -10
    --format='%s%x09%cI' | jq -R -s 'split("\n")|map(select(length>0)|split("\t")|{text:.[0],when:.[1]})'`
    prints the bar's `[{ text, when }]`.
  - The browser half meets 13.5's wall: a page runs no command. Getting there
    needs a GitHub webhook into the server through conduit, which puts a
    member's data on a server, so a ruling comes first.

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
- [x] 12.4 Verbs in reach. `$context.commands` grows into the one registry:
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
  - Built: `commands.js` is the registry (`createCommands()`: `add`,
    `words`/`helps`/`find` by reach, `press`, and `open`/`modeKey`/`close`
    for a mode) and `Scene.mesa` reads it for the line, Tab, the hints, the
    keys and the unknown-command help. `Whisper`, `Mod`, `WorldMap`,
    `History`, `Bubbles`, `Nameplates`, `Sitting` and `HomeRow` are actors
    placed by the scene; `Taskmaster`, `Ledger` and `Assembly` add to the
    same registry, the desk's `/yes` and `/no` only in Tab and the help
    within two cells of him. The home row is `HomeRow.mesa`: `a s d f` are
    key verbs that answer false in INSERT, and a waiting operator and a
    find-walk are modes with a `take`, handed every key first, Esc included;
    a bolt landing on the figure stops its walk with `close('find')`. A key
    is pressed with the figure's `facing`, and of two verbs as near, the one
    faced is asked first. `Scene.mesa`'s keydown is Tab, the open mode,
    `press`, a step. Proved by `commands.test.js`, `verify:home-row`,
    `verify:bolt`, `verify:map`, `verify:taskmaster` and `verify:browser`
    (all but its fog check, off while no scene names `fog`). Left open: the
    booth route's Esc is its own rather than a mode, and the bolt's flight
    and stun flicker are drawn in `Scene.mesa`, since a struck figure's
    glyph is one it draws.
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

### Phase 14 — Claude in Haven

Goal: Claude helps build scenes beside the editor, and two named agents live in
the square; emoji and denser scenes widen what a scene can draw.
Done when: a scene made in the editor through its ask panel passes
`verify:scenes`, and a mod's line to an agent is answered on a second terminal
while a non-mod's is not.

- [x] 14.1 The ask panel in the scene editor. `editor/vite.config.js` adds the
  ask plugin (`packages/cli/core/vite-ask.js`, as Sierra's
  `src/build/ask-plugin.js` loads it) and turns Mesa's inspector on, which a
  bare `mesa()` leaves off. Its edit scope is the Vite root, `editor/`, while
  scenes and pieces live in `web/src/`, so the scope widens to `SRC`. Since
  `FJS-D997` Claude writes `<Piece>` placements into the scene's `.mesa`, and
  the save already hot-swaps the editor onto it.
  - Found: a bare `mesa()` has the inspector ON; what was missing is where locs
    are rooted — `mesa({ locRoot })` and `askPlugin({ root })` both take `SRC`.
    A placement is no element, so the editor lays a box per tag (its line as
    the loc) and one for `<Scene>`; and the HMR swap of a scene left the editor
    on a dead stage, so another writer's edit reloads the page. Unsaved edits
    are lost to an ask (a trap in `CLAUDE.md`). `verify:scenes` 66 green.
- [ ] 14.2 The builder's stages. The editor walks a new scene through, in
  order: the brief (name, mood, size, its doors in the door graph), the
  blockout (borders, walls, `<Door>`s), the dressing (pieces), the light
  (lamps, layers, night, weather), the life (pacers, spots, behaviors), the
  secrets (`<Door hidden>`), and the walk test (every door reachable). The
  panel's ask is told which stage is open. This is 12.9 given an order, not
  a second editor.
  - Needs 12.2 (the door graph and the walk test read `world.json`).
- [x] 14.3 Emoji in what is said. Probe a bubble, the input line, the history
  pane and a booth in both targets; Mesa's terminal runtime counts a wide
  character with `Bun.stringWidth`, so most may already hold. A joined
  sequence (ZWJ) draws differently per terminal, VS Code's included.
  - Held: OpenTUI draws 🙂 中文 👍🏽 👩‍💻 🇯🇵 at `Bun.stringWidth` cells and the bubble never tears the art; the browser's emoji font runs ~0.04ch short of 2ch, printed by `verify:emoji`, not asserted. ZWJ per real terminal is not chased.
  - Broke and fixed: Haven laid bubbles, the booth and history rows out by `length` (`web/src/lib/scene/cells.js` now); the engine reads a key per code point, so a typed skin tone or ZWJ left the cursor past the text and a combining mark landed after the next key (`joined` in mesa's `runtime-terminal.js`, `wide.spec.mjs`).
- [x] 14.4 An emoji figure. A figure drawn as an emoji is two cells wide: the
  stage claims both cells for it, and a step still moves one column. This is
  9.7's shapeshift taking a wide character.
  - Built: `s` takes one single-code-point emoji (`shapeOf`, `api/src/shape.ts`;
    all 1,188 are two cells by `Bun.stringWidth` and `estimate`), and presence
    carries it. A sequence (skin tone, ZWJ, flag) is refused, as 14.3 found it
    draws per terminal and arrives a code point at a time; chalk stays ASCII.
    Both cells must be floor: the shapeshift is refused by name beside a wall,
    an arrow into one turns the figure without stepping, and a find or a seat
    that lands it there ends the shape. A bolt crossing either cell hits it, a
    knock-back stops the second cell at a wall, and a wide shooter fires east
    from its second cell. The server's floor check reads both cells too.
  - Found: OpenTUI blanks a wide glyph under the transparent overhead buffer,
    so an emoji figure is drawn above it (`WIDE_LAYER`) and hidden under a
    canopy by not being drawn (`covered`, `crowd.js`). Proved in two pty
    terminals by a throwaway drive; no drive kept (experimenting), so that
    trap is unguarded. `shapeOf`, `spanOf` and the wide hit are in
    `bolt.test.ts`.
- [ ] 14.5 Half-cell art in the terminal. A terminal app cannot set its font
  size, so detail comes from the glyph instead: a piece authored at twice the
  rows is lowered to `▀`/`▄` with the top half its `fg` and the bottom its
  `bg` (sextants for 2×3). Art only — text and figures stay one cell. Check
  that a palette entry carries a `bg` per cell first.
- [x] 14.6 The view follows the terminal. `VIEW` is 97×26 whatever the
  terminal is; taken from the terminal's size instead, zooming out
  (ctrl+minus) shows more of the scene, and `EDGE` scales with it.
  `#paint` fits the stage to the renderer (`viewFor`, `stage.fit()`) at the
  attach and on each `resize`; `VIEW` is `viewFor(100, 30)`, so `--frame`,
  the tests and every drive keep 97×26, and `verify:view` resizes a pty.
  Found: the shell's page already overflows by one row at 100×30, and a
  resize left the input under the bottom edge — Mesa's terminal document now
  reveals the focused node after a resize as it does on focus.
- [x] 14.7 A scene's scale in a browser. `<Scene scale={0.5}>` halves browser
  Haven's cell size, so the scene draws twice the cells on the same screen.
  The terminal ignores it and gets 14.6 instead. `paint.browser.js` fits the
  stage to VIEW over the scale and multiplies the font by it; no scene sets
  it yet. Found: a stage `size` past the scene's height read as rows left
  under the art, so `Profile.mesa` drew the foot at the page's font, wider
  than the window — the foot is the terminal's now (`FOOT` in `#paint`).
  Proved by a throwaway CDP probe (the square at 0.5: 160×26 at 11px, the
  figure on its cell, no overflow); no drive kept (experimenting).
- [ ] 14.8 An NPC's line bank. A figure whose lines are written by Claude
  offline (`bun run lines`, a file per NPC beside its scene) and picked at
  random by the clock and a seed. Random replies with no model at run time, so
  `FJS-D994` stands.
  - Needs 12.4 (talking to it is a verb in reach).
- [x] 14.9 Two agents with souls. Each is a member with its own key
  (`FJS-D981`) and a `souls/<name>.md`; a runner on the owner's machine
  (`claude -p` under the owner's own Claude login, the soul as its system
  prompt, the lines it heard as the prompt, no tools — the runner itself says
  and steps) logs them in and walks them. It answers a line only from a
  `HAVEN_MODS` nick (`FJS-D1017`), so the bill is the owner's; every member
  still sees what was said. The two are Ace and Charles.
  - `bun run agents -- --api <url>` (`agents/agents.js`, souls in
    `agents/souls/`, keys under `~/.fli/haven/agents/<nick>/`). `Member.role`
    is `@guarded`, so no client reads a speaker's standing: the runner reads
    `HAVEN_MODS` (or `--mods`) itself. A line from either agent is never
    answered, one reply per agent per 8 s; `agents/test/agents.test.js` proves
    it on a real app with a stub `HAVEN_AGENTS_CLAUDE`. No pty drive yet.
- [x] 14.10 An agent at work. A mod hands an agent a task in the square; it
  runs as a Claude Code session, so Phase 11's feed draws it at its package's
  bench, and its last words (11.7) come back as its line.
  - Built: `ace task: <words>` from a mod (or a whisper holding `task:`;
    `taskOf`) is work, anything else talk. The agent says it is off, walks into
    the workshop (a reconnect, `walkTo`), and `claude -p` runs in the checkout
    with `--session-id` its own, the soul appended, `--permission-mode auto`
    (`FJS-D1019`), `WORK_BUDGET_USD` 5, the project's
    hooks on and `FLI_DONE_STOP=off`. It stands beside the bench its session's
    worker file names (`benchSpot`, polled), walks back to its spot and says
    `workLine` — `lastWords` of the JSON result, or why it stopped. One task an
    agent at a time; a second is refused in a line.
  - Found: a session that reads before it edits writes no worker file, so the
    agent waits by the workshop door until the first edit. One real run ($0.13)
    proved `auto` in print mode and the hook seating it with its last words;
    `agents.test.js` proves the walk and the line with the stub. No pty drive.
  - Replaced by 14.11: a task no longer runs a session of its own.
- [x] 14.11 An agent hands the task to the fix loop. Ace stays Haiku with no
  tools, and his whole job on a task is turning a mod's words into the right
  `scripts/fix-loop.mjs` command (`FJS-D1020`, amending `FJS-D1019`).
  - A named `FJS-###` is `--ids` with no model asked. Anything else goes to
    Haiku with the loop's ready rows (`fli next --json`, `byHand` out) and the
    package list, and it answers one plan: `{ ids }`, `{ pkg, sev? }`, or
    `{ file: { sev, area, title } }` when no row is it — filed with `fli file`
    and then run by its new id, so every task is a row in the register.
  - The plan is checked in code: an id must be a ready row, a package a bench,
    a severity `S1`–`S4`, `rows` 1–3. The model never writes a flag.
  - Ace says the plan back (`Taking FJS-2790 — …`), walks into the workshop,
    and the loop starts through the taskmaster's one `startLoop`, so one loop
    runs at a time across the agents and the desk. He stands at the bench of
    the row the loop's log says it is on, and back in the square says each
    row's outcome and the loop's own summary line.
  - The raw `claude -p` session, `workArgv` and `WORK_BUDGET_USD` go; the
    loop's own ladder and `--budget` are the bill.
  - Built: `idsIn`, `PLANNER`, `checkPlan`, `planLine`, `reportLine` and
    `followLoop` in `agents/agents.js`; `readyRows`, `loopArgv`, `fileRow` and
    `loopReport` in `web/src/lib/hash/taskmaster.js`, whose `startLoop` takes a plan
    and the desk calls with `{ pkg }`. A plan from free words names one row
    (`--rows 1`). `agents.test.js` proves it over a fake checkout's `fli` and
    loop; `verify:taskmaster` the desk. No real loop run yet, and no pty drive.
- [x] 14.12 Ace takes the desk's loop. A `/yes` at the taskmaster's desk
  starts the loop as before, and the agent marked `desk` (Ace) follows it as
  his own: he says where he is going in the square, walks into the workshop,
  stands at the bench of the row the loop is on with `(…)` over him (`thinking`
  in presence) and still, and walks back to say the outcome to the Taskmaster.
  The desk stays the one starter, so one loop at a time holds; the runner reads
  the lock every `deskMs` and follows a pid once (`tended`), so a loop he left
  past `workMs` is not taken up again. With no `bun run agents` running, the
  desk works as before and nobody walks.
  - Built: `adopt`, `tend` and `comeBack` in `agents/agents.js`, `work` sharing
    the last two. Proved by a throwaway probe over `agents.test.js`'s fake
    checkout (experimenting, no test kept). No pty drive.

### Phase 15 — The town hall

Goal: the roadmap stands in the haven as people. Every open row of
`IDEAS/overview.md` is a delegate in the town hall, by wave, and a member
walks up to one, hears what it stands for and votes aye or nay; every screen in
the hall reads the same count.
Done when: two terminals beside one delegate each read a vote the other cast,
and the board of the most wanted carries it.

- [x] 15.1 The building and the hall. The square's first house past the first
  screen is the town hall, its sign over the door at (110, 10). `TownHall.mesa`
  is computed from `web/src/townhall.data.json`, which `bun run townhall`
  writes from the overview (`townhall.js` `wavesOf`: a struck or settled row
  has left the hall): a lit sign per wave, a delegate per open row — a head in
  its status's color with the row's number under it, `PITCH` apart, twelve to
  a line — and the board along the top. A delegate's name is the idea's
  (`nameOf`, a hash of the id), so it survives a recount. Pinned by
  `scenes.test.js`, beside a delegate for every idea and floor round every head.
- [x] 15.2 The vote. `Vote` (member, idea, aye; one per member and idea) in
  the schema, read by every member, written by its own member, and a banned
  member's filtered out by policy, so a ban takes their votes off every count
  at once. `votes.cast` upserts and refuses an idea the hall's data file does
  not hold; `votes.tally` answers the counts and the caller's own. The hall's
  room is told `tallied` with the idea and each screen asks again through its
  own client. `api/test/votes.test.ts`.
- [x] 15.3 The assembly. `Assembly.mesa`, placed by the route: beside a
  delegate they say their name, the idea, its reading, the paper, the count
  and this member's vote; `/aye`, `/nay`, `/withdraw`; a head this member
  voted wears ✓ or ✗ and a number goes green or red with the net; the board
  is the five most wanted by aye less nay. `bun run verify:townhall`.
- [ ] 15.4 The count reaches the owner. The hall's tally beside `fli next`'s
  ranking — a read of the hosted server's `votes.tally` that prints the
  overview's rows with their aye and nay, so what members want is weighed when
  the waves are re-derived. Not a column in the overview, which would be a
  second origin for a number the server owns.
  - Needs 10.1.
- [ ] 15.5 `/townhall` in a checkout, as `/ledger` is: the overview read again,
  the data file written and the hall mounted again on it, so a row added today
  stands in the hall without a restart. The server reads the file once, so
  this needs the server's read to follow it.

### Phase 16 — What the workspace grades

Goal: Haven carries every artefact and passes every check the workspace grades
an app by, as Basecamp does. Probed 2026-10-14 against Basecamp, `fli check`,
`DRIVES.md` and `THREATS.md`.
Done when: `fli check` in `packages/haven` warns on nothing a baseline does not
name, `bun run typecheck` there is clean, and `bun run ci -- --only haven`
passes with Haven's snapshots in its count.

- [ ] 16.1 The schema's snapshots beside `db/schema.lite`: `access`, `ddl`,
  `release` (`litestone <kind> --schema schema.lite`) and `jsonschema`
  (`litestone jsonschema --snapshot --schema schema.lite`). Each writes when
  run without `--check`; `jsonschema` without `--snapshot` writes a
  `schema.json` instead, which is not the snapshot. The access snapshot first:
  a ban is a row policy, and this is what shows one moving in a diff.
- [ ] 16.2 The API's snapshots at the package root: `surface` and `principal`
  (`junction <kind> --app api/src/app.ts`), and
  `jobs` and `notifications` where Haven declares any. Blocked today: the
  generator builds the app with no environment, and `createHavenAuth` throws
  without `HAVEN_SESSION_KEY` (`api/src/auth.ts:42`). Building the app needs to
  succeed without the key; it is refused when the app starts.
- [ ] 16.3 Haven's rows in `THREATS.md`, each with the test that proves it: a
  stranger minting a fresh key after a ban, a banned member (an empty room, not
  a 403), a mod reaching past `FJS-D998`'s predicates, a replayed signed login
  (`FJS-D981`).
  - Before 10.1: the hosted server is the first with strangers on it.
- [ ] 16.4 `app-layout`, the modules: the 30 loose modules in `web/src/` into
  `web/src/lib/<area>/`, the eight `#`-import twins with them (the `imports`
  map moves in the same commit), and the 13 `scenes/*.mesa` into
  `components/<area>/` or baselined with the reason `scenes/` is its own kind.
  Which of the two is a `decision-rules` call.
- [ ] 16.5 `app-layout`, the 10 relative imports from `web/` into `api/`
  (Invariant 3, `FJS-D627`): what both sides need moves to whichever side runs
  it, and the other reaches it through a service.
- [ ] 16.6 The other six warnings: `detail-read-dead` at `Booth.mesa:118` and
  `Scene.mesa:213` (`nicks` read once, so watched with `members.record(id)`);
  `service-as-system` at `barkeep.service.ts:42`; `css-class-collision` on
  `.pane` in `Barkeep.mesa`, `History.mesa` and `Notices.mesa`. What stays is
  baselined with its reason in a new `check-baseline.json`.
- [ ] 16.7 Typecheck to zero: `api/src/rooms.ts:145` passes a
  `Set<string | undefined>` where a `ReadonlySet<string>` is taken. Haven has
  no baseline, so this one error fails CI.
- [ ] 16.8 `DRIVES.md` rows for the seven drives it does not name, so
  `fli proves` can: `verify:taskmaster`, `ledger`, `townhall`, `nameplate`,
  `home-row`, `bolt`, `bar`.
- [ ] 16.9 `web/config/routes.js` out of git: Sierra writes it, so it is
  ignored in Haven's `.gitignore` with a `generatedIgnored` entry in
  `scripts/ci-allowances.json`, as Basecamp's is.
- [ ] 16.10 The small ones: Haven's row in the root `CLAUDE.md` Packages table
  (its State still reads *Schema only*); `haven` in `scripts/fix-loop.mjs`'s
  realm map beside `example` and `basecamp`; and a read of `scripts/ci.mjs`'s
  coverage phase to confirm it runs Haven's suite, which the probe did not
  reach.

### Phase 17 — A kit of pieces

Goal: what a scene puts in a room or out of doors comes from `pieces/`, so a
new scene is placed rather than drawn and the editor has a catalog to offer
(12.1 names a piece by its key in `pieces/`; 12.9).
Done when: no two scenes draw one thing, each piece has one name, Upstairs and
the cellar are lit by an indoor light, and `scenes.test.js` passes with every
`*.frame.txt` unchanged but where a step says otherwise.

A piece below that no scene places yet is drawn when the first scene needs it,
not ahead of time; the lists are the menu, and 17.4–17.5 close when every
scene that wants one has it.

- [x] 17.1 The twins into `pieces/`: `signpost(label)` and `sign(text)`
  (Woods, Square, Road, Market, Docks; Canal, Docks' `ferry-sign`), `crate`
  (Market, Docks), `ladder(rows)` (Mine, Canal), `plank(w)` (Docks, Island),
  `shroom` (Woods, Glade), `flower` (Square, Lane). Market's own `barrel` gave
  way to `pieces/barrel.js`, so its hoops take the staves' color. Every
  `*.frame.txt` and `*.world.json` is unchanged (a sign is floor, so
  `world.json` never named it).
  - What only shares a name, so stays put until 17.3: `cart` (Road's wagon,
    Mine's tub, Market's fruit cart), `hearth` (Tavern, Sheriff, Lodge, three
    sizes), `rack` (Cellar's wine, Sheriff's guns), `pier` (Docks' crumbling
    floor, Canal's post), `bar` (Lodge's beside `pieces/bar.js`, which spans a
    room), the floor coverings (Tavern's `rug`, Lodge's `bearskin`, Sheriff's
    `cowhide`), and `hedge` — a wall in Square and walked through in Lane.
- [x] 17.2 Indoor lights, because Upstairs and the cellar each stand two street
  lamps in the room. `sconce` (on a wall, a light of 2, steady), `lantern`
  (hung, all of it overhead, a light of 3, a flicker) and `chandelier` (over
  the middle of a room, a light of 5 — Upstairs' dance floor). `lamp` stays
  the street lamp. Whether Upstairs and the cellar name `lamplight`, as Sheriff
  and Lodge do, is settled by looking at both rooms lit.
  - Upstairs has a sconce in each back corner and the chandelier over the
    dance floor's middle, its notes kept a cell clear of it; the cellar hangs
    two lanterns where its lamps stood, and drops the `Y` it named for them.
    Both rooms, rendered side by side with and without the layer, name
    `lamplight`: the pool is what shows the cellar as a dark room with two
    lights in it. Each light carries its own paint letter (`U`, `J`, `C`),
    since two pieces naming one letter differently throw at mount.
  - `lantern` was already the dark scene's prop, which `stage.js` called
    "sight, not a lamp"; the prop is `sight={r}` now, so the word means one
    thing (owner's call).
- [x] 17.3 One name per thing: each piece in 17.1's list of namesakes is named
  for what it is (`wagon`, `minecart`, `wine rack`, `gun rack`, …), so a
  catalog key never means two drawings. `hedge` is a wall; Lane's that is
  walked through is a different piece or a bug, read from its scene first.
  - Two things under one name, renamed: Road's `wagon`, Mine's `minecart`,
    Market's `fruit-cart`; the cellar's `wine-rack`, Sheriff's `gun-rack` and
    `pieces/home.js`'s `serverRack` (Jordan's, a third `rack` 17.1 missed);
    Canal's vault `pillar` (the docks keep `pier`); Ravine's `signboard`
    beside `signpost.js`'s `sign`. Every `*.frame.txt` is unchanged; each
    `world.json` carries the new ids.
  - Lane's hedge was the bug the square's had (`FJS-2875`): its gaps sit
    under the cottage doors, so it meant a wall. One `pieces/hedge.js`, a
    wall painting `G`, which each scene names (`<Row>` stamps no piece
    palette); Lane's `world.json` now walls row 11 between the gaps.
  - One thing drawn several ways keeps its name, since the name is right and
    the drawings are the twins: `hearth` (Tavern, Sheriff, Lodge), `rug`
    (Tavern, `home.js`), `bar` (Lodge, `pieces/bar.js`), `armchair` (Lodge,
    `home.js`), `pond` (Glade, `home.js`), `water` (Canal, Docks) and the
    square's four `house` fronts. `fishing.ts` reads `water` and `pond` by
    name as a kind. Folding each into one sized piece is 17.4 or 17.5, which
    list them. Bearskin and cowhide never shared a name.
- [x] 17.4 Indoors. Furniture: `stool`, `chair`, `armchair` and `couch`
  (Lodge's), `cot` (Sheriff's), `bed`, `desk`, `counter`. Storage: `shelves`
  (Tavern's), `bookcase`, `chest` (the cellar's), `crates` (the cellar's
  stack), `wardrobe`. On a wall: `window` (Lodge's, by season), `poster`
  (Sheriff's), `painting`, `neon` (Lodge's), `clock`. Sized: `rug(w, h)`
  (Tavern's and the homes'), `stage(w, h)` (Upstairs' boards), `hearth(w)`
  (Tavern's, Sheriff's, Lodge's), `bar(stools)` (Lodge's and `pieces/bar.js`).
  The rest: `jukebox` (Lodge's), `piano`, `potted plant`, `stove`, `bucket`
  (Sheriff's), `trapdoor` (a floor piece under a `<Door>`).
  - Moved, every `*.frame.txt` and `*.world.json` unchanged: `pieces/storage.js`
    (`shelves`, `wineRack`, `crates`, `chest`, `gunRack`), `pieces/wall.js`
    (`window`, `poster(face, inks, sum)`, `neon`) and `pieces/furniture.js`
    (`couch`, `cot`, `bucket`, `jukebox`, `rug(w, h, marks)` -- the tavern's
    two ornaments are `marks`, the homes' is `homeRug` in `home.js`). `inked`
    and `seats` live in `pieces/index.js`, one copy for Lodge and Sheriff.
  - Not moved: `bookcase`, `potted plant` and `stove` are `home.js`'s
    `bookshelf`, `plant` and `stove` already; `stool`, `chair`, `counter`,
    `wardrobe`, `painting`, `clock`, `piano` and `trapdoor` no scene places yet.
    `stage(w, h)` is Upstairs' boards, cut round the band's cells, so it stays
    with the band.
  - Kept scene-local (owner's call): three `hearth`s (Tavern 27 wide with a
    crest, Sheriff 18, Lodge 32 in fieldstone with a moose), two `bar`s
    (Lodge's carries taps and glasses over a counter) and two `armchair`s
    (Lodge's `.[__].` club chair with a seat, Colin's wing chair). One sized
    piece each would redraw a picture, and 17.7 compares art, so a shared
    name over different drawings does not trip it.
- [x] 17.5 Out of doors. Lights: `torch`, `brazier`, `campfire` (Ravine's
  `fire`). Growing: the tree's kinds — `oak` (Glade's), `palm` (Island's),
  `juniper` (Ravine's), `cactus` (Sheriff's) — `stump` and `log` (Woods'),
  `bush`, `reeds`. Stone: `rock(size)` for Mine's `rock`, Glade's `stone` and
  Ravine's `boulder`. Water: `water(w, h)` for Canal's and Docks',
  `pond(size)` for Glade's and the lane's, `bridge`, `bollard` (Docks'),
  `rowboat` (Canal's `boat`). Town: `house(sign)` (the square's four fronts),
  `well` (Square's), `fence(w)` (Road's), `gate`, `milestone` (Road's),
  `stall` (Square's and Market's), `fountain`, `flag` (Range's). Work: `bales`
  (Range's), `woodpile` (Lodge's `firewood`), `rails(w)` (Mine's),
  `wheelbarrow`, `scarecrow`. Camp: `tent`, `bedroll`, `telescope` (Ravine's).
  - Moved, every `*.frame.txt` unchanged: `pieces/growth.js` (`oak`, `palm`,
    `juniper`, `cactus`, `stump`, `log`), `stone.js` (`stone`, `boulder`),
    `campfire.js` (its `h` a light of 3, so Ravine's palette drops it),
    `camp.js` (`telescope`), `work.js` (`bales(rows)`, `woodpile`, `rails(w)`),
    `water.js` (`water(w, h, dry)` -- the pool with what stands in it cut out,
    Canal's and Docks' one recipe -- `deck(name, w, h, options)`, which is
    Canal's bridge, the docks' pier and the island's jetty, `rowboat`,
    `bollard`) and `town.js` (`house(sign)` -- the workshop's and the town
    hall's, one 20-wide house -- `well`, `stall`, `marketStall(name, awning,
    wares, inks)`, `fence(posts, key)`, `milestone`, `flag`, `fountain`,
    `basin`).
  - Four `world.json` ids moved with their names: `rowboat`, `woodpile`,
    `campfire`, and Ravine's `railing`, which is `fence(7, 'e')` -- the same
    drawing as the road's.
  - Kept scene-local: Mine's `rock` (the cavern, a map with the tunnels left
    out), Glade's `pond` beside `home.js`'s (two drawings, one name, as 17.3
    left them), the square's `houseB` and `houseC` (two sizes, no sign), and
    the market stalls' `fruit-cart`. `torch`, `brazier`, `bush`, `reeds`,
    `gate`, `wheelbarrow`, `scarecrow`, `tent`, `bedroll` wait until a scene
    places one.
- [x] 17.6 What grows has seasons: `hedge` and `flower` each stand on the same
  cells in every season, as `tree` does. Every `*.frame.txt` and `*.world.json`
  is unchanged (the frames are summer). A season's letters are its own, on
  letters no scene names; the dormant flower is floor and `dye`s nobody.
  `scenes.test.js` holds every seasonal piece in `pieces/` to the same floor
  flag and the same non-overhead cells in each of its seasons, so `bush` is
  held to it the day a scene places one.
- [ ] 17.7 A twin is refused: `scenes.test.js` fails a scene-local piece whose
  art is a `pieces/` piece's, naming the import. Until then nothing stops
  17.1's duplicates from growing back.

### Phase 18 — The kitchen

Goal: the kitchen (`Brigade.mesa`, through the tavern's east wall) is where a
session of work is chosen and watched, not only watched.
Done when: a menu picked at the pass sets what the 86 board lists and what the
fix-loop is handed, and a CHEF! ticket opens in the study (`IDEAS/study.md`
3.3).

- [x] 18.1 Set dressing and a bell you can see: `pieces/kitchen.js` gains the
  range behind the cooks (gas flames, a light of 1), sink, stockpot, prep
  block, produce bins, walk-in, mop, plates and the service bell at the pass's
  end; the bell is drawn jumping (`\ô/`) for `RUNG_MS` on a CHEF! (red) or an
  ORDER UP (gold), sounded or muted.
  - Run in a pty against a test API with three sessions seated through the
    real hook and `HAVEN_MUSIC=off`: walk-in drew the tickets, cooks and board
    with no jump; a Notification jumped it red and it went down; a Stop put a
    plate on the pass and jumped it gold.
- [x] 18.2 The menu. **Ruled 2026-10-17 (owner): all four**, each feeding a
  knob the loop already has and turning the 86 board into its list:
  - **Expedite** — the register worst first, S1/S2 at the head (`fli next`'s
    order, the Taskmaster's pitch).
  - **Station night** — one package cleared deep (`--pkg`), one cook per
    station so no `! N here`.
  - **Prep list** — S3/S4 papercuts in parallel on a cheap rung (`--sev
    S3,S4 --lanes N`).
  - **Chef's table** — no code: the waiting rulings (`fli decisions`), one at
    a time, which unblocks what the loop set aside.
  - **Ruled 2026-10-17 (owner):** the verb is `/menu`, reached only at the
    pass (as the Taskmaster's `/yes` is); the choice is kept per machine
    beside `workers/`, as 18.4's close-outs are, so the loop reads it with
    no terminal open.
  - Built: `~/.fli/haven/menu.json` holds `{ menu, flags }`, the flags the
    loop already takes (`MENUS` in `#taskmaster`); `scripts/fix-loop.mjs`
    reads it as starting settings only when its command line names no
    `--ids`/`--pkg`/`--sev`/`--trial`, and prints `[fix-loop] menu: …`. So
    the Taskmaster's `/yes` (`--pkg`) and a mod's task (`--ids`) ignore the
    menu, and the chef's table keeps no flags: a bare loop under it runs the
    register's own order. `/menu station` with no package takes the ledger's
    most open; `/menu off` takes the menu down.
  - Run in a pty (scratch probe, not committed) against a test API and a
    fake root: `/menu` at the door answered by nobody; at the pass each of
    the four turned the board (title and rows), the file kept in HOME, a bad
    lane count and an unknown menu refused, a file written by another
    terminal turned the board within the poll, `off` back to the ledger.
    `fix-loop --dry-run` under a kept prep list took S3/S4 rows only, under
    a station night only `cli`, and with `--pkg mesa` ignored the menu.
- [x] 18.3 Timers (owner note, 2026-10-17): how long a chef has waited and
  how long an order has sat ready, on the ticket and the plate. A CHEF!
  ticket's head already counts from `asking.at`; a plate shows no age, only
  its reading does. A wait past some threshold should look worse.
  - Built: `WAIT` in `Brigade.mesa`, 2 and 5 minutes, the turn a kitchen
    display's ticket timer makes (fresh, late, over). A CHEF! ticket's head
    row is filled amber late and red over; a plate's age is chalked on the
    pass under it, and plate and age go green, amber, red. Both thresholds
    sit under `QUIET_MS`, since a plate leaves at ten minutes. A working
    ticket's age is not a wait on you and keeps the paper's ink. The two
    numbers ruled 2026-10-18 (owner).
  - Run (scratch probe, not committed) against a test API with six workers
    written into a HOME with old stamps: a `--frame /kitchen/` read each
    head's wait (`34s`, `3m`, `7m`) and each plate's age under it (`24s`,
    `3m`, `6m`); a pty's raw stream carried the amber and red head fills and
    the green and amber plate inks.
- [x] 18.4 Closing an order out (owner note, 2026-10-17): a verb at the pass
  acknowledges a plate and it leaves. Today a plate stays until the session's
  next event or `QUIET_MS`. Keyed `session:said.at`, so the session's next
  stop plates again; kept per machine beside `workers/`, as the workers are.
  A CHEF! can be marked seen, but only its own host answers it (study 3.3).
  - Built: `/bump [id | all]` along the pass (a kitchen display's bump bar)
    and `/heard [id | all]` along the line (the cook's call-back), each
    `closeOut(w, 'said' | 'asking')` in `#workers`, which keeps that moment's
    stamp in `~/.fli/haven/closed/<session>.json`; `readWorkers` reads
    `said.bumped` and `asking.heard` true only for that very stamp. A bumped
    plate leaves the pass; a heard CHEF! stops flashing, its ticket footed
    `HEARD` and its station `HEARD`, and stays on the rail. Bare, each takes
    what is in front of you; a miss names what is up. SessionEnd and the
    hook's day-old sweep take the file. The workshop still shows a bumped
    session's `✓`. Both words, and `HEARD` on a ticket left on the rail, ruled 2026-10-18 (owner); nothing committed
    guards the stamp keying (no new tests while experimenting).
  - Run (scratch probe, not committed) in a pty against a test API, four
    workers written into a HOME: `/bump` at the door answered by nobody; in
    front of a plate it left and the next took its slot, the file kept the
    stamp; an unknown id named what was up; a new stop on the bumped session
    plated again; `/bump all` cleared the pass and ORDER UP; at the mesa
    station `/heard` footed its ticket `HEARD` and left cli's CHEF!
    flashing; SessionEnd removed worker and close-out.

### Phase 19 — Stops

Goal: a member who came to work, not to wander, reaches every stop a scene
cares about by Tab, the way a browser reaches every control on a page,
without a scene file stating anything new.
Done when: in the tavern and the kitchen, Tab names each stop in turn and
Enter walks the figure there, a step at a time and seen by the room; the
cellar's hidden door is never named; and a list of the scene's stops picks
one by its number.

**The reading** (owner, 2026-10-18). The noun is the browser's: a Tab
stop, never a "place", which is what Haven itself is.
Walking is the fun, and sometimes in the
way. The precedent is the image map — a picture whose `<area>`s are Tab stops
— and the roguelikes' travel: NetHack's `_` moves the cursor from one
interesting thing to the next (`<` `>` stairs, `d` doors, `m` monsters, `a`
anything) and then travels there, and DCSS's `G`/`X` does the same. A scene
already declares what it cares about: every verb with a `reach` on
`$context.commands` (`lib/hash/commands.js`) is a cell that answers, and every
`<Door>` is a cell that leads somewhere. So the stops are DERIVED from those —
no `tabindex` on a piece, no list beside the scene — and their order is the
order the scene file mounts them, which is a browser's DOM order; a numbered
order is the anti-pattern a positive `tabindex` is on the web. Enter WALKS
there rather than jumping or acting at a distance: a `reach` is standing
there, the room sees the figure cross to the board, and a walk cannot pass a
wall or find a hidden door. A plain mesa TUI needs none of this — a box with a
`tabindex` is already a Tab stop (`packages/mesa/src/terminal/tags.js`) — so
this is the gap a surface painted in cells has, not mesa's.

- [x] 19.1 The stops. `stops(stage.marks)` beside `words(at)` in `commands.js`: one
  stop per verb `reach`, and one per door mark that is not `hidden` (the
  marks, since `stage.doors` is claim order — a door claims over the wall that
  came first — and a cell apiece), in mount order —
  the doors, then the verbs, as every scene file puts its `<slot />` last. A
  `night` door is never a stop either: it is found by being there in the
  dark, as a hidden one is by stepping (**ruled 2026-10-18 (owner): never**,
  not even at full night). A stop is `{ name, to?, reaches }`, a door's reaches its own cells
  within 0. Probed: the tavern is `/`, `/kitchen/`, `/upstairs/` and one `/ask`;
  the kitchen `/tavern/`, `/menu /bump` along the pass, `/heard` along the line. **Ruled 2026-10-18 (owner): stops whose reaches overlap
  merge into one**, so the Barkeep's `/ask` on every stool is one stop at the
  bar and the Notices' `e` and `/board` and `/pin` are one at the board. A
  stop's name is what its verbs already say — their words, `/board /pin`, and
  a door its `to` — since a new label field would restate the `help`. Pure. A hidden door
  never named is the invariant, and nothing guards it yet (no new tests
  while experimenting) — a line in `scenes.test.js` when this is settled.
- [x] 19.2 Tab and Shift+Tab. With the line empty, Tab names the next stop and
  Shift+Tab the one before; the stop's cells are marked on the art (each
  reach's own cell, in a mark's ground) and the NOTE reads `→ /board /pin (3/7)`
  — the note, not the room's status line, since a verb answers there and every
  drive's `cellOf` counts up from `· N here`. Where the first press lands is a
  browser's focus: standing in a stop's reach is that stop focused, and the
  press moves past it; standing in none, it names the nearest BY THE WALK
  (`walked()` in `paths.js`), as `f` finds a member, since by the crow the
  nearest may be through a wall. `Stops.mesa`, an actor: a `Tab` key verb
  that opens a `stops` mode whose keys are Tab and Shift+Tab, any other key
  letting it go as the `f` walk's does (Esc taken, an arrow let through to
  step). Tab on a partial `/word` still completes it (`Scene.mesa`'s
  `keydown` asks that first). Both targets prevent the Tab, since the scene
  is one `<pre>` and its stops are cells, not elements. Probed in a pty: the
  tavern `/`, `/kitchen/`, `/upstairs/`, `/ask` and round, Shift+Tab back,
  the mark's ground in the stream, the kitchen `/tavern/`, `/menu /bump`,
  `/heard`; no drive kept (no new tests while experimenting).
- [x] 19.3 Enter walks. **Ruled 2026-10-18 (owner): animated** — a step per
  `WALK_MS` (`paths.js`, `f`'s pace too) along `pathTo(stage, from, ok)`, the
  nearest cell `ok` accepts, re-planned from where the figure stands at each
  step; the `walk` mode, which `f`'s walk now is too (the `find` mode
  renamed), so any key stops it and a bolt landing on this figure does. A step
  is `Scene.mesa`'s `stepTo`, the one an arrow takes, so the walk's last step
  onto a door is the door taken; any other stop's ends inside its reach, and
  the stop stays marked while it is walked to. Beside a door is a step from
  its cell, never a diagonal, for Tab's nearest too. A stop no floor reaches
  is named and refused (`nobody can reach /board from here`) with the stop
  still named. Probed in a pty, two members in the tavern: Enter on `/ask`
  steps at once and on to where `/ask` answers, drawn there on the other
  screen; Esc partway stops it; Enter on `/kitchen/` walks through the door;
  in the kitchen Enter on `/heard` ends where `/heard` answers. The refusal
  has no scene to try it in; no drive kept (no new tests while experimenting).
- [ ] 19.4 The stops list. **Ruled 2026-10-18 (owner): yes.** `/stops` (no
  reach) opens a pane over the art listing the scene's stops, numbered in
  Tab's order with their words and how far each is walked; a number walks
  there as 19.3, Esc closes. It is a mode on the registry, as the map is, so
  it takes keys before the figure. The screen reader's rotor is the
  precedent: the same stops, read as a list instead of in turn.

### Phase 10 — Hosted

Goal: Haven answers at a public address, so a stranger needs no `--api`.
Done when: `bunx @frontierjs/cli haven` on a machine that has never seen this
repo shows a figure that a second machine can see. (`fli` on npm is somebody
else's package.)

- [ ] 10.1 Deploy through outpost at `haven.maverickmade.tech` (the apex is on
  Cloudflare; the subdomain has no record yet), with Haven's API serving
  `web/dist` (5.2). `web/config/sierra.config.js` moves to it when a server
  answers there, not before. The machine is not named.
  - Needs `db/migrations/` and a deploy block (`frontier.config.js`), as
    Basecamp has; until both exist `fli check` skips `migration-history` and
    `log-db-unbound` rather than grading them. Needs 16.3.

## Ideas past the plan

Not steps. Each becomes one at the end of the plan when it is wanted. The
first group is the runner's pattern: from this machine, drawn on this screen
only. The second is shared, so it is rows or presence. The third is scenes and
the fourth animals, each tagged with the mechanism it would add, cheapest first.

**This machine's**

- **CI as the square's weather.** Clear when `.cache/ci-last.txt` is green,
  rain when a phase failed, a storm when several did. 7.3 draws the overlay;
  this picks it. Distinct from 9.2's roof storm, which is baked in at deploy
  (`FJS-D996`) and is the framework's, not this machine's.
- **Ships at the docks.** A ship pulls in when a deploy lands, and one stuck at
  sea is a deploy that hung. Pairs with 8.3's crier, which announces the same
  landing.
- **The petition board.** The town hall (Phase 15) pins the owner's open
  decisions (`fli decisions`) beside its board; read one, pick an option, and
  the ruling is written.
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
  could come before 3.2's mod standing does. Built (2026-10-15), north of the
  road through the gap in its north fence rather than off the square, since a
  border's run sits at the same column in both scenes (`Market.mesa`): seven
  stalls, each a keeper's stool behind the counter and a customer's in front
  as a seat pair, so `Sitting.mesa` walks the two into a booth unchanged, and
  the counter's lantern a `burn` lit while either stool is taken. Renting a
  stall is not built: it waits on 9.3.
- **Rooftops.** A ladder in a house, there at night only. A narrow run where a
  step off the edge is a door back to the square at the cell you fell from.
- **The old town.** A museum off the town hall where each gallery is a scene as
  it was N commits ago, read from the `git log` of its committed
  `scenes/<name>.frame.txt`, with the commit's date on a plaque. Nothing new is
  stored. The square's frame has five commits today, so the gallery fills as
  Haven grows.
- **The echo canyon,** past the road. A line comes back twice, delayed and
  fainter, as a bubble the client redraws. Hearing is shaped by the walls,
  which is the library's per-scene `EARSHOT` taken one step further.
- **The dream.** Sleep in a tavern bed and wake in the square drawn in an
  inverted palette, derived from the day colors as `shade()` derives night, so
  no scene is edited for it. Hidden doors (6.5) are drawn visible there, so the
  dream is how a secret is found.

One mechanism each:

- **The lighthouse,** at the docks' far end. Its beam is a light that turns on
  the clock. Light is steady today (`litAt` takes no tick), so this is a moving
  light, still a pure function of the clock and so still sent nowhere.
- **The mine,** under 9.2's quarry. Pitch dark, and a figure carries a lantern —
  a light that moves with its member, so the others are seen by theirs. This is
  what gives `FOG` a reason to come back on. Built (2026-10-15), under the
  road rather than the quarry, since 9.2 is not built: a pithead on the road
  (`Mine.mesa`), a shaft, a railed gallery, an ore room, a crawl and a flooded
  chamber, and the way on down to the canal. `<Scene sight={r}>` names the
  fog and a radius: SIGHT shrinks to `r`, and every figure's cell is one
  another screen sees from -- sight, not a light, so it stops at rock.
  The map still keeps the whole picture at mount (6.4), so `/map` shows a
  dark scene's every tunnel after one visit.
- **The hedge maze.** Generated from the date, so every terminal walks the same
  maze and it changes at midnight with nothing stored, as the sky does (7.2).
  The first member to reach the middle is announced by 8.3's crier.
- **The amphitheater.** A member on the stage is heard by the whole scene, which
  is earshot turned inside out: hearing becomes a property of the cell as well
  as of the speaker. For demos and office hours.
- **The frozen pond.** The glade's pond when 7.3's weather is snow: a step onto
  the ice slides until a wall stops it, which is room for small puzzles.
- **The haunted house.** It opens only on certain dates: 6.6's `<Door night>`
  keyed to the calendar (7.7) instead of the hour. It has jack-o'-lanterns for
  flickering lights, and the fog is on inside. The same door gives a winter
  fair in December and a garden in spring.
- **The dollhouse.** A model of the town on a town hall table: the `/map` snaps
  (6.4), with every member in every room drawn live as a dot. The mechanism is
  presence read across rooms, since today a client hears only its own room's
  channel.
- **The balloon ride,** from a fairground. The scene's art is the world map,
  and the basket drifts with 7.8's wind, so where it lands depends on the
  weather. The mechanism is a view moved by the clock instead of by a figure.
- **The underground canal,** down the square's well (6.1). Tunnels join the
  cellar, the docks and the glade, so a boat is fast travel. It is pitch dark
  and uses the mine's `sight`: whichever of the two is built first pays for the
  other. Built (2026-10-15) with the mine (`Canal.mesa`): the well's ladder,
  the docks' culvert, the cellar's steps and the glade's are doors, and the
  mine's way down a fifth; the canal's ways up into the cellar and the glade
  are hidden, as each is from above. The boat is moored, not sailed: the fast
  travel is five places one screen apart.
- **The engine room,** under the town hall. Haven's own API as a place: a rack
  per service blinking at its request rate (`app.registerMetricsSource`) and
  Caravan jobs as carts on rails. The mechanism is a metrics feed reaching a
  scene.
- **The archery range.** Targets for 9.5's arrow, so it lands somewhere before
  it lands on a member. Its scoreboard is rows. Built: `/range/`, south of the
  woods across a border in their south wall; four targets riding a carousel
  on the shared clock -- up one column, under a housing, down the other
  (`api/src/carousel.ts`, `Carousel.mesa`, `pieces/archery.js`) -- met where
  each is when the bolt reaches it (`at(x, y, i)` in `bolt.ts`, `FLY_MS` a
  cell), so a shot is led, and scored by the server on the row a bolt struck, or
  the column flying north or south -- 10 the bull, 5 the ring, 1 the rim
  (`pointsFor` in `api/src/play.ts`) -- as a `scored` trace in the room's
  memory, so the board (`Scores.mesa`) is the room's last ten minutes and a
  restart wipes it: the owner's pick over a model. A miss scorches the bales.
  No drive kept; a throwaway pty probe proved the bull, the `+10`, the board's
  row and a joiner handed it; the carousel by a throwaway sim of 828 shots,
  every score on the rider's cell at landing. Left open: the woods' quivers are the range's
  only supply but its own two, and the flag ignores 7.8's wind.

These need server state:

- **The post office.** A mailbox per member. A whisper sent while its member is
  offline waits there until they sign in — 7.1's `toId` row with a read flag.
- **The ferry's timetable.** The ferry and the island it runs to are built
  (`Docks.mesa`, `Island.mesa`, `pieces/ferry.js`), always docked at both
  ends. Left: it sails on a timetable, and its door is there only while it is
  docked — 6.6's night door on a schedule.
- **The fishing pier's audience.** `/fish` is built (`api/src/fishing.ts`,
  `fishing.cast`, `Fishing.mesa`): at the water's edge a server roll weighed
  by the server's almanac (a moonfish only on a full-moon night, most often in
  snow), the catch an item in 9.9's inventory, the float drawn on the
  caster's screen. Left: the room sees it — a float on every screen, and a
  rare catch cried in the square — and a drive of its own.
- **The greenhouse.** A pot per member: a seed grows over real days and wilts
  if the member stays away, and the season decides what will grow. A pot is a
  row, 9.3's plots at the size of a flowerpot.
- **The arcade,** in the tavern's back room. Snake on the floor played on 9.4's
  home row, the high-score table as rows, and 8.3's crier announcing a new
  record.
- **The troll bridge.** A 14.8 line-bank NPC guards a bridge with a riddle. The
  answer is graded on the server, so no client holds it, and the door opens for
  that member only.

**Animals**

There are two kinds today. A pacer (4.5) is a scene's animal on the wall
clock, sent nowhere: the tavern cat and the glade deer. A pet (8.2) is one
glyph that follows its member.

Pacers the existing fields carry (`right`, `left`, `sit`, `flee`) — placed,
each a `<Pacer>` in its scene file, a crab and gull at the docks, pigeons in the
square, a rat in the cellar, a chicken in the lane, a hound in the sheriff's
house:

- **The docks crab,** `(\/)°°(\/)`. It walks sideways, so its left frames are
  its right ones.
- **The docks gull,** `~v~` / `-v-`, patrolling the pier and fleeing a figure.
  It belongs to the fishing pier.
- **Square pigeons,** `<'` / `<,`. They scatter when a figure steps near, which
  is `flee` as it already works, and they come back.
- **The cellar rat,** `~~(_'>`, one floor under the tavern cat.
- **A lane chicken,** `>(')`, its `sit` frames pecking (`>(.)`).
- **The sheriff's old hound.** Nearly all `sit`, with a `zZ` frame, and it walks
  rarely.

Pacers that keep hours take `night: true`, the key 6.6's `<Door night>` already
spells and answered by the same `isNight()` (`web/src/lib/scene/sky.js`). A second
spelling of the same gate is what this rules out: a day-only animal is
`night: false` (absent means always), and the field joins the pacer's whitelist
in `web/src/lib/scene/world.js` as `flee` did. Built: `pacerNow()` (`api/src/pacer.ts`)
answers `null` outside a pacer's hours, so the stage draws nothing there and the
server's `obstacleAt` lets a bolt through, the one check both read --
`fishing.service.ts` already imports `sky.js` server side. Placed: the owl, the
rabbit, three fireflies, the otter (the gull is `night: false`), the seal and
the turtle:

- **The woods owl,** `(o,o)` blinking `(-,o)`, there only in the dark. It is the
  first animal that tells the time, so it is the one to build `night` with.
- **A glade rabbit** `(\_/)` by day, and **fireflies**, a `*` / `.` blink, on
  summer nights (`sky="summer"`, below).
- **The docks otter** takes the pier at night when the gull leaves it.
- **The island's seal and turtle,** slow animals at the ferry's far, quiet end.

More pets, each a glyph that is not a Latin letter, since a figure is its
initial: a duckling `ɞ`, a hedgehog `ж`, a crow `ɤ`, a frog `ȣ`. Each glyph
must render in VS Code's terminal font, and `ɞ` and `ȣ` may come out as tofu.

Gameplay, which needs server state. Built: what an animal does is the room's,
an `animal` event (`{ id, by, line, laid? }`) that `Fishing.mesa` hears -- a
`laid` trace runs the pacer off on every screen, and the line is the note on
every screen but the caller's, which has its own in the answer.

- **The gull takes the bait.** A missed `/fish` while the gull is in the scene
  is the gull's one time in `THIEF.odds` (3), rolled by the server as the catch
  is (`fishing.ts`). It lays a `spooked` trace, so it flies off away from the
  caster and is gone for the trace's five minutes.
- **Rare animals on rare skies,** by the fishing pier's rule for a rare fish: a
  pacer's `sky` names a rule in `SKIES` (`web/src/lib/scene/sky.js`), asked in
  `pacerNow` beside `night`. A rule reads the WORLD's almanac -- the clock under
  `HAVEN_WEATHER`/`HAVEN_SEASON` -- never a screen's `/weather` hold, which the
  server cannot see, so a held snow draws no stag a bolt flies through. An
  unknown name throws. There is no fog, so the heron is `twilight-rain` (dusk
  or dawn in rain) at the glade pond; the white stag is `full-moon-snow` on the
  glade's south row. Over a year of clock that is the heron about 2% of the
  time and the stag about 1%.
- **Feeding the animals.** `/feed [fish]` (`fishing.feed`) hands one fish from
  9.9's pack -- the first held in `CATCH`'s order unless named -- to an eater
  within `FEED_REACH` (2) of its sprite: the tavern cat, the docks otter, the
  gull (`EATERS`, each with what it does). Nothing to feed, no fish and a name
  that is no fish are refused by name. Left open: the cat doing anything once
  fed but purr in the note, and a drive of either.

## Open questions

- ~~**Q15 — Who may talk to a figure Claude speaks for.**~~ **Answered 2026-10-14 (`FJS-D1017`): A — a mod only: a model-backed figure answers a line from a `HAVEN_MODS` nick and nothing else.** 14.9's agents run on the owner's machine in the shared square.
  - **A** — a mod only. The bill is the owner's, and `FJS-D994` stands for the public barkeep.
  - **B** — anyone, with a budget per member per day: `FJS-D994`'s B.
  - **C** — no live model: NPCs speak from a line bank, agents only on a private `--api` server.
  - **Recommend A** — a stranger cannot prompt it, so there is no bill to run up and no injection from outside, and the square still sees the agents talk.
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

- ~~**Q6 — How a machine with no checkout gets the client, and how it stays the server's version.**~~ **Answered 2026-10-14 (`FJS-D982`): A — publish `@frontierjs/haven`. The server states the version it runs at `GET /haven/client` (`{ package, version }`, read from its own `package.json`). `fli haven` installs exactly that version into `~/.fli/haven/<version>/` on first sight, then imports its `web/src/lib/session/sign-in.js` as it does now. A checkout's sibling Haven still wins, the way `dev:tui` runs the app in front of it. There is no floor: the client is always the server's. A version npm does not have is refused by name.** 3.1 names "the build floor the server refuses", and § Version skew has the client send `x-fjs-build` for the server to refuse. Junction's protocol is the reverse, on purpose: the server STATES its build and the client compares (`junction/src/core/build-id.ts`), and that build is a browser bundle's hash, which a terminal client never has. Today `fli haven` runs only the Haven found beside it in a checkout.
  - **A** — publish `@frontierjs/haven`. The server states the version it runs at `GET /haven/client` (`{ package, version }`, read from its own `package.json`). `fli haven` installs exactly that version into `~/.fli/haven/<version>/` on first sight, then imports its `web/src/lib/session/sign-in.js` as it does now. A checkout's sibling Haven still wins, the way `dev:tui` runs the app in front of it. There is no floor: the client is always the server's. A version npm does not have is refused by name.
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
