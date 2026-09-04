# Replication

Litestone wraps Litestream for continuous WAL replication to S3-compatible storage. Zero data loss with point-in-time recovery.

## Setup

Nothing to configure if you pass the replica url:

```bash
litestone replicate --schema db/schema.lite --url s3://mybucket/myapp
```

Or put it in `litestone.config.js` and run `litestone replicate`:

```js
export default {
  schema: './db/schema.lite',
  replicate: {
    url:             's3://mybucket/myapp',
    syncInterval:    '10s',
    retentionPeriod: '720h',    // 30 days
    l0Retention:     '24h',     // time-travel window via PRAGMA litestream_time
  }
}
```

Flags override the config: `--url`, `--interval`, `--retention`, `--l0`.

## Every declared database, one replica each

The schema is the source of truth for what exists, so `litestone replicate`
reads it the way `litestone backup` does. A schema declaring `main` and
`analytics` replicates both, each to its own path under the url:

```
s3://mybucket/myapp/main
s3://mybucket/myapp/analytics
```

The suffix is not cosmetic — two databases sharing one replica url would
overwrite each other's generations. It is also what a restore names — one invocation per database, by hand; see
§ Restoring:

```bash
litestream restore -o ./main.db s3://mybucket/myapp/main
```

`--db main` replicates one of them.

**Litestream replicates SQLite.** A `jsonl` or `logger` database is a directory
of append-only files with no WAL, so it cannot be replicated here at all —
`litestone replicate` names any it finds and carries on. Cover those with
`litestone backup` on a schedule, or sync the directory to object storage.

## Restoring

**Replication is derived from the schema; restore is not, and you have to type it.**
There is no `litestone restore` — it is filed as `ISSUES.md` `FJS-552`, with what it
should do — so coming back is one litestream invocation per declared SQLite database,
naming the same suffix `replicate` wrote to:

```bash
litestream restore -o ./data/main.db      s3://mybucket/myapp/main
litestream restore -o ./data/analytics.db s3://mybucket/myapp/analytics
```

Then the databases litestream never had. A `jsonl` or `logger` database is a directory,
so its way back is the copy `litestone backup` made:

```bash
cp -r ./backups/2026-04-21_120000/audit ./data/audit
```

Three things to check, because nothing here is checking them for you:

- **Every database, not just `main`.** `litestone backup --db main` and
  `litestone replicate --db main` narrow deliberately; a restore that narrows by
  accident starts an app whose audit trail stops at the disaster.
- **The `-wal` and `-shm` files.** `litestream restore` writes a consistent database
  and needs no help; a restore done by copying files back does — copy the sidecars or
  copy none of them, never one of three. `db.$backup()` already handles this, which is
  the reason to use it over `cp`.
- **The app is not restored — the Data realm is.** A restore does not un-send an
  email, un-run a job, or un-notify a client.

**A restore nothing has read is a rumor.** The cheapest proof available today is to
restore into a temporary directory, point a client at it and run the app's own suite:

```bash
litestream restore -o /tmp/verify/main.db s3://mybucket/myapp/main
DATABASE_URL=/tmp/verify/main.db bun run test
```

Making that one command is the other half of `FJS-552`.

## Which Litestream

**v0.5 or newer**, and `litestone replicate` refuses anything older rather than
warning.

Litestone emits STRICT tables (`@@strict` is on by default) and litestream 0.3.x
bundles a SQLite that cannot parse them. Pointed at a litestone database it
starts, prints `replicating to:`, and then loops forever on

```
sync error: malformed database schema (user) - near "STRICT": syntax error
```

without ever exiting — a live process, an empty replica, and any check that asks
`pgrep` reporting a healthy replica. That is the failure the version guard
exists to prevent. `l0Retention` is also v0.5, and older builds ignore it, so
time-travel would silently not be there either.

`LITESTREAM_BIN=/path/to/litestream` points at a specific build.

Litestream is not vendored, forked or republished, and there is no
`@frontierjs/litestream` — see `DECISIONS.md` `FJS-D31`. Install it from
[litestream.io/install](https://litestream.io/install); Litestone drives the
binary you provide.

## How it works

Litestream continuously streams SQLite's WAL (Write-Ahead Log) to S3/R2/GCS/Azure. Each WAL frame is uploaded as it's checkpointed — typically within seconds.

Litestone sets the required SQLite pragmas automatically:
- `WAL` mode
- `synchronous = NORMAL`
- `busy_timeout = 5000`

## Point-in-time queries

With `l0Retention` set, query the database at any past timestamp:

```sql
PRAGMA litestream_time = '2024-01-15T10:30:00Z';
SELECT * FROM users;
```

The `l0Retention` window determines how far back you can query. Default: `24h`.

## Providers

```js
// Cloudflare R2
url: 'r2://bucket/path'

// AWS S3
url: 's3://bucket/path'

// Backblaze B2
url: 's3://bucket/path?endpoint=s3.us-west-004.backblazeb2.com'

// Local filesystem (dev/testing)
url: 'file:///backups/myapp'
```

## Backup vs replication

| | `db.$backup()` | Litestream |
|---|---|---|
| Frequency | Manual / scheduled | Continuous (seconds) |
| RPO | Hours (if hourly) | Near-zero |
| Storage | Single SQLite file | WAL segment stream |
| Recovery | Copy file back | `litestream restore` |
| Use case | Point-in-time snapshots, pre-migration | Production disaster recovery |

Use both: `db.$backup()` before migrations, Litestream for continuous protection.

## Pre-migration backup

```js
// Always back up before running migrations
await db.$backup(`./backups/pre-migration-${Date.now()}.db`)
await apply(db, './migrations')
```

## WAL status

```js
const status = await db.$walStatus
// → { walSize: 1048576, checkpointCount: 42, ... }
```
