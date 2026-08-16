---
title: extension:audit
description: Compare declared permissions against the chrome.* calls in the built bundles
alias: ext-audit
examples:
  - fli extension:audit
  - fli extension:audit --browser firefox
flags:
  browser:
    char: b
    type: string
    description: chrome | firefox
    defaultValue: chrome
---

Four answers, and three of them are worth acting on: **missing** (an API used
without the permission declared — it fails at runtime, on a user's machine),
**unused** (declared and never called — every one of those is a line in the
install prompt buying nothing), **unknown** (a namespace the catalog has never
heard of), and **dynamic** (`chrome[expr]`, which the scanner cannot resolve).

It reads the BUILT bundles by string match, not an AST, so minification and
jetty's own indirection are invisible to it. `permissions.audit: 'strict'` in
`config/jetty.config.js` turns the report into a failed build.

```js
context.exec({
  command: `bunx jetty-audit --root=${context.paths.extension} --browser=${flag.browser || 'chrome'}`,
  dry: flag.dry,
})
```
