# Haven — traps

Every trap in the Haven package, verbatim, moved out of `CLAUDE.md`. The ones that bite most often stay there.

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
  `@allow(write)` drops the key (`FJS-D22`) and the row policy filters another
  member's row to no row, so the patch resolves either way. The client reads
  the answered row's `bannedAt` to say *only a mod bans*; a test asserts the
  column, never the promise.
- **A socket `service_call` carries its filters in `params: { query }`.** A
  `query` at the top of the frame is dropped in silence, so a `find` a test
  meant to filter answers the whole room — the crier's welcomes included.
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
- **A member's nick is the post's row, never the walk's.** There is no
  `--nick`: renaming a member is the post's, and the next login carries it.
- **A drive's `fli haven` walks in only from a staked HOME.** A key in no
  chain is refused (`FJS-D1477`), so a drive spawning `fli haven` gives it
  `stakedHome()` from `api/test/sign-in.ts`, signed by the test post every
  test haven pins as `postKey: POST_KEY`.
- **A Haven with no `HAVEN_POST_KEY` refuses every chain login (503).** `fli
  haven` hands a checkout's API the key this machine pinned
  (`frontier.postKey`), but an API started any other way has to be given it.
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
  mount, naming the cell and both.** A cell left of or above 0,0 throws too: a cell's key is
  `y * 4096 + x`, and such a key would name a cell in the row above. A door is the one claim allowed over
  another. A scene that mounts is therefore a scene with no overlap, and the
  picture test is what catches a piece on the wrong free cell.
- **A disposed scene is an empty stage.** A piece frees its cells when it is
  destroyed, so a drive or a test reads a stage while its mount is alive
  (`stage.mjs` keeps it); a stage read after `dispose()` has no cells and no
  doors, and a check against it fails in the wrong place.
- **The editor binds tags to marks by position**, the i-th placed tag to the
  i-th mark, so a scene file is a flat list of `<Piece>`, `<Row>`, `<Door>`,
  `<Pacer>` and `<Carousel>` tags under one `<Scene>`: a block in the markup or a tag the
  stage does not know is refused by name. A save renumbers the tags, so the
  undo history is rekeyed before it is kept (`remapOf`).
- **A screen shows as many cells of a scene as its terminal holds, and a scene
  may be bigger.** `viewFor(cols, rows)` in `stage.js` is the terminal less the
  shell's scrollbar and the status, input and mode lines under the art; `VIEW`
  (97×26) is that at `--frame`'s headless 100×30 (`sierra/src/terminal/shell.js`)
  and every drive's pty, so a drive that wants another size states it
  (`verify-view.mjs`). The stage's `view` is the slice drawn, and it follows the screen's own figure. So two screens in one
  room show different cells, and a cell is read off a screen THROUGH ITS VIEW:
  a `--frame` from the spawn through the stage's own, which a drive never
  pans, and a terminal that walked through the view the drive followed
  beside it (`walk`'s `eye` in `verify-explore.mjs`). A `--frame` of a tall
  scene shows the view round its spawn and nothing above it.
- **A bubble is kept inside the view**, so a figure within a bubble's width of
  the right edge has its line pushed left of its cell, and a speaker outside
  the view has it on the edge with a marker. A drive reads a line over its
  figure only where the figure stands inside the view's slack (`EDGE`). A
  bubble's bottom row is TWO over the speaker (the tail is the row between),
  one over a speaker near the view's top or out of it. A line past 34 cells
  wraps upward from there, and a speaker out of view or with another figure
  beside them has `nick: ` in front, so a drive's `(words)` read on that row
  holds only for a short line with nobody else beside its speaker.
- **A wide glyph under the terminal's overhead buffer is blanked**, whole,
  though every cell of that buffer over it is transparent; a one-cell glyph
  shows through. So an emoji figure is drawn above it (`WIDE_LAYER`) and
  hidden under a canopy by not being drawn (`covered`, `crowd.js`). Anything
  else wide drawn in a scene meets the same.
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
- **A piece taken away redraws a microtask later**, once for every piece
  taken that turn, so a scene torn down paints nothing. Its cells, palette
  entries and lights are gone at once, so a test reads `picture()`, `doors`
  and `lights` straight after a `remove()`; a listener or a paint count is
  read after an `await`. A piece placed still redraws at once.
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
  `SIGHT` after dark: only the canal and the mine name the fog, and they are
  indoors, so there is nothing for it to act on.
- **Weather changes GLYPHS, so a test or a drive that reads a blank cell is
  at the clock's mercy.** `HAVEN_WEATHER` (`clear`, `rain`, `snow`, `storm`; anything
  else is the clock's own) pins the kind, `web/test/stage.mjs` sets it to
  `clear` for every process that imports it and every child it spawns, and the
  two Vite configs bake it into the page at server start (`define`) -- a
  browser has no environment. A test of rain sets it back, and puts it back.
  `HAVEN_SEASON` is the same for the season (7.7), which turns a tree's art:
  `stage.mjs` pins `summer`, the season the frames are drawn in, or a
  frame would flip with the month. The ground's puddles and snow follow the
  pinned weather as though it always fell, so `clear` keeps the ground bare;
  a test of rain or snow reads `~` or `·` on blanks beside its drops.
  `tickOf(ms)` is asked again after every paint, because a spell turning on
  changes it; a timer set once would draw the first spell's step for good.
- **A save writes a module Vite is serving, and Vite answers with a hot
  swap of `Editor.mesa`, not a reload** — its script runs again with fresh
  state, so anything the editor holds across a save goes through
  `sessionStorage` (the undo history does). A drive that saves points
  `SCENES_DIR` at a copy's `scenes/`; the page evaluates the copy, so the
  swap happens there as in the tree.
- **An ask's edit is a write too, so it swaps the editor the same way — and
  edits not saved yet are gone.** The history is kept only at Save, against
  the text saved, and Claude's edit makes another text. Save before asking.
  A pick's line is the file's as last opened, so a piece moved and not saved
  is asked about where the file still has it.
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
- **A task starts the fix loop on this machine.** A mod's words reach a model
  with no tools and come out as a plan `loopArgv` accepted, but the loop they
  start runs under `auto` in the checkout, on the owner's bill (`FJS-D1020`);
  `HAVEN_MODS` given to `bun run agents` is the whole gate, and the server's
  own list is not read. The agent reads the loop's own log lines
  (`loopReport`), so a change to their shape in `scripts/fix-loop.mjs` reads as
  a loop that took nothing, and nothing else says so. The test never runs the
  real `claude` or the real loop.
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
- **A pin is not a line said, so it never enters the messages tether.** The
  bubbles read that tether and draw a member's newest line over their head, so
  a pin loaded into it would hang over its author. `Notices.mesa` asks
  `messages.service` directly, and nobody stands in the `board` room, so a pin
  reaches no screen live: the board is read each time it opens.

- **The map is a command, not `m`.** The line input holds every letter, so a bare
  key is typed into the line (the workshop's reading met it too). A scene opens in
  NORMAL, so a drive types `i` before `/map`.
- **A snap is written once, at mount, from the picture.** Only the dark
  scenes (the canal, the mine) name the `fog` layer, and their snap is the
  whole picture all the same, so `/map` shows every tunnel after one visit. Keeping only what a visit
  uncovered would mean merging into the file and writing on leaving; nothing
  does that, and nothing says so.
- **The map is laid out from the doors, so a scene needs a border back.** A
  neighbor is placed by the border that leads to it, aligned on the two doors'
  rows or columns; with no border back it is placed by the one door, unaligned.
  A scene reached by single-cell doors only goes in the bottom row.
- **A map wider than the pane is cut at its right and bottom**, not scaled; the
  current world is 72×21 glyphs in a 94×24 pane.
- **A drive's terminal with no HOME of its own writes `~/.fli/haven/seen/` on
  the machine running it** — `verify-explore` and `verify-browser`'s do. The
  files are the real scenes' pictures, so it is harmless, but a map drive sets a HOME.
