# Replication

Litestone wraps Litestream for continuous WAL replication to S3-compatible storage. Zero data loss with point-in-time recovery.

## Setup

```js
// litestone.config.js
export let config = {
  db: './production.db',
  replicate: {
    url:             's3://mybucket/myapp',
    syncInterval:    '10s',
    retentionPeriod: '720h',    // 30 days
    l0Retention:     '24h',     // time-travel window via PRAGMA litestream_time
  }
}
```

```bash
litestone replicate litestone.config.js
```

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
