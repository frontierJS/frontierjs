---
title: basecamp:posture
description: Each machine's security grade as Basecamp stored it — one line per server, or every control of one with its fix
effects: reads only
examples:
  - fli basecamp:posture
  - fli basecamp:posture yuma
  - fli basecamp:posture <server-id> --json
args:
  -
    name: server
    description: One server, by its id or name in Basecamp; with none, one line per server
flags:
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
  json:
    type: boolean
    description: Print what Basecamp answered, as JSON
    defaultValue: false
---

The Security screen on a command line. Basecamp grades each Outpost's report
when it lands and this prints that grade with the report's age; nothing here
grades a control, so it agrees with `/security/` and `/hub/security/`. A
server with no report, or one too old to trust, reads `unknown`, never ok.

Basecamp's own box, marked ⛺, carries the `hub.*` controls only when the
key's holder is a system admin. Any other key reads that box as a fleet row
without them.

The key needs `serverPostures:read`; `fli basecamp:key` mints one that has it.

```js
const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — fli basecamp:key mints one, or issue one at /api-keys/ in the Basecamp workspace'); process.exitCode = 1; return }
const origin = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
const server = String(arg.server ?? '').trim()

if (!server) {
  const { servers } = await readPostures(origin, key)
  if (flag.json) { echo(JSON.stringify(servers, null, 2)); return }
  if (!servers.length) { echo`\n  {dim No servers in this workspace.}\n`; return }
  echo``
  echo.lines(servers.map(postureLine))
  echo``
  if (servers.some(s => Object.keys(failingBySeverity(s)).length)) process.exitCode = 1
  return
}

const view = await readPosture(origin, key, server)
if (!view) { log.error(`No server '${server}' in this key's workspace — fli basecamp:posture lists them`); process.exitCode = 1; return }
if (flag.json) { echo(JSON.stringify(view, null, 2)); return }
echo``
echo.lines(postureDetail(view))
echo``
if (Object.keys(failingBySeverity(view)).length) process.exitCode = 1
```
