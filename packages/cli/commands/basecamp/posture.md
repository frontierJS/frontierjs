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
  basecamp:
    type: string
    description: The Basecamp to call, by its name in basecamps.json (default the only one; with several and none named, refused with the names)
    defaultValue: ''
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

The key is the Basecamp's entry in `basecamps.json`, chosen by `--basecamp`; it needs `serverPostures:read`, which `fli basecamp:key` mints.

```js
const target = reach(flag.basecamp, log)
if (!target) return
const { url: origin, apiKey: key } = target
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
