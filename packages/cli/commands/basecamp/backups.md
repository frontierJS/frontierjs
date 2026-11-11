---
title: basecamp:backups
description: Give a Basecamp tested off-box backups in B2 — make its buckets, mint a narrow key per workspace, file and test each as a backup destination, and point the hub and the Apps named at them; --undo takes them back off
effects: makes B2 buckets (the archive one compliance-locked 7 days, which nobody can shorten), mints B2 keys, and over ssh creates backup destinations and points the hub's and the named Apps' backups at them; --undo removes the destinations and deletes their keys
confirm: human
examples:
  - fli basecamp:backups yuma-test
  - fli basecamp:backups chartered --apps ela
  - fli basecamp:backups yuma-test --dry
  - fli basecamp:backups yuma-test --undo
args:
  -
    name: basecamp
    description: The Basecamp, by its name in basecamps.json (default the only entry); dev is this checkout's dev Basecamp, reached without ssh
flags:
  apps:
    type: string
    description: Comma-separated slugs of Apps to point at their workspace's destination, with a nightly backupCron where they have none. The hub is always set up; an App is only changed when named
    defaultValue: ''
  undo:
    type: boolean
    description: Take every destination this files off the hub and its Apps, remove it and delete its key at B2. One that archives are recorded in stays, with its key. The buckets and their archives stay
---

The setup `basecamp/docs/backups.md` § 1, § 2 and § 9 walk through by hand,
made with the laptop's B2 key (`B2_KEY_ID`, `B2_APPLICATION_KEY` in
`~/.config/fli/.env`, `FJS-D2077`), which never leaves this machine:

- **`basecamp-<name>`** holds the archives, with Object Lock and a 7-day
  compliance default retention, so a stolen hub cannot empty it
  (`hub.bucket-locked`). Every workspace with an App set up here gets a
  destination in it, prefix the workspace id, with a key that reaches that
  prefix and no other (`FJS-D2076`).
- **`basecamp-<name>-replica`** holds the hub's live replica, unlocked, since
  `test` refuses a replica on a locked bucket. Its destination's key reaches
  `hub/` alone.

Each destination is created and tested through Basecamp's own
`backupDestinations` service, called in the repl over ssh as an owner of its
workspace, because an API key works in one workspace only. The hub's
`backupDestinationId`, `replicaDestinationId` and `backupCron` are then saved
where they are empty, and each App in `--apps` gets its workspace's destination
and `0 2 * * *` where it has none. A pointer already set is left alone, so
running it again changes nothing. A key whose destination Basecamp refused is
deleted at B2 before the run stops.

`--dry` reads the Basecamp and the B2 account and says what a run would make,
then stops. The Apps with no destination are listed either way, so a first run
shows the names `--apps` takes.

`--undo` is the way back: each destination this files is taken off the hub
and the Apps, removed, and its key deleted at B2. Basecamp refuses to remove a
destination that archives are recorded in, so that one stays with its key and
is named, since deleting the key would leave those archives out of reach from
the screen. The buckets stay; a locked bucket cannot be emptied before its
retention ends anyway. The module is `core/basecamp-backups.js`, which
Workbench's Basecamps screen calls too.

<script>
const { planBackups, setUpBackups, undoBackups, laptopSession, LOCK_DAYS, NIGHTLY } = await import(new URL('file://' + global.fliRoot + '/core/basecamp-backups.js'))

const refuse = (log, message) => { log.error(message); process.exitCode = 1 }

/** One line per thing the plan would make or keep. */
const planLines = (plan, chalk) => {
  const bucket = (b, locked) => b.held
    ? chalk`{dim keep} bucket ${b.name}{dim ${b.held.lockDays ? `, locked ${b.held.lockDays} days` : ', not locked'}}`
    : chalk`{cyan make} bucket ${b.name}{dim ${locked ? `, locked ${LOCK_DAYS} days` : ''}}`
  const dest = (d, w) => d.row?.lastTestAt ? chalk`{dim keep} ${d.name} {dim in ${w.name}, tested}`
    : d.row ? chalk`{cyan test} ${d.name} {dim in ${w.name}}`
    : chalk`{cyan make} ${d.name} {dim in ${w.name}, key ${d.keyName} limited to ${d.prefix}/, as ${w.holder?.email ?? 'nobody — no owner or admin there'}}`
  const pointer = (label, set) => set ? chalk`{dim keep} ${label}` : chalk`{cyan set } ${label}`
  return [
    bucket(plan.buckets.archive, true),
    bucket(plan.buckets.replica, false),
    ...plan.workspaces.flatMap(w => [dest(w.archive, w), ...(w.replica ? [dest(w.replica, w)] : [])]),
    pointer('hub backupDestinationId', plan.hub.backupDestinationId),
    pointer('hub replicaDestinationId', plan.hub.replicaDestinationId),
    pointer(`hub backupCron ${plan.hub.backupCron ?? NIGHTLY}`, plan.hub.backupCron),
    ...plan.apps.map(a => pointer(`${a.slug} backupDestinationId, backupCron ${a.backupCron ?? NIGHTLY}`, a.backupDestinationId)),
  ]
}
</script>

```js
const entry = resolveBasecamp(String(arg.basecamp ?? '').trim() || undefined)
const say   = (line) => echo`  {green ✓} ${line}`

if (flag.undo) {
  echo`\n  {bold fli basecamp:backups --undo}  {dim ${entry.name}}`
  if (flag.dry) { log.dry('Nothing undone'); return }
  try { await undoBackups(entry, { say }) } catch (e) { return refuse(log, e.message) }
  echo('')
  return
}

const apps = flag.apps.split(',').map(s => s.trim()).filter(Boolean)
echo`\n  {bold fli basecamp:backups}  {dim reading ${entry.name} and the B2 account}`
let session, plan
try {
  session = await laptopSession()
  plan    = await planBackups(entry, { apps, session })
} catch (e) { return refuse(log, e.message) }

echo.lines(planLines(plan, chalk), { indent: 4 })
const left = plan.unset.filter(a => !apps.includes(a.slug))
if (left.length) echo`\n  {dim Apps with no destination, not named in --apps:} ${left.map(a => a.slug).join(', ')}`
echo('')
if (flag.dry) { log.dry('Nothing made'); return }

try { await setUpBackups(entry, { apps, session, say }) } catch (e) { return refuse(log, e.message) }
echo`\n  {dim The hub's next backup goes to} ${plan.buckets.archive.name}{dim ; /hub/backups/ shows where each one landed}\n`
```
