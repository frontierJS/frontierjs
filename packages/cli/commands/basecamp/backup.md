---
title: basecamp:backup
description: Take a backup of Basecamp itself and bring it to this machine, under ~/.local/share/fli/basecamp/<server>/<stamp>/, checked against its manifest — or copy its files over ssh when the API cannot
effects: asks Basecamp for a hub backup, then downloads and unpacks the archive; with --raw, or when the API cannot back up, copies the db directory and env file over ssh; reads the key over ssh and files it under ~/.config/fli/basecamp/<server>/, prints it, or both, as asked; attests the copy to Basecamp after an API backup
examples:
  - fli basecamp:backup
  - fli basecamp:backup yuma
  - fli basecamp:backup --out ./snapshot
  - fli basecamp:backup yuma --raw
  - fli basecamp:backup --list
args:
  -
    name: server
    description: The box Basecamp runs on, which names the directory the archive lands in (default deploy.server in packages/basecamp/frontier.config.js; with --list, every box)
flags:
  basecamp:
    type: string
    description: The Basecamp whose API takes the backup, by its name in basecamps.json (default the entry named like <server>, else the only one; with several and none named, refused with the names). --raw needs none
    defaultValue: ''
  out:
    type: string
    description: The directory the <stamp>/ directory goes in (default ~/.local/share/fli/basecamp/<server>/)
  raw:
    type: boolean
    description: Copy the db directory and env file over ssh instead of asking the API — what runs on its own when the API cannot back up. /setup cannot take the copy
  list:
    type: boolean
    description: List the backups already on this machine, per box, with size, age, manifest version and whether a filed key opens each — takes nothing, asks nothing
---

Basecamp's own state on this machine, the way the Take a backup button on
`/hub/backups/` takes it: every database the API keeps and the job queue,
written to the hub's backup destination, or to the box's own disk with none.
The archive is fetched, its sha256 checked when the bucket recorded one,
unpacked, and every file checked against the `manifest.json` it carries. The
`<stamp>/` directory holds the `.tar.gz` `/setup` takes back and the
`basecamp-<stamp>/` directory in it. Nothing here is ever pruned
(`FJS-D1851`). An App's archive is `fli db:download` (`FJS-D1848`).

The origin and key are the Basecamp's entry in `basecamps.json`, chosen by
`--basecamp`. The key needs `hubBackups:read` and `hubBackups:write`, `hubConfig:read` for
the destination and `hubConfig:write` to attest the key copy; its holder must
be a system admin, or Basecamp answers 404, which is refused here rather than
worked around.

**The encryption key** is never in a backup, and a backup cannot be read
without it. Each run reads it off the box over ssh and asks where its copy goes
(`FJS-D1852`): filed at `~/.config/fli/basecamp/<server>/encryption.key`,
mode 600, where restore reads it; printed once for a password manager; or both.
Enter files it, and so does a run with no terminal. A different key already
filed there is kept and this one named by its fingerprint, since older backups
need the old one. After an API backup whose manifest names the same key, the
copy is attested to Basecamp (`hubConfig.attestEscrow`), which turns
`hub.key-escrowed` green; a raw copy proves nothing about the key the API runs,
so it attests nothing.

**When the API cannot back up** — it does not answer, answers 5xx, or the
Basecamp has no hub App because it was installed `--no-outpost` — the files
are copied over ssh instead, and the run says so. `--raw` asks for that path
outright and needs no key. The databases in the db directory are read with
`sqlite3 .backup` on the box, which is one moment even while the API writes
(without sqlite3 there, each file and its `-wal` are copied, whole only when
nothing writes), and the env file comes with them, everything checked against
the sha256 the box took. The archives in the box's `backups/` directory are
not copied. The directory is `<stamp>-raw/`: `db/`, `.env.production` and the
`raw.json` that marks it, with box names, not an archive's, so `/setup` cannot
take it. An `ENCRYPTION_KEY` line in the env file is taken out of the copy.

**`--list`** reads what is already here and touches no box: every box's
directory, or the one named, each backup with its kind, when it was taken,
its size on disk, the Basecamp version its manifest names, and whether a key
filed under `~/.config/fli/basecamp/<server>/` opens it. Read from the marker,
not hashed — restore checks each file. A directory with neither marker, a
download cut short, is listed as unreadable rather than left out.

<script>
const { basename, join } = await import('node:path')
const { existsSync, readdirSync } = await import('node:fs')
const { formatBytes } = await import('@frontierjs/toolbelt/units')

/** The boxes `--list` reads: `--out` alone, the one named, or every box with a directory. */
const listedBoxes = (server, out) => {
  if (out) return [{ server: basename(out), dir: out }]
  if (server) return [{ server, dir: backupsOf(server) }]
  const root = backupsRoot()
  return existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ server: e.name, dir: join(root, e.name) }))
    : []
}

/** One backup's row; a key not filed is what a restore of it would stop on. */
const backupRow = (b, width, keys, chalk) => {
  if (b.kind === 'unreadable') return chalk`{yellow ${b.name.padEnd(width)}}  {dim no manifest.json or raw.json — a download cut short, not a backup restore can read}`
  const key = !b.fingerprint ? chalk`{dim key} the development placeholder`
    : keys.has(b.fingerprint) ? chalk`{dim key} ${b.fingerprint.slice(0, 12)} {green filed}`
    : chalk`{dim key} ${b.fingerprint.slice(0, 12)} {yellow not filed}`
  return chalk`${b.name.padEnd(width)}  {dim ${ageOf(b.takenAt).padStart(4)}}  ${b.kind.padEnd(7)} ${(b.version ?? '—').padEnd(7)} ${formatBytes(b.bytes).padStart(7)}  ${key}`
}

/** Every backup on this machine, one block per box, oldest first. */
const listBackups = ({ server, out, echo, chalk }) => {
  const boxes = listedBoxes(server, out).map(box => ({ ...box, backups: localBackups(box.dir) })).filter(box => box.backups.length)
  if (!boxes.length) { echo(chalk`
  {dim No backups under} ${out || (server ? backupsOf(server) : backupsRoot())}
`); return }
  for (const box of boxes) {
    const keys = filedKeys(box.server)
    const bytes = box.backups.reduce((n, b) => n + b.bytes, 0)
    echo(chalk`
  {bold ${box.server}}  {dim ${plural(box.backups.length, 'backup')} · ${formatBytes(bytes)} ·} ${box.dir}`)
    const width = Math.max(...box.backups.map(b => b.name.length))
    echo.lines(box.backups.map(b => backupRow(b, width, keys, chalk)), { indent: 4 })
  }
  echo('')
}
</script>

```js
if (flag.list) { listBackups({ server: String(arg.server ?? '').trim(), out: flag.out, echo, chalk }); return }

const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:backup <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
await takeBackup({ server, out: flag.out || backupsOf(server), basecamp: entryFor(flag.basecamp, server), raw: flag.raw, dry: flag.dry, tty, log, echo, chalk })
```
