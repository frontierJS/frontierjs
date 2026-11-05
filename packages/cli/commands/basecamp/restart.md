---
title: basecamp:restart
description: Restart Basecamp's API container over ssh and wait until the box's API answers again, reporting what its health probe said
effects: runs docker restart on Basecamp's API container over ssh, then asks the box's own /setup/probe every two seconds for up to three minutes; the API is down for the seconds between the two
examples:
  - fli basecamp:restart
  - fli basecamp:restart yuma
  - fli basecamp:restart yuma --dry
args:
  -
    name: server
    description: The box Basecamp runs on, which is also the name of its entry in basecamps.json (default deploy.server in packages/basecamp/frontier.config.js)
flags:
  basecamp:
    type: string
    description: The entry in basecamps.json whose ssh Host is restarted (default the entry named like <server>, else the only one; with several and none named, refused with the names)
    defaultValue: ''
---

The restart a person does by hand on the box, with the wait they would
otherwise do by eye. The container and port are `basecampApi()`'s reading of
`packages/basecamp/frontier.config.js`, the one `restore` and `reinstall`
make, and the box is the entry's `host`, the ssh Host it was made under. An entry with no `host` is the dev Basecamp or a CI machine's, which
has no box to ssh to, so it is refused by name.

The wait asks `/setup/probe` from the box itself, as `basecamp:restore` does,
so a container that is up but not answering is waited on, not reported as back.
The result is what the probe said (users, workspaces, a restore it is
carrying), never that the restart was asked for. A probe that has not answered
in three minutes exits 1 with the last thing it said.

`--dry` names the container and the box and runs nothing over ssh.

<script>
/** The entry to restart, or null after the refusal: no entry, or one with no ssh Host. */
const restartTarget = (name, log) => {
  let entry
  try { entry = resolveBasecamp(name || undefined) } catch (err) { log.error(err.message); process.exitCode = 1; return null }
  if (entry.host) return entry
  log.error(`Basecamp "${entry.name}" has no host in basecamps.json, and restart needs an ssh Host to reach its box (the dev Basecamp has none)`)
  process.exitCode = 1
  return null
}

/** What `/setup/probe` said, as the result line carries it. */
const saidBy = (probe) => [
  plural(probe.users, 'user'),
  plural(probe.workspaces, 'workspace'),
  probe.needs_setup && 'waiting for setup',
  probe.restore && `restore ${probe.restore}`,
].filter(Boolean).join(', ')

</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:restart <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const entry = restartTarget(entryFor(flag.basecamp, server), log)
if (!entry) return

const { container, port } = await basecampApi()

echo`
  {bold Restarting Basecamp}
    {dim entry     } ${entry.name}
    {dim host      } ${entry.host}
    {dim container } ${container}
    {dim port      } ${port}`
if (flag.dry) { log.dry(`restart ${container} on ${entry.host} over ssh and wait for /setup/probe to answer`); return }

try {
  const began = Date.now()
  await restartApi({ host: entry.host, container })
  echo`  {dim restarted ${container}; waiting for /setup/probe}`
  const probe = await probeUntil({ host: entry.host, port, until: () => true })
  echo`  {green ✓} {bold Basecamp on ${entry.host} answered after ${((Date.now() - began) / 1000).toFixed(1)}s} {dim — ${saidBy(probe)}}
`
} catch (err) { log.error(err.message); process.exitCode = 1 }
```
