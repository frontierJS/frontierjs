---
title: shortcut:go-time
description: fli ws:atlas --open --live
alias: go-time
mode: passthrough
examples:
  - fli go-time
---

Runs `fli ws:atlas --open --live` from the project root.

Anything typed after the name is appended verbatim, so `fli go-time --as=report`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
// minimist has already read the argv into `flag`, so forwarding `flag`
// would send fli's own defaults (--dry, --test) to a command that never
// asked for them. The raw tail is the only faithful copy of what was typed.
const q     = (a) => "'" + a.split("'").join("'\\''") + "'"
const extra = process.argv.slice(3).map(q).join(' ')

context.exec({
  command: `${context.fli} ws:atlas --open --live${extra ? ' ' + extra : ''}`,
  cwd:     context.paths.root,
  dry:     flag.dry,
})
```
