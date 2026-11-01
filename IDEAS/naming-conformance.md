---
id: naming-conformance
status: proposed
dated: 2026-10-31
---

# Idea — example and basecamp name things the way a new app should

**Status: PROPOSED.** Probed against the tree 2026-10-31. Do not cite this file
as behavior — see `VERIFYING.md`. Builds `FJS-D1748` (enum values camelCase),
`FJS-D1749` (Booleans `is*`/`has*`), `FJS-D1750` (`Seconds`) and `FJS-D1751`
(Model → service → Resource derive end to end) over the two apps a new FJS app
copies from.

## What the audit found (2026-10-31)

Two read-only passes, one per app, spot-checked. The conventions both apps
already agree on — models PascalCase singular, fields camelCase, kebab service
files with derived names, `PascalCase.notification.ts`, `kebab.job.ts`,
PascalCase components, CLI commands verbatim (`FJS-D403`) — need nothing. Where
they drift, they drift in opposite directions, which is what this plan closes:

- **Enum values**: example camelCase, basecamp snake (`rolled_back`,
  `pending_verification`, `ssh_key`, multi-line `ServerEventKind`).
- **Booleans**: basecamp bare `allowApiKeyAuth allowBotUsers deployOnPush
  emailVerified exposesPort gone headless ignoreTls inUse invert proxied
  published required requireTwoFactorForOwners secret subagent` plus input-type
  fields `connect email inApp ok overwrite`; example bare `active
  cancelAtPeriodEnd counts emailVerified reminded retired show`.
- **Resource rows**: the 11 irregulars `FJS-D1751` lists; example passes the
  kebab alias to `createResource` in about 20 files.
- **Mechanical, no ruling needed**: listed in Phases 3 and 4.

## Open questions

- ~~**Q1** — `emailVerified` is read by `toolbelt/gate` and litestone (`auth()`
  claims). Rename framework-wide or exempt?~~ Answered `FJS-D1752`: rename to
  `isEmailVerified` across the framework and both apps (step 0.4).
- ~~**Q2** — per-channel toggles on a preference input (`email`, `inApp`) name a
  channel, not a predicate. `isEmailOn`/`isInAppOn`, or exempt?~~ Answered
  `FJS-D1753`: a Boolean named for a channel stays bare.
- ~~**Q3** — should `fli check` grade the four rulings?~~ Answered `FJS-D1754`:
  yes, warn-level, after Phases 1–2 so the two apps are the clean baseline.

### Phase 0 — Scope measured

Goal: every name each phase moves is listed before anything moves.
Done when: the lists below are filled.

- [x] 0.1 Rulings `FJS-D1748`–`FJS-D1751` written
- [x] 0.2 Full list of basecamp enum values to rename, multi-line enums included — 49 values in 10 enums, all in `db/schema.lite`; none is an Outpost wire string; exemptions `FJS-D1755`. Step 3.1 needs table rebuilds (the initial migration holds a `CHECK (col IN …)` per enum), the `random_hex_` regex in `apps.service.ts`, a `@@check` and a `@@transitions` entry, and three cli sites (`core/checks/ui.js`, its test, `commands/basecamp/deploy.md`)
- [x] 0.3 Full list of Boolean fields in both apps, model vs input `type`, with Q1–Q2 applied — example 12 stored renames, basecamp 19 stored + 4 input; names fixed by `FJS-D1756`
- [x] 0.4 `emailVerified` → `isEmailVerified` in the framework (toolbelt gate, litestone claims) — lands with Phase 1

### Phase 1 — example

Goal: example teaches all four rulings.
Done when: example's own `bun run test` and the drives `fli proves` names for
the change are green, and `fli done` is clear.

- [x] 1.1 `inventory.service.ts` → `inventory-movements.service.ts` (`inventoryMovements`); `InventoryMovement.mesa` exports `inventoryMovements`; `StocktakeCount`/`StocktakeSheet` export `stocktakeCounts`/`stocktakeSheets`
- [x] 1.2 Every `createResource('<kebab>')` → camelCase
- [x] 1.3 Bare Booleans → `is*`/`has*` (schema, seed, services, web), one migration
- [x] 1.4 `type`/`kind` by `FJS-D1761`: basecamp `Account`/`Workspace`/`Network`/`App` `.type` → `kind` (`*Kind` enums), `Blueprint.appType` → `appKind`; example `PaymentEvent.kind` → `type`, label "Type"; one migration per app

### Phase 2 — basecamp services and models

Goal: every basecamp Resource row derives (`FJS-D1751`).
Done when: basecamp `bun run test`, its `verify:*` drives for the touched
screens, and `fli done` are green; `AuditEvent.subjectType` holds no old name.

- [x] 2.1 `AlertEvent` → `Alert`; `alerts` splits into `alertRules` (CRUD, snooze, channels) and `alerts` (find, acknowledge, resolve); Resources `AlertRule.mesa`, `Alert.mesa`
- [x] 2.2 `audit` → `auditEvents`
- [x] 2.3 Model `FeatureFlag` → `Flag`, `Flag.mesa`
- [x] 2.4 `cleanup` → `maintenanceRuns`; `cleanup-run.job.ts` → `maintenance-run.job.ts`
- [x] 2.5 `channels` → `notificationChannels`
- [x] 2.6 `registry` → `registryImages`
- [x] 2.7 `posture` → `serverPostures`
- [x] 2.8 hub `backups` → `hubBackups`, `Backup.mesa` → `HubBackup.mesa`
- [x] 2.9 One appended migration: table renames (2.1, 2.3) and `AuditEvent.subjectType` rewritten to the new service names

### Phase 3 — basecamp values

Goal: basecamp's schema obeys `FJS-D1748`–`FJS-D1750`.
Done when: as Phase 2, and a dev db migrated forward reads every row.

- [x] 3.1 Enum values snake → camelCase, with an appended migration rewriting stored values; Outpost wire strings translated where read
- [x] 3.2 Bare Booleans → `is*`/`has*`
- [x] 3.3 `Monitor.intervalSec`/`retryIntervalSec` → `intervalSeconds`/`retryIntervalSeconds`

### Phase 4 — mechanical fixes

Goal: the audit's no-ruling findings closed.
Done when: both apps' suites green and `fli done` clear.

- [x] 4.1 example: `domain/payroll/payrates.ts` → `pay-rates.ts`; `widgets/src/Embeds` → `embeds`; `web/src` imports all `@/`; drives `payroll-sweep.mjs`/`preview.mjs` take `verify-`; stale `OrderPaid.ts` in schema; British spellings in comments
- [x] 4.2 basecamp: snake log keys (`job_id` …) → camelCase; stored `metadata.outpost_version` → `outpostVersion`; portal config keys `cloud_spend`, `grafana_url` → camelCase; `plugins/push.ts` → `git-push.ts`; `lib/logLines.js` → `log-lines.js`; `jobs/context.ts` and `jobs/outpost-run.ts` out of `jobs/`; `offCentre`; `docs/` filename case; root `test/` → `tests/` (Invariant 3)
- [x] 4.3 Stray `packages/basecamp/file:/` directory removed (owner confirmed 2026-11-01) — an Oct 28 session's scratch dbs, made by FJS-3802
- [x] 4.4 Framework: `auth.lite` `linked`/`enrollmentOnly`, `orion.lite` `fromCache` → `is*`/`has*` (`FJS-D1756`); litestone `ActorKind.api_key` and orion `FlowCredentialAuth.api_key` → `apiKey` with a migration for stored audit rows (`FJS-D1755`)
- [x] 4.5 sierra's and the cli's widget default `src/Embeds/` → `src/embeds/` (`FJS-D1759`): build default, sierra cli, cli widget surface, scaffold, `make:widget`/`widgets:build` docs, the `ui`/`app` checks

### Phase 5 — guard

- [x] 5.1 `fli check` rules per Q3 — `enum-value-case`, `boolean-prefix`, `duration-unit-spelled`, `resource-export-name`, all warn; a one-row model stays singular (`FJS-D1762`); framework Booleans in deploy.lite and haven moved (`FJS-D1763`). `FJS-D1761` is not graded: `Flag.type` is a closed enum that rightly stays `type`
