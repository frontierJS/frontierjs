# Haven — Project Context

An FJS app laid out like `basecamp` (`FJS-D977`): `db/`, `api/`, and one `web/`
built for two targets (`FJS-D985`) — the terminal (`fli haven`, `fli dev:tui`)
and a browser (`bun run web`, `fli dev`). Eight modules differ per target and
nothing else: `#paint`, `#cell`, `#sign-in`, `#errand`, `#workers`, `#taskmaster`, `#ledger` and `#seen`, the
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
| `api/src/rooms.ts` | the room channel's one spelling, `ROOMS` (a row per scene, the workshop's included), the `{ x, y }` move (with `typing: true` while a member's line has words — the booth's flame leans toward it; a cell that is not floor in the room's `world.json`, or a piece the room has not seen broken, is refused as `presence_meta_refused`), the join at the upgrade — the frame shapes `web/` imports |
| `api/src/retention.ts` | `sweepRooms(db, { keep })` — a room keeps its newest `KEEP` (500) lines; `app.ts` puts it on `app.scheduler` every hour, through `asSystem()` so each dropped line reaches the trail. A count per room, never a window of days (`FJS-D748`) |
| `api/src/booth.ts` | `boothFor(db, me, them)` — the Room row for a pair, `booth-<lo>-<hi>`, made on the first sitting; the Room and Message read policies in `db/schema.lite` (`pairLoId`/`pairHiId`) are what keep it private |
| `api/src/hearing.ts` | who hears a line (`FJS-D992`): `EARSHOT` (a box, 16×6 cells), a `!` line is a shout heard by the room, a `toId` line a whisper, and `hears(line, speakerCells, listenerCell)` — a listener with no cell hears nothing, a speaker with none is heard by the room (a booth's lines). `messages.service.ts` filters the room's channel by it, and `Scene.mesa` asks it of the lines it loaded, so there is one rule |
| `api/src/facing.ts` · `shape.ts` | the home row's shared rules (`IDEAS/haven.md` 9.4, 9.7), imported by both sides as `hearing.ts` is: `Facing` (`n e s w`, the way a figure last stepped), `facingOf`, `ahead`, `behind`; `glyphOf()` — one printable ASCII character, the only text a stranger draws on another screen (a shapeshift, chalk) — and `SHAPE_MS`; `inkOf()`, the `#rrggbb` a flower dyed a figure. All three ride presence as `facing`, `shape` and `ink`, which `roomMeta` validates and drops when malformed (`presenceMetaBytes` 80); the shape's 60 s is the client's to end, since presence meta is stateless |
| `api/src/memory.ts` | the room's memory (`FJS-D993`): `createRoomMemory()`, traces on cells that last a while — `step`, `struck`, `scorch`, `chalk` — each kind's time and caps in `TRACES` (chalk also per member), `wipe` (a bolt), `forget(by)` (a ban), `fadeOf`, and `stepped(was, now)` — one cell over, the rule a footprint is laid by on both sides (7.4). Held by the app as `app.memory`, keyed by the room's channel name; `rooms.ts` lays a `step` from `presenceMeta`, which Junction hands `{ channel, conn, was }` |
| `api/src/bolt.ts` | `d` (9.5): `fly(world, shooter, facing)` — the cells crossed and what stopped it; a member is knocked back `KNOCK` cells, never into a wall or a figure, and never removed — `volley` (`dd`), `crosses`, `createCooldowns` (`BOLT_MS`, `VOLLEY_MS`). What stands on a cell is the caller's `at(x, y)` — `play.ts` hands it the scene's `world.ts` |
| `api/src/world.ts` · `pacer.ts` · `play.ts` | the scene as the server reads it (`IDEAS/haven.md` 12.2, 9.5): `worldFor(slug)` loads `web/src/scenes/<slug>.world.json` (a slug of letters only; a booth has none), `walkable`, `obstacleAt(world, x, y, ms)` — a wall, a piece (a `fragile` one shatters), or the cat where `pacerAt` puts it on the shared clock; `pacerAt` lives in `pacer.ts` so the client and the server ask one function. `shoot()` resolves a bolt or `dd` against it: a shattered piece stops nothing, a wall takes a scorch, chalk crossed is wiped, and each is a trace in `app.memory`. `rooms.bolt` (`{ roomId, facing?, volley? }`) is the service call: the caller must be in the room's presence, the cooldown is `app.cooldowns`, and the `bolt` event goes to the whole room. `rooms.traces` hands a joiner every trace still lasting (footprints included); `Scene.mesa` hears the event and draws it |
| `api/src/principal.ts` | the one read of the standing — `bannedAt` and `role` — for a call (`principal:`) and a socket frame (`channels({ claims })`) |
| `api/src/services/` | `messages` (find/get/create, rate-limited per member), `rooms` (and `traces`, the room's memory for a joiner -- footprints, broken pieces, scorches -- read through the caller's client; `bolt`), `members` |
| `api/test/room.test.ts` | real sockets: two members see each other, a door moves a figure between rooms, a banned one sees and is seen by nothing; a step remembered and handed to a later joiner, a jump not |
| `api/test/hearing.test.ts` | earshot's edge, a line reaching the near and not the far (beside each delivery), a shout, a whisper across the room and through `find` to its two members alone, history still holding what a member did not hear |
| `api/test/bolt-service.test.ts` · `world.test.ts` · `meta.test.ts` | the bolt over real sockets — a hit and its knock-back told to both screens, the facing from presence and a stated way, the cooldown, a scorch, a piece shattered for everyone, `dd`, a member not in the room, a banned one, a booth; the world reader, a slug that is a path, the cat on the clock; what a presence frame may carry |
| `web/src/world.js` | `worldOf(stage)` → `scenes/<slug>.world.json`, written by `bun run frames` and pinned by `scenes.test.js` like a `.frame.txt`: a row a line of `.` `+` `#`, the doors, the solid pieces by id (`FRAGILE` names the ones a bolt breaks), the pacers |
| `api/test/bolt.test.ts` · `memory.test.ts` | over rooms drawn as text: a bolt's range, a wall, a piece and the cat named, a knock-back stopped by a wall and a figure, a volley, the cooldown; a facing, a glyph; each trace's time and fade, the room and member caps, a wipe, a ban's `forget` |
| `api/test/login.test.ts` | the signed login — forged, tampered, replayed and stale make nothing; a dead session closes 4001 |
| `api/test/retention.test.ts` | seven lines in one burst keep exactly three, a room under the count is untouched, a second sweep finds nothing, and the app has the sweep on its clock |
| `api/test/client.test.ts` | the stated version is the manifest's, answered with no session |
| `api/test/sign-in.ts` | a test's machine walking in, with the signed request's parts kept for a test that tampers with them |
| `web/src/routes/` | `index.mesa` the square, `tavern.mesa`, `road.mesa`, `woods.mesa`, `docks.mesa`, `workshop.mesa`, `cellar.mesa`, `glade.mesa`, `lane.mesa`, `jordan.mesa`, `vlad.mesa`, `colin.mesa` — each one `WalkIn` around its scene; the tavern's passes its scene a `<Runner />`, the workshop's a `<Workers />`, a `<Taskmaster />` and a `<Ledger />`, inside a `{#key}` on the counts so a new count mounts the room again |
| `web/src/components/WalkIn.mesa` | a route's body: asks the socket for the scene's room, reads its Room row, then provides it as `$context.room` and lets the scene in |
| `web/src/components/Scene.mesa` | one room drawn (`FJS-D997`): makes a stage, provides it as `$context.scene`, paints it with `#paint`; and with a `$context.room`, a figure per `presence()` member, a bubble per member's newest line that this figure hears (`hearing.ts`), the input line — a line beginning `/` is a command, looked up in `$context.commands` (`commands.js`) and never a Message; the scene keeps this scene's map snap at mount; a step onto a door is `goto`. Everything else a room draws or answers is an actor placed inside it (`Bubbles`, `Nameplates`, `Sitting`, `Whisper`, `Mod`, `WorldMap`, `History`). With no room it is a picture. The home row: `f` + a letter walks to the nearest member IN THE LIGHT whose nick starts with it, one step per `FIND_MS`, re-planned each tick toward where they stand now, stopped by a step, a key or Esc; `s` + a character is `shape` in presence for `SHAPE_MS`, ended by this component's timer (so a door, which remounts the scene, ends it); `d` + a way, `dd` and a lone `d` call `rooms.bolt`, and the room's `bolt` event (heard on `getClient().on('event')`, shooter included) is drawn on every screen: a `-` or `|` a cell a `FLY_MS` along each flight, then at landing the struck figures flicker `x` for `STUN_MS`, THIS figure is moved to its `to` if it was one (a position is its owner's, so no other screen moves it), `stage.shatter` and `stage.scorch` take the laid traces, and a cat hit says so in the note; a joiner asks `rooms.traces` at mount; `a` says chalk is not drawn. `facing` rides every move, and an arrow into a wall turns the figure |
| `web/src/booth.js` · `components/Booth.mesa` · `routes/booth.mesa` | the booth screen: `transcript()` lays a conversation out as bubbles (mine against the left, theirs against the right, the oldest scrolling off the top), `Booth.mesa` draws it between two half faces (`pieces/face.js`, one drawing and its mirror — mine on the left, theirs on the right, always), and Esc stands up beside the stool. Reached only by `Scene.mesa`'s `sitAcross` — two figures on the two seats of one `table` (a piece's `seat` spots, `stage.seatAt`; a `solo` seat — the bar's stools — has no mate and is never a booth) each ask `rooms.booth` and `goto('/booth/')`; the route refuses a slug that is not a booth's |
| `web/src/components/Piece.mesa` · `Row.mesa` · `Door.mesa` · `Pacer.mesa` | what a scene is made of — each claims cells on the stage it is inside and draws nothing itself: a piece at `x, y`, a piece `n` times `step` apart, a door that replaces the wall cell under it — with a `w` or an `h` a run of door cells, a border along an edge, with `hidden` one that draws what is under it, with `night` one that is a door only at full night and the cell under it by day — a sprite pacing a row |
| `web/src/components/Runner.mesa` | a boy who runs in through a door with `#errand`'s answer, drawn on this screen only and never sent; placed by a route, inside the scene's `<slot />`, so a scene's picture and its test run no command |
| `web/src/components/Workers.mesa` | the Claude sessions working on this machine (`#workers`), one each at the bench of its package whatever the fog — `?` stopped on a prompt and seated first, `✓` stopped, else `✻` — `(! N here · ? N waiting on you)` beside a bench, and the one beside this figure read out — what it asks, else its last words, else its file, and how long ago; read every second, drawn on this screen only and never sent (`IDEAS/haven.md` Phase 11) |
| `web/src/components/Taskmaster.mesa` | the man at the workshop's desk on the left by the door (`✦`, drawn only where `#taskmaster` finds a checkout): walk within `REACH` and he reads `fli next` and says *"litestone has the most severe issue — FJS-2084 (S2). Work on it? /yes or /no"*; `/yes` starts `scripts/fix-loop.mjs --pkg <it>` detached, `/no` hears the next package. His words are verbs on `$context.commands` with his desk as their `reach`, so `/yes` and `/no` are in Tab, the hints and the help only within two cells of him, and out of reach the registry answers *nobody here to answer*; because the line input holds every letter. Drawn on this screen only and never sent |
| `web/src/components/Bar.mesa` | the board behind the tavern's bar: a figure on a stool (a `solo` seat of the piece named `bar`) has `barActivity()`'s rows chalked up over the shelves, newest first with how long ago, the project cut to `PROJECT_W` so the notification gets the width, each row its own color (`INKS`, by its index in the list so it keeps it while scrolling), kept a minute, a board of more rows than fit scrolling one row every 3s (`SCROLL_MS`) and starting at the top on each sitting; standing up takes it down, no `HAVEN_BAR` draws nothing, a failing command says so on the board. Placed by `routes/tavern.mesa`, drawn on this screen only and never sent (`IDEAS/haven.md` 8.6). A row is not a link — `linked()` paints none on a text Mesa binds in an `{#each}` |
| `web/src/components/HomeBoard.mesa` · `home-board.js` | a member's board (`IDEAS/haven.md` Phase 13), placed by `routes/lane.mesa` and each home's route: `#errand`'s `homeBoard()` runs `HAVEN_HOME` (else `~/.fli/haven/home`), whose `{ home, pins, inbox, pings, due }` NAMES its home, and is drawn in that home alone — pins on the `corkboard`, the inbox on the `screen` (the newest standing, all of it scrolling sat at the `desk`), the `calendar`, a `✉` on the `doormat` per thing unread, the `bell` ringing for a fresh ping and its pings in a pane beside it — and as a flag by that home's mailbox in the lane. A failing command says so on this home's screen. `home-board.js` is the text, pure; the pieces are found by name. A line is a `<pre>`, since outside one the terminal collapses its padding. Drawn on this screen only and never sent |
| `web/src/stage.js` | `createStage()`: the cells a scene's pieces claim, one owner per cell (two pieces on one cell throw naming both), `walkable`, `doorAt(x, y, ms)` (a night door is none by day; `doors` lists it whatever the clock), `look()` — how a cell is painted at a tick: its own glyph folded through the `LAYERS` the scene names (`candle`, `weather`, `steps`, `sky`, `fog`; `OUTDOORS` by default, `INDOORS` under a roof) — `tread(traces)`, footprints, the newest per cell — `task(key, fn, { phase, every, after })`, the one clock (`PHASES` simulate, light, paint; a paint task runs on a change and on the look's next tick), `frame(ms)` and `manual: true`, a stage a test steps —  `see(x, y)`, the figure that sees, and `seer`, where it stands, `light(x, y)` → `lit`/`dim`/`dark`, `lights`, and the pure `litAt(stage, x, y, from)` under them (`SIGHT`, a palette entry's `light: r`), `scorch(traces)` and `shatter(traces)` (9.5) — the `scorch` layer draws a `,` over the wall a bolt struck, fading in thirds; a shattered piece's solid cells draw as nothing and are walkable until the trace's `until` — and `dyeAt(x, y, ms)`, the color a cell whose palette entry says `dye` gives a figure stepping on it (the square's flowers; `Scene.mesa` sends it as `ink` and keeps it in `worn` across doors), `arrival()`, where a figure stands having come through a door (beside the door back to `from`, nearest the cell crossed, so a border is crossed at its row), `pacerAt()`, `picture()`, and `marks`, every placed thing in order, which the editor moves; `view`, the slice a screen draws (`VIEW`, 97×26, at most), `follow(x, y)`, which pans it when the figure comes within `EDGE` of a side, and `showAll()`, the editor's; the pure `follow()` a drive mirrors a terminal's view with; `stages` by slug, for a test or a drive |
| `web/src/sky.js` | the time of day (`IDEAS/haven.md` 7.2), a pure function of the wall clock: `darkness(ms)` (0, ⅓, ⅔ or 1 — a `DAY_MS` of an hour, half of it daylight, a tenth dusk, three tenths night, a tenth dawn), `isNight(ms)`, `shade(hex, level)` toward moonlight, `SKY_MS`. `stage.look()` shades every outdoor cell by it except a light source's own (a palette entry with `light`), and a cell inside a light's radius keeps half the day; `stage.tint()` does the same for a pacer; `<Scene layers={INDOORS}>` (the tavern, the cellar, the workshop) names no sky. Nothing is sent, so every screen draws the same sky. Weather (7.3) is here too: `scheduleAt(ms)` (a spell of `WEATHER_MS`, ten minutes: clear, rain or snow), `weatherAt(ms)` (that, or the kind `HAVEN_WEATHER` pins), `fallAt(kind, x, y, ms)` (a drop a column a period, a row lower each step; snow drifts), `FALL`, `untilWeatherChange`, and `hash`, the clock's dice `stage.js` flickers with. `stage.look()` lets a drop replace a BLANK outdoor cell that is not overhead, never a claimed one |
| `web/src/home-row.js` | `a s d f` in NORMAL (9.4): `createHomeRow()`, a key in and an action out — `d` + a way, `dd`, a lone `d` after `PENDING_MS`, `f` + a letter, `s` + a character (Space back), `a` + a character; after an operator an arrow reads as its letter, since the terminal shell renames h j k l. `Scene.mesa` reads it only for a printable key the shell already prevented (NORMAL) or any key while an operator waits, so in INSERT, or in a browser with no NORMAL, the letters are typed and the home row is inert |
| `web/src/paths.js` | walking by the floor: `reach` (the flood fill), `pathBeside(stage, from, goal)`, `findByNick` — nearest by the walk, a tie to the nick first in order (9.6). `editor/doc.js` and `scenes.test.js` still keep their own `reach` |
| `web/src/scenes/Square.mesa` · `Tavern.mesa` · `Road.mesa` · `Woods.mesa` · `Docks.mesa` · `Workshop.mesa` · `Cellar.mesa` · `Glade.mesa` · `Lane.mesa` · `Jordan.mesa` · `Vlad.mesa` · `Colin.mesa` | each scene as a tree: its one-off piece blocks and palette in `<script>`, its `<Scene>` of placed tags after. The square is 160 cells wide, a screen and two thirds, its frame its own `framed(159, 26)`, with borders east onto the road, west into the woods and south down to the docks; every other scene but the workshop one screen. The workshop is a `namedBench` per `packages/*`, `example` and `frontierjs`, through the house beside the tavern's. A package with open issues has a table (23 wide) with its `ledgerBlock` on it: a slip (`━`) in the severity's color per open issue of that package in `ISSUES.md`, piled on the table's edge, one pile per severity (S1 to S4, left to right, `PILE` across, growing upward), counts from `web/src/ledger.data.js`; one with none has no table and is listed under `(no work)` in a row along the bottom. Where each stands is computed by `pieces/workshop.js` (`layoutWorkshop`: six columns, each bench dealt to the shortest), so the file is a loop, the editor refuses it by name, and the room's size follows the counts (160 × 43 now); the view pans across and up it, the door at its foot. The lane is east across the road's border, a cottage per home along its top; each home has the board's furniture at the same cells and its own decor. The cellar is reached by the tavern rug's hidden door, and at night by the tunnel from the glade's oak; the glade only by the loose plank in the woods' west fence |
| `web/src/scenes/*.frame.txt` | each scene's picture, rendered from the tree and pinned by `scenes.test.js`; `bun run frames` rewrites them, and the diff is the review |
| `web/src/pieces/home.js` | the lane's `cottage(name, roof)` (its door at `COTTAGE_DOOR`, its `home` slug on the piece), `mailbox`, `pond`; a home's furniture — `corkboard`, `screen`, `calendar` and `doormat` each with `inner`, the blank cells the board writes in; `desk` (its chair a `solo` seat), `bell` — and the decor that tells one home from another |
| `web/src/pieces/` | `piece()` and the pieces any scene may use, each a small art and its paint: `frame`, `tree`, `lamp` (its bulb is `Y`, the light), `bench` and `namedBench` (the workshop's, its name a light, four `slot-N` spots below it where `Workers.mesa` stands a session), `ledgerBlock` (the piles of issue slips on a workshop bench), `layoutWorkshop` (where each workshop bench stands), `table` (its candle, a `burn` spot, burns only while a stool is taken, a white dot otherwise — `stage.occupy`, fed by `Scene.mesa`; its two stools are seats, each the other's `mate`), `bar` (seven solo stools), `barrel`. A piece may carry `palette` entries for its paint letters (the lamp's `Y`): `stage.entryOf(letter)` is the scene's entry, else the placed pieces', and `scenes.test.js` fails a letter neither defines. A piece's `spots` (`pieces/index.js`) are named cells an actor reads — `mark.spot(name)` — and are never an offset in a component; a piece is found with `stage.placed(piece)`, by import and not by `piece.name` |
| `web/src/paint.js` | `#paint` in the terminal: `paint(stage)` — the attach that draws the stage's `view` and its pacers into an OpenTUI frame buffer in color, a paint task on the stage's clock — redrawn on the look's next tick and on any claim, pan or footprint changing |
| `web/src/paint.browser.js` | `#paint` in a browser: the same `look()` and `pacerAt()` as a `<pre>` of color runs, in a box laid out in `ch`/`lh` cells — the view's size at every window, the font scaled to fit |
| `web/src/cell.js` | `#cell` in the terminal: `at(col, row, layer, size)` — the attach that places a box on a cell (`FJS-D978`); `tint(color)` sets a text's `fg` (the terminal paints no CSS); `linked(url, seen)` makes a text an OSC 8 hyperlink, telling `seen` whether the terminal has them; with a `[cols, rows]` size it is a pane over that many |
| `web/src/cell.browser.js` | `#cell` in a browser: `tint` and `left`/`top` in `ch`/`lh`, margin and padding zeroed so a bubble's glyph lands on its cell |
| `web/src/sign-in.js` | `#sign-in` in the terminal: the key at `~/.fli/haven/key.json` (made 0600 on the first run), a signed login on every run, and `sessionToken()` — the `HAVEN_TOKEN` `fli haven` handed over. `fli haven` imports this file by path, so the door versions with the server |
| `web/src/sign-in.browser.js` | `#sign-in` in a browser: the same signed login over a WebCrypto key kept in IndexedDB, once per page load; a first login's nick is `?nick=`, else `guest-` and the key's first six characters |
| `web/src/errand.js` | `#errand` in the terminal: `nextErrand()` runs `HAVEN_ERRAND` through `sh -c` for one `{ id, title, url }` (unset, none), and `markDelivered(id)` keeps it in `~/.fli/haven/errands.json` for a day; and `barActivity()`, the same opt-in a second time — `HAVEN_BAR`, else `~/.fli/haven/bar`, a command printing `[{ text, when? }]`, null when neither is set |
| `web/src/errand.browser.js` | `#errand` in a browser: no errand, since a page runs no command on its machine |
| `web/src/workers.js` | `#workers` in the terminal: `recordWorker(input, { root })`, what `.claude/hooks/haven-worker.mjs` calls on `PostToolUse` (every tool), `Notification`, `Stop`, `UserPromptSubmit` and `SessionEnd` — `~/.fli/haven/workers/<session>.json` at the bench `benchOf()` names, `asking` from a Notification in `ASKS`, `said` from a Stop's `last_assistant_message` (`lastWords()`), both cleared by the next event, the file removed at SessionEnd and a day old deleted — and `readWorkers()`, every session heard from within `QUIET_MS` (ten minutes) or asking |
| `web/src/workers.browser.js` | `#workers` in a browser: no workers, since a page reads no directory on its machine |
| `web/src/taskmaster.js` | `#taskmaster` in the terminal: `checkout()` (the root holding `scripts/fix-loop.mjs`, else null — an installed Haven has none; `HAVEN_TASKMASTER_ROOT` names another, for a drive), `proposals()` (a package per `fli next --json` row the loop can take, `byHand` skipped), `running()`/`startLoop(pkg)` (the loop detached, output to `~/.fli/haven/fix-loop.log`, its pid in `~/.fli/haven/taskmaster.json` so one runs at a time across terminals; a name with a leading dash or a non-word is refused) |
| `web/src/taskmaster.browser.js` | `#taskmaster` in a browser: no checkout, so the desk has nobody at it |
| `web/src/ledger.js` · `ledger.browser.js` | `#ledger`: the one count of `ISSUES.md` per bench and severity — `checkout()` (a root with `ISSUES.md`; `HAVEN_LEDGER_ROOT` names another, for a drive), `count(root)`, `write(counts, out)`, `recount({ root })`, which writes `ledger.data.js` and returns the counts. `bun run ledger` and `/ledger` both call it. A browser's twin has no checkout |
| `web/src/components/Ledger.mesa` | `/ledger` in the workshop, anywhere in it, only where `#ledger` finds a checkout: recounts, and hands a changed count to the route, which mounts the room again on it — the figure back by the door; an unchanged count says `the ledger is as it was — N open`. The pinned `workshop.frame.txt` still needs `bun run frames` |
| `web/src/map.js` | the map (`IDEAS/haven.md` 6.4), target-neutral: `coarse(stage, route)` — a scene as a snap, its picture at `SCALE` (5×5 cells a glyph), size, doors and route — `remember`/`recall` over `#seen`, `layoutOf(snaps)` placing each scene from its borders (houses in a row under the streets), `drawn()` the rows with `@` on the figure's block |
| `web/src/seen.js` | `#seen` in the terminal: a snap per scene at `~/.fli/haven/seen/<slug>.json` (`FJS-D991`), a slug that is a path writes nothing, a torn file reads as none |
| `web/src/seen.browser.js` | `#seen` in a browser: a record per scene in IndexedDB, database `haven-seen` — its own, since a store added to `haven` is a version bump of the member's key |
| `web/src/components/WorldMap.mesa` | the `/map` actor: the verb, and the pane it opens as the registry's mode (Esc closes) — the kept snaps less this scene's, plus this scene's live stage, drawn over the art and following the figure; the store is read when it opens |
| `web/src/commands.js` | the one registry (`IDEAS/haven.md` 12.4), `createCommands()`: `add({ word?, aliases?, key?, help, run, reach? })` returns its removal; `words(at)` (sorted, aliases out), `helps(at)`, `find(word, at)` → `{ verb, reached }`, `press(key, at, event)` (nearest in reach first, a `run` answering `false` passes the key on), and the mode over the art — `open({ name, keys?, closed? })`, `mode`, `modeKey(event)`, Esc closing unless the mode names it, opening one closing the last. `reach` is `{ x, y, within }`, a cell and a Chebyshev radius; a verb with none is the member's own or the room's and ranks after any in reach. `partial`/`matches`/`complete` are Tab over a words list |
| `web/src/crowd.js` | what the other figures put on this screen, pure over `here.get()`: `cellOf`, `inView`, `figures` (in view and lit), `plates` (the nick under a figure within `NEAR`), `bubbles` (the newest line per speaker this figure hears, a marker on the edge for one out of view) |
| `web/src/components/Bubbles.mesa` · `Nameplates.mesa` · `Sitting.mesa` · `Whisper.mesa` · `Mod.mesa` · `History.mesa` | `Scene.mesa`'s actors, each placed by it with the presence it made and drawn in the scene's box: the lines over speakers, the names under near figures, the booth (`sitAcross`), `/w`, `/ban` and `/unban`, and the history pane — PageUp and PageDown are key verbs, the open pane the registry's mode |
| `web/src/walk-in.js` | `walkIn(slug)`: `#sign-in`'s token, the room as the socket's query, then the token — target-neutral |
| `web/src/main.js` · `App.mesa` · `web/index.html` | the browser's entry and root; the terminal shell mounts a route itself and never reads them |
| `web/config/vite.config.js` | the browser build: 5506 (`havenWeb`) or `WEB_PORT`/`FLI_PORT_FE`, `strictPort`, the API's paths proxied to 5505 or `API_PORT` |
| `web/src/resources/` | `rooms`, `members`, `messages` |
| `web/test/stage.mjs` | a scene mounted headless through Sierra's terminal loader: its stage and the frame the terminal drew — `scenes.test.js`'s and both drives' |
| `web/test/scenes.test.js` | each scene's picture is its `.frame.txt`, and the terminal draws its view's slice of it from the spawn and from the far corner; `follow()` pans only near an edge and stays inside the stage; a glyph and a color at every tick; from the spawn a figure sees part of the scene and every light, and `litAt` on a probe — the radius, a wall seen and the cell behind it not, a lamp from across the stage, lit then dim then dark through `look()`; every door reached from the spawn, leading to a scene with a door back, and every border cell paired with one across at its row; a pacer walks floor only; the stage's own rules — a cell claimed twice refused, a door over a wall, a door run as one mark, `arrival()`, a moved piece freeing its cells |
| `web/test/workers.test.js` | `#workers` over a directory handed in: the bench of a path, a move, quiet, the day's sweep, a torn file, a session id that is a path; a hand raised and lowered, kept past quiet, last words kept through an `idle_prompt` and dropped by the next prompt, a session seated where it started, SessionEnd; and the real hook run as Claude Code runs it, silent and 0 on input it cannot use |
| `web/test/sky.test.js` | the curve and its quantized steps, a shade, a probe stage by day and night — a light source left, a lamp's pool half, ink shaded, `indoors` untouched, a pacer tinted, the redraw tick — and the real scenes: the square shaded at night, the three interiors never; the square mounted under a night clock; the schedule, a pin, a drop's fall and drift, a density, rain on blank outdoor cells and nowhere else, `tickOf` while it falls, and the square's terminal frame in the rain: drops on blanks, every other glyph as it was |
| `web/test/clock.test.js` · `steps.test.js` | the one clock over a `manual` stage — phase order, `after`, `every` on its multiples, a paint only on a change or the look's tick, a task stopping itself, a piece a task walks pinned at frame N; a footprint's thirds and its end, the newest on a cell, never on the art, indoors as out, under a drop and shaded at night, and a paint at each third |
| `web/test/commands.test.js` · `crowd.test.js` | the registry — a verb's shape refused by name, words and help only within reach, the nearest verb for a word or a key, a key passed on, a mode taking its own keys and Esc, a mode replaced; Tab over a words list; then a real stage with presence snapshots: who is drawn, a nameplate within reach and inside the view, a bubble per speaker, earshot, a marker for one out of view |
| `web/test/home-row.test.js` · `paths.test.js` | each operator and the key after it, Esc, a lone `d` on the clock, the arrows read back; the flood fill over a real stage, a walk ending beside a figure, the nearest by the walk and not the crow, a tie |
| `web/test/scars.test.js` | a broken piece draws as nothing and is walkable until it grows back, the redraw asked for at that ms, a trace for a piece this scene lacks ignored; a scorch replaces a wall's glyph and fades in thirds, never on a blank cell, indoors as out |
| `web/test/verify-bolt.mjs` | two ptys in the square, Ana eight cells east of Sam: his `d` `l` is a `-` across the cells between them on both screens, she is knocked two cells east and flickers `x` for a second before she is `A` again, her own `@` stands at the knocked cell; `d` `j` ends in a `,` on the wall below on both, and a third member walking in after sees it. A piece breaking is not in it -- the square has none |
| `web/test/verify-home-row.mjs` | two ptys, Ana eight cells east of Sam: `s` `T` is a `T` on both screens and `s` Space gives her back, `f` `a` walks Sam up beside her and he stays, a letter nobody has is said, Esc stops a walk partway, a second `d` `l` inside the cooldown is refused by the server, and in INSERT `fa` is typed into the line and walks nobody |
| `web/test/map.test.js` | a snap is its picture at `SCALE` with a door where one is; the real scenes laid out — woods west, road east, docks under the square at the door both name, houses in a row apart; an unwalked scene not drawn; `@` once, in its own scene; a smaller pane cuts; `#seen` round trip, a torn file, another shape and a path slug |
| `web/test/verify-map.mjs` | the map: a pty in a HOME of its own opens `/map` in the square — the square alone, Sam's `@` on the spawn's block — walks through the tavern's door and sees both with `@` in the tavern's block and a file per scene; a second terminal in that HOME draws the tavern it never walked into, a third HOME draws the square alone |
| `web/test/verify-booth.mjs` | two ptys sit across the tavern table at (49, 16): one alone goes nowhere, two are the booth, a line is a bubble on the left of its speaker's screen and the right of the other's, the next under it, one stands up and the other keeps the lines, their head gone and `<nick> left` where their name was, and neither is sent back |
| `web/test/bar.test.js` · `verify-bar.mjs` | `barActivity()` over real commands — none is null, the env var over the file, rows in order, no output an empty board, output that is no list or a row with no text refused by name — and each stool of the bar a walkable seat with floor to stand up to and no mate; then a pty: no board on his feet, the board up on a stool with each row's age, down on standing, eight rows scrolling off the top and a new sitting back at the newest, a second stool within the minute asking the command nothing, no `HAVEN_BAR` drawing nothing, a failing command saying so |
| `web/test/verify-hearing.mjs` | two ptys in the square, Ana walked 18 cells from Sam: his line is on his screen and not hers, a `!` line is on both, a `/w ana` line is on hers as `(psst: …)`, a third member beside Sam reads his shout from the history and nothing of the whisper, and walking back the next line is hers |
| `web/test/verify-steps.mjs` | footprints (7.4): two ptys on the square's spawn, Sam walks four cells east — his screen and Ana's (laid from presence) show a `.` on each cell he left, and Rex's later `--frame /` finds the same three from the server's memory; none west of the spawn |
| `web/test/verify-nameplate.mjs` | a figure within reach (`NEAR` in `Scene.mesa`) wears its full nick on the row under it, and out of reach is its initial again — Ana's frame beside Sam, then Sam five steps off |
| `web/test/verify-cellar.mjs` | the cellar: another HOME's `--frame /tavern/` reads the hidden door's cell as rug, the same glyph as its neighbors; a pty walks in from the square, steps onto it and is in the cellar beside the ladder, seen by a `--frame /cellar/`, and climbs back up beside the hole |
| `web/test/verify-glade.mjs` · `clock-at.mjs` | the glade and the tunnel: another HOME's `--frame /woods/` reads the plank as fence; a pty pinned to day walks the square, the woods' path and the plank into the glade, is in a `--frame /glade/`, and bumps the oak's trunk; a pty pinned to night goes through the oak into the cellar and back. `clock-at.mjs` is the pin, a `--preload` through `BUN_OPTIONS` reading `HAVEN_CLOCK_AT` (a fraction of the day) |
| `web/test/verify-workshop.mjs` | the workshop: three sessions seated through the real hook in a HOME of Sam's, Sam's pty walks from the square through the door, two workers and their count at one bench and one alone, standing beside one reads it; a `--frame /workshop/` from another HOME draws Sam and none of it; a session moving benches and one going quiet; the one beside him a `?` on a permission prompt with its bench and the prompt read, then a `✓` with its last words; then Sam walks up the room to the aisle past litestone's table, the view panning, and its bench and the top slip of its tallest pile are on his screen cell for cell |
| `web/test/taskmaster.test.js` | `checkout()`, `proposals()` against the real `fli next`, and `startLoop()` against a stub loop that is a real child: argv and cwd, a second start refused while it lives, let go when it ends, a bad name never reaching a command line |
| `web/test/verify-taskmaster.mjs` | the desk, over a fake root whose `fli` and loop cost nothing: silent at three cells, the offer past a `byHand` row, `/no` to the next, `/yes` from out of reach starts nothing, from beside him starts `--pkg mesa`, a second `/yes` refused, the register read again when it ends, a root with no loop drawing the desk and no one |
| `web/test/ledger.test.js` · `verify-ledger.mjs` | `#ledger` over a root made here — the first package, `fli`, a name that is no bench, a closed row, the file read back; then a pty with `HAVEN_LEDGER_ROOT` at that root: `/ledger` redraws on its counts (the legend's totals), a second says nothing moved, a row added redraws again, a root with no register has no `/ledger` |
| `scripts/basecamp-home.mjs` | `bun scripts/basecamp-home.mjs <home>`: one source for `HAVEN_HOME`, this machine's Basecamp through the `basecamp` CLI — bookmarked projects as pins, notifications as the inbox, chat readings as pings, `assignments due`. Nothing in `web/` imports it |
| `web/test/home-board.test.js` | `homeBoard()` over real commands — none, the env over the file, a board read, one naming no home refused, held a minute and a failure asked again — the text at a fixed clock, the inner cells blank, every home's furniture and the lane's mailboxes |
| `scripts/ledger.mjs` | `bun run ledger`: counts the open rows per package and `S1`–`S4` in the repo's `ISSUES.md` and writes `web/src/ledger.data.js`; a row goes to the FIRST package its Pkg cell names, `fli` is `cli`, and a name that is no bench (`repo`, `docs`) is `frontierjs`. A snapshot, so the workshop's picture moves only when this and `bun run frames` are run — a browser reads no register |
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
  `{ x, y }` is refused by name with an `error` frame, and extra keys are cut —
  `typing` survives only as `true`.
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
  `package.json`, and a copy with none above it draws nothing. It mirrors the
  package's layout (`web/src` and `api/src` under the copy), since the web
  imports the rules it shares with the server (`hearing.ts`, `memory.ts`,
  `pacer.ts`) by a relative path, and a file left out is a preview of nothing.
- **A color is the sky's as well as the palette's.** `stage.look(x, y)` at the
  default `ms = 0` is daylight, so a test reads a palette color there; a drive
  that reads a color off a live screen asks `look(x, y, Date.now())`, and one
  that wants a cell no clock moves compares two times of the same day
  (`3 * DAY_MS + n`), never `1e7`, which is night. The sky does not shrink
  `SIGHT` after dark: the fog is off, so there is nothing for it to act on.
- **Weather changes GLYPHS, so a test or a drive that reads a blank cell is
  at the clock's mercy.** `HAVEN_WEATHER` (`clear`, `rain`, `snow`; anything
  else is the clock's own) pins the kind, `web/test/stage.mjs` sets it to
  `clear` for every process that imports it and every child it spawns, and the
  two Vite configs bake it into the page at server start (`define`) -- a
  browser has no environment. A test of rain sets it back, and puts it back.
  `tickOf(ms)` is asked again after every paint, because a spell turning on
  changes it; a timer set once would draw the first spell's step for good.
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
  `packages/*`. A package with no issues keeps a bench, listed under
  `(no work)`, so its workers still stand somewhere.
- **The workshop's layout moves with `bun run ledger`.** A package that gains
  issues grows its piles and every bench dealt after it shifts, so a drive
  picks its benches by what the first screen shows (`onFirst` in
  `verify-workshop.mjs`), never by a name or a row.
- **The ban is read per call and per frame, never off the session.** With a
  `claims` resolver installed every committed write re-grades every room, so a
  write costs one `Member` read per person standing in a room.

- **A `crumbles` cell falls per SCREEN, off the figures that screen sees.**
  `stage.occupy()` is the only input, so a plank shakes (`CRUMBLE.wobble`) and
  sinks (`CRUMBLE.fall`) from the moment THIS screen saw its last figure leave,
  and the server's `world.json` still has the pier as floor (a bolt flies over
  the water). A step back onto a shaking plank holds it; onto a sinking one
  does not. A figure walked to the pier's end past its own fallen planks is on
  an island: every neighbor is water and an arrow does nothing, so the way out
  is a new session. `test/crumble.test.js`.

- **A hidden door is stepped onto to be found, and the editor cannot place
  one.** It is not walkable and it draws what was under it, so a figure bumps
  into a floor cell that looks open and is through. A tag added in the editor
  has no `hidden`; one moved keeps it. A scene whose only way in is a hidden
  door is reached by `stage.doors` in a test, never by looking at its picture.
- **A night door asks the clock it is handed, and `doorAt` and `look` default
  to `ms = 0`, which is day.** `Scene.mesa` hands `Date.now()`; a test or a
  drive that wants the door open hands a night time (`3 * DAY_MS + DAY_MS *
  0.75`) or pins the child's clock (`clock-at.mjs`). `stage.doors` lists it
  whatever the clock, so `arrival()` finds the way back, and `picture()` is
  the day's. Only a child holding a token may be pinned: a signed login
  stamped off a moved clock is refused as stale.
- **The map is a command, not `m`.** The line input holds every letter, so a bare
  key is typed into the line (the workshop's reading met it too). A scene opens in
  NORMAL, so a drive types `i` before `/map`.
- **A snap is written once, at mount, and the fog is off.** No scene names the
  `fog` layer, so a scene is seen whole on arrival. With it on, what a visit uncovered would
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
(Chrome; it starts its own server over a copy of `web/src`). `Workers.mesa`, `#workers`, the workshop or the hook are proved by `bun run verify:workshop` (bun, util-linux `script`; it starts its own API). `Ledger.mesa`, `#ledger` or the workshop route by `bun run verify:ledger` (the same; it never writes this tree's `ledger.data.js`). `Taskmaster.mesa`, `taskmaster.js`, `commands.js` or any actor on `$context.commands` are proved by `bun run verify:taskmaster` (the same); it never runs the real loop, which spends money. `map.js`, `WorldMap.mesa`, `#seen` or `/map` are proved by `bun run verify:map` (the same) and, for the browser twin, `verify:browser`. `hearing.ts`, the messages service's channel or `/w` are proved by `bun run verify:hearing` (the same). Footprints — `stepped()`, `rooms.steps`, `presenceMeta` in `rooms.ts`, `tread` or the `steps` layer — by `bun run verify:steps` (the same). `hidden` in `Door.mesa` or `stage.js`, or `Cellar.mesa`, is proved by `bun run verify:cellar` (the same); `night` there, `Glade.mesa`, the woods' plank or `clock-at.mjs` by `bun run verify:glade` (the same). `Runner.mesa`, `errand.js` or the tavern route are proved by `bun run verify:errand` (the same). A change to
`web/src/sign-in.js` or `packages/cli/commands/haven/` is proved by
`verify:explore` too, and `api/src/client.ts`, the door's installer or this
manifest's `dependencies` by `bun run verify:fresh` (Docker, network).
