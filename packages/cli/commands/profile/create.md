---
title: profile:create
description: Make a profile — ~/.config/fli/profiles/<name>.env, empty, at mode 600
examples:
  - fli profile:create acme
args:
  -
    name: name
    description: The profile's name — lowercase letters, digits and dashes
    required: true
---

The file starts as its header alone; `fli eset <KEY> <value> --profile <name>`
fills it, and `fli profile:open <name>` edits it. A name that already has a
file is left as it is.

```js
const { createProfile, badProfileName, profilePath } = await import(path.resolve(global.fliRoot, 'core/global-env.js'))

const bad = badProfileName(arg.name)
if (bad) {
  log.error(bad)
  process.exitCode = 1
  return
}

const home  = process.env.HOME ?? ''
const shown = (p) => home && p.startsWith(home) ? '~' + p.slice(home.length) : p

if (flag.dry) return log.dry(`Would make ${shown(profilePath(arg.name))} at mode 600`)

const { file, made } = createProfile(arg.name)
echo(made
  ? chalk`{green ✓} profile {bold ${arg.name}} {dim at ${shown(file)}}`
  : chalk`{dim profile} {bold ${arg.name}} {dim already exists at ${shown(file)} — left as it is}`)
echo`  {dim add a key}   fli eset <KEY> <value> --profile ${arg.name}`
echo`  {dim edit it}     fli profile:open ${arg.name}`
echo`  {dim spend it}    FLI_PROFILE=${arg.name} {dim in a project's .env}`
```
