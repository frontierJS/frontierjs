# oracle — Project State

_Verified 2026-10-10 by running the code._

> `CLAUDE.md` is the map: the files, the traps, and what proves a change.
> Read `../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/oracle` 0.0.1, private. It holds the catalog, the checks a model's answer must pass, and the emitter from that answer to `db/schema.lite`, with no model inside (`FJS-D601`). One caller today: `fjs-prototypes/charter`'s prompt-to-app harness.

## Verified state

| | |
| --- | --- |
| Tests | **57 passing, 0 failing** (`bun run test`). Every catalog entry and every per-kind lifecycle is emitted and parsed by litestone. One refusing case per rule. The hiring fixture runs on a real client, and a second tenant reads none of six models |
| Typecheck | clean, no baseline (`bun run typecheck`) |
| The whole catalog as one app | parses, `fli advise` exits 0, `fli db:migrate` applies, the API boots (`@secret` included), and every model seeds. `fli check` reported only `transition-methods`, fixed in the tree as `FJS-1778` |
| Corpus | 21 product prompts (Charter Phase 2, `claude-opus-5-5`). **One emitted schema failed to parse in the whole run**: a membership with an optional person under a plain `@@unique`. It is fixed, with a test. All 21 apps settled, booted, and seeded every model. 17 passed the access drive, and the 6 models it read across tenants were declared `public` or `shared` |

## Open, in fix order

Planned 2026-10-10. **Access defects come before features**, because getting access right is the case Oracle makes against freehand (Charter `PLAN.md` § Q2: no model exposed across tenants by accident, against 24). The rows themselves live in `ISSUES.md`. Steps 1 and 2 run in parallel.

1. **Rulings that block later steps.** Write the options into each question's bullet, then ask the owner.
   - `FJS-D623`: how an answer names which membership role administers a container. Blocks `FJS-1799`.
   - `FJS-D886`: whether onboarding for a container `system` creates lives in an `onRegistered` hook emit writes, or in the scaffold. Blocks `FJS-2530`.
   - `FJS-D683`: what a backfill and a split look like in the operations document. Blocks `FJS-1787`.
2. **Where the finding the person approves and the rule emit writes disagree.** These need no ruling. `FJS-2549` was this class and is closed.
   - `FJS-2552`: the finding says an administrator writes, and the emitted `@@allow` refuses one.
   - `FJS-1881`: a child's `publicWhen` ignores its parent, so an unpublished shop's active listings are public.
   - `FJS-1885`: emit writes `@system` moves on models whose row policy admits no system principal, so the commitment never fires.
   - Do the same pass on the **`inferred` check** ([answer.js](src/answer.js) `GUESS`). It is a word match, and in the corpus it refused 2 of 21 first answers whose "not stated" explained an omission rather than an inference. That cost a turn each (`IDEAS/oracle-reasoning.md` § 8).
3. **The two S2 holes**, once their rulings land.
   - `FJS-1799`: any member re-roles anyone, themselves to admin included.
   - `FJS-2530`: a generated app with a tenant container cannot be entered.
4. **What an answer cannot say yet.** Each coins a word, so run `decision-rules` first.
   - `FJS-2550`: the one-business team shape, where every signed-in staff member writes.
   - `FJS-2551`: a visitor without an account has no actor archetype.
5. **The edit path.** Oracle edits exist only in the prototype: `fjs-prototypes/charter/builder/edit.ts` re-answers and calls `emit(json, { scaffold })`. Its M11 rerun applied 7 of 9 edits on populated apps and lost 0 rows. The 2 it did not apply are renames.
   - `FJS-1787`, after `FJS-D683`: renames, backfills and rows carried into a new model.
   - Then move that route into the framework and join it to `fli intent` (`packages/cli/core/intent.js`). Nothing outside this package imports oracle today.
   - **Done 2026-10-11:** an answer now says `softDelete`, `fts` and `extensible` on an entity and `currency` on the answer. Each emits its litestone word, has a refusing rule, and runs on a real client in `test/oracle.test.js`. The corpus run has not been repeated with them.
6. **Last.**
   - **Shapes as `@@trait`.** Recurring column groups (interval, weekday window, tree) are written out by hand, and the catalog has no shape level yet.
   - **Behavior.** Only the `audit` pattern becomes a declaration (`@@trail(audit)`). The other patterns emit as comments, and hooks, jobs and notifications are not generated.

**`mockup/`** stays as reference and is not ported.
