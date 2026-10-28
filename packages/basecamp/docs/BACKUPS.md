# Backups — the operator's recipe

How a Basecamp hub and every app it runs get their archives off the machine,
with Backblaze B2 as the worked example and the recommended default
(`FJS-D1506`); Cloudflare R2 is the runner-up. Any S3-compatible bucket works the
same way: the hub speaks SigV4 through `@frontierjs/conduit`'s `storage:s3` target
and nothing here is B2-specific but the console steps and the prices.

What is archived and why `VACUUM INTO` rather than a file copy is the header of
`api/src/jobs/backup-run.job.ts`; the app half is `app-backup-run.job.ts`. This
page is only what a person does.

## 1. The bucket

1. Make a **private** bucket. Its name is what the form calls *Bucket*.
2. In the bucket's **Lifecycle Settings** choose *Keep only the last version of
   the file*. Retention is Basecamp's job (§ 4); a bucket that keeps every
   version keeps every pruned archive too, and the storage bill grows while the
   screen says seven.
3. Read the bucket's **Endpoint** off the console: `s3.us-west-004.backblazeb2.com`
   or similar. The form's *Endpoint URL* is `https://` plus that host, with **no
   bucket in it**. The *Region* is the middle of the host, `us-west-004` here.
   A B2 account lives in one region and the endpoint must match it
   ([Backblaze docs](https://www.backblaze.com/docs/cloud-storage-get-started-with-a-backblaze-integration)).

## 2. The key

Make an **application key restricted to that bucket**, never the master key
(the S3 API refuses it). Capabilities: `listBuckets`, `listFiles`, `readFiles`,
`writeFiles`, `deleteFiles`. Leave *File name prefix* empty, or set it to the
destination's *Prefix* plus a slash: archives land at `<prefix>/<name>`, so a
destination prefix `backups` needs a key prefix `backups/`. The console shows the
`keyID` and the `applicationKey` once.

The form's *Credential* is the two joined by a colon:

```
<keyID>:<applicationKey>
```

It is lifted into an `@encrypted` `Secret` row on save and never read back
onto a screen. If you lose it, make a new key and paste it again.

## 3. The destination, on `/hub/settings/`

In the *Scheduled backup* card press *Add a bucket* and fill *Name*, *Endpoint URL*,
*Region*, *Bucket*, *Prefix* and *Credential*, then *Add bucket*. Saving runs
the probe at once: a PUT and a DELETE of one key under the prefix, with the
stored key — the path the schedule takes. The answer is the alert under the
card; a failure is said in words, the connector's failure kind first and the
vendor's S3 `<Code>` after it:

| It says | Do |
| --- | --- |
| `forbidden` | the key lacks one of the five capabilities, or its prefix does not match |
| `auth_failed` | the credential is not `keyID:applicationKey`, or the key was deleted |
| `missing` | the bucket name is wrong, or it sits in another region than the endpoint |
| `clock_skew` | the hub's clock is more than fifteen minutes out; fix the clock, not the key |
| `refused` | the bucket answered with something else; the vendor's `<Code>` in the message is what its docs name |
| `connection_failed`, `timeout` | the endpoint host is wrong or unreachable from the hub |

*Test bucket*, beside *Add a bucket* once a destination is picked, reruns the
probe later; *Last tested* is stamped only when both calls answered, and a
pass marks the credential's `Secret` verified. A failed DELETE says the probe
key is still in the bucket.

Then under *Scheduled backup* pick the *Destination*, turn *Take a scheduled backup*
on, and set its cron (`0 2 * * *` by default). An app's schedule is the
`backupCron` and `backupDestinationId` columns on its `App` row, written
through the `apps` service; a release of an app with a volume also takes an
archive before the swap, to the same destination.

## 4. Retention

Two counts and two optional ages on the hub settings, local and remote apart:
keep the last N on the disk and the last M in the bucket, or anything younger
than a number of days. Pruning runs after each successful backup and reads the
bucket as it is, so an archive the hub stopped pointing at is still pruned. An
upload the hub never saw land is left alone.

## 5. What `location` means

A `Backup` or `AppBackup` row's `location` is the **object key** when the
upload landed — `<prefix>/basecamp-<stamp>.tar.gz` for the hub,
`<prefix>/<appId>-<stamp>.tar.gz` for an app — and a **path on the machine** when there was no destination or
the upload was refused. A refused upload still finishes `success`, with the
reason in `error`: the archive exists, it is only on the disk it was meant to
leave. Read the row, not the status, before trusting that a machine can burn.

*Download* on `/hub/backups/` fetches either kind as
`basecamp-<stamp>.tar.gz`: a remote one by a pre-signed GET straight from the
bucket, a local one through the hub by a link that lasts five minutes.

The hub holds a whole archive in memory to send it; above 1 GiB the job refuses
rather than discovering the limit in the heap.

## 6. The encryption key

An archive of `@encrypted` columns is unreadable without the hub's
`ENCRYPTION_KEY`. Keep a copy of it somewhere that is not the hub's disk, then
press *Attest* on `/hub/backups/`: the hub records when and the key's digest,
and `hub.key-escrowed` on `/hub/security/` goes green. It is a person's word,
not a check. The development placeholder is refused, because a copy of a public
key protects nothing.

## 7. Restore

Run a restore once, on a scratch box, before you need it.

### The hub, from `/setup`

On a new box with Basecamp installed and the old `ENCRYPTION_KEY`, before
anyone signs up, open `/setup` and its *Restore a hub* tab. Either:

- fill the bucket — *Endpoint*, *Region*, *Bucket*, *Prefix* as § 1 and § 3,
  *Key* as `keyID:applicationKey` (§ 2) — press *List archives*, then *Restore
  this* beside the archive you want; or
- take a `basecamp-<stamp>.tar.gz` that *Download* on `/hub/backups/` saved
  (§ 5) and press *Restore from file*. Bun refuses an upload over 128 MB, so a
  larger archive comes from the bucket.

On a box with no browser, `HUB_RESTORE_ENDPOINT`, `HUB_RESTORE_REGION`,
`HUB_RESTORE_BUCKET`, `HUB_RESTORE_PREFIX` and `HUB_RESTORE_KEY` fill the form;
the key is only reported as set, and nothing stores it.

The archive is checked before a file is touched. One taken under another
`ENCRYPTION_KEY`, one with a damaged file, and one this version cannot carry on
from (taken by a newer Basecamp, or by one whose migrations were rewritten
since) is refused with its reason and nothing staged. A checked archive waits
in `restore-staged/` beside the database, and the page says *staged*.

**Restart Basecamp.** The next boot puts the archive in place before anything
opens a database, and the page notices by itself: *Restored from the archive
taken …*, and an account the old hub had signs in. A restart that finds an
account already there leaves the staged directory where it is and says so on
`/setup`; remove it, or restore by hand below.

After it:

- The staged directory is renamed `restore-done-<stamp>/`. Delete it once the
  hub is right; it is a second copy of every secret.
- The queue starts empty, and boot re-registers every scheduled Job from its
  row.
- The first boot lists every replica the restored rows name (§ 9). An app whose
  replica is in its bucket and that is not running shows *Replica found* with
  *Restore onto <server>* per machine it is placed on, or *re-enroll it first*
  for a machine that is not online; each workspace gets one notification
  naming its apps. Basecamp's own replica shows the same card on
  `/hub/backups/` — the next section.

### The hub, from its own replica

The archive is as old as its stamp; Basecamp's own replica (§ 9, the hub's
box enrolled) runs to the minute it stopped. When `/hub/backups/`'s *Replica
found* card says the replica synced after the archive was taken, the minutes
between are in the replica, and the hub cannot restore itself while it serves.

The replica lands at `<prefix>/basecamp/<file>`, one object path per database
file. Restore it with Basecamp stopped, on its box, and **before that box's
Outpost is enrolled as the hub's own**: Litestream there would stream the
archive's older file to the same path, and the replica's latest is then the
archive's history, with the found minutes no longer in it.

Litestream is at `/usr/local/bin/litestream` on a box an Outpost was installed
on; elsewhere install the build `@frontierjs/litestone` pins
(`litestone/docs/replication.md`). The key is the replica destination's own
(§ 9), which the hub never shows: the copy you kept, or a new one for the same
prefix.

```sh
DB=<db dir>     # the directory holding basecamp.db: the compose volume, or <server path>/db under fli deploy
E=https://s3.us-west-004.backblazeb2.com
export AWS_ACCESS_KEY_ID=<keyID> AWS_SECRET_ACCESS_KEY=<applicationKey>
export LITESTREAM_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
Q="endpoint=$E&region=us-west-004&force-path-style=true"
# each database is a folder <file>.db/; every one but the queue
FILES=$(aws --endpoint-url "$E" s3 ls "s3://<bucket>/<prefix>/basecamp/" |
  awk '$1 == "PRE" && $2 ~ /\.db\/$/ { sub(/\/$/, "", $2); print $2 }' | grep -vx basecamp-jobs.db)
echo "$FILES"   # basecamp.db at least; stop here if it is missing
for f in $FILES; do
  litestream restore -integrity-check quick -o "${DB:?}/.$f.restoring" \
    "s3://<bucket>/<prefix>/basecamp/$f?$Q" || exit 1
done
for f in $FILES; do
  rm -rf "${DB:?}/$f-wal" "${DB:?}/$f-shm" "${DB:?}/.$f-litestream"
  mv "${DB:?}/.$f.restoring" "${DB:?}/$f"
done
```

`-timestamp 2026-10-27T09:00:00Z` before `-o` restores an earlier instant
instead of the latest. Every file is fetched before any is moved, so a failed
fetch leaves the hub as it was; delete the `.restoring` files it left. A `-wal`
left beside a restored file would be replayed onto it, which is why the second
loop removes it first. Then start Basecamp. The card is gone because the rows
it read are the replica's.

### The hub, by hand

For a box whose `/setup` cannot be reached, or a staged archive refused beside
an account. With the same `ENCRYPTION_KEY` and Basecamp stopped:

```sh
# fetch the archive named by the Backup row's location
aws --endpoint-url https://s3.us-west-004.backblazeb2.com s3 cp \
  s3://<bucket>/<prefix>/basecamp-<stamp>.tar.gz .
tar xzf basecamp-<stamp>.tar.gz          # one directory, basecamp-<stamp>/
cd packages/basecamp && DATABASE_URL=<db dir>/basecamp.db AUDIT_PATH=<db dir>/audit.db \
  bunx litestone restore --from-backup=../../basecamp-<stamp> --force
```

`litestone restore` is all or nothing across every database the schema
declares, and without `--force` it refuses to replace a file that is there and
names each one. The queue (`jobs.db`) is in the archive and is NOT restored:
no schema names it, so the hub starts with an empty queue, as above. Leave out
`--verify=<dir>`: it proves a Litestream replica, and beside `--from-backup`
the SQLite files would come from the replica, not the archive.

### The hub, under a new key

When the old `ENCRYPTION_KEY` has leaked, the hub still comes back under it: an
archive is refused under any other key. Restore it as above, sign in once to
see it is the old hub, then stop Basecamp and move every encrypted column to a
new key:

```sh
openssl rand -hex 32 > new.key           # keep a copy off this box (§ 6)
cd packages/basecamp && DATABASE_URL=<db dir>/basecamp.db AUDIT_PATH=<db dir>/audit.db \
  ENCRYPTION_KEY=<old key> NEW_ENCRYPTION_KEY_FILE=../../new.key bunx litestone rekey
```

The new key is read from a file, never typed on the command line, which `ps`
and shell history keep. Each database is one transaction; a run that stopped
part way is finished by running it again with the same two keys. Then set
`ENCRYPTION_KEY` to the new key and start Basecamp. Three things follow:

- `hub.key-escrowed` on `/hub/security/` goes red, because the attested digest
  is the old key's. Put the new key off the box and press *Attest* again.
- Every archive taken before the rekey is under the old key, and `/setup`
  refuses it under the new one. Run *Back up now* so the newest is not.
- An App's own `ENCRYPTION_KEY` is its own Variable, not the hub's; it moved
  with the rows, unchanged. Rotate one the leak reached in the App itself.

### An app

**From its replica.** The *Replica found* card's *Restore onto <server>* is
`apps.restoreReplica { serverId }`; call it directly with `at` for an earlier
instant, and `overwrite: true` over databases that are there. Only the `.db`
files are replaced, and Outpost refuses a volume a running container holds, so
stop the app first.

**From an archive.** `apps.restoreVolume { serverId, backupId }`: the machine
fetches the `AppBackup` from the bucket and refuses one whose sha256 is not the
one recorded when it was taken. `path` instead of `backupId` names a file you
copied into Outpost's restore directory. Stop the app first, and state
`overwrite: true` if the volume is not empty.

## 8. What it costs

Backblaze B2's first 10 GB stored are free and egress is free up to three times
the average stored per month, then $0.01/GB; storage past the free 10 GB is
about $6/TB/month
([pricing](https://www.backblaze.com/cloud-storage/pricing)). A daily hub
archive is megabytes, so seven kept locally and seven in the bucket stays
inside the free tier until an app's volume does not.

## 9. Live replicas — one key per app

A snapshot leaves the machine by a URL that expires; a replica cannot, so
Litestream on each machine holds a standing key, and every machine the app is
placed on holds it (`FJS-D1505`). So a replica destination is **one app's**:
`App.replicaDestinationId` is unique, and a second app pointing at the same row
is refused. Make a destination per app, with a key that reaches no further than
that app's objects, and set it with `apps.patch { replicaDestinationId }`.

The replica lands at `<destination prefix>/<app id>/`. Litestream needs list on
the bucket and get, put and delete on its objects
([guide](https://litestream.io/guides/s3/)). How narrow the key can be is the
vendor's:

| Vendor | Narrowest key | How |
| --- | --- | --- |
| Backblaze B2 | a prefix | Application key restricted to the bucket, *File name prefix* `<prefix>/<app id>/`, the five capabilities of § 2 ([b2_create_key](https://www.backblaze.com/apidocs/b2-create-key)) |
| AWS S3 / MinIO | a prefix | `s3:ListBucket` on the bucket with an `s3:prefix` condition, object actions on `bucket/<prefix>/<app id>/*` ([AWS](https://repost.aws/knowledge-center/s3-folder-user-access) · [MinIO](https://min.io/docs/minio/linux/administration/identity-access-management/policy-based-access-control.html)) |
| Cloudflare R2 | a bucket | A bucket per app, and an *Object Read & Write* token on that bucket only ([tokens](https://developers.cloudflare.com/r2/api/tokens/)) |
| DigitalOcean Spaces | a bucket | A bucket per app, and a *Read/Write/Delete* key on it; made in the control panel ([manage access](https://docs.digitalocean.com/products/spaces/how-to/manage-access/)) |
| Hetzner | a bucket, by policy | A bucket per app with a bucket policy allowing only that key, `p<project>:<key>`; keys are made in the Console ([S3 credentials](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials)) |

Changing the destination's address or key, removing it, or clearing the
pointer re-sends every machine the app is on its list, and the replica stops
there. The key is not deleted at the vendor; revoke it there.
