# conduit-mattermost — package map

`src/index.ts` `mattermostTargets`, `bindMattermost`, `postMessage`, the backfill reads · `src/mirror.ts` the claim: rows, keys, verbs per model (`FJS-D1125`) · `src/receive.ts` the two Dialects, `verifyMattermostToken`, `respond` (`FJS-D899`) · `src/socket.ts` the socket target, `mattermostFraming`, `mattermostSocketDialect` (`FJS-D1127`) · `src/errors.ts` `translate` · `src/types.ts` Mattermost's shapes · `sink.ts` · `test/mattermost.drive.ts`.

## What bites

- **`as` is whose token every call spends.** A bundle bound `as: 'service'` posts as the bot and nothing refuses it; a human verb binds `as: 'user'`, and the plugin writes `who` from the call in progress. Standalone, the caller states `who` — the drive binds each person over a conduit that names them. Only `upload` refuses the bot.
- **`PUT /posts/{id}` replaces the post** and blanks an omitted `message`; every update here is `/patch`.
- **A 403 is `forbidden`, not a bad key.** Conduit grades it `auth_failed`; reminting changes nothing. `translate` reads the status.
- **A 429 carries no `Retry-After`.** The wait is `X-Ratelimit-Reset` in seconds, read by `translate` from `meta.headers`.
- **`pending_post_id` is the only key** and it is the caller's; a key minted here guards nothing. The window is 30 s.
- **`threadModel.parse` needs `scope.profileExternalId`** — a thread is one user's view and the body never carries the user.
- **Mattermost's user is the claim's `Profile`, never `User`** (`FJS-D1152`) — `User` is every auth app's `@@auth` model, so a claim keyed `User` collides out of the box. A row naming one holds `profileExternalId`.
- **A direct or group channel has `team_id: ''`**, which `parse` lands as `null`; an empty string would be a key naming no team.
- **Times are ms epochs and 0 is never.** `at()` turns 0 into `null`; a row with `deletedAt: null` is live.
- **Reads with `since` include deletions** (`delete_at` set); reads without exclude them. The backfill wants the first.
- **A receiver's `credential` must not choose the key by the token.** A hook's key is chosen by `trigger_word`, a command's by `command`; a function that looks the token up by itself verifies every forgery.
- **A command's reply is not the answer body.** Conduit answers `{ received, outcome }`; `apply` sends the reply through `respond()` to `response_url` (five inside 30 minutes). A webhook's reply is `postMessage()` as the bot with `rootExternalId`.
- **Junction's form parser hands a numeric field back as a number** (`timestamp`, a `text` of `123`); the dialect reads every field through `String()`.
- **A command configured as GET reaches no route** — conduit mounts `app.post`.
- **A socket frame is keyed by connection AND `seq`.** `seq` restarts per connection; `socket:<seq>` alone loses the first post after a redial as a duplicate (the drive's negative control).
- **The socket redelivers nothing.** A frame whose `apply` throws, and every frame sent while the connection was down, comes back only through the `listPosts({ since })` backfill.
- **A quiet socket and a dead one look the same.** Mattermost pushes nothing to an idle person, so the framing's `keepalive` sends the `ping` action (answered `seq_reply` + `text: 'pong'`) and conduit cuts a connection silent for 60 s. A reply has no `event`; without `pong` naming it, every ping counts as `dropped`. The sink's `{ silenceSocket: id }` is that dead link.
- **A skip in `seq` is lost frames, not a new connection.** The framing's `sequence` answers each frame's `seq` and conduit calls the receiver's `gap` when one connection's jumps; a new connection starts afresh. The sink's `{ skipSeq: n }` makes the jump.
- **`data.post` and `data.channel` are JSON strings inside the frame**, not objects.

## Proving a change

`bun run drive` — 56 rows against the sink; no fixture. The `mirror.forward*` rows bind the claim with `conduit.mirror(mirror)` and wrap `send` to write `who`, as the junction plugin does. The drive's `bridge` is the junction plugin's `app.post(receiver.path)` without junction: request → `Delivery` → `conduit.accept()`. Typecheck from the connectors root with frontierjs's tsc: `../../../frontierjs/node_modules/.bin/tsc -p tsconfig.json --noEmit --typeRoots ../../../frontierjs/node_modules` (never `bunx tsc` here — `AGENT_BRIEF.md`).
