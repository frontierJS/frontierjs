---
title: cloudflare:tui
description: Browse and edit a zone's DNS records — the console on its :dns pane
alias: dns
effects: adds, edits and deletes DNS records at Cloudflare, and turns a record's proxy on or off, each only after it is shown and confirmed in the pane
examples:
  - fli dns
  - fli dns --open
  - fli dns --port 7599
flags:
  port:
    char: p
    type: number
    description: Port the console listens on — default is fli gui's
    defaultValue: 0
  open:
    char: o
    type: boolean
    description: Open the pane in your browser instead of this terminal
    defaultValue: false
---

`fli gui :dns`: accounts, then zones, then records, over the `cf` login (§
Setup). A write is shown before it is sent, and one to a record `basecamp:dns`
marked warns that the next sync puts it back.

Run as a child of this fli rather than imported: `fli gui` owns the port, the
server and the terminal, and a second copy of that here would drift from it.

```js
const { spawnSync } = await import('node:child_process')
const { resolve }   = await import('node:path')

const argv = ['gui', ':dns', ...(flag.open ? ['--open'] : []), ...(flag.port ? ['--port', String(flag.port)] : [])]
if (flag.dry) {
  log.dry(`Would run fli ${argv.join(' ')}`)
  return
}
const r = spawnSync(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), ...argv],
  { cwd: $.paths.root, stdio: 'inherit', env: process.env })
process.exitCode = r.status ?? 1
```
