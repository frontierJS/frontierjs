---
title: extension:dev
description: Watch the extension surface and push reloads to the loaded-unpacked build
alias: ext-dev
examples:
  - fli extension:dev
  - fli extension:dev --browser both --launch
flags:
  browser:
    char: b
    type: string
    description: chrome | firefox | both
    defaultValue: chrome
  launch:
    type: boolean
    description: Launch a browser with the extension already loaded
    defaultValue: false
  verbose:
    type: boolean
    description: Print every classified change
    defaultValue: false
---

There is no page to open — an extension is loaded into a profile, and what this
serves is a reload signal. Port 8400 is `dev / ext / project 0`, declared in
`config/jetty.config.js` under `dev.port`, and the built extension connects back
to it.

```js
const cliArgs = [`--root=${context.paths.extension}`, `--browser=${flag.browser || 'chrome'}`]
if (flag.launch)  cliArgs.push('--launch')
if (flag.verbose) cliArgs.push('--verbose')
context.exec({ command: `bunx jetty-dev-ext ${cliArgs.join(' ')}`, dry: flag.dry })
```
