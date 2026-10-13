---
title: shortcut:basecamp
description: fli dev:desktop in packages/basecamp
alias: basecamp
mode: passthrough
examples:
  - fli basecamp
---

Runs `fli dev:desktop` from `packages/basecamp`.

Anything typed after the name is appended verbatim, so `fli basecamp --no-build`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
$.exec({
  command: `${$.fli} dev:desktop`,
  args:    $.forwarded,
  cwd:     `${$.paths.root}/packages/basecamp`,
  dry:     flag.dry,
})
```
