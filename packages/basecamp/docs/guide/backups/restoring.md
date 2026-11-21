# Restoring

A restore puts an archive or a replica back on a box. The hub comes back from `/setup` on a fresh install, from its own replica, or by hand; an app comes back from its replica or from one of its archives.

```bash
fli basecamp:restore yuma --dry   # check the newest archive on this laptop against its manifest and key; the box is not touched
fli basecamp:restore yuma         # send it to /setup/restore on the box, then restart so it boots on the archive
```

The same on a screen: on a new box with the old `ENCRYPTION_KEY`, before anyone signs up, open `/setup`, the *Restore a hub* tab, press *List archives* and then *Restore this*, and restart Basecamp.

## What else it can do

- Take a `basecamp-<stamp>.tar.gz` from `/hub/backups/` and press *Restore from file*; an upload over 128 MB comes from the bucket instead
- Fill the bucket form from `HUB_RESTORE_ENDPOINT`, `HUB_RESTORE_REGION`, `HUB_RESTORE_BUCKET`, `HUB_RESTORE_PREFIX` and `HUB_RESTORE_KEY` on a box with no browser
- An archive is checked before a file is touched and refused with its reason when the key, a file or the migration history does not fit
- After a restore the first boot lists the replicas the rows name and shows *Replica found* with *Restore onto <server>* for an app
- The hub's own replica runs to the minute it stopped, restored with Litestream while Basecamp is stopped and before the box's Outpost is enrolled as the hub's own
- By hand, `litestone restore --from-backup=<dir> --force` is for a box whose `/setup` cannot be reached
- A copy taken before a bad migration waits in `pre-migrate/` beside the database
- `litestone rekey` moves every encrypted column to a new key when the old one has leaked
- An app restores from its replica with `apps.restoreReplica` or from an archive with `apps.restoreVolume`, with the app stopped first
- A raw copy from `fli basecamp:backup --raw` has no manifest, so `/setup` and `basecamp:restore` refuse it and it goes back by hand

**In depth:** [Backups § 7 Restore](../../backups.md#7-restore), [basecamp:restore](../../../../cli/commands/basecamp/restore.md)
