---
title: shortcut:fix-s4
description: Work the S4 rows down with fix-loop, 75 at most; --rows/--lanes/--budget pass through
alias: vladify
mode: passthrough
examples:
  - fli fix-s4
---

Runs `bun run fix:loop -- --sev S4 --rows 75` from the project root.

Anything typed after the name is appended verbatim, so `fli fix-s4 --as=report`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
// fli has already read the argv into `flag`, so forwarding `flag`
// would send fli's own defaults (--dry, --test) to a command that never
// asked for them. The raw tail is the only faithful copy of what was typed.
const q     = (a) => "'" + a.split("'").join("'\\''") + "'"
const extra = process.argv.slice(3).map(q).join(' ')

$.exec({
  command: `bun run fix:loop -- --sev S4 --rows 75${extra ? ' ' + extra : ''}`,
  cwd:     $.paths.root,
  dry:     flag.dry,
})
```
