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

The hub holds a whole archive in memory to send it; above 1 GiB the job refuses
rather than discovering the limit in the heap.

## 6. The encryption key

An archive of `@encrypted` columns is unreadable without the hub's
`ENCRYPTION_KEY`. Keep a copy of it somewhere that is not the hub's disk, then
press *Attest* on `/hub/backups/`: the hub records when and the key's digest,
and `hub.key-escrowed` on `/hub/security/` goes green. It is a person's word,
not a check. The development placeholder is refused, because a copy of a public
key protects nothing.

## 7. Restore, by hand

There is no restore button yet (`IDEAS/backups.md` Phase 3). Today:

**The hub.** On a new box with Basecamp installed and the same `ENCRYPTION_KEY`:

```sh
# fetch the archive named by the Backup row's location
aws --endpoint-url https://s3.us-west-004.backblazeb2.com s3 cp \
  s3://<bucket>/<prefix>/basecamp-<stamp>.tar.gz .
tar xzf basecamp-<stamp>.tar.gz          # one directory, basecamp-<stamp>/
# stop Basecamp first: a box it has started on already has its databases
cd packages/basecamp && bunx litestone restore --from-backup=../../basecamp-<stamp> --force
```

`litestone restore` is all or nothing across every database the schema
declares, and without `--force` it refuses to replace a file that is there and
names each one. The queue (`jobs.db`) is in the archive and is restored by the
same command. Do not add `--verify=<dir>`: it proves a Litestream replica, and
beside `--from-backup` the SQLite files come from the replica, not the archive.

**An app.** Fetch the archive onto the machine that holds the volume, into
Outpost's restore directory, then call `apps.restoreVolume` with the server,
the path and `overwrite: true` if the volume is not empty. Outpost refuses a
path off its restore directory and a volume a running container holds, so stop
the app first.

Run a restore once, on a scratch box, before you need it.

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
