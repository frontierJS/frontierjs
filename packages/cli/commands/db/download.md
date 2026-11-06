---
title: db:download
description: Download the app's database to db/backups/ — through Basecamp when BASECAMP_APP_ID is set, over ssh otherwise
alias: db-download
examples:
  - fli db:download
  - fli db:download --take
  - fli db:download --dev
  - fli db:download --dry
flags:
  dev:
    type: boolean
    description: Download from the dev server instead of production — with BASECAMP_APP_ID set, the project's development App
    defaultValue: false
  basecamp:
    type: string
    description: The Basecamp holding the App, by its name in basecamps.json (default the only one; with several and none named, refused with the names) — Basecamp only
    defaultValue: ''
  take:
    type: boolean
    description: Back the App up now and fetch that archive, rather than the newest one already in its bucket (Basecamp only)
    defaultValue: false
---

With `BASECAMP_APP_ID` set, the project's production App's newest bucket
archive (`--dev`: its development App's) is fetched and unpacked under `db/backups/<stamp>/`, or one taken now with `--take`; with no
archive in a bucket it refuses, and never falls back to ssh (`FJS-D1717`).
This is the one command that takes an App's archive (`FJS-D1848`);
the Basecamp is an entry in `basecamps.json` (`--basecamp` names it; the local
dev Basecamp is the reserved entry `dev`, written in by hand), and its key —
the entry's `scopedKey`, else its `apiKey` — needs `appBackups:read`, and
`--take` also `appBackups:write` and `apps:read`. Finding the App reads
`/apps` and `/environments` with the entry's `apiKey` (`apps:read`,
`environments:read`), since the narrow key does not cover them (`FJS-D1965`). Otherwise `production.db*` is copied by
scp from `PROD_SERVER` (or `DEV_SERVER` with `--dev`) at its `*_SERVER_PATH`.

```js
const env    = $.env
const dbPath = $.paths.db
if (!dbPath) { log.error('DB path not configured'); return }

const appId = pullPath({ flag, log, echo, chalk })
if (appId === false) { process.exitCode = 1; return }
if (appId) {
  if (!await pullThroughBasecamp({ $, flag, log, echo, chalk }, appId) && !flag.dry) process.exitCode = 1
  return
}

const server     = flag.dev ? env.DEV_SERVER     : env.PROD_SERVER
const serverPath = flag.dev ? env.DEV_SERVER_PATH : env.PROD_SERVER_PATH

if (!server) {
  log.error(`${flag.dev ? 'DEV' : 'PROD'}_SERVER not set in .env`)
  process.exitCode = 1
  return
}

echo(chalk`  {dim Downloading production.db from} ${server}`)
$.exec({
  command: `scp ${server}:${serverPath}/db/production.db* ${dbPath}/backups/.`,
  dry: flag.dry
})
if (!flag.dry) echo(chalk`  {green ✓} {dim downloaded into} ${dbPath}/backups`)
```
