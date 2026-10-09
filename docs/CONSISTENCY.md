# Consistency — what a caller can rely on after a write

One row per seam. Each row is a guarantee, the way it fails, the file that keeps it and the test that proves it. The reasoning lives in the comment above the code and in the ruling. This page names where to find them and does not restate them (`FJS-D659`).

**The model in one line:** serializable per database file, revision-checked per row, announced after commit, effects at most once unless they go through the outbox, and a gap on the wire answered by a reload.

## Writes

| Seam | Guarantee | How it fails | Kept by | Proved by |
| --- | --- | --- | --- | --- |
| A transaction | `BEGIN IMMEDIATE` takes the write lock up front. Transactions on one file run one after another (serializable), because SQLite has one writer per file. | A transaction spanning two database files is two transactions. | `litestone/src/core/transaction.js` | `litestone/test/litestone.test.ts` § `$transaction under concurrency`; `second-database-tx.test.ts` for two files |
| Own write, same process | Read-your-writes. One `bun:sqlite` handle and synchronous SQL, so a read inside the callback sees the uncommitted write. | — | `litestone/docs/concurrency.md` | `litestone/test/litestone.test.ts` § `client — transactions` |
| A lost update | A model with `@version` refuses a stale write with `VersionConflictError` (409) and an unversioned one with `VersionRequiredError`. | A write that states no version is not checked: `asSystem()` may leave it out, which a migration does and a job that read first must not, and `updateMany` / `upsert` / `upsertMany` bump without requiring one. | `litestone/src/core/client.js` (`prepareUpdate`) | `litestone/test/litestone.test.ts` § `@version — runtime` |
| The revision a screen sends | `x-version` names the column. The resource sends the revision it READ for that row, never the latest one it heard. | — | `litestone/src/jsonschema.js`, `sierra/src/resource/resource.js` | `sierra/test/resource-version.test.js` |
| Tenants | `strategy database` gives each tenant its own file, so a transaction belongs to one tenant. | Nothing spans two tenants. A cross-tenant write is two writes. | `litestone/docs/multi-tenancy.md` | `litestone/test/tenant-isolation.test.ts` |

## After the commit

| Seam | Guarantee | How it fails | Kept by | Proved by |
| --- | --- | --- | --- | --- |
| The announcement | Held until the OUTERMOST transaction commits (`FJS-D170`). A rolled-back write announces nothing. | — | `junction/src/core/context.ts` (the commit scope), `junction/src/core/service.ts` | `junction/test/commit-scope.test.ts` |
| `ctx.afterCommit(fn)` | Runs once, on the success path only. **At most once.** | A crash between the commit and the callback loses it, with no error. Mail or a third-party call belongs in `ctx.enqueue` ([FJS-2070](../ISSUES.md#fjs-2070) adds a development warning). | `junction/src/core/service.ts` | `junction/test/commit-scope.test.ts` |
| `ctx.enqueue(job, payload)` | An outbox row written in the call's own transaction, delivered by a kick after commit and by a sweep. **At least once.** A handler is made idempotent by the job id, as caravan's `dispatch({ id })` is. | A handler that is not idempotent runs twice after a crash. | `junction/src/plugins/outbox/` | `junction/test/outbox.test.ts`, `outbox-relay.test.ts` |

## Across processes and the wire

| Seam | Guarantee | How it fails | Kept by | Proved by |
| --- | --- | --- | --- | --- |
| A second process, same file | `database main { announce crossProcess }` records each write's id after commit, and the other processes re-read it. At most once, **one machine only**. | A second host sees none of the first host's writes, and nothing reports it. A refusal at boot waits until `outpost` knows the fleet's shape. | `litestone/src/core/cross-process.js` | `litestone/test/cross-process.test.ts` |
| A reconnect | Frames carry no sequence number. A reconnect is a gap: the client emits `reconnected` and a live list refetches, with jitter. | — | `junction/src/client/index.ts` | `junction/test/reconnected.test.ts` |
| An offline write | Queued first, cleared on acknowledgement, keyed so a replay is idempotent. A model with no `@@sync` refuses it (`FJS-D298`). | — | `sierra/src/resource/pending.js` | `sierra/test/pending-queue.test.js`, `sync-policies.test.js` |
| Replicas | Litestream ships the WAL to object storage, for recovery only. Nothing reads from a replica. | A read from a replica would be stale, and none exists to make one. | `litestone/docs/replication.md` | — |

## Words

**Read-your-writes** and **at-most-once / at-least-once** carry their database-literature senses here. **Revision** is the value of the `@version` column that a screen read. `@version` is the name of the attribute. **`sync` is `@@sync`'s word only**, and this page does not use it for replication, announcement or outbox delivery.
