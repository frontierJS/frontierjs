---
title: shortcut:fix-s4
description: Work the S4 rows down with fix-loop, 75 at most, two lanes; --rows/--lanes/--budget pass through
alias: vladify
mode: passthrough
examples:
  - fli fix-s4
---

Runs `bun run fix:loop -- --sev S4 --rows 75 --lanes 2` from the project root.

Anything typed after the name is appended verbatim, so `fli fix-s4 --as=report`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
$.exec({
  command: `bun run fix:loop -- --sev S3,S4 --rows 75 --lanes 2`,
  args:    $.forwarded,
  cwd:     $.paths.root,
  dry:     flag.dry,
})
```
