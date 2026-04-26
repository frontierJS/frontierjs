---
title: fli:setup
description: Show setup instructions for adding fli to your PATH
alias: setup
examples:
  - fli setup
  - fli setup --apply
flags:
  apply:
    char: a
    type: boolean
    description: Automatically append the PATH export to your shell rc file
    defaultValue: false
---

<script>
import { homedir } from 'os'
import { resolve } from 'path'
import { existsSync, readFileSync, appendFileSync } from 'fs'
import { execSync } from 'child_process'

const detectShellRc = () => {
  const home  = homedir()
  const shell = process.env.SHELL || ''
  if (shell.includes('zsh'))  return resolve(home, '.zshrc')
  if (shell.includes('fish')) return resolve(home, '.config', 'fish', 'config.fish')
  return resolve(home, '.bashrc')  // default
}

const EXPORT_LINE = 'export PATH="$HOME/.bun/bin:$PATH"'
const FISH_LINE   = 'set -gx PATH $HOME/.bun/bin $PATH'
</script>

Checks your PATH for `~/.bun/bin` and shows what to add to your shell config
if it's missing. Pass `--apply` to write it automatically.

```js
const home   = homedir()
const bunBin = resolve(home, '.bun', 'bin')
const rcFile = detectShellRc()
const isFish = rcFile.includes('fish')
const line   = isFish ? FISH_LINE : EXPORT_LINE

// Check if already on PATH
const onPath = (process.env.PATH || '').split(':').includes(bunBin)

// Check if already in rc file
const rcExists  = existsSync(rcFile)
const rcContent = rcExists ? readFileSync(rcFile, 'utf8') : ''
const inRc      = rcContent.includes('.bun/bin')

echo('')

if (onPath) {
  log.success(`~/.bun/bin is already on your PATH`)
} else {
  log.warn(`~/.bun/bin is not on your PATH`)
}

echo('')
echo(`  Shell rc:  ${rcFile}`)
echo(`  bun bin:   ${bunBin}`)
echo('')

if (inRc) {
  log.info('PATH export already found in ' + rcFile)
} else {
  echo('  Add this to ' + rcFile + ':')
  echo('')
  echo('    ' + line)
  echo('')
  echo('  Then reload:')
  echo('    source ' + rcFile)
  echo('')
}

if (flag.apply) {
  if (inRc) {
    log.info('Already present — nothing to add')
    return
  }
  if (flag.dry) {
    log.dry(`Would append to ${rcFile}:  ${line}`)
    return
  }
  appendFileSync(rcFile, `\n# Added by fli setup\n${line}\n`, 'utf8')
  log.success(`Added to ${rcFile}`)
  log.info(`Run:  source ${rcFile}`)
  return
}

if (!onPath && !inRc) {
  log.info('Run with --apply to add it automatically')
}
```
