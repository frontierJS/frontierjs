---
namespace: completion
description: Shell tab completion for fli — bash, zsh, and fish
---

<script>

// Default flags present on every fli command
const DEFAULT_FLAGS = ['--dry', '-d', '--test', '-t']

// What the query answers where a positional argument goes. Each generated
// script turns it into that shell's own path completion — a list of names
// printed from here would lose tilde expansion, escaping and the trailing slash.
const FILES = '__fli_files__'

// ─── Load completions ────────────────────────────────────────────────────────
// Asks the registry rather than scanning for .md files a second time. This used
// to be its own scanner, its own mtime fingerprint and its own cache file, none
// of which ever ran: the script referenced `join`, `homedir`, `existsSync` and
// `statSync` without importing any of them, so every completion command threw
// `join is not defined` and Tab produced nothing. The registry answers the same
// question and caches the same parse, so there is one owner of both now.
const loadCompletions = async () => {
  const { buildRegistry, uniqueCommands } = await import(
    new URL('file://' + global.fliRoot + '/core/registry.js')
  )
  const { flagSpelling } = await import(new URL('file://' + global.fliRoot + '/core/flags.js'))

  return uniqueCommands(buildRegistry()).map((meta) => {
    const flags = [...DEFAULT_FLAGS]
    for (const [name, def] of Object.entries(meta.flags || {})) {
      flags.push(flagSpelling(name, def))
      if (def?.char) flags.push(`-${def.char}`)
    }
    return {
      name:        meta.title,
      alias:       meta.alias || null,
      description: meta.description || '',
      args:        (meta.args || []).length,
      flags,
    }
  })
}
</script>

## Overview

```
fli completion:install          ← one-time setup (adds source line to shell config)
fli completion:generate         ← print the shell completion script
fli completion:generate --shell fish
fli completion:refresh          ← clear and rebuild the completion cache
fli completion:query "fli dep"  ← used internally by shell on every Tab press
```

After running `fli completion:install`, restart your shell (or `source ~/.zshrc` / `source ~/.bashrc`). Tab completion is now active.

## How it works

`fli completion:install` adds one line to your shell config that sources the completion script. The script defines a completion function. Every time you press Tab, the shell calls `fli completion:query` with the current command line, which asks the registry what commands and flags exist. Where the command takes an argument and the word does not start with `-`, the answer is a path, completed by the shell itself.

## Cache

Completion reads the registry, so it shares the registry's cache under `~/.fli/cache/` — one parsed frontmatter block per command file, keyed by mtime and size. A changed file is re-parsed, a new file is found by the directory walk, and neither needs a refresh. Use `fli completion:refresh` if completions feel stale, or set `FLI_NO_CACHE=1` for one run to bypass the cache entirely.
