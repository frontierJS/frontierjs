---
title: basecamp:backup
description: Fetch a Basecamp App's newest bucket archive, or take one first with --take, and unpack it under db/backups/<stamp>/
effects: downloads and unpacks the archive; with --take, first asks the App's machine for a backup
examples:
  - fli basecamp:backup
  - fli basecamp:backup --take
  - fli basecamp:backup --app <app-id> --out ./snapshot
flags:
  app:
    type: string
    description: The Basecamp App — its id, from the App's page (default is BASECAMP_APP_ID)
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
  take:
    type: boolean
    description: Back the App up now and fetch that archive, rather than the newest one already in the bucket
    defaultValue: false
  out:
    type: string
    description: The directory to unpack into (default is db/backups/<stamp>/, the archive's start time)
---

An app's data without ssh to its box: the archive Basecamp already holds in
the App's bucket, fetched by the pre-signed link the App page's Download uses,
checked against the sha256 Basecamp recorded, and unpacked. The directory
holds the `.tar.gz` and the databases in it — `<name>.db` with its `-wal`
beside it, a consistent pair.

Only an archive in a bucket can be fetched. One kept on its machine has no
link (`FJS-D1485`), so an App with no backup destination is refused, as is
one with no archive yet.

The key needs `appBackups:read`; `--take` also needs `appBackups:write` and
`apps:read`, which picks the machine the App page's Back up now picks.
Settings are read as `basecamp:live` reads them. `fli db:download` and `fli
db:import` fetch the same way when `BASECAMP_APP_ID` is set (`FJS-D1717`).

```js
const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace the app is in'); process.exitCode = 1; return }
const origin = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
const appId  = flag.app || process.env.BASECAMP_APP_ID
if (!appId) { log.error("needs --app or BASECAMP_APP_ID — the App's id, from its page in Basecamp"); process.exitCode = 1; return }

const say = (line) => echo(chalk`  {dim ${line}}`)
const got = await pullAppArchive({ origin, key, appId, take: flag.take, dbDir: $.paths.db, out: flag.out, dry: flag.dry, log, say })
  .catch(err => { log.error(err.message); process.exitCode = 1; return null })
if (!got) return

echo(chalk`\n  {green ✓} {bold Archive taken ${got.row.startedAt}} {dim unpacked into} ${got.dir}\n`)
echo.lines(got.files.map(f => chalk`    {dim ·} ${f}`))
echo('')
```
