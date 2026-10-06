# oracle — Project State

_Verified 2026-10-06 by running the code._

> `CLAUDE.md` is the map: the files, the traps, and what proves a change.
> Read `../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/oracle` 0.0.1, private. It holds the catalog, the checks a model's answer must pass, and the emitter from that answer to `db/schema.lite`, with no model inside (`FJS-D601`). One caller today: `fjs-prototypes/base44`'s prompt-to-app harness.

## Verified state

| | |
| --- | --- |
| Tests | **32 passing, 0 failing** (`bun run test`). Every catalog entry and every per-kind lifecycle is emitted and parsed by litestone. One refusing case per rule. The hiring fixture runs on a real client, and a second tenant reads none of six models |
| Typecheck | clean, no baseline (`bun run typecheck`) |
| The whole catalog as one app | parses, `fli advise` exits 0, `fli db:migrate` applies, the API boots (`@secret` included), and every model seeds. `fli check` reports only `transition-methods` (`FJS-1778`) |
| Corpus | 21 product prompts (base44 Phase 2, `claude-opus-5-5`). **One emitted schema failed to parse in the whole run**: a membership with an optional person under a plain `@@unique`. It is fixed, with a test. All 21 apps settled, booted, and seeded every model. 17 passed the access drive, and the 6 models it read across tenants were declared `public` or `shared` |

## Open

- **The `inferred` check is a word match.** In the corpus it refused 2 of 21 first answers whose "not stated" explained an omission rather than an inference. That cost a turn each. The doctrine words it mechanically (`IDEAS/oracle-reasoning.md` § 8).
- **No soft delete in the contract.** A vault's trash had to be dropped, because a `deletedAt` field without `@@softDelete` is inert and advise says so.
- **Behavior.** Only the `audit` pattern becomes a declaration (`@@log(audit)`).
- **`mockup/`** stays as reference and is not ported.
