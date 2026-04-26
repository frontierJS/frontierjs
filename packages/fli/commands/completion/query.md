---
title: completion:query
description: Return completions for the current command line (called by shell on Tab)
alias: cq
examples:
  - fli completion:query "fli "
  - fli completion:query "fli dep"
  - fli completion:query "fli deploy:logs "
  - fli completion:query "fli deploy:logs --"
args:
  -
    name: line
    description: Current command line up to the cursor
    required: false
---

```js
// ─── Parse the command line ───────────────────────────────────────────────────
// The shell passes the command line up to the cursor as a single string.
// We split on whitespace (preserving colons — that's the whole point) to
// determine whether we're completing a command name or flags.

const rawLine  = arg.line || ''
const words    = rawLine.trim().split(/\s+/).filter(Boolean)
const trailing = /\s$/.test(rawLine)  // true if user hit space after last word

// Words that have been fully typed (not the partial being completed right now)
// trailing space means we're starting a fresh word — all existing words are "done"
const doneWords = trailing ? words.slice(1) : words.slice(1, -1)

// ─── Load completions ─────────────────────────────────────────────────────────
const commands = await loadCompletions()

// ─── Determine what to complete ───────────────────────────────────────────────
// Build a lookup of all known command names + aliases
const knownNames = new Set(
  commands.flatMap(c => [c.name, c.alias].filter(Boolean))
)

// If any already-typed word matches a known command, complete flags for it.
// Otherwise, complete command names.
const typedCommand = doneWords.find(w => knownNames.has(w))

if (typedCommand) {
  const cmd = commands.find(c => c.name === typedCommand || c.alias === typedCommand)
  if (cmd?.flags?.length) {
    process.stdout.write(cmd.flags.join('\n') + '\n')
  }
} else {
  const names = commands.flatMap(c => [c.name, c.alias].filter(Boolean))
  process.stdout.write(names.join('\n') + '\n')
}
```
