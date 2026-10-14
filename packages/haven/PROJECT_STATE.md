# Haven — Project State

**Phases 1 and 2 of `IDEAS/haven.md` are built, and 3.1–3.2.** 1.1 is the schema, 1.2 the
API, 1.3 the signed login, 2.1 the square in a terminal, 2.2 the tavern and its
door, 2.3 `fli haven`, 3.1 the server naming its client, 3.2 the mod standing
and the ban end to end. Next: 3.3, the history pane and retention; the deploy
is the last step (10.1).

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
  between them that cycles the socket into the other room. `web/src/sign-in.js`
  is this machine's key and signed login, which `fli haven`
  (`packages/cli/commands/haven/walk.md`) runs before the shell.
  `web/test/verify-explore.mjs` — 34 checks over two live terminals, the
  second walking in through `fli haven`, the first a mod.
- The same `web/` built for a browser (5.2, `FJS-D985`): `bun run web` on
  5506, the routes unchanged, `#paint`/`#cell`/`#sign-in` resolved to their
  `.browser.js` twins by the package's `imports` conditions; the key kept in
  IndexedDB. `web/test/verify-browser.mjs` — 23 checks, a pty terminal and a
  CDP tab in one room, each read off the other's screen.

## What is not here yet

Nothing is published: a machine with no checkout walks in only through
`verify:fresh`'s registry. There is no hosted Haven, so such a machine must
pass `--api`, and a checkout's default origin is `localhost:5505`, where `bun run api` listens. Arriving through a door
puts a figure on the scene's spawn, not beside the door it came out of. There is no logout route: `auth.logout` revokes, but nothing mounts it.
