---
title: profile:open
description: Open a profile's file in $VISUAL, else $EDITOR — the one this directory spends when no name is given
examples:
  - fli profile:open acme
  - fli profile:open
args:
  -
    name: name
    description: The profile to open (default the one this directory spends)
    required: false
---

A profile with no file is refused rather than made: an editor saving a new
file writes it at the umask's mode, and a profile holds account keys.
`fli profile:create <name>` makes it at 600 first.

```js
const { badProfileName, profilePath } = await import(path.resolve(global.fliRoot, 'core/global-env.js'))

const name = arg.name || global.fliProfile?.name
if (!name) {
  log.error('this directory spends no profile — name one: fli profile:open <name>')
  process.exitCode = 1
  return
}
const bad = badProfileName(name)
if (bad) {
  log.error(bad)
  process.exitCode = 1
  return
}

const file = profilePath(name)
if (!fs.existsSync(file)) {
  log.error(`profile '${name}' has no file — make it with: fli profile:create ${name}`)
  process.exitCode = 1
  return
}

const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
echo`{dim opening} ${file} {dim in ${editor}}`
if (flag.dry) return log.dry(`${editor} "${file}"`)
$.exec({ command: `${editor} "${file}"` })
```
