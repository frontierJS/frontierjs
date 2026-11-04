---
title: basecamp:backup
description: Take a backup of Basecamp itself and bring it to this machine, under ~/.local/share/fli/basecamp/<server>/<stamp>/, checked against its manifest — or copy its files over ssh when the API cannot
effects: asks Basecamp for a hub backup, then downloads and unpacks the archive; with --raw, or when the API cannot back up, copies the db directory and env file over ssh; reads the key over ssh and files it under ~/.config/fli/basecamp/<server>/, prints it, or both, as asked; attests the copy to Basecamp after an API backup
examples:
  - fli basecamp:backup
  - fli basecamp:backup yuma
  - fli basecamp:backup --out ./snapshot
  - fli basecamp:backup yuma --raw
args:
  -
    name: server
    description: The box Basecamp runs on, which names the directory the archive lands in (default deploy.server in packages/basecamp/frontier.config.js)
flags:
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then https:// and Basecamp's hostname)
  out:
    type: string
    description: The directory the <stamp>/ directory goes in (default ~/.local/share/fli/basecamp/<server>/)
  raw:
    type: boolean
    description: Copy the db directory and env file over ssh instead of asking the API — what runs on its own when the API cannot back up. /setup cannot take the copy
---

Basecamp's own state on this machine, the way the Take a backup button on
`/hub/backups/` takes it: every database the API keeps and the job queue,
written to the hub's backup destination, or to the box's own disk with none.
The archive is fetched, its sha256 checked when the bucket recorded one,
unpacked, and every file checked against the `manifest.json` it carries. The
`<stamp>/` directory holds the `.tar.gz` `/setup` takes back and the
`basecamp-<stamp>/` directory in it. Nothing here is ever pruned
(`FJS-D1851`). An App's archive is `fli db:download` (`FJS-D1848`).

The key needs `hubBackups:read` and `hubBackups:write`, `hubConfig:read` for
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

<script>
const { join }    = await import('node:path')
const { homedir } = await import('node:os')
const { plural }  = await import(new URL('file://' + global.fliRoot + '/core/text.js'))

/** Where a box's backups land: one directory per box, never pruned. */
const backupsOf = (server) =>
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'fli', 'basecamp', server)

/** `--url`, then `BASECAMP_URL`, then Basecamp's hostname; never the dev API,
 *  since the directory is named for the box. */
const apiOrigin = async (url) => {
  const domain = await webDomain()
  return (url || process.env.BASECAMP_URL || (domain ? `https://${domain}` : '')).replace(/\/+$/, '')
}

/** Where the key's copy goes, asked at every backup; a run with no terminal files it. */
const howToKeep = async (tty, chalk) =>
  tty.interactive ? await tty.keys(chalk`{cyan ?} {bold Where does a copy of the key go?}`, KEY_COPIES) : 'f'

/** Keep the box's key off the box as asked, and attest it when `attest` says
 *  the API runs that key; the backup stands whatever happens here. */
const keepKeyCopy = async ({ server, key, host, attest, tty, log, echo, chalk }) => {
  if (!key) { log.warn(`No ENCRYPTION_KEY on ${host}, in its secrets directory or env file — no copy of the key was kept`); return }
  const kept = keepKey({ server, key, how: await howToKeep(tty, chalk), echo })
  if (kept.keyFile) echo(chalk`    {dim ·} {dim key} ${kept.fingerprint.slice(0, 12)} ${kept.already ? chalk`{dim already filed in}` : chalk`{dim filed in}`} ${kept.keyFile}`)
  if (!attest) { echo(chalk`    {dim ·} {dim not attested to Basecamp: a raw copy cannot show the API runs this key — the next API backup attests it}\n`); return }
  const done = await attest(kept.fingerprint).catch(err => err)
  if (done instanceof Error) log.warn(`The key copy was kept, but not attested to Basecamp: ${done.message}\n`)
  else echo(chalk`    {dim ·} {dim attested to Basecamp, so hub.key-escrowed reads} {green kept off the box}\n`)
}

/** After an API backup: the box's key, attested only when the archive was
 *  taken under it. A key changed on the box without a restart is not the one
 *  the API still runs, which is the one the archive needs. */
const keepArchiveKey = async ({ server, origin, key, taken, tty, log, echo, chalk }) => {
  const files = await deployFiles(server)
  const boxKey = await readBoxKey(files).catch(err => { log.warn(`${err.message} — no copy of the key was kept`); return undefined })
  if (boxKey === undefined) return
  const same = !!boxKey && new Bun.CryptoHasher('sha256').update(boxKey).digest('hex') === taken
  if (boxKey && !same) log.warn(`The key on ${files.host} is not the ${taken.slice(0, 12)} this archive was taken under — the API has not restarted since it changed. This archive needs that key; keeping the one on the box, unattested`)
  const attest = same ? (fingerprint) => attestKeyCopy({ origin, key, fingerprint }) : null
  await keepKeyCopy({ server, key: boxKey, host: files.host, attest, tty, log, echo, chalk })
}

/** The ssh path, printed as raw so nobody mistakes it for an archive. */
const copyRaw = async ({ server, out, say, dry, tty, log, echo, chalk }) => {
  const files = await deployFiles(server)
  echo(chalk`\n  {bold Copying Basecamp's files} {dim off} ${files.host} {dim — raw, so /setup cannot take them}`)
  const got = await pullRawBackup({ server, ...files, out, dry, log, say })
    .catch(err => { log.error(err.message); process.exitCode = 1; return null })
  if (!got) return
  const ways = [...new Set(Object.values(got.record.copiedWith))].join(', ')
  echo(chalk`  {green ✓} {bold Copied ${got.record.takenAt}} {dim into} ${got.dir}`)
  echo(chalk`    {dim ·} ${plural(Object.keys(got.record.copiedWith).length, 'database')} {dim copied with} ${ways}${got.record.files.some(f => f.path === '.env.production') ? chalk` {dim and the env file}` : ''}`)
  await keepKeyCopy({ server, key: got.key, host: files.host, attest: null, tty, log, echo, chalk })
}
</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:backup <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const out = flag.out || backupsOf(server)
const say = (line) => echo(chalk`  {dim ${line}}`)

if (flag.raw) { await copyRaw({ server, out, say, dry: flag.dry, tty, log, echo, chalk }); return }

const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — fli basecamp:key mints one for the first admin, or pass --raw to copy the files over ssh'); process.exitCode = 1; return }
const origin = await apiOrigin(flag.url)
if (!origin) { log.error("needs --url or BASECAMP_URL — Basecamp's origin, https://<its hostname>"); process.exitCode = 1; return }

echo(chalk`\n  {bold Backing up Basecamp} {dim at} ${origin} {dim on} ${server}`)
const got = await pullHubArchive({ origin, key, out, dry: flag.dry, log, say }).catch(err => err)
if (got instanceof Error && apiCannotBackUp(got)) {
  log.warn(`${got.message} — copying its files over ssh instead, which /setup cannot take`)
  await copyRaw({ server, out, say, dry: flag.dry, tty, log, echo, chalk })
  return
}
if (got instanceof Error) { log.error(got.message); process.exitCode = 1; return }
if (!got) return

echo(chalk`  {green ✓} {bold Archive taken ${got.manifest.takenAt}} {dim unpacked into} ${got.dir}`)
echo(chalk`    {dim ·} ${plural(got.manifest.files.length, 'file')} {dim match manifest.json}`)
const taken = got.manifest.encryptionKeyFingerprint
if (!taken) { echo(chalk`    {dim ·} {dim key} the development placeholder {dim — nothing to keep a copy of}\n`); return }

await keepArchiveKey({ server, origin, key, taken, tty, log, echo, chalk })
```
