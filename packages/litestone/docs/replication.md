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
overwrite each other's generations. It is also where `litestone restore` reads
each one back from — § Restoring.

`--db main` replicates one of them.

## Under `tenancy { strategy database }`

A tenant's rows are in `<dir>/<id>.db`, which no `database { }` block names, so
both commands add two targets the tenancy block implies:

```
s3://mybucket/myapp/tenant-files/<id>.db        every *.db in the tenant directory
s3://mybucket/myapp/tenant-registry/<file>.db   the registry that lists them
```

Both are litestream directory entries with `watch` on, so a tenant created after
`replicate` started is picked up without a restart. `litestone backup` writes the
same two names as directories under its destination. `--dir` and `--registry`
override the block, the order the `tenant` commands use. A registry inside the
tenant directory is one of its `*.db` files and gets no target of its own.

Two things the schema cannot name are outside both commands (`FJS-1391`): a
Caravan queue (`jobs.db`, from the app's Junction config) and a storage
adapter's files.

## S3-compatible storage

Litestream reads the AWS environment: `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_ENDPOINT_URL_S3` for anything
that is not AWS — MinIO, SeaweedFS, Garage. Do not put the endpoint in the url:
each database's name is appended to it, and a query string there ends up in
the middle of the path.

**Litestream replicates SQLite.** A `jsonl` or `logger` database is a directory
of append-only files with no WAL, so it cannot be replicated here at all —
`litestone replicate` names any it finds and carries on. Cover those with
`litestone backup` on a schedule, or sync the directory to object storage.

## Restoring

`litestone restore` is `replicate` run backwards: the same targets, read from the
same `<url>/<name>` paths, onto the paths the schema, the tenancy block and
`--dir`/`--registry` resolve to.

```bash
litestone restore --url s3://mybucket/myapp --from-backup ./backups/2026-09-27_0300
litestone restore --at 2026-09-27T10:00:00Z --from-backup ./backups/2026-09-27_0300
litestone restore --force                        # over files that exist — stop the app first
```

**All or nothing.** Every file is fetched beside its destination as
`.<name>.restoring`, and none is moved into place until all of them came back.
It refuses, writing nothing:

- **Files already at a destination**, without `--force`. With it, the old `-wal`,
  `-shm` and litestream's `.<db>-litestream` state go too — a stale WAL beside a
  restored file would be replayed onto it.
- **A `jsonl` or `logger` database without `--from-backup <dir>`.** Litestream never
  streamed it, so its way back is the directory a `litestone backup` wrote.
  `--db <name>` restores one database and leaves the rest deliberately.
- **Any one replica it cannot reach** — a tenant whose files are gone, a url with
  nothing in it.

Under database tenancy the registry comes back first, because it names the
tenants; each tenant it lists is then fetched from `tenant-files/<id>.db`. A file
in the tenant directory the registry does not name is not a tenant, and is not
restored.

**`--at` is one instant for every file.** A database whose last write is earlier
than the instant comes back at its latest — that IS its state at that instant —
because litestream refuses a timestamp past a replica's last write. An instant
before a replica's first write refuses the set. The window is `l0Retention`.

Every restored file gets litestream's `quick` integrity check. Two things it cannot
check for you:

- **The app is not restored — the Data realm is.** A restore does not un-send an
  email, un-run a job, or un-notify a client, and a Caravan queue or a storage
  adapter's files are outside it (`FJS-1391`).
- **A restore nothing has read is a rumor** — § Proving a copy.

## Proving a copy

```bash
litestone restore --verify /tmp/drill --from-backup ./backups/2026-09-27_0300
```

The same all-or-nothing restore, into an empty `<dir>` and never over a live
path, laid out the way `litestone backup` writes. Then every file is graded,
from what the schema says about it rather than from the app's suite, which
arranges its own rows and cannot run on real ones:

- a full `integrity_check` and a `foreign_key_check`
- its tables against the schema's — a tenant file against every SQLite
  database's, since it holds all of them
- every row of every model read through a real client and held to the schema's
  rules, the check `litestone validate` runs

Replica lag — the age of each replica's last write — is reported and never
graded: a tenant nobody has written to since Tuesday has a Tuesday replica.

**Without the key, only when somebody says so.** With `ENCRYPTION_KEY` every
`@encrypted` and `@secret` column is decrypted, and a copy written under another
key fails naming both key ids — the backup nobody can read. Without it those
columns are read around and listed as NOT checked, and the verify runs only if
the operator states it: a terminal is asked, and anything else — a cron line —
is refused unless the command says `--without-key`. A cron environment that
lost the key would otherwise go on passing every night having checked none of
them. A schema with no encrypted column needs no key and asks nothing.

Exit 0 only when everything graded passed; `--json` prints the report. The copy
is removed after a pass and kept after a failure. Nothing schedules it: a cron
line running it is the drill, and the exit code is the alarm.

## Which Litestream

**v0.5 or newer**, and `litestone replicate` refuses anything older rather than
warning.

Litestone emits STRICT tables (strict is the default) and litestream 0.3.x
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

// Backblaze B2, MinIO, SeaweedFS — the endpoint goes in AWS_ENDPOINT_URL_S3
url: 's3://bucket/path'

// Local filesystem (dev/testing)
url: 'file:///backups/myapp'
```

## Backup vs replication

| | `db.$backup()` | Litestream |
|---|---|---|
| Frequency | Manual / scheduled | Continuous (seconds) |
| RPO | Hours (if hourly) | Near-zero |
| Storage | Single SQLite file | WAL segment stream |
| Recovery | Copy file back | `litestone restore` |
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
