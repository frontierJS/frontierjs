---
namespace: completion
description: Shell tab completion for fli — bash, zsh, and fish
---

<script>

const CACHE_DIR  = join(homedir(), '.fli')
const CACHE_FILE = join(CACHE_DIR, 'completion-cache.json')

// Default flags present on every fli command
const DEFAULT_FLAGS = ['--dry', '-d', '--test', '-t']

// ─── Filesystem scanner ───────────────────────────────────────────────────────
// Recursively finds all .md command files, excluding steps and module files.
const scanCommandFiles = (dir) => {
  const results = []
  if (!existsSync(dir)) return results
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...scanCommandFiles(full))
      } else if (
        entry.name.endsWith('.md') &&
        !entry.name.startsWith('_') &&
        !full.includes('_steps')
      ) {
        results.push(full)
      }
    }
  } catch {}
  return results
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────
// Hash of all command file paths + mtimes. Changes whenever any .md file is
// added, removed, or modified — triggers a cache rebuild on the next Tab press.
const buildFingerprint = (dirs) => {
  const parts = []
  for (const dir of dirs) {
    for (const filePath of scanCommandFiles(dir)) {
      try {
        parts.push(`${filePath}:${statSync(filePath).mtimeMs}`)
      } catch {}
    }
  }
  parts.sort()
  return createHash('md5').update(parts.join('\n')).digest('hex').slice(0, 12)
}

// ─── Cache read/write ─────────────────────────────────────────────────────────
const readCompletionCache = (dirs) => {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    if (cache.fingerprint !== buildFingerprint(dirs)) return null
    return cache
  } catch { return null }
}

const writeCompletionCache = (commands, dirs) => {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify({
      fingerprint: buildFingerprint(dirs),
      commands,
    }), 'utf8')
  } catch {}
}

// ─── Command list builder ─────────────────────────────────────────────────────
// Reads only frontmatter — no compilation, no module loading.
// Called only on cache miss (first run, or after command files change).
const buildCompletionCommands = async (dirs) => {
  const { extractFrontmatter } = await import(
    new URL('file://' + global.fliRoot + '/core/compiler.js')
  )
  const commands = []
  const seen = new Set()

  for (const dir of dirs) {
    for (const filePath of scanCommandFiles(dir)) {
      try {
        const raw  = readFileSync(filePath, 'utf8')
        const meta = extractFrontmatter(raw)
        if (!meta.title || seen.has(meta.title)) continue
        seen.add(meta.title)

        // Extract flag names and short chars from frontmatter
        const flags = [...DEFAULT_FLAGS]
        for (const [name, def] of Object.entries(meta.flags || {})) {
          flags.push(`--${name}`)
          if (def?.char) flags.push(`-${def.char}`)
        }

        commands.push({
          name:        meta.title,
          alias:       meta.alias || null,
          description: meta.description || '',
          flags,
        })
      } catch {}
    }
  }

  return commands
}

// ─── Command dirs ─────────────────────────────────────────────────────────────
// global.fliConfig is populated by bootstrap.js before any command runs.
const getCompletionDirs = () => {
  const routesDir = global.fliConfig?.routesDir ?? 'cli/src/routes'
  return [
    resolve(global.fliRoot, 'commands'),
    resolve(global.projectRoot, routesDir),
  ]
}

// ─── Load completions (cache-first) ──────────────────────────────────────────
// Returns the commands array, hitting the disk cache when possible.
const loadCompletions = async () => {
  const dirs     = getCompletionDirs()
  const cached   = readCompletionCache(dirs)
  if (cached) return cached.commands

  const commands = await buildCompletionCommands(dirs)
  writeCompletionCache(commands, dirs)
  return commands
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

`fli completion:install` adds one line to your shell config that sources the completion script. The script defines a completion function. Every time you press Tab, the shell calls `fli completion:query` with the current command line. This command reads a disk cache at `~/.fli/completion-cache.json` — if the cache is fresh (no command files have changed) it returns completions in milliseconds. If any `.md` file has been added or changed, the cache is rebuilt transparently before returning.

## Cache

The cache lives at `~/.fli/completion-cache.json`. It is keyed by a fingerprint of all command file paths and their modification times. It rebuilds automatically — you should never need to manage it manually. Use `fli completion:refresh` after installing new fli packages or if completions feel stale.
