---
title: extension:build
description: Build the extension for Chrome, Firefox, or both
alias: ext-build
examples:
  - fli extension:build
  - fli extension:build --browser both
flags:
  browser:
    char: b
    type: string
    description: chrome | firefox | both
    defaultValue: chrome
  verbose:
    type: boolean
    description: Print the discovery summary and every emitted file
    defaultValue: false
---

One source tree, two manifests. `--browser both` emits `dist/chrome/` and
`dist/firefox/` from the same `config/jetty.config.js`; the fields that differ
(background form, minimum version, the gecko id AMO identifies the add-on by)
are the two blocks at the bottom of that file.

Load the result unpacked — `extension/test/README.md` says how, and what to
check by hand once it is loaded.

```js
const cliArgs = [`--root=${context.paths.extension}`, `--browser=${flag.browser || 'chrome'}`]
if (flag.verbose) cliArgs.push('--verbose')
context.exec({ command: `bunx jetty-build-ext ${cliArgs.join(' ')}`, dry: flag.dry })
```
