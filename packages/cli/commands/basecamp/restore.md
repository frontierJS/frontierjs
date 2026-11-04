---
title: basecamp:restore
description: Make a freshly installed Basecamp the archived one — the archive checked on this machine first, then sent to /setup/restore over ssh and swapped in by a restart
effects: reads the archive and its key on this machine; with --dry stops there. Otherwise asks the box's Basecamp whether it is set up, writes the archive's key to its secrets directory and restarts the API when the box runs another, sends the archive to /setup/restore, and restarts the API so it boots on the archive; then reads the restored hub with BASECAMP_API_KEY for its machines and what it found
examples:
  - fli basecamp:restore
  - fli basecamp:restore yuma --dry
  - fli basecamp:restore yuma --from ~/.local/share/fli/basecamp/yuma/2026-11-04T08-50-56-022Z
  - fli basecamp:restore yuma --url https://basecamp.example.com
args:
  -
    name: server
    description: The box Basecamp runs on, whose backups are searched (default deploy.server in packages/basecamp/frontier.config.js)
flags:
  from:
    type: string
    description: The archive — a <stamp>/ directory basecamp:backup wrote, the basecamp-<stamp>/ in it, or its .tar.gz (default the newest archive under ~/.local/share/fli/basecamp/<server>/)
  key:
    type: string
    description: The file holding the archive's ENCRYPTION_KEY (default the one filed under ~/.config/fli/basecamp/<server>/ whose fingerprint the manifest names)
  url:
    type: string
    description: Basecamp's API origin, where the restored hub is read for what it found (default is BASECAMP_URL, then https:// and Basecamp's hostname)
  yes:
    type: boolean
    description: Restore without asking; still refuses everything the check refuses
---

A Basecamp nobody has set up becomes the one an archive holds, the way the
restore form on `/setup` does it. The archive is one `basecamp:backup` brought
here, and **it is checked on this machine before the box is touched**: every
file against `manifest.json`, the key against the fingerprint the manifest
names, and the migrations it applied against this checkout's, so an archive
this code cannot continue is refused while the box is as it was. `/setup`
checks it again on the box. `--dry` stops after this check.

On the box, a Basecamp that is set up already is refused — an archive only
ever fills an empty one, so the box is retired and installed again first.
When the box runs a different key from the archive's, the archive's is
written to its `secrets/ENCRYPTION_KEY` and the API restarted on it, since
`/setup` refuses an archive taken under another key. Then the archive is sent
to `POST /setup/restore`, which stages it, and one more restart swaps it in
before any database opens.

**After the restore** the restored hub is read with `BASECAMP_API_KEY` — the
archive's own key rows came back with it — for up to a minute and a half:
each enrolled machine and whether it has heartbeat since the archive was
taken, which only the restored hub could have heard, and what the reconcile
the restored boot queued has found in the buckets: Apps' replicas,
Basecamp's own, and App archives newer than the hub's. A machine at the same
URL needs nothing, since the same key derives the same signing key
(`FJS-D1646`); one that stays silent is down or points elsewhere. The
reconcile marks no end, so a finding after the wait shows on `/hub/backups/`
and the App's screen instead.

A raw copy, the one `basecamp:backup --raw` takes, is refused: it carries the
box's file names and no manifest, so it is put back by hand
(`packages/basecamp/docs/backups.md` § 7, *The hub, by hand*).

<script>
const { apiContainer } = await import(new URL('file://' + global.fliRoot + '/core/ports.js'))

const confirmed = async ({ host, takenAt, yes, tty, log, chalk }) => {
  if (yes) return true
  if (!tty.interactive) { log.error('Pass --yes to restore without a terminal to confirm on'); return false }
  return await tty.keys(chalk`{cyan ?} {bold Make Basecamp on ${host} the hub archived ${takenAt}?}`, { n: 'no', y: 'yes' }) === 'y'
}
</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:restore <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const say = (line) => echo(chalk`  {dim ${line}}`)

let picked, keyFile
try {
  picked  = pickArchive({ from: flag.from, server })
  keyFile = keyFor(server, picked.manifest, flag.key)
} catch (err) { log.error(err.message); process.exitCode = 1; return }

echo(chalk`\n  {bold Restoring Basecamp} {dim onto} ${server}`)
if (!await checkHere({ picked, keyFile, log, echo, chalk })) { process.exitCode = 1; return }
if (flag.dry) { log.dry(`ask Basecamp on ${server} whether it is empty, put the archive's key there, send the archive to /setup/restore and restart it`); return }

const files = await deployFiles(server)
const { default: conf } = await import(provisionScript().root + 'frontier.config.js')
const port = conf.deploy.api.port
const container = apiContainer(conf.deploy.app_id, conf.deploy)
const key = (await Bun.file(keyFile).text()).trim()

try {
  if (!await emptyOnBox({ host: files.host, port, log, echo, chalk })) { process.exitCode = 1; return }
  if (!await confirmed({ host: files.host, takenAt: picked.manifest.takenAt, yes: flag.yes, tty, log, chalk })) { process.exitCode = 1; return }
  await boxRunsKey({ files, port, container, key, say, echo, chalk })
  const probe = await swapIn({ files, port, container, tar: picked.tar, say })
  echo(chalk`  {green ✓} {bold Restored the hub archived ${probe.restore_taken_at ?? picked.manifest.takenAt}} {dim onto} ${files.host}`)
  echo(chalk`    {dim ·} {dim sign in as the archived hub's admin}`)
  await reportFindings({ origin: await apiOrigin(flag.url), takenAt: picked.manifest.takenAt, log, echo, chalk })
} catch (err) { log.error(err.message); process.exitCode = 1 }
```
