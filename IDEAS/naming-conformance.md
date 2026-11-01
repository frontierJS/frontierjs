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
- [ ] 0.2 Full list of basecamp enum values to rename, multi-line enums included
- [ ] 0.3 Full list of Boolean fields in both apps, model vs input `type`, with Q1–Q2 applied
- [ ] 0.4 `emailVerified` → `isEmailVerified` in the framework (toolbelt gate, litestone claims) — lands with Phase 1

### Phase 1 — example

Goal: example teaches all four rulings.
Done when: example's own `bun run test` and the drives `fli proves` names for
the change are green, and `fli done` is clear.

- [ ] 1.1 `inventory.service.ts` → `inventory-movements.service.ts` (`inventoryMovements`); `InventoryMovement.mesa` exports `inventoryMovements`; `StocktakeCount`/`StocktakeSheet` export `stocktakeCounts`/`stocktakeSheets`
- [ ] 1.2 Every `createResource('<kebab>')` → camelCase
- [ ] 1.3 Bare Booleans → `is*`/`has*` (schema, seed, services, web), one migration
- [ ] 1.4 `CustomField.type`/`CustomFieldType` → `kind`/`CustomFieldKind`, `Notification.type` → `kind`, `PaymentEvent.kind` label "Kind"

### Phase 2 — basecamp services and models

Goal: every basecamp Resource row derives (`FJS-D1751`).
Done when: basecamp `bun run test`, its `verify:*` drives for the touched
screens, and `fli done` are green; `AuditEvent.subjectType` holds no old name.

- [ ] 2.1 `AlertEvent` → `Alert`; `alerts` splits into `alertRules` (CRUD, snooze, channels) and `alerts` (find, acknowledge, resolve); Resources `AlertRule.mesa`, `Alert.mesa`
- [ ] 2.2 `audit` → `auditEvents`
- [ ] 2.3 Model `FeatureFlag` → `Flag`, `Flag.mesa`
- [ ] 2.4 `cleanup` → `maintenanceRuns`; `cleanup-run.job.ts` → `maintenance-run.job.ts`
- [ ] 2.5 `channels` → `notificationChannels`
- [ ] 2.6 `registry` → `registryImages`
- [ ] 2.7 `posture` → `serverPostures`
- [ ] 2.8 hub `backups` → `hubBackups`, `Backup.mesa` → `HubBackup.mesa`
- [ ] 2.9 One appended migration: table renames (2.1, 2.3) and `AuditEvent.subjectType` rewritten to the new service names

### Phase 3 — basecamp values

Goal: basecamp's schema obeys `FJS-D1748`–`FJS-D1750`.
Done when: as Phase 2, and a dev db migrated forward reads every row.

- [ ] 3.1 Enum values snake → camelCase, with an appended migration rewriting stored values; Outpost wire strings translated where read
- [ ] 3.2 Bare Booleans → `is*`/`has*`
- [ ] 3.3 `Monitor.intervalSec`/`retryIntervalSec` → `intervalSeconds`/`retryIntervalSeconds`

### Phase 4 — mechanical fixes

Goal: the audit's no-ruling findings closed.
Done when: both apps' suites green and `fli done` clear.

- [ ] 4.1 example: `domain/payroll/payrates.ts` → `pay-rates.ts`; `widgets/src/Embeds` → `embeds`; `web/src` imports all `@/`; drives `payroll-sweep.mjs`/`preview.mjs` take `verify-`; stale `OrderPaid.ts` in schema; British spellings in comments
- [ ] 4.2 basecamp: snake log keys (`job_id` …) → camelCase; stored `metadata.outpost_version` → `outpostVersion`; portal config keys `cloud_spend`, `grafana_url` → camelCase; `plugins/push.ts` → `git-push.ts`; `lib/logLines.js` → `log-lines.js`; `jobs/context.ts` and `jobs/outpost-run.ts` out of `jobs/`; `offCentre`; `docs/` filename case; root `test/` → `tests/` (Invariant 3)
- [ ] 4.3 Stray `packages/basecamp/file:/` directory removed (owner confirms)

### Phase 5 — guard

- [ ] 5.1 `fli check` rules per Q3
