---
title: ports:proxy
description: Serve every dev surface under a name — example.localhost, not localhost:8010
alias: proxy
examples:
  - fli proxy
  - fli proxy --list
  - fli proxy --port 8504
flags:
  port:
    char: p
    type: string
    description: Listen here instead of 80
    defaultValue: 8504
  list:
    char: l
    type: boolean
    description: Print the names and exit
    defaultValue: false
---

<script>
import { resolve } from 'path'
</script>

`example.localhost` instead of `localhost:8010`, and `api.example.localhost`
instead of `localhost:8110`.

The names are not configured — they are a rendering of `core/ports.js`, which
already knows that project 1 is `example` and that 8010 is its frontend. A
browser resolves `*.localhost` to loopback with no `/etc/hosts` entry, so the
only missing half is a listener that maps Host to port, which is this.

**Strictly additive.** Every number keeps working and nothing may come to depend
on this running. Three things it fixes that are not *remembering a number*:
`strictPort` exists because vite otherwise hops in silence and the second app's
drive tests the first app's app, and a name makes that unreachable rather than
merely loud; **cookie scope stops being a lie**, because a port is not part of a
cookie's origin, so `localhost:8010` and `localhost:8110` share one jar and
cookie auth in dev behaves unlike cookie auth anywhere else; and a drive's
assertions stop hard-coding the port `CLAUDE.md` also states.

```js
const { runnables }   = await import(resolve(global.fliRoot, 'core/runnables.js'))
const { hostTable, hostCollisions, createProxy, listenWithFallback } =
  await import(resolve(global.fliRoot, 'core/proxy.js'))

const root  = (await context.wsRoot?.()) ?? context.paths.root
const rows  = runnables(root)
const table = hostTable(rows)

// Two rows wanting one name is a bug in the ports table, not a choice to make
// at runtime — so it is reported by name rather than resolved by arrival order.
for (const c of hostCollisions(rows)) {
  log.warn(`${c.host} is claimed by ${c.ids.join(' and ')} — check PROJECTS in core/ports.js`)
}

if (!table.size) {
  log.warn('no dev surface here has a name — is this a FrontierJS project?')
  return
}

if (flag.list) {
  echo('')
  for (const r of [...table.values()].sort((a, b) => a.host.localeCompare(b.host))) {
    echo(`  ${r.host.padEnd(34)} :${String(r.port).padEnd(6)} ${r.name}`)
  }
  echo('')
  return
}

const server = createProxy({ table })

// 80 first, because a name with a port on it is only half the point; the
// fallback is a number from the ports table rather than a convention, because a
// tool typed from memory cannot take a number from an app's row.
const wanted = flag.port && String(flag.port) !== '8504' ? Number(flag.port) : 80
let bound
try {
  bound = await listenWithFallback(server, { port: wanted, fallback: Number(flag.port) || 8504 })
} catch (err) {
  log.error(`could not listen on ${wanted} or ${flag.port}: ${err.message}`)
  return
}

const suffix = bound.port === 80 ? '' : `:${bound.port}`
echo('')
log.success(`serving ${table.size} name(s) on :${bound.port}`)
if (!bound.privileged) {
  // Expected, not an error: 80 is a privileged bind on a project whose pitch is
  // that everything runs as a plain user process.
  echo(`  (80 needs a privileged bind — using the reserved tooling slot instead)`)
}
echo('')
for (const r of [...table.values()].sort((a, b) => a.host.localeCompare(b.host))) {
  echo(`  http://${r.host}${suffix}`.padEnd(48) + `→ :${r.port}  ${r.name}`)
}
echo('')
echo('  Ctrl-C to stop. Every port keeps working exactly as it did.')

await new Promise(() => {})
```
