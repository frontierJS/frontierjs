---
title: completion:query
description: Return completions for the current command line (called by shell on Tab)
alias: cq
examples:
  - fli completion:query "fli "
  - fli completion:query "fli dep"
  - fli completion:query "fli deploy:logs "
  - fli completion:query "fli deploy:logs --"
  - fli completion:query "fli make:factory "
args:
  -
    name: line
    description: Current command line up to the cursor
    required: false
---

```js
// The shell passes the command line up to the cursor as one string. Split on
// whitespace only: a colon is part of a command name.
const rawLine  = arg.line || ''
const words    = rawLine.trim().split(/\s+/).filter(Boolean)
const trailing = /\s$/.test(rawLine)

// A trailing space means a fresh word is starting, so every word is done.
const doneWords = trailing ? words.slice(1) : words.slice(1, -1)
const cur       = trailing ? '' : words.at(-1) ?? ''

const commands = await loadCompletions()
const byName   = new Map(commands.flatMap(c => [c.name, c.alias].filter(Boolean).map(n => [n, c])))
const at       = doneWords.findIndex(w => byName.has(w))

const out = at === -1
  ? commandLines(commands)
  : await answerFor(byName.get(doneWords[at]), doneWords.slice(at + 1), cur, commands)

if (out.length) process.stdout.write(out.join('\n') + '\n')
```
