---
title: widgets:build
description: Build one embeddable script per widget in widgets/src/Embeds/
alias: widgets-build
examples:
  - fli widgets:build
  - fli widgets:build --dry
---

Each widget is its own library build — a self-contained IIFE carrying its
runtime and its CSS, because the page loading it has no bundler and Vite's
library mode takes one entry. N widgets is N builds; `sierra widgets` runs the
loop.

```js
$.exec({
  command: `${$.bin('sierra', $.paths.widgets)} widgets --config config/sierra.config.js`,
  cwd:     $.paths.widgets,
  dry:     flag.dry,
})
```
