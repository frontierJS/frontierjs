---
id: workbench-package
status: proposed
dated: 2026-11-02
---

# Workbench — the developer's own machine as its own private app

**Status: PROPOSED.** Dated 2026-11-02. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

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
  (all ten slots are taken). Workbench takes **5508** API and **5509** web, which
  fills `GLOBAL_RANGE`; a third port means widening the block, a ruling of its own.
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

- [ ] 0.1 Owner commits the atlas, autopilot and stress-loop work now uncommitted across `basecamp` and `cli` — a move on top of a dirty tree is the merge hazard `concurrent-claude-sessions` names.
- [x] 0.2 Rule Q1–Q4 through AskUserQuestion; record them.
  - Ruled 2026-11-03: `FJS-D1785` Workbench, `D1786` Haven's door, `D1787` both keep a shell, `D1788` `packages/workbench`. Two of four against the recommendation (Q2, Q3).
- [ ] 0.3 Probe the seams decision-rules named: `AutopilotReport` writes Basecamp's `Notification` model (Workbench needs its own `@frontierjs/notifications` wiring or a push/ntfy transport only); `git-activity/local.mesa` and `apps/[id]` read the git service; `basecamp.types.ts` and `notify.test.ts`; every `fjs-prototypes` repo linking a basecamp path (22 repos, `link:`).
  - Found so far: `AutopilotReport` is sent through `domain/notification/notify.ts` into Basecamp's `Notification` model; the git service's readers are `git-activity/local.mesa` and `apps/[id]`; `basecamp.types.ts` types the `workbench` claim. The 22 prototype repos are unprobed.
- [ ] 0.4 Reserve 5508/5509 in `packages/cli/core/ports.js` § GLOBAL and `docs/PORTS.md`.

### Phase 1 — The skeleton

Goal: an empty private app that boots.
Done when: `fli dev` in `packages/workbench` preflights, both servers answer, and `/workbench/` renders its empty state.

- [ ] 1.1 `packages/workbench/` — `package.json` (`@frontierjs/workbench`, `"private": true`), `tsconfig.json`, `frontier.config.js`, the three root markdown files, `docs/layout.md`.
- [ ] 1.2 `db/schema.lite` — `ClaudeTranscript`, `ClaudeMessage`, `ClaudeWrite` moved verbatim, plus `Member` and `Session` on Haven's pattern (`FJS-D1786`, no `@frontierjs/auth`); `db/types`, `db/migrations/main/` fresh (nothing has shipped, no upgrade step).
- [ ] 1.3 `api/` — `app.ts` with `createApp` and the `app.own('workbench', …)` claim; `core/env.ts` with `WORKBENCH_DIR` and `CLAUDE_BIN` and no `LOCAL_MACHINE`; the principal read off `Session.tokenHash` under `asSystem()` as Haven's is.
- [ ] 1.4 `web/` — `App.mesa`, `_module.mesa` shell, `lib/nav.js` with the four entries now in basecamp's nav, `config/api-paths.js` derived from `app.snapshot.md`.

### Phase 2 — The move

Goal: every file of the wing lives in Workbench and none of it in Basecamp.
Done when: `bun run test` and `bun run verify` are green in both packages, basecamp's `rg workbench|atlas|domain/claude|local-git` finds only `local-ssh` and the preview endpoint, and the import-direction check is in `fli check`.

- [ ] 2.1 `git mv` the four domains, four services, three jobs, the plugin, the two route trees, four resources, `town.js` and their tests; fix importers; `local-ssh.ts` stays.
- [ ] 2.2 Basecamp subtracts: the four nav entries, the `.screen-body:has(.workbench)` rule in `_module.mesa`, the `app.own('workbench')` claim, `WORKBENCH_DIR`/`CLAUDE_BIN` env keys, `verify:screens` steps that opened the wing, and a NEW migration dropping the three tables (`db/migrations/` is append-only, `FJS-D1605`).
- [ ] 2.3 Regenerate the snapshots both apps carry at their root (`app`, `jobs`, `notifications`, `principal`); `bun run db:types` in both.
- [ ] 2.4 An import-direction check: `packages/basecamp` imports nothing under `packages/workbench` and the reverse; add it beside Invariant 1's enforcement, cite it in `invariants.snapshot.md`.

### Phase 3 — The two seams over the wire

Goal: what crossed by import crosses by a signed call.
Done when: the preview-branch drive makes a preview from a Workbench branch with both APIs running, and the morning report arrives through a transport Workbench owns.

- [ ] 3.1 Preview: the Basecamp half of `workbench-preview.ts` becomes an `apps` method (`preview` — freeze, activate, thaw, retire); Workbench calls it as a peer (`FJS-D1188` signed calls) with the pin's settings.
- [ ] 3.2 `AutopilotReport`: Workbench's own notifications wiring, in-app plus the push/ntfy transport (`IDEAS/phone-ping.md`); the mail channel only if Workbench grows a mailer.

### Phase 4 — The shell and the record

Goal: the desktop shell, the docs and the registers say what the tree says.
Done when: Workbench's own `fli desktop:run` opens it while Basecamp's still opens Basecamp, `fli done` is clear in both packages, and basecamp's `docs/vision.md` § Domain placement is closed by subtraction.

- [ ] 4.1 A `desktop/` surface of Workbench's own (`FJS-D1787`): Basecamp's shell stays and loses the "signed in and scanning" step; `fli desktop:*` runs in either package from its own `desktop/`.
- [ ] 4.2 `docs/PORTS.md`, both `CLAUDE.md` files, `HANDOFF.md`, the memory files naming basecamp paths for the wing; `IDEAS/workbench.md` § Ranked re-pointed at the new package.
- [ ] 4.3 Close vision.md's domain-placement question: Basecamp is Operations, Workbench is the developer's desk; record the ruling.
