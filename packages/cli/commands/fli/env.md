---
title: fli:env
description: Open or print the FLI global env file (~/.config/fli/.env)
alias: config
examples:
  - fli config
  - fli config --print
  - fli fli:env
flags:
  print:
    char: p
    type: boolean
    description: Print the env file contents to the terminal instead of opening editor
    defaultValue: false
---

<script>
import { resolve, dirname } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
</script>

```js
const { getConfig } = await import(resolve(global.fliRoot, 'core/config.js'))
const { editor: configEditor } = getConfig()
const editor     = configEditor || process.env.EDITOR || process.env.VISUAL || 'vi'
const { globalEnvPath, GLOBAL_ENV_HEADER } = await import(resolve(global.fliRoot, 'core/global-env.js'))
const configFile = globalEnvPath()

mkdirSync(dirname(configFile), { recursive: true })
if (!existsSync(configFile)) {
  writeFileSync(configFile, GLOBAL_ENV_HEADER, 'utf8')
  log.info(`Created ${configFile}`)
}

if (flag.print) {
  const contents = readFileSync(configFile, 'utf8')
  log.info(configFile)
  echo('')
  echo(contents)
  return
}

log.info(`Opening ${configFile}`)
if (flag.dry) {
  log.dry(`${editor} "${configFile}"`)
} else {
  $.exec({ command: `${editor} "${configFile}"` })
}
```
