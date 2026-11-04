---
title: basecamp:backup
description: Take a backup of Basecamp itself and bring it to this machine, under ~/.local/share/fli/basecamp/<server>/<stamp>/, checked against its manifest
effects: asks Basecamp for a hub backup, then downloads and unpacks the archive
examples:
  - fli basecamp:backup
  - fli basecamp:backup yuma
  - fli basecamp:backup --out ./snapshot
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
404. A Basecamp that is not a machine of its own fleet (`--no-outpost`) has
no hub App to back up, and Basecamp refuses with 400.

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
</script>

```js
const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — fli basecamp:key mints one for the first admin'); process.exitCode = 1; return }
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:backup <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const origin = await apiOrigin(flag.url)
if (!origin) { log.error("needs --url or BASECAMP_URL — Basecamp's origin, https://<its hostname>"); process.exitCode = 1; return }

echo(chalk`\n  {bold Backing up Basecamp} {dim at} ${origin} {dim on} ${server}`)
const say = (line) => echo(chalk`  {dim ${line}}`)
const got = await pullHubArchive({ origin, key, out: flag.out || backupsOf(server), dry: flag.dry, log, say })
  .catch(err => { log.error(err.message); process.exitCode = 1; return null })
if (!got) return

echo(chalk`  {green ✓} {bold Archive taken ${got.manifest.takenAt}} {dim unpacked into} ${got.dir}`)
echo(chalk`    {dim ·} ${plural(got.manifest.files.length, 'file')} {dim match manifest.json}`)
echo(chalk`    {dim ·} {dim key} ${got.manifest.encryptionKeyFingerprint?.slice(0, 12) ?? 'the development placeholder'}\n`)
```
