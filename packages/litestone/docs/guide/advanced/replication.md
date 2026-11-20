# Replication

`litestone replicate` streams every declared database to S3-compatible storage with Litestream, and `litestone restore` brings it back, to the latest write or to an instant in the retention window.

```lite
model User {
  id    Int    @id
  email String @unique
}
```

```sh
litestone replicate --schema db/schema.lite --url s3://mybucket/myapp
litestone restore --url s3://mybucket/myapp --at 2026-09-27T10:00:00Z
```

The same settings live in `litestone.config.js`, and flags override them:

```js
export default {
  schema: './db/schema.lite',
  replicate: {
    url:             's3://mybucket/myapp',
    syncInterval:    '10s',
    retentionPeriod: '720h',   // 30 days of snapshots
    l0Retention:     '1h',     // the point-in-time window
  },
}
```

The schema says what exists, so each declared database replicates to its own path under the url.

## What else it can do

- `--db main` replicates or restores one database
- Under `strategy database` the tenant files and the registry get their own targets, and a new tenant is picked up without a restart
- `restore` is all or nothing, and refuses files already at a destination without `--force`
- `--at` restores every file to one instant, within the `l0Retention` window
- `--from-backup <dir>` restores from a `litestone backup`, the only way back for `jsonl` and `trail` databases
- `restore --verify <dir>` restores into an empty directory and grades every file against the schema
- Every restored file gets Litestream's integrity check
- `db.$walStatus()` reports the WAL's frames since the last full checkpoint
- `litestone migrate apply --backup` takes a backup before it migrates

**In depth:** [Replication § Setup](../../replication.md#setup), [§ Every declared database](../../replication.md#every-declared-database-one-replica-each), [§ Restoring](../../replication.md#restoring), [§ Proving a copy](../../replication.md#proving-a-copy), [§ Point-in-time restore](../../replication.md#point-in-time-restore), [§ Pre-migration backup](../../replication.md#pre-migration-backup)
