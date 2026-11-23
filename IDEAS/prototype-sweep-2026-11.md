---
id: prototype-sweep-2026-11
status: reading
dated: 2026-11-21
---

# Prototype sweep, 2026-11-21

**Status: READING. A record of one sweep, not behavior and not a plan.** Every repo under `../fjs-prototypes/` was probed against the framework tree and brought up to it where the fix was mechanical. Nothing was committed, deployed or applied to a database; every migration is a file only. The numbers below were true on 2026-11-21; rerun the probe before trusting one. The old → new spellings are `../fjs-prototypes/catalog/UPGRADE-RECIPE.md`.

**The probe, per repo:** `fli check --json`, `bun build api/src/app.ts --target=bun --outdir <scratch>`, `bun run typecheck`, `bun run test`. Tests were not run in `chat`, `ela`, `maidtech`, `thod` or `capture` (live or production data).

## Waiting on the owner

- `FJS-D2339` — one rule for a hand-registered helper in `api/src/routes/`. `sstime` is blocked on it.
- `FJS-D2340` — whether `fli check` names a stale `AUDIT_PATH=./db/audit/` line. Seen in `notion`, `jazzhr`, `personal-starter`, `connectteam`, `linear`, `sstime`, `transit`, `quo`, and likely `saas-starter`, `eventmark`, `lago`.

## Filed

- `FJS-4588` — `serpgrid`: a non-member's `POST /roomMembers` into a private room returns 201. Unconfirmed litestone regression.
- `FJS-4589` — `verifyGateLadder` cannot build a fixture for an either-or column pair (`ghost`, `moodle`).

## Working, with something left

| Repo | Tests | What is left |
| ---- | ----- | ------------ |
| `statuspage` | 6/6 | Model `IncidentUpdate` collides with `Incident`'s generated type (`FJS-D1282`), so `db:types` stops. Rename it; `IncidentPost` was suggested. |
| `charter` | 266/266 | The bundle proof fails on vite's optional `@vitejs/devtools/config`. A lazy import in `host.ts` fixes it. |
| `linear` | 53/53 | 12 check errors in browser drive scripts: hard-coded ports, a hand-rolled Chrome launch. |
| `calendly` | 76 pass, 1 fail | The failure depends on time of day. Port 8400 has no port category. Widget and site fetch `/api/event-types/`, now a 404 (the wire path is camelCase). |
| `ghost`, `moodle` | 5 pass, 1 fail | `FJS-4589`. |
| `notion` | 9 pass, 4 fail | Raw route `/links/redeem` collides with the `links` service; three pins assert `FJS-1752`, `FJS-1754`, `FJS-1755`, since fixed. |
| `saas-starter` | 2 pass, 4 fail | The org-membership schema rewrite is ahead of `gate.ts` and the tests. `drive.ts` stops at signup (`userId` given undefined). Migrations replay to the schema: the catch-up accepts dropping `notification`, which is now the opt-in add-on and was in no db, and `20261123160718_oauth_flow_grant.sql` adds auth's two new columns. |
| `lago` | 220 pass, 6 fail | Six tests pin behavior the framework changed. |
| `serpgrid` | 258 pass, 3 fail | `FJS-4588`, and a file `mime` that comes back `null` in two tests. |
| `connectteam` | 63 pass, 11 fail | Tests use the removed `@@log`, the old audit table, and a `Shift` created already `published`. |
| `transit` | 241 pass, 11 fail | Cross-currency `_sum` (`FJS-2171`), two refused fixture shapes, a chart width, fixtures shared across test files. `happy-dom` is declared but not installed. |
| `sstime` | 16 pass, 8 fail | `FJS-D2339` blocks the test boot. |

## Not moved

- **`ela`, `portal`** pin published tarballs. `portal` uses `heldClaims`, which junction 0.1.11 lacks.
- **`thod`, `capture`, `chat`** are live; each owes a `schema_catchup` migration file and `thod` has 2 typecheck errors.
- **`maidtech`** bundles and typechecks (35 errors → 0). It owes the migration and has drive-script check errors; no test or database command was run.
- **`darkroom`** has one `surface-script` check error.

**Session `userId` → `id` is silent under a cast.** It broke authorization while typecheck stayed clean in `connectteam`, `maidtech`, `transit` and `sstime`. Look for it first in the five repos above.

## Tests rewritten to current behavior

`jazzhr`, `linear`, `chatwoot`, `lago`, `sstime`, `swatchbook`, and several `access.test.ts` files. Read those diffs before committing. No test was deleted or skipped and no check baseline was raised.

