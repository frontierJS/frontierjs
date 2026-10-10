---
namespace: completion
description: Shell tab completion for fli — bash, zsh, and fish
---

<script>

// What the query answers where a path or a directory goes. Each generated
// script turns it into that shell's own completion — a list of names printed
// from here would lose tilde expansion, escaping and the trailing slash.
const ANSWER = { path: '__fli_path__', dir: '__fli_dir__' }

const core = (file) => import(new URL('file://' + global.fliRoot + '/core/' + file))

// One candidate per line, its description after a tab. Bash drops the
// description; zsh and fish print it beside the candidate.
const described = (value, description) => {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim()
  return text ? `${value}\t${text}` : String(value)
}

const takesValue = (def) => Boolean(def?.type) && def.type !== 'boolean'

// ─── Load completions ────────────────────────────────────────────────────────
// Asks the registry rather than scanning for .md files a second time; the
// registry caches the same parse.
const loadCompletions = async () => {
  const { buildRegistry, uniqueCommands } = await core('registry.js')
  const { flagSpelling, DEFAULT_FLAGS }   = await core('flags.js')

  return uniqueCommands(buildRegistry()).map((meta) => {
    const flags = []
    for (const name of new Set([...Object.keys(DEFAULT_FLAGS), ...Object.keys(meta.flags || {})])) {
      const def = { ...DEFAULT_FLAGS[name], ...meta.flags?.[name] }
      flags.push({ spelling: flagSpelling(name, def), def })
      if (def.char) flags.push({ spelling: `-${def.char}`, def })
    }
    return {
      name:        meta.title,
      alias:       meta.alias || null,
      description: meta.description || '',
      args:        meta.args || [],
      flags,
    }
  })
}

const commandLines = (commands) => commands.flatMap(c =>
  [c.name, c.alias].filter(Boolean).map(n => described(n, c.description)))

// ─── What a value can be ─────────────────────────────────────────────────────
// `choices` first, then the declared `kind` (KINDS in core/flags.js), then
// nothing: an argument that does not say what it names offers no guess.
const valuesFor = async (def, commands) => {
  if (Array.isArray(def.choices)) return def.choices.map(String)
  switch (def.kind) {
    case 'path': return [ANSWER.path]
    case 'dir':  return [ANSWER.dir]
    case 'model': {
      const { appSchemaModels } = await core('app-schema.js')
      return appSchemaModels(global.projectRoot)
        .map(m => described(m.name, m.origin === 'app' ? '' : m.origin))
    }
    case 'package': {
      const { findWorkspaceRoot } = await core('utils.js')
      const { workspaceDeps }     = await core('runnables.js')
      const root = findWorkspaceRoot(process.cwd())
      return root ? [...workspaceDeps(root)].map(([folder, m]) => described(folder, m.name)) : []
    }
    case 'command': return commandLines(commands)
  }
  return []
}

// What goes at the cursor once `cmd` is on the line: `after` is the words
// typed since it, `cur` the word being typed.
const answerFor = (cmd, after, cur, commands) => {
  const flagLines = () => cmd.flags.map(f => described(f.spelling, f.def.description))
  const flagNamed = (word) => cmd.flags.find(f => f.spelling === word)

  if (cur.startsWith('-')) return flagLines()

  const prev = flagNamed(after.at(-1))
  if (prev && takesValue(prev.def)) return valuesFor(prev.def, commands)

  // A flag's value is not a positional, or `--shell zsh foo` counts zsh as one.
  let position = 0
  for (let i = 0; i < after.length; i++) {
    if (!after[i].startsWith('-')) { position++; continue }
    if (takesValue(flagNamed(after[i])?.def)) i++
  }
  const last = cmd.args.at(-1)
  const def  = cmd.args[position] ?? (last?.variadic ? last : null)
  return def ? valuesFor(def, commands) : flagLines()
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

`fli completion:install` adds one line to your shell config that sources the completion script. The script defines a completion function. Every time you press Tab, the shell calls `fli completion:query` with the current command line, which asks the registry what commands and flags exist. zsh and fish show each one's description beside it.

What goes where an argument or a flag's value is typed comes from its declaration: `choices` offers those values, and `kind` names what the value is — `path` and `dir` hand over to the shell's own completion, `model` offers the app's models, `package` the workspace's packages, `command` fli's commands. An argument that declares neither offers nothing. A word starting with `-` always offers flags.

## Cache

Completion reads the registry, so it shares the registry's cache under `~/.fli/cache/` — one parsed frontmatter block per command file, keyed by mtime and size. A changed file is re-parsed, a new file is found by the directory walk, and neither needs a refresh. Use `fli completion:refresh` if completions feel stale, or set `FLI_NO_CACHE=1` for one run to bypass the cache entirely.
