# Rehearsing a restore

A backup nobody has read back is a hope, so run a restore once on a scratch box before you need it. Basecamp also reads its own newest hub archive back every week, and a live replica keeps a second copy within seconds of each write.

```bash
fli basecamp:backup --list        # what is on this laptop, and whether a filed key opens each
fli basecamp:restore yuma --dry   # the checks a real restore makes, with the box left as it was
```

The Workbench screen `/charter/drill/` is the whole drill. *Rehearse* reads the box and plans the reinstall, and changes nothing.

**That drill has not been run for real.** *Run for real* backs the Basecamp up, retires it, restores it and grades what came back, and it is built and checked only against stand-ins in tests. Only the rehearsal has been driven, so treat the restore it describes as unproven.

## What else it can do

- Every week the hub downloads its newest uploaded archive, checks its sha256 and manifest, runs `PRAGMA integrity_check` over each database, deletes the copy, and tells the system admins when it fails
- An app's replica drill restores the bucket beside the app and proves it with the app's own release image, from `appDrills.run` or the app's `drillCron`, and the app's screen shows *Drill passed* or *Drill failed*
- *Run for real* in Workbench asks first, since a failed run leaves the apps unmanaged until the hub is repaired
- A replica destination is one app's, with a key that reaches no further than that app's objects, and *Test bucket* checks the scope
- Litestream on each machine streams the app to `<destination prefix>/<app id>/`, and `/hub/backups/` grades the hub's own replica as replicating or behind
- A replica needs a bucket of its own, since a locked bucket refuses one
- `fli basecamp:backups` makes the locked archive bucket and the unlocked replica bucket together

**In depth:** [Backups § 7 Restore](../../backups.md#7-restore), [§ 9 Live replicas](../../backups.md#9-live-replicas--one-key-per-app), [basecamp:restore](../../../../cli/commands/basecamp/restore.md), [Workbench layout](../../../../workbench/docs/layout.md)
