---
title: 01c-files-check
description: Say so when the schema has File columns and the server env leaves FILES_PROVIDER unset
optional: true
skip: "!$.config.doApi"
---

```js
// FJS-D1549: an unbound provider is warned, never refused -- the client stores
// uploads under db/files anyway, so the only failure is not knowing it. Not
// behind 01b's `envCheck`: this has to speak on every deploy.
const { deployConf, target } = $.config
const { host, path: serverPath } = $.config.api
const { existsSync, readFileSync } = await import('fs')
const { resolve } = await import('path')

const schemaFile = resolve($.paths.db, 'schema.lite')
if (!existsSync(schemaFile)) return

const { fileColumns, filesProviderNote } = await import(new URL('file://' + global.fliRoot + '/core/env-preflight.js'))
const columns = fileColumns(readFileSync(schemaFile, 'utf8'))
if (!columns.length) return

const { configurationSet, ConfigurationError } = await import(new URL('file://' + global.fliRoot + '/core/release.js'))
const { envFile, secretsDir, dbDir } = apiFiles(deployConf, serverPath)
const machine = machineFor($, host, serverPath)

let env = ''
try {
  env = machine.capture(`cat ${envFile} 2>/dev/null || echo ''`)
} catch {
  log.warn(`Files check: could not read ${envFile} on ${host} -- skipping`)
  return
}

// A value the swap applies (deploy.configuration) or a secret file binds it too.
let set = secretNames(machine, secretsDir, log)
try {
  const conf = configurationSet(deployConf, target)
  set = [...set, ...Object.keys(conf.values), ...Object.keys(conf.secretRefs)]
} catch (err) {
  if (!(err instanceof ConfigurationError)) throw err
}

const note = filesProviderNote({ columns, env, set, dir: `${dbDir}/files` })
if (note) for (const line of note.split('\n')) log.warn(line)
```
