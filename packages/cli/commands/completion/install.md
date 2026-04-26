---
title: completion:install
description: Add fli tab completion to your shell — one-time setup
alias: ci
examples:
  - fli completion:install
  - fli completion:install --shell zsh
  - fli completion:install --shell bash
  - fli completion:install --shell fish
flags:
  shell:
    char: s
    type: string
    description: "Shell to configure: bash | zsh | fish (default: auto-detect)"
    defaultValue: ''
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const detectShell = () => {
  const shell = process.env.SHELL || ''
  if (shell.includes('zsh'))  return 'zsh'
  if (shell.includes('fish')) return 'fish'
  if (shell.includes('bash')) return 'bash'
  return 'bash'
}

const getShellConfig = (shell) => {
  const home = homedir()
  switch (shell) {
    case 'zsh':  return join(home, '.zshrc')
    case 'fish': return join(home, '.config', 'fish', 'config.fish')
    case 'bash':
    default: {
      // Prefer .bash_profile on macOS, .bashrc on Linux
      const profile = join(home, '.bash_profile')
      const rc      = join(home, '.bashrc')
      return existsSync(profile) ? profile : rc
    }
  }
}

const getSourceLine = (shell) => {
  switch (shell) {
    case 'fish':
      // Fish uses a completions directory, not eval
      return `# fli completions are in ~/.config/fish/completions/fli.fish`
    case 'zsh':
      return `eval "$(fli completion:generate --shell zsh)"`
    case 'bash':
    default:
      return `eval "$(fli completion:generate --shell bash)"`
  }
}

const MARKER = '# fli tab completion'
</script>

```js
const shell      = flag.shell || detectShell()
const configFile = getShellConfig(shell)
const sourceLine = getSourceLine(shell)

log.info(`Shell:  ${shell}`)
log.info(`Config: ${configFile}`)

// ── Fish: write to completions directory ──────────────────────────────────────
if (shell === 'fish') {
  const { mkdirSync } = await import('fs')
  const { join }      = await import('path')
  const { homedir }   = await import('os')

  const fishDir  = join(homedir(), '.config', 'fish', 'completions')
  const fishFile = join(fishDir, 'fli.fish')

  if (flag.dry) {
    log.dry(`Would write fish completions to: ${fishFile}`)
    return
  }

  mkdirSync(fishDir, { recursive: true })
  context.exec({ command: `fli completion:generate --shell fish > "${fishFile}"` })
  log.success(`Fish completions written → ${fishFile}`)
  log.info(`Completions are active in new fish sessions automatically.`)
  return
}

// ── Bash / Zsh: append eval line to shell config ─────────────────────────────
if (flag.dry) {
  log.dry(`Would append to ${configFile}:`)
  log.dry(`  ${MARKER}`)
  log.dry(`  ${sourceLine}`)
  return
}

// Check if already installed
if (existsSync(configFile)) {
  const contents = readFileSync(configFile, 'utf8')
  if (contents.includes(MARKER)) {
    log.warn(`fli completion is already installed in ${configFile}`)
    log.info(`Run: source ${configFile}  (or restart your shell)`)
    return
  }
}

// Append the source block
const block = `\n${MARKER}\n${sourceLine}\n`

try {
  const existing = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  writeFileSync(configFile, existing + block, 'utf8')
  log.success(`Completion installed → ${configFile}`)
  log.info('')
  log.info(`Activate now:  source ${configFile}`)
  log.info(`Or restart your shell.`)
  log.info('')
  log.info(`Test it:  fli <TAB>`)
} catch (err) {
  log.error(`Could not write to ${configFile}: ${err.message}`)
  log.info('')
  log.info(`Add this line manually to ${configFile}:`)
  log.info(`  ${sourceLine}`)
}
```
