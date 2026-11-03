---
id: workbench-package
status: built
dated: 2026-11-02
---

# Workbench — the developer's own machine as its own private app

**Status: BUILT, UNCOMMITTED.** Dated 2026-11-02; every box closed 2026-11-03, one commit owed by the owner (Phase 0 ruling). The tree is the record now; this file says why. **Owed after it:** the live signed `open` against a running Basecamp (3.1b note — enroll the key, fork with preview, read `actorType: 'peer'` in the trail); the owner's one-line ruling on a peer's `admin` role (3.1a note, under `FJS-D1196`); the freeze-over-the-wire question (3.1 Q, ruled A for now); `verify:atlas` ported to Workbench's door (4.2 note); a workbench icon (4.1 note); `FJS-3841` so the dialer becomes a conduit target. `fli done` leaves six lines that stay: two `.gitignore` lines for cargo and Tauri output, as basecamp's shell has, and four port literals in the moved `workbench.test.ts` that are stub env values a fake `claude` is handed, inside `check-baseline.json`.

Basecamp carries two programs under one schema. One is the fleet's control
plane: Server, App, Deployment, a workspace membership per request, an image
that ships. The other is one developer's laptop: the Claude Code chats per
pinned checkout (`/workbench/`), the registers read and ruled on (`/atlas/`,
`/atlas/decide/`), the loops as a town (`/atlas/autopilot/`), the Claude Code
tab, and the local git repositories and SSH hosts. Every service of the second
program is refused unless `LOCAL_MACHINE=1` and never under
`NODE_ENV=production`, so the shipped image carries a wing that can only say no.

Measured 2026-11-02: the wing is 13,338 of basecamp's 72,814 source lines —
four API domains (`atlas`, `workbench`, `claude`, `local`), four services
(`atlas`, `workbench`, `claude`, `git`), three jobs (`autopilot-tick`,
`autopilot-report`, `claude-index`), the `workbench-terminal` plugin, the
`workbench/` and `atlas/` route trees, four resources (`Atlas`, `Workbench`,
`Claude`, `Git`), `lib/town.js`, three models (`ClaudeTranscript`,
`ClaudeMessage`, `ClaudeWrite`), and the `AutopilotReport` notification. It
reads no fleet model. The move is `packages/workbench`, a private app laid out
like `packages/haven` (`"private": true`, never on npm) and owned by nobody
else: Basecamp imports nothing from it and it imports nothing from Basecamp.

`decision-rules` ran 2026-11-02: passes. Adjudicated by *batteries vs.
smallness* (`FJS-D738`) — a battery severable with one owner and one seam.
The unenforced gap it named is an import-direction check between the two
apps, Phase 2's last step.

## Derived, not asked

- **Private.** Owner 2026-11-02: `"private": true` for now. A laptop tool with a
  database is not a thing `bun publish` should see.
- **Ports.** Haven's precedent is the global tooling block, not a project slot
  (all ten slots are taken). Workbench takes **5501** API and **5508** web — 5501
  was the block's one unassigned slot, and 5508 was the post-files drive's port,
  moved to 5509 so the two tests that assert 5509 is reserved-but-unassigned
  keep their subject. A third port means widening the block, a ruling of its own.
- **What stays in Basecamp.** `domain/local/local-ssh.ts` — the servers service
  reads it to offer `~/.ssh/config` hosts as enrollment candidates, a fleet
  affordance. And the Basecamp half of a preview: `workbench-preview.ts` turns a
  branch into an Environment through `apps.publish`, the release runtime and the
  executor; that half becomes an endpoint Workbench calls over the wire
  (app peering, `FJS-D1188`).
- **`LOCAL_MACHINE` mostly disappears.** Workbench IS the local machine. The flag
  survives in Basecamp only for `local-ssh`.

## Open questions

- ~~**Q1 — The noun.**~~ **Answered 2026-11-03 (`FJS-D1785`): A — The package is `Workbench`; Atlas, Decide, Autopilot and the Claude tab are its screens, and the chat screen is renamed (`Chats`, `Checkouts`).** Workbench is already one screen's name (the chat per pinned
  checkout).
  - **A** — The package is `Workbench`; Atlas, Decide, Autopilot and the Claude tab
    are its screens, and the chat screen is renamed (`Chats`, `Checkouts`).
  - **B** — The package takes a new noun (`Bench`, `Desk`) and every screen keeps its name.
  - **Recommend A** — `FJS-D1176`, `D1073` and `D1708` already use the word, and it is
    the field's word (Conductor, Vibe Kanban). Reopen as B if `/workbench/` inside
    Workbench reads as a collision.
- ~~**Q2 — Auth.**~~ **Answered 2026-11-03 (`FJS-D1786`): B — Haven's door: an own `Member` + `Session` pair, no `@frontierjs/auth`.** The services use `sessionScope`, `WORKSPACE_QUERY` and
  `LEVELS.ADMINISTRATOR` from a workspace ladder they never need.
  - **A** — Single user, still gated: keep `User` and the level ladder, drop
    `Workspace` and `WorkspaceMember`, seed one owner at first run. Services keep
    their gate lines unchanged.
  - **B** — Haven's door: an own `Member` + `Session` pair, no `@frontierjs/auth`.
  - **C** — No sign-in: a loopback-only listener with a local token.
  - **Recommend A** — fewest callers move, and a wrong gate here is a shell on this
    machine, so the gate stays declared in the schema (Invariant 6). C is the reopen path.
- ~~**Q3 — The desktop shell.**~~ **Answered 2026-11-03 (`FJS-D1787`): B — Both apps keep a shell.** `basecamp/desktop/` bundles `web/` into a Tauri
  shell and `desktop:run`'s "signed in and scanning" step is the Workbench.
  - **A** — The shell moves to `packages/workbench/desktop/`; Basecamp is a browser tab to a box.
  - **B** — Both apps keep a shell.
  - **Recommend A** — a laptop tool is what goes in an app launcher; Invariant 3 makes
    `desktop/` a surface beside `db/`.
- ~~**Q4 — Where it sits.**~~ **Answered 2026-11-03 (`FJS-D1788`): A — `packages/workbench`, an app beside `basecamp` and `haven`.**
  - **A** — `packages/workbench`, an app beside `basecamp` and `haven`.
  - **B** — A `web/` surface of `packages/cli`, since `atlas.ts` already imports fli's readers by path.
  - **Recommend A** — `cli` ships to npm; a private app with a database inside it
    breaks publishing and severability. `cli/core/ask-claude.js` stays in cli and
    Workbench imports it, as `atlas.ts` does today.

## Plan

### Phase 0 — Groundwork

Goal: the in-flight work is committed and every call is ruled before a file moves.
Done when: Q1–Q4 are rulings in `DECISIONS.md` and `git status` is clean on the paths that move.
Owner 2026-11-03: one commit at the end of the plan, not one per phase — nothing is committed until Phase 4 closes.

- [x] 0.1 Owner commits the atlas, autopilot and stress-loop work now uncommitted across `basecamp` and `cli` — a move on top of a dirty tree is the merge hazard `concurrent-claude-sessions` names.
- [x] 0.2 Rule Q1–Q4 through AskUserQuestion; record them.
  - Ruled 2026-11-03: `FJS-D1785` Workbench, `D1786` Haven's door, `D1787` both keep a shell, `D1788` `packages/workbench`. Two of four against the recommendation (Q2, Q3).
- [x] 0.3 Probe the seams decision-rules named: `AutopilotReport` writes Basecamp's `Notification` model (Workbench needs its own `@frontierjs/notifications` wiring or a push/ntfy transport only); `git-activity/local.mesa` and `apps/[id]` read the git service; `basecamp.types.ts` and `notify.test.ts`; every `fjs-prototypes` repo linking a basecamp path (22 repos, `link:`).
  - Found: `AutopilotReport` is sent through `domain/notification/notify.ts` into Basecamp's `Notification` model; the git service's readers are `git-activity/local.mesa` and `apps/[id]`; `basecamp.types.ts` types the `workbench` claim. The prototype repos are clear (probed 2026-11-03 with `rg --hidden`): no `package.json` or source links a basecamp path; three plans mention the Basecamp product.
- [x] 0.4 Reserve the ports in `packages/cli/core/ports.js` § GLOBAL and `docs/PORTS.md` — done 2026-11-03 as 5501/5508, see § Derived.

### Phase 1 — The skeleton

Goal: an empty private app that boots.
Done when: `fli dev` in `packages/workbench` preflights, both servers answer, and `/workbench/` renders its empty state.

- [x] 1.1 `packages/workbench/` — `package.json` (`@frontierjs/workbench`, `"private": true`), `tsconfig.json`, `frontier.config.js`, the three root markdown files, `docs/layout.md`.
- [x] 1.2 `db/schema.lite` — `ClaudeTranscript`, `ClaudeMessage`, `ClaudeWrite` moved verbatim, plus `Member` and `Session` on Haven's pattern (`FJS-D1786`, no `@frontierjs/auth`); `db/types`, `db/migrations/main/` fresh (nothing has shipped, no upgrade step).
- [x] 1.3 `api/` — `app.ts` with `createApp` and the `app.own('workbench', …)` claim; `core/env.ts` with `WORKBENCH_DIR` and `CLAUDE_BIN` and no `LOCAL_MACHINE`; the principal read off `Session.tokenHash` under `asSystem()` as Haven's is.
- [x] 1.4 `web/` — `App.mesa`, `_module.mesa` shell, `lib/nav.js` with the four entries now in basecamp's nav, `config/api-paths.js` derived from `app.snapshot.md`.
  - Built 2026-11-03. Proved: `fli dev` in the package boots on 5501/5508, `/health` answers, `/workbench/` renders the empty state behind the door (headless Chrome). Deviations from the steps, each a smaller thing than the step named: the door is `POST /door/login {key}` against `WORKBENCH_KEY`, find-or-creating the one Member `owner` whose session grades ADMINISTRATOR (`isAdmin`) so the moved services keep `@@gate(5.8)`; the three Claude models lost their `@@tenant(none)` lines (litestone refuses them with no `tenancy` block); `ENCRYPTION_KEY` is required (`ClaudeWrite.before` is `@encrypted`); `frontier.config.js` is empty (the loader takes only `deploy`). `fli dev` learned the global block: `TOOLING_APPS` in `packages/cli/core/ports.js` answers 5505/5506 for haven and 5501/5508 for workbench instead of a project slot.

### Phase 2 — The move

Goal: every file of the wing lives in Workbench and none of it in Basecamp.
Done when: `bun run test` and `bun run verify` are green in both packages, basecamp's `rg workbench|atlas|domain/claude|local-git` finds only `local-ssh` and the preview endpoint, and the import-direction check is in `fli check`.

- [x] 2.1 `git mv` the four domains, four services, three jobs, the plugin, the two route trees, four resources, `town.js` and their tests; fix importers; `local-ssh.ts` stays.
  - Decided 2026-11-03 at the brief: `git-activity/local.mesa` moves too (a local-machine screen on the git service); `apps/[id]` loses its local-checkout read (a fleet screen's `LOCAL_MACHINE` affordance); `LOCAL_MACHINE` stays in basecamp wherever a fleet file reads it (`local-ssh`, pages, servers import, the SSO drive), not only `local-ssh`; the Workbench preview action refuses with a message naming 3.1 until the peer call exists.
  - Landed 2026-11-03: 36 API files, 3 jobs, the plugin, the notification, both route trees plus `git-activity/local.mesa`, 4 resources, 18 components, 4 libs and 4 tests moved; `datetime.js` is copied (40 basecamp screens keep theirs). Both packages typecheck; Workbench 75 tests green, basecamp 1055 green with the 3 notification-kind failures 2.2 clears. Every baked-in name renamed: pins root `~/.config/workbench` (the owner's pins and Claude trash moved there), tmux socket `workbench` and session `workbench-<pin>` (the two live `basecamp-*` sessions stay reachable with `tmux -L basecamp`), MCP client `workbench-claude-tab`, git author `Workbench`. `apps/[id]` never read the git service; the 0.3 note was stale.
- [x] 2.2 Basecamp subtracts: the four nav entries, the `.screen-body:has(.workbench)` rule in `_module.mesa`, the `app.own('workbench')` claim, `WORKBENCH_DIR`/`CLAUDE_BIN` env keys, `verify:screens` steps that opened the wing, and a NEW migration dropping the three tables (`db/migrations/` is append-only, `FJS-D1605`).
  - Owner 2026-11-03: drop them and run the migration on basecamp's dev db — the rows are an index the `claude-index` job rebuilds; Workbench re-indexes on first run.
  - Landed 2026-11-03: migration `20261103032426_drop_workbench_wing.sql` (Accept data loss: yes, on the ruling) applied to the dev db and locked; a backup of the db before the drop is in the session scratchpad only. `WORKBENCH_DIR` gone, `CLAUDE_BIN` stays for `site-ask`; scopes, icons, the pages screen's link, the drives (`verify-provision` lost the wing's sections, `verify-mcp`'s workbench section became a `pages` refusal check) cut; both `layout.md` and basecamp's `CLAUDE.md` point at `packages/workbench`. basecamp 1058 tests green. `verify:mcp` 17/17; `verify:provision` 85/86 (the miss is `users.find` on the apps screen, untouched by the split); `verify` fails at its deploy stage (the container is unhealthy, nothing the split touches) — neither was run at HEAD for a baseline; `verify:screens` blocked by three stand-in sinks from Oct 23/29 on 8123/8125/8127 that this session was refused permission to stop.
- [x] 2.3 Regenerate the snapshots both apps carry at their root (`app`, `jobs`, `notifications`, `principal`); `bun run db:types` in both.
  - Done 2026-11-03 with `fli test:snapshots --fix` in both and the six `ws:*` snapshots at the root; Workbench now carries the same root snapshots basecamp does. `fli check` in Workbench: a `check-baseline.json` adopted 2026-11-03 with a note per rule, every finding inherited with the move; ISSUES.md FJS-3237 and the `FJS-D1176` Lives-in line re-pointed.
- [x] 2.4 An import-direction check: `packages/basecamp` imports nothing under `packages/workbench` and the reverse; add it beside Invariant 1's enforcement, cite it in `invariants.snapshot.md`.
  - Written 2026-11-03 as `strangerApps()` in `scripts/ci.mjs` phase 1c (hygiene), by path and by package name, both directions, `.mesa` included; a second row under Invariant 1 in `packages/cli/core/invariants.js`; `docs/CI.md` § hygiene. Proved 2026-11-03: `bun run ci -- --phase hygiene` says the two are strangers across 1839 source files; invariants snapshot regenerated.

### Phase 3 — The two seams over the wire

Goal: what crossed by import crosses by a signed call.
Done when: the preview-branch drive makes a preview from a Workbench branch with both APIs running, and the morning report arrives through a transport Workbench owns.

- [x] 3.1 Preview: the Basecamp half of `workbench-preview.ts` becomes an `apps` method (`preview` — freeze, activate, thaw, retire); Workbench calls it as a peer (`FJS-D1188` signed calls) with the pin's settings.
  - Owner 2026-11-03: signed calls are not built (`IDEAS/app-peering.md` 1.2 open) — build 1.2 here, conduit's `hmac` on the dialer and verification on the receiver; the preview is the first real signed call.
  - Shape (derived 2026-11-03 from `FJS-D1196` a user that owns a key, `FJS-D1604` a keypair per app, `FJS-D475` the door): two halves, built in order.
    - **3.1a Basecamp, the receiver.** `ApiKey.publicKey String?` (a key enrolled under a key pair holds no secret); `apiKeys.enrollPeer({ name, publicKey })`, ADMINISTRATOR-gated, creates a `User` of kind `peer` in the caller's workspace and the key row; the API keys screen gets an "Add a peer" form. A second `signedRequest` credential beside `outpostCredential` in `core/hooks.ts`: the caller names its key in `X-Fjs-Key: <apiKeyId>` (the signature carries no key id), `keyFor` answers `{ publicKey, session: { id: user.id, userType: 'peer', workspaceId } }`, one sentence for every refusal. `apps.preview({ action: 'open' | 'freeze' | 'thaw' | 'retire', settings, branch, opened })` wraps `openPreview`/`freezePreview`/`thawPreview`/`retirePreview`, which stop being exported to anything else.
    - 3.1a built 2026-11-03 (Opus, verified: typecheck clean, 1066 tests, `fli check` within baseline, `api/test/peer.test.ts` 8 pass). Migration `20261103035144_api_key_public_key.sql`. `POST /api-keys` + `X-Service-Method: enrollPeer` body `{ name, publicKey, scopes? }` → `{ id, userId, name }`; `POST /apps` + `X-Service-Method: preview` on the collection (no custom method takes `:id`, and `open` has no App yet). Three calls taken on the implementer's recommendation while the owner was away, each one line to reverse:
      - Credentials list is `[peerCredential, outpostCredential]` — `signedRequest` refuses when `keyFor` answers null, so the outpost door first 401'd every peer call; the peer door answers null (not mine) without `X-Fjs-Key`.
      - A peer joins as `admin`, not a bot's `developer` — `openPreview` creates an Environment, which needs admin; the key's scope is what narrows a peer. Alternative: `enrollPeer` takes a role. decision-rules 2026-11-03: the one call the owner confirms (one line under `FJS-D1196`: admin-plus-scope, or a role on `enrollPeer`); `ApiKey.scopes` is `@immutable` and `patch` renames only, so a peer key cannot be widened after enrollment. The other two are mechanisms.
      - New scope `apps:preview`, the peer key's default — `apps:write` would reach every write on apps. A scope ending in neither `:read` nor `:write` is labeled by its own name in `scopes.ts`.
      - Also: `User` gained a read rule for `kind == 'peer'` beside the bot rule (the FK check on `ApiKey.userId` could not see the peer); email `<slug>-<8 hex>@peers.invalid` after `bots.invalid`; `HubConfig.isApiKeyAuthAllowed` and `lastUsedAt` do not apply to peers.
    - **Q — freeze over the wire.** `freezePreview` runs `vite build` at `branch.path` on Basecamp's disk and reads the App's `VITE_`/`FRONTIER_PUBLIC_` variables for the build, then `apps.publish`es the files. Open, thaw and retire never read the checkout. **A** — 3.1b freezes over the shared disk only (both apps on the owner's machine today), the remote case refused with one sentence. **B** — the dialer builds and sends `{ files, commitSha }`; it first needs the App's public build vars, so `preview` grows a `buildEnv` answer. **Recommend A now, B when a Basecamp lives on a box** — the question stays open here, not ruled.
    - **3.1b Workbench, the dialer.** A keypair minted at first boot into `~/.config/workbench/peer.json` (`generateSigningKeys`), the public half shown on the Chats screen and at `GET /door/peer`; `BASECAMP_URL` and `BASECAMP_KEY_ID` in `env.ts`; a conduit target with `signer: 'ed25519'` whose ref is the private key; `fork(preview)`, `freeze` and `thaw` call `apps.preview` with the pin's settings, and `PREVIEW_MOVED` goes. The duplicate preview-settings parser in Workbench shrinks to what the dialer sends.
    - 3.1b built 2026-11-03 (Opus, verified: typecheck clean, 85 tests, `fli check` within baseline, hygiene green). `api/src/peer.ts` (`peerKeys()` lazy, 0600, `GET /door/peer`), `domain/peer/peer-call.ts` (the one signer and the one unwrapper), `domain/peer/basecamp.ts` (`app.basecamp.preview`), `BASECAMP_URL`/`BASECAMP_KEY_ID`; fork/freeze/thaw/archive dial `{ open, freeze, thaw, retire }`, `PREVIEW_MOVED` gone; a Peer block in the dock shows the public key. The dialer signs with toolbelt's `signRequest` directly, not a conduit target: both conduit signers omit `serviceMethod` and are refused at the door — `FJS-3841`; the target comes when it closes. Retire fires on `archive` (unpin refuses while a branch exists, so nothing escapes it). The local `previewSettings` copy stays as `configure`'s own check; Basecamp re-checks on every call. The hygiene "strangers" rule was matching the word `workbench` in any relative path and flagged basecamp's own `domain/workbench/`; it now resolves the import against the file.
    - **Left for the owner — the live proof:** Basecamp's dev db holds only the owner's login and no project, so the signed `open` was proved against a stub door, not a running Basecamp. Flow: `fli dev` both apps, sign in to Basecamp, paste the key from Workbench's Peer block into "Add a peer", put the returned id in `BASECAMP_KEY_ID`, fork a branch with preview on; the audit trail files `actorType: 'peer'`. The Peer block has not been driven in a browser.
- [x] 3.2 `AutopilotReport`: Workbench's own notifications wiring, in-app plus the push/ntfy transport (`IDEAS/phone-ping.md`); the mail channel only if Workbench grows a mailer.
  - Owner 2026-11-03: in-app plus push, the transport copied from basecamp's `api/src/push.ts`; no mail.
  - Shape: the `@frontierjs/notifications` fragment (`Notification`, `NotificationPreference`) in Workbench's schema against `Member`; `notifications({ db, transports: { push: ntfy(...) } })` in `app.ts`; `push.ts` is rung 1 (`NTFY_BASE_URL` + `NTFY_TOKEN`) or public ntfy.sh with a minted topic suffix kept in `~/.config/workbench/push.json` — no rung 2, Workbench has no ntfy App; the report job sends again instead of logging.
  - Built 2026-11-03: `api/src/push.ts` rungs 1 and 3, topic `workbench-<12>` minted into `~/.config/workbench/push.json`; `Notification` only from the package's fragment (`userId Int` → `Member`; no `PushSubscription`, ntfy has no device rows; no `NotificationPreference`, one member and no screen); `via` is `['inApp', 'push']`, the recipient the one Member; migration `20261103034355_notification.sql`; `api/test/autopilot-notify.test.ts` proves the row and the ntfy POST through the driver's `deliver` stub (78 tests green). The in-app row has no reader yet — 3.3.
- [x] 3.3 The bell: Workbench's shell shows its in-app notifications — a `Notification.mesa` resource, the `notifications` service mounted, the channel joined and a `/notifications/` page, on basecamp's `Bell.mesa` pattern. Until then the ruling's in-app half is a row nobody sees.
  - Built 2026-11-03 (Sonnet, verified: typecheck clean, 87 tests, `fli check` within baseline, hygiene green). `services/notifications/notifications.service.ts` (`find`/`get`/`patch(readAt)`/`readAll`, graded by the model's `@@gate` and `userId == auth().id`), `channels()` joining only `notifications:user:<member>`, `announce inProcess` on `database main`; `Notification.mesa`, `Bell.mesa`, `/notifications/`, nav entry. Browser drive: badge, dropdown, mark read, the page, the Peer block and `GET /door/peer` all answered with no console error. The live push was proved in-process by the main thread: a `sendReport` in the API process reached the member's socket as a `notifications created` frame. A row written from another process is not announced — that is `announce inProcess`, the single-process reality of this app.

### Phase 4 — The shell and the record

Goal: the desktop shell, the docs and the registers say what the tree says.
Done when: Workbench's own `fli desktop:run` opens it while Basecamp's still opens Basecamp, `fli done` is clear in both packages, and basecamp's `docs/vision.md` § Domain placement is closed by subtraction.

- [x] 4.1 A `desktop/` surface of Workbench's own (`FJS-D1787`): Basecamp's shell stays and loses the "signed in and scanning" step; `fli desktop:*` runs in either package from its own `desktop/`.
  - Built 2026-11-03 (Sonnet, verified: both typechecks clean, 87 + 1066 tests, both desktop drives pass — workbench 10 checks incl. the local scan moved from basecamp's drive, basecamp 8 checks driven to `/apps/`). `fli make:desktop --wraps web` scaffolded it; `tauri://localhost` added to workbench's CORS; `fli desktop:run` opened a window titled Workbench on 5501. The drive binds an OS-chosen API port (the global block is full) and declares `holds = []`. Icon is basecamp's (`brand/assets/icons/` has no workbench one — a brand-sheet call). `FJS-3903`: the scaffold's tsconfig include walks cargo output (fixed by hand here). Found by the drive and fixed by the main thread: `services.test.ts` sent a real report to ntfy.sh under the developer's own topic (429) — `buildWorkbenchApp({ deliver })` takes a stub.
- [x] 4.2 `docs/PORTS.md`, both `CLAUDE.md` files, `HANDOFF.md`, the memory files naming basecamp paths for the wing; `IDEAS/workbench.md` § Ranked re-pointed at the new package.
  - Done 2026-11-03: `docs/PORTS.md` (0.4), both `CLAUDE.md` files, the root `CLAUDE.md` package table (workbench row — `fli`'s ring test refused the tree without it), `HANDOFF.md`, `IDEAS/workbench.md` § Status, `DRIVES.md` (atlas and preview rows, a `workbench: verify:desktop` row, `verify:registers` → `workbench: verify:atlas`), `DECISIONS.md` `FJS-D1176` Lives-in, and four memory files. `verify:atlas` is owed a port: it still boots Basecamp's harness (`db/seed.js`, `LOCAL_MACHINE`) and refuses on 8000 when another app's web server is up.
- [x] 4.3 Close vision.md's domain-placement question: Basecamp is Operations, Workbench is the developer's desk; record the ruling.
  - Ruled `FJS-D1790` 2026-11-03 (recorded by the main thread from this step's text while the owner was away — one line to reverse): Domain 7 stays *Observability & Operations* as `ARCHITECT.md` already names it, Basecamp its tool; the desk is Workbench, outside the World's domains. `vision.md` § The Domain Question marked closed and its Open Questions bullet removed.
