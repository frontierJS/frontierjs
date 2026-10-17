---
title: 05-files
description: Delete the deploy root on every machine — with the database and env file, unless --keep-data
---

```js
if ($.config.abort) return

const { sides, dbDir, envFile, api } = $.config
const { shQuote } = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
const keep = $.flag['keep-data']

// The container wrote the database as the image's uid, so a login that is not
// that uid cannot remove it without sudo — the same fallback 03-directories
// takes for the chown.
const remove = (paths) => {
  const list = paths.map(shQuote).join(' ')
  return `rm -rf ${list} 2>/dev/null || sudo rm -rf ${list}`
}

for (const s of sides) {
  const machine = machineFor($, s.host, s.path)
  if (!keep) {
    const extra = s.host === api.host && s.path === api.path ? [dbDir, envFile] : []
    machine.run(remove([s.path, ...extra]))
    log.success(`  Removed ${s.host}:${s.path}${extra.length ? `, ${dbDir} and ${envFile}` : ''}`)
    continue
  }
  // What a deploy writes beside the data, by name: the lock goes last, in
  // 06-cleanup, because releasing it is a write into .fli.
  const ours = ['src', 'releases', 'current', 'deploy', '.litestone'].map(n => `${s.path}/${n}`)
  machine.run(remove(ours))
  log.success(`  Removed the source and web releases from ${s.host}:${s.path} — ${dbDir} and ${envFile} kept`)
}
$.config.filesRemoved = !keep
```
