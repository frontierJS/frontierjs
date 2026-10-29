---
id: basecamp-dogfood
status: proposed
dated: 2026-10-28
---

# Basecamp dogfood — the last schema rewrite, then append-only

Basecamp runs the FrontierJS fleet, and the team wants to run it for real while still breaking it. The two pull against each other at exactly one place: the database. Code and API churn stay free under the evolution policy; a committed migration a dogfood database has applied cannot (`FJS-D1605`). So the order is: settle every structural question that is cheap now and a migration later, land them as the last in-place rewrite of `initial_schema.sql`, flip to append-only, then install.

Backup-and-reimport was priced first and is not a way around this: `archive-manifest.ts` refuses an archive whose applied migration reads `modified`, on purpose.

Rulings this paper asked for: `FJS-D1603` (hub is an App row), `FJS-D1604` (Ed25519 per app), `FJS-D873` (two trails), `FJS-D1438` (runtime columns), `FJS-D1605`–`FJS-D1611`, and the amendment under `FJS-D1198`.

### Phase 0 — Settle what is cheap now

Goal: every schema- or identity-shaped question in the Basecamp registers ruled or deferred by name.
Done when: `fli register:check` passes with the rulings in `DECISIONS.md` and no open question here is schema-shaped.

- [x] 0.1 Append-only migrations from the first dogfood database — `FJS-D1605`
- [x] 0.2 Review IDEAS, DECISIONS and ISSUES for overarching Basecamp changes; rank them
- [x] 0.3 Q2 — align `User` to `FJS-D1198` fully (amendment under it)
- [x] 0.4 Q4 — two audit trails, writer as a junction plugin — `FJS-D873`
- [x] 0.5 Q5 — the hub is an App row, `HubConfig.appId` — `FJS-D1603`
- [x] 0.6 Q6 — Ed25519 keypair per app; Outpost hard switch — `FJS-D1604`
- [x] 0.7 Q7 — `ProviderKind` split by role — `FJS-D1607`
- [x] 0.8 Q8 — `Backup` merges into `AppBackup`; installer's workspace owns the hub App — `FJS-D1606`
- [x] 0.9 Q10 — the four small fixes — `FJS-D1608`–`FJS-D1611`
- [x] 0.10 Q11 — runtime columns stay in `runtime.ts`, pinned by a test — `FJS-D1438`
- [x] 0.11 Q1 — Account tier: **A**, finish it (`FJS-D1618`)
- [x] 0.12 Q3 — the machine noun: `Server` + *Hub*; `Workspace` not renamed `Space` (`FJS-D1619`)

### Phase 1 — The schema pass

Goal: every Phase 0 ruling lands in `db/schema.lite` and the one rewritten `initial_schema.sql`.
Done when: `fli db:check`, `fli db:types`, the seed and `packages/basecamp/db/test` are green on a fresh database, and `app.snapshot.md` is regenerated.

- [x] 1.1 `User` per `FJS-D1198`: `UserKind { user bot peer }`, `kind @system @immutable`, drop `role` and `scopes`; `/hub/users` count loses its `ai` bucket
- [ ] 1.2 Hub as App (`FJS-D1603`): `HubConfig.appId` relation, drop `hostServerId`; `App.isHub`-free — the pointer is the flag
- [ ] 1.3 `Backup` → `AppBackup` (`FJS-D1606`): drop `Backup`, drop the five restated columns on `HubConfig`, align `BackupKind`/`DrillKind`
- [x] 1.4 `ProviderKind` split (`FJS-D1607`): `ComputeProvider` on `Server`, the two `@@check`s go, `fleetByProvider.providerKind` typed `ComputeProvider`
- [x] 1.5 The ruled-and-unbuilt six, as one pass (Q9): demo workspace `FJS-D1537`, `MaintenanceRun` `FJS-D825`, ~~`readAt @scoped` `FJS-D1238`~~ (no column: notice acknowledgements stay in `web/src/lib/dismissals.js`, localStorage), `Secret.verifiedAt` + `verifyError` (`IDEAS/workspace-onboarding.md` 1.1, schema half; the refusal-clears rule and its test row stay there), `Domain.certKind` enum (landed in 1.6), `DashboardTile` `FJS-1896`
- [x] 1.6 Q10: `Invitation.token @hashed`; drop `Deployment.environmentId` and `Job.environmentId`; `Workspace.ownerId` relation; the Strings → enums list in `FJS-D1611` (values under it; `Account.status` moves to 1.7)
- [x] 1.7 Q1's answer (`FJS-D1618`): `Account` finished — `AccountStatus { active suspended }`, default `active`; the false *auth owns this* comment goes
- [ ] 1.8 Rewrite `initial_schema.sql` in place for the last time; `db:check`, `db:types`, seed, `db/test` green; `app.snapshot.md` regenerated

### Phase 2 — The code halves

Goal: every service reads the new shapes; nothing reads a dropped column.
Done when: `packages/basecamp/api/test` and the web build are green, and `fli ws:surface` names no dropped export.

- [ ] 2.1 `useHost` creates the hub App row in the installer's workspace and points `HubConfig.appId` at it; posture `hub.app-row-drift`; Release on the hub refused; `/hub/` settings read the row and the app lists hide it — closes `FJS-3515`
- [ ] 2.2 Backup services over `AppBackup`: hub archive, restore (`IDEAS/backups.md` 4.3) and `archive-manifest.ts` — closes `FJS-3563`
- [ ] 2.3 Audit writer moves to a junction plugin handed `AuditEvent` (`FJS-D873`); `hooks.ts` `recordable()` shrinks to the call
- [ ] 2.4 Outpost enrollment: `Server.enrollTokenHash` then per-app Ed25519 (`FJS-D1604`); `keyFor` returns `{ publicKey }` through junction's `credentials.ts` owner
- [ ] 2.5 `RUNTIME_COLUMNS` test pins the list against the schema (`FJS-D1438`); `ComputeProvider ⊂ ProviderKind` test (`FJS-D1607`)
- [ ] 2.6 Readers of `environmentId`, `User.role`, `User.scopes`, `Backup` and `HubConfig`'s dropped columns move; `fli ws:surface` clean

### Phase 3 — Cutover

Goal: the migration folder is frozen and something fails when it is touched.
Done when: `bun run ci --phase snapshots` fails on an edited `initial_schema.sql` and passes on an appended one.

- [ ] 3.1 `snapshots`-phase check hashes `db/migrations/**` against a committed snapshot; `fli ws:*` generator writes it
- [ ] 3.2 `packages/basecamp/PROJECT_STATE.md` gets the dated sentence: migrations append-only from this date; `CLAUDE.md` trap line: `db:push` on dev, `db:migrate <label>` to land
- [ ] 3.3 Dogfood deploy runs `migrate apply` before boot (`IDEAS/zero-to-live.md` deploy path)

### Phase 4 — Dogfood

Goal: Basecamp runs the team's own fleet from a real box.
Done when: the hub App row has a successful `AppBackup` and a restore drill passes on the dogfood database.

- [ ] 4.1 Install on the real box (`IDEAS/zero-to-live.md` Phase 0 droplet, `IDEAS/hetzner-host.md`)
- [ ] 4.2 First backup and drill (`IDEAS/backups.md` Phase 5)
- [ ] 4.3 First append migration on the dogfood database, as proof the path works

## Open questions

- ~~Q1 — What an Account is.~~ Ruled `FJS-D1618`.
- ~~Q3 — The machine noun.~~ Ruled `FJS-D1619`.
- ~~Q2 — align `User` to `FJS-D1198` fully, or keep Basecamp's `ai`?~~ Ruled: amendment under `FJS-D1198`.
- ~~Q4 — one audit trail or two?~~ Ruled `FJS-D873`.
- ~~Q5 — how the hub is a row.~~ Ruled `FJS-D1603`.
- ~~Q6 — HMAC or keypair per app; Outpost transition?~~ Ruled `FJS-D1604`.
- ~~Q7 — one `ProviderKind` with checks, or split by role?~~ Ruled `FJS-D1607`.
- ~~Q8 — `Backup` and `AppBackup`; who reads a hub archive?~~ Ruled `FJS-D1606`.
- ~~Q9 — the six ruled-and-unbuilt items: one pass or as they come?~~ One pass, step 1.5.
- ~~Q10 — the four small fixes.~~ Ruled `FJS-D1608`–`FJS-D1611`.
- ~~Q11 — where the runtime column list lives.~~ Ruled `FJS-D1438`.
