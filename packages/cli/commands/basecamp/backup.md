---
title: basecamp:backup
description: Take a backup of Basecamp itself and bring it to this machine, under ~/.local/share/fli/basecamp/<server>/<stamp>/, checked against its manifest — or copy its files over ssh when the API cannot
effects: asks Basecamp for a hub backup, then downloads and unpacks the archive; with --raw, or when the API cannot back up, copies the db directory and env file over ssh and files the key under ~/.config/fli/basecamp/<server>/
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

The key needs `hubBackups:read` and `hubBackups:write`, and `hubConfig:read`
for the destination; its holder must be a system admin, or Basecamp answers
404, which is refused here rather than worked around.

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
take it. The key is never in it (`FJS-D1852`): it goes to
`~/.config/fli/basecamp/<server>/encryption.key`, mode 600, and an
`ENCRYPTION_KEY` line in the env file is taken out; a different key already
filed there is kept and the new one named by its fingerprint.

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

/** The ssh path, printed as raw so nobody mistakes it for an archive. */
const copyRaw = async ({ server, out, say, dry, log, echo, chalk }) => {
  const files = await deployFiles(server)
  echo(chalk`\n  {bold Copying Basecamp's files} {dim off} ${files.host} {dim — raw, so /setup cannot take them}`)
  const got = await pullRawBackup({ server, ...files, out, dry, log, say })
    .catch(err => { log.error(err.message); process.exitCode = 1; return null })
  if (!got) return
  const ways = [...new Set(Object.values(got.record.copiedWith))].join(', ')
  echo(chalk`  {green ✓} {bold Copied ${got.record.takenAt}} {dim into} ${got.dir}`)
  echo(chalk`    {dim ·} ${plural(Object.keys(got.record.copiedWith).length, 'database')} {dim copied with} ${ways}${got.record.files.some(f => f.path === '.env.production') ? chalk` {dim and the env file}` : ''}`)
  if (got.keyFile) echo(chalk`    {dim ·} {dim key} ${got.record.encryptionKeyFingerprint.slice(0, 12)} {dim filed in} ${got.keyFile}\n`)
  else log.warn(`No ENCRYPTION_KEY on ${files.host}, in ${files.secretsDir} or the env file, so this copy has no key beside it\n`)
}
</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:backup <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const out = flag.out || backupsOf(server)
const say = (line) => echo(chalk`  {dim ${line}}`)

if (flag.raw) { await copyRaw({ server, out, say, dry: flag.dry, log, echo, chalk }); return }

const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — fli basecamp:key mints one for the first admin, or pass --raw to copy the files over ssh'); process.exitCode = 1; return }
const origin = await apiOrigin(flag.url)
if (!origin) { log.error("needs --url or BASECAMP_URL — Basecamp's origin, https://<its hostname>"); process.exitCode = 1; return }

echo(chalk`\n  {bold Backing up Basecamp} {dim at} ${origin} {dim on} ${server}`)
const got = await pullHubArchive({ origin, key, out, dry: flag.dry, log, say }).catch(err => err)
if (got instanceof Error && apiCannotBackUp(got)) {
  log.warn(`${got.message} — copying its files over ssh instead, which /setup cannot take`)
  await copyRaw({ server, out, say, dry: flag.dry, log, echo, chalk })
  return
}
if (got instanceof Error) { log.error(got.message); process.exitCode = 1; return }
if (!got) return

echo(chalk`  {green ✓} {bold Archive taken ${got.manifest.takenAt}} {dim unpacked into} ${got.dir}`)
echo(chalk`    {dim ·} ${plural(got.manifest.files.length, 'file')} {dim match manifest.json}`)
echo(chalk`    {dim ·} {dim key} ${got.manifest.encryptionKeyFingerprint?.slice(0, 12) ?? 'the development placeholder'}\n`)
```
