// ─── swap-cases.js — the swap's contract, one table for both deploy paths ─────
// `src/swap.js` is driven over Outpost's local runner and over `fli deploy`'s
// ssh runner (`FJS-D1866`). A case here is a box's containers before the swap
// and the docker commands that must change it; `test/swap.test.js` runs every
// case against `createSwap` and `packages/cli/test/deploy-helpers.test.js`
// runs the stop-first ones through the cli's swap. A caller whose sequence
// drifted from this table is the put-back nobody sees until it is needed.
//
// The daemon is a map of name → { image, running, port, picked }. Only the
// commands that change it are recorded; `ps` and `inspect` are reads. A case's
// `log` also holds `route <port>` where the swap moves the route, since WHEN it
// moves is the contract (`FJS-4018`); `route` records it into the same log.
// `picked` is a port Docker chose, which a `docker start` chooses again.
// `dials` is the port the route dials before the swap moves it (7300, the
// App's own, unless a case states it) and `refuses` the commands the daemon
// fails, as they are logged.

export const NAME = 'app'

// What a release that cannot boot wrote before the swap removed it. `img:dead`
// exits at boot, so like a real one it has no port for `inspect` to answer.
const BOOT_LOG = {
  'img:sick': 'booting\ndb:migrate refused\n',
  'img:dead': 'db:migrate refused\n',
}

/** A fake daemon answering argv. `healthy(image)` decides a health check. */
export function fakeDaemon(initial = {}, { dials = 7300, refuses = [] } = {}) {
  const box = new Map(Object.entries(initial).map(([name, c]) => [name, { ...c }]))
  const log = []
  const ok  = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  const no  = (stderr) => ({ exitCode: 1, stdout: '', stderr })

  function argv([bin, verb, ...rest]) {
    if (bin === 'sh' && /^docker logs .*2>&1$/.test(rest[0])) {
      const c = box.get(rest[rest.length - 1])
      if (!c) return no(`Error: No such container: ${rest[rest.length - 1]}`)
      return ok(BOOT_LOG[c.image] ?? '')
    }
    if (bin !== 'docker') return no(`not docker: ${bin}`)
    if (verb === 'ps') return ok([...box.keys()].join('\n'))
    if (verb === 'inspect') {
      const name = rest[rest.length - 1]
      const c = box.get(name)
      if (!c) return no(`Error: No such object: ${name}`)
      if (rest.includes('{{.State.Running}}')) return ok(String(c.running))
      if (c.image === 'img:dead') return ok('{}')
      return ok(JSON.stringify({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(c.port ?? 7300) }] }))
    }
    if (verb === 'rm') {
      const names = rest.filter(a => a !== '-f')
      log.push(`rm ${names.join(' ')}`)
      for (const n of names) box.delete(n)
      return ok()
    }
    if (verb === 'rename') {
      const [from, to] = rest
      log.push(`rename ${from} ${to}`)
      if (refuses.includes(`rename ${from} ${to}`)) return no('Error response from daemon: rename refused')
      if (!box.has(from)) return no(`Error: No such container: ${from}`)
      if (box.has(to)) return no(`Error: Conflict. The container name "/${to}" is already in use`)
      box.set(to, box.get(from)); box.delete(from)
      return ok()
    }
    if (verb === 'stop' || verb === 'start') {
      const name = rest[rest.length - 1]
      log.push(`${verb} ${name}`)
      const c = box.get(name)
      if (!c) return no(`Error: No such container: ${name}`)
      c.running = verb === 'start'
      if (verb === 'start' && c.picked) c.port += 1
      return ok(name)
    }
    if (verb === 'run') {
      const name  = rest[rest.indexOf('--name') + 1]
      const image = rest[rest.length - 1]
      log.push(`run ${name} ${image}`)
      if (image === 'img:broken') return no('docker: Error response from daemon: invalid reference format')
      if (box.has(name)) return no(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use`)
      const next = name.endsWith('_next')
      box.set(name, { image, running: true, port: next ? 49153 : 7300, picked: next })
      return ok(`id-${image}`)
    }
    return no(`unknown verb ${verb}`)
  }

  const find = () => {
    const all = [...box.keys()]
    return {
      live:     all.find(n => !n.endsWith('_replaced') && !n.endsWith('_next')) ?? null,
      replaced: all.find(n => n.endsWith('_replaced')) ?? null,
      next:     all.find(n => n.endsWith('_next')) ?? null,
      all,
    }
  }

  /** What a health check of `name` finds: running, on an image that answers. */
  const healthOf = (name) => {
    const c = box.get(name)
    if (!c?.running) return { healthy: false, reason: 'not running' }
    return c.image === 'img:sick' ? { healthy: false, reason: 'answered 500' } : { healthy: true }
  }

  let dialing = dials
  const route  = async (port) => { dialing = port; log.push(`route ${port}`) }
  const routed = async () => [dialing]

  return { argv, find, healthOf, route, routed, log, box }
}

/** A case's log without its route moves: what a caller fronting nothing runs. */
export const dockerOnly = (log) => log.filter(s => !s.startsWith('route '))
/** The ports a case's swap routes to, in order. */
export const routesOf = (log) => log.filter(s => s.startsWith('route ')).map(s => Number(s.slice('route '.length)))

/** The `docker run` argv after `docker`, as a caller would build it. */
export const runArgv = (name, image) => ['run', '-d', '--name', name, '--restart', 'unless-stopped', image]

const old = { image: 'img:old', running: true }
// The live release a start-first left: on a port Docker picked.
const overlapped = { image: 'img:old', running: true, port: 49153, picked: true }

export const CASES = [
  {
    case: 'first deploy',
    swap: 'stop-first', image: 'img:new', before: {},
    log: ['run app img:new', 'route 7300'],
    after: { app: 'img:new' },
  },
  {
    case: 'healthy replace',
    swap: 'stop-first', image: 'img:new', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:new', 'route 7300', 'rm app_replaced'],
    after: { app: 'img:new' },
  },
  {
    // The route dials the old release until the new one answers on the App's
    // port: moved before the stop, it sent the live release's traffic to nothing.
    case: 'stop-first after a start-first',
    swap: 'stop-first', image: 'img:new', before: { app: overlapped },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:new', 'route 7300', 'rm app_replaced'],
    after: { app: 'img:new' },
  },
  {
    case: 'stop-first after a start-first, unhealthy → put back on a new port',
    swap: 'stop-first', image: 'img:sick', before: { app: overlapped },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:sick',
          'rm app', 'rename app_replaced app', 'start app', 'route 49154'],
    throws: /not healthy — .*; the previous container is serving again/,
    restored: true,
    after: { app: 'img:old' },
  },
  {
    case: 'unhealthy → put back',
    swap: 'stop-first', image: 'img:sick', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:sick',
          'rm app', 'rename app_replaced app', 'start app', 'route 7300'],
    throws: /the new container started and is not healthy — .*; the previous container is serving again\n[\s\S]*booting\ndb:migrate refused$/,
    restored: true,
    after: { app: 'img:old' },
  },
  {
    case: 'start fails → put back',
    swap: 'stop-first', image: 'img:broken', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:broken',
          'rm app', 'rename app_replaced app', 'start app', 'route 7300'],
    throws: /the new container did not start — docker run failed \(exit 1\): .*invalid reference format; the previous container is serving again/,
    restored: true,
    after: { app: 'img:old' },
  },
  {
    case: 'unhealthy first deploy → nothing to put back',
    swap: 'stop-first', image: 'img:sick', before: {},
    log: ['run app img:sick', 'rm app'],
    throws: /not healthy — .*; there was no previous container to put back\n[\s\S]*db:migrate refused$/,
    restored: false, none: true,
    after: {},
  },
  {
    case: 'stale _next and orphan _replaced, stop-first',
    swap: 'stop-first', image: 'img:new',
    before: { app_next: { image: 'img:half', running: true, port: 49200 }, app_replaced: { image: 'img:old', running: false } },
    log: ['rm app_next', 'stop app_replaced', 'run app img:new', 'route 7300', 'rm app_replaced'],
    after: { app: 'img:new' },
  },
  {
    case: 'start-first happy',
    swap: 'start-first', image: 'img:new', before: { app: old },
    log: ['run app_next img:new', 'route 49153', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    port: 49153,
    after: { app: 'img:new' },
  },
  {
    case: 'start-first unhealthy → old untouched',
    swap: 'start-first', image: 'img:sick', before: { app: old },
    log: ['run app_next img:sick', 'rm app_next'],
    throws: /not healthy — .*; the previous container was not touched and is still serving\n[\s\S]*db:migrate refused$/,
    after: { app: 'img:old' },
  },
  {
    // An exited container holds no port, so this is how a boot failure reads
    // on a start-first, before any health check.
    case: 'start-first exits at boot → old untouched, the log kept',
    swap: 'start-first', image: 'img:dead', before: { app: old },
    log: ['run app_next img:dead', 'rm app_next'],
    throws: /published no port for the route to follow; the previous container was not touched and is still serving\n[\s\S]*db:migrate refused$/,
    after: { app: 'img:old' },
  },
  {
    case: 'stale _next and finished _replaced, start-first',
    swap: 'start-first', image: 'img:new',
    before: { app: old, app_next: { image: 'img:half', running: true, port: 49200 }, app_replaced: { image: 'img:older', running: false } },
    log: ['rm app_next app_replaced', 'run app_next img:new', 'route 49153', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    port: 49153,
    after: { app: 'img:new' },
  },
  {
    // The route moved to `_next`, then the rename into place failed: the new
    // release serves under a name the next swap removes.
    case: 'start-first, naming the new container fails after the route moved → _next keeps serving',
    swap: 'start-first', image: 'img:new', before: { app: old }, refuses: ['rename app_next app'],
    log: ['run app_next img:new', 'route 49153', 'rename app app_replaced', 'rename app_next app'],
    throws: /the route moved to it, but naming it app failed — docker rename failed \(exit 1\): .*rename refused; it keeps serving as app_next/,
    after: { app_replaced: 'img:old', app_next: 'img:new' },
  },
  {
    case: 'start-first adopts the serving _next it finds, and the set-aside one goes',
    swap: 'start-first', image: 'img:newer', dials: 49153,
    before: { app_replaced: { image: 'img:old', running: true }, app_next: { image: 'img:new', running: true, port: 49153, picked: true } },
    log: ['rename app_next app', 'stop app_replaced', 'rm app_replaced',
          'run app_next img:newer', 'route 49153', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    port: 49153,
    after: { app: 'img:newer' },
  },
  {
    // The first rename failed: the old release still holds its own name.
    case: 'start-first adopts the serving _next beside the old release still named for it',
    swap: 'start-first', image: 'img:newer', dials: 49153,
    before: { app: old, app_next: { image: 'img:new', running: true, port: 49153, picked: true } },
    log: ['rm app_replaced', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced',
          'run app_next img:newer', 'route 49153', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    port: 49153,
    after: { app: 'img:newer' },
  },
  {
    case: 'start-first whose adoption cannot name the serving _next leaves it running',
    swap: 'start-first', image: 'img:newer', dials: 49153, refuses: ['rename app_next app'],
    before: { app_replaced: { image: 'img:old', running: true }, app_next: { image: 'img:new', running: true, port: 49153, picked: true } },
    log: ['rename app_next app'],
    throws: /app_next is the release serving \(the route dials it\) and could not be named app, so it is left running — docker rename failed/,
    after: { app_replaced: 'img:old', app_next: 'img:new' },
  },
  {
    case: 'stop-first adopts the serving _next it finds before setting anything aside',
    swap: 'stop-first', image: 'img:newer', dials: 49153,
    before: { app_replaced: { image: 'img:old', running: true }, app_next: { image: 'img:new', running: true, port: 49153, picked: true } },
    log: ['rename app_next app', 'stop app_replaced', 'rm app_replaced',
          'rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:newer', 'route 7300', 'rm app_replaced'],
    after: { app: 'img:newer' },
  },
]

/** What the box holds after, as name → image, to compare with `after`. */
export const imagesOn = (box) => Object.fromEntries([...box].map(([n, c]) => [n, c.image]))
