# Haven — Project State

**Phases 1, 2, 3, 4 and 5 of `IDEAS/haven.md` are built (5.4, the VS Code
editor, aside), and 6.1–6.5.** 1.1 is the schema, 1.2 the API, 1.3 the signed
login, 2.1 the square in a terminal, 2.2 the tavern and its door, 2.3 `fli
haven`, 3.1 the server naming its client, 3.2 the mod standing and the ban end
to end, 3.3 the history pane and retention by count, Phase 4 color and motion,
Phase 5 scenes as component trees, the browser target and the scene editor,
6.1 the view that follows a figure across a square wider than a screen, 6.2
the road, the woods and the docks across the square's borders, 6.3 light and
fog, 6.4 the map, 6.5 the cellar, and Phase 11, the workshop — this machine's Claude sessions
at their packages' benches. Next: 6.6, more secrets (waits on 7.2 for the night door); the deploy is the
last step (10.1).

## What exists

- `db/schema.lite` — Member (nick, public key, `bannedAt`, `role`), Room (slug,
  name, read refused to a banned member), Message (room, member stamped
  `@createdBy`, body), Session (a Grant: digest, required `expiresAt`,
  `revokedAt`). Read at CREATOR(3); every create but a Message's is the
  system's. A mod (`role = 'mod'`, a nick in `HAVEN_MODS`, `FJS-D998`) bans and
  lifts a ban by an ordinary patch of `bannedAt`, which the row and field
  policies admit a mod to.
- `api/` — `messages`, `rooms`, `members`; a channel per room bound to its row;
  a move is presence meta, a say is `messages.create`; per-member and per-IP
  rate limits, socket bounds in `app.ts`. `POST /haven/login` verifies an
  Ed25519 signature and mints a 30-day session (`FJS-D981`).
- `db/test/schema.test.js` — 15 tests; `api/test/room.test.ts` — 11, over real
  sockets and real logins; `api/test/login.test.ts` — 13.

- `web/` — the square and the tavern, compiled for the terminal by Sierra's
  shell: art, figures from presence, bubbles from the newest line per member,
  an input line that also takes `/ban <nick>` and `/unban <nick>`, and a door
  between them that cycles the socket into the other room. `web/src/lib/session/sign-in.js`
  is this machine's key and signed login, which `fli haven`
  (`packages/cli/commands/haven/walk.md`) runs before the shell.
  `web/test/verify-explore.mjs` — 54 checks over three live terminals, the
  second walking in through `fli haven`, the first a mod, the third walking
  past the first screen's edge.
- A scene bigger than a screen (6.1): the stage's `view` is the 97×26 slice a
  screen draws, following that screen's figure with eight columns and four
  rows of slack; the square is 224 cells wide, with a well, a stall and a
  signpost east of the first screen. A speaker outside the view is their line
  as a marker on the edge facing them.
- Borders (6.2): the square's east edge opens onto the road, its west into
  the woods, and a gap in its hedge south down to the docks — each its own
  scene, route and Room. A border is a `<Door>` run along the edge, and a
  figure crosses at the matching row, beside the run back; any door is come
  out of, not spawned away from. `verify:explore` times the crossing.
- Light and fog (6.3): a figure sees seven rows round itself over floor, a
  palette entry with `light: r` is a source seen from anywhere in the room,
  a cell lit once is remembered dim and one never lit is blank; a figure in
  the dark is not drawn. `litAt()` in `stage.js` is the one answer, and the
  picture and the editor, with no seer, are lit throughout.
- The map (6.4): `/map` over the art, every scene this machine has walked
  into at one glyph per 5×5 cells and `@` on the figure's block; scenes laid
  out from their borders, houses in a row under the streets. Kept on the
  machine — `~/.fli/haven/seen/` or IndexedDB (`#seen`) — and never sent.
  `verify:map` (3 HOMEs, 18 checks) and `web/test/map.test.js`.
- Nameplates: a figure within four columns and two rows of yours wears its full
  nick on the row under it (`Scene.mesa` `plates`); `verify:nameplate`.
- Secrets (6.5): `<Door hidden>` keeps the glyph and paint under it, so a
  cell on the tavern's rug looks like rug and is the way down to the cellar;
  stepping on it is `goto`. The map leaves a hidden door out of a snap.
  `verify:cellar` and the cellar tests in `scenes.test.js`.
- More secrets (6.6): a loose plank in the woods' west fence (hidden) to the
  glade, a scene of its own; and `<Door night>`, a door only at full night
  (`isNight`) and the cell under it by day — the oak's foot in the glade and
  the cellar's west wall are a tunnel of two. Neither is on the map.
  `verify:glade` (a pty by day, one by night, through `clock-at.mjs`) and the
  glade, tunnel and night-door tests in `scenes.test.js`.
- The runner (`Runner.mesa`, `#errand`): walking into the tavern, a boy runs
  in through the door and stops with `(! title)` and the URL over his head;
  drawn on that screen only, delivered once a day. The title is a terminal
  hyperlink (OSC 8, `linked()` in `#cell`) with the URL unprinted; a terminal
  that does not say it has hyperlinks is shown the URL as text instead. The command is
  `HAVEN_ERRAND`, else the one line in `~/.fli/haven/errand` (opt-in, set once;
  neither set, no boy). This machine's file carries the newest unread in
  Basecamp's Hey! menu — `basecamp notifications list --jq` over
  `.data.unreads`, `{ id: "<id>@<unread_at>", title: "N unread · <who> in
  <project>: <title>", url }`, the `@unread_at` so a new reply in a thread
  comes again the same day — else the first todo assigned to you.
  `verify:errand` drives it with a stand-in, env and file;
  `HAVEN_ERRAND_CMD=<command>` drives a real one.
- The same `web/` built for a browser (5.2, `FJS-D985`): `bun run web` on
  5506, the routes unchanged, `#paint`/`#cell`/`#sign-in` resolved to their
  `.browser.js` twins by the package's `imports` conditions; the key kept in
  IndexedDB. `web/test/verify-browser.mjs` — 27 checks, a pty terminal and a
  CDP tab in one room, each read off the other's screen.

## What is not here yet

Nothing is published: a machine with no checkout walks in only through
`verify:fresh`'s registry. Such a machine's default
server is `haven.knightly.dev` (a tunnel to the owner's machine, `bun run
share`, not a deploy), and a checkout's default origin is `localhost:5505`, where `bun run api` listens. There is no logout route: `auth.logout` revokes, but nothing mounts it.
