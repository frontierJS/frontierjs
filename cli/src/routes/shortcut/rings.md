---
title: shortcut:rings
description: fli ws:atlas --as=rings --open
alias: rings
mode: passthrough
examples:
  - fli rings
---

Runs `fli ws:atlas --as=rings --open` from the project root.

Anything typed after the name is appended verbatim, so `fli rings --as=report`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
$.exec({
  command: `${$.fli} ws:atlas --as=rings --open`,
  args:    $.forwarded,
  cwd:     $.paths.root,
  dry:     flag.dry,
})
```
