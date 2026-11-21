# What is backed up

Basecamp archives its own databases and the job queue, and each app's volume, off the machine into a private bucket you own. Backblaze B2 is the worked example; any S3-compatible bucket works the same way.

```bash
fli basecamp:backups yuma-test --dry   # read the Basecamp and the B2 account, say what a run would make
fli basecamp:backups yuma-test         # make the buckets and keys, file and test the destinations
fli basecamp:backup yuma               # take a hub backup now and bring it to this laptop
```

On a screen, the same by hand is `/hub/settings/`: *Add a bucket* in the *Scheduled backup* card (*Name*, *Endpoint URL*, *Region*, *Bucket*, *Prefix*, *Credential* as `keyID:applicationKey`), then *Take a scheduled backup* and its cron, `0 2 * * *` by default.

## What else it can do

- The bucket is private and locked: a compliance-mode Object Lock of N days, so the hub's own key cannot delete a younger archive, and `hub.bucket-locked` on `/hub/security/` grades it
- The key is an application key restricted to that bucket, never the master key, and never one that can write retention
- *Add bucket* runs a probe at once, a PUT and a DELETE under the prefix, and says a failure in words; *Test bucket* reruns it
- Retention is two counts and two optional ages, local and remote apart, pruned after each successful backup
- A row's `location` is an object key when the upload landed and a path on the machine when it did not, so read the row before trusting that a machine can burn
- *Download* on `/hub/backups/` fetches an archive as `basecamp-<stamp>.tar.gz`, from the bucket or the hub's disk
- An app's schedule is its `backupCron` and `backupDestinationId`; a release of an app with a volume also takes an archive before the swap
- The archive holds `@encrypted` columns as ciphertext and the encryption key never travels with it, so keep a copy off the hub's disk and press *I keep a copy off this box* on `/hub/backups/`
- `fli basecamp:key` mints the API key those commands read; `fli basecamp:backup --list` shows what is already on this laptop and whether a filed key opens each
- On B2 the first 10 GB stored are free and a daily hub archive is megabytes; see the source for the figures

**In depth:** [Backups § 1 The bucket](../../backups.md#1-the-bucket) to [§ 6 The encryption key](../../backups.md#6-the-encryption-key), [§ 8 What it costs](../../backups.md#8-what-it-costs), [basecamp:backups](../../../../cli/commands/basecamp/backups.md), [basecamp:backup](../../../../cli/commands/basecamp/backup.md)
