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
import { homedir } from 'os'
import { resolve } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
</script>

```js
const { getConfig } = await import(resolve(global.fliRoot, 'core/config.js'))
const { editor: configEditor } = getConfig()
const editor     = configEditor || process.env.EDITOR || process.env.VISUAL || 'vi'
const configDir  = resolve(homedir(), '.config', 'fli')
const configFile = resolve(configDir, '.env')

if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
if (!existsSync(configFile)) {
  writeFileSync(configFile, '# FLI global environment\n# Add env vars here that apply across all projects\n', 'utf8')
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
  context.exec({ command: `${editor} "${configFile}"` })
}
```
