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
$.exec({
  command: `${$.fli} ws:atlas --open --live`,
  args:    $.forwarded,
  cwd:     $.paths.root,
  dry:     flag.dry,
})
```
