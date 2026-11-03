---
title: outpost:logs
description: An app's container logs on a fleet box, or a unit's journal, over ssh
examples:
  - fli outpost:logs box1
  - fli outpost:logs box1 nela
  - fli outpost:logs box1 caddy-api --follow
  - fli outpost:logs box1 a1b2c3d4 --tail 500
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host"
  -
    name: what
    description: "An App: its id, a prefix of it, or a word of its container name. Or a unit: outpost, caddy-api, basecamp-litestream, basecamp-firewall, docker. Omitted, the Outpost's own journal"
flags:
  follow:
    char: f
    type: boolean
    description: Stream logs (follow mode — Ctrl+C to stop)
    defaultValue: false
  tail:
    char: n
    type: string
    description: Number of lines to show from the end
    defaultValue: '200'
---

<script>
const UNITS = ['outpost', 'caddy-api', 'basecamp-litestream', 'basecamp-firewall', 'docker']

/** `{ id, name, state }` per container an App has on the box, by its label. */
function containersOn(machine, sudo) {
  const out = machine.capture(`${sudo}\nsudo docker ps -a --filter label=fjs.app --format '{{.Label "fjs.app"}}\t{{.Names}}\t{{.State}}'`)
  return out.split('\n').filter(Boolean).map(l => { const [id, name, state] = l.split('\t'); return { id, name, state } })
}

/** The App `what` names, live container first: an id, an id's prefix, then a
 *  word of the name. A set-aside `_replaced` answers only when nothing live does. */
function pick(containers, what) {
  const by = (test) => containers.filter(test).sort((a, b) => a.name.endsWith('_replaced') - b.name.endsWith('_replaced'))
  for (const test of [c => c.id === what, c => c.id.startsWith(what), c => c.name.includes(what)]) {
    const hits = by(test)
    const apps = [...new Set(hits.map(c => c.id))]
    if (apps.length === 1) return { container: hits[0] }
    if (apps.length > 1) return { many: hits.filter(c => !c.name.endsWith('_replaced')) }
  }
  return { none: true }
}
</script>

The log a person reads next, after `fli outpost:status`. A container is
found by its `fjs.app` label, never its name, the rule the Outpost keeps, so
`what` matches an App's id, a prefix of it, or a word of the container name
(`fjs--<project>-<env>-<app>-<id>`), and a word two Apps share is refused with
both named. A unit's name reads its journal instead; no word reads the
Outpost's own, which is where a refused command or a failed report says why.

`docker logs` and `journalctl` run on the box as they are: nothing is parsed
here, so this is a door to the log and not a second reader of it.

```js
const { SUDO } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const { shQuote } = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))

const dest = String(arg.server ?? '').trim()
const what = String(arg.what ?? '').trim()
const tail = String(flag.tail)
if (!dest) { log.error('Pass the box: fli outpost:logs <ssh alias or user@host> [app or unit]'); process.exitCode = 1; return }
if (!/^\d+$/.test(tail)) { log.error(`--tail takes a number of lines, not ${tail}`); process.exitCode = 1; return }

const machine = createMachine({ host: dest, path: null, exec: $.exec, transport: null })
if (!machine.reach()) { log.error(`Cannot reach ${dest} over ssh`); process.exitCode = 1; return }

const unit = !what ? 'outpost' : UNITS.includes(what.replace(/\.service$/, '')) ? what.replace(/\.service$/, '') : null
let command, label
if (unit) {
  command = `sudo journalctl -u ${unit}.service -n ${tail} --no-pager${flag.follow ? ' -f' : ''}`
  label   = `${unit}.service`
} else {
  const containers = containersOn(machine, SUDO)
  if (!containers.length) { log.error(`${dest} runs no App container — one an Outpost deployed carries the fjs.app label`); process.exitCode = 1; return }
  const found = pick(containers, what)
  if (found.none) { log.error(`No App on ${dest} matches ${what} — fli outpost:status ${dest} lists them`); process.exitCode = 1; return }
  if (found.many) { log.error(`${what} matches more than one App on ${dest}: ${found.many.map(c => `${c.name} (${c.id})`).join(', ')}`); process.exitCode = 1; return }
  command = `sudo docker logs --tail ${tail}${flag.follow ? ' --follow' : ''} ${shQuote(found.container.name)}`
  label   = chalk`${found.container.name} {dim · ${found.container.state} · ${found.container.id}}`
}

echo`\n  {bold ${dest}} {dim ·} ${label}${flag.follow ? chalk` {dim · streaming, Ctrl+C to stop}` : ''}\n`
// `tty`, not `run`: --follow streams until Ctrl+C, so stdin stays the terminal.
machine.tty(`${SUDO}; ${command}`, { pty: flag.follow })
```
