---
title: shortcut:vlad-frontend-fixes
description: Work the open ui and css rows down with fix-loop, 40 at most; --rows/--lanes/--budget pass through
alias: vlad-frontend-fixes
mode: passthrough
examples:
  - fli vlad-frontend-fixes
  - fli vlad-frontend-fixes --sev S3 --lanes 2
---

Runs `bun run fix:loop -- --pkg ui,css --rows 40` from the project root.

Frontend only: a row names `ui` or `css` in its Pkg column, and the loop never
runs two rows in one package at once under `--lanes`. A row that also names
`litestone`, `junction` or `auth` is still picked, so check `git status` in
those packages first or pass `--ids` to name the rows.

Anything typed after the name is appended verbatim, so `fli vlad-frontend-fixes --sev S3`
reaches the target command. `--help` does not: fli answers that itself, and
the answer is this file.

An ordinary command file — a shortcut that grows into a command is an edit
here, not a migration.

```js
$.exec({
  command: `bun run fix:loop -- --pkg ui,css --rows 40`,
  args:    $.forwarded,
  cwd:     $.paths.root,
  dry:     flag.dry,
})
```
