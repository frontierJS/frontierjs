// ─── swap-cases.js — the swap's contract, one table for both deploy paths ─────
// `src/swap.js` is driven over Outpost's local runner and over `fli deploy`'s
// ssh runner (`FJS-D1866`). A case here is a box's containers before the swap
// and the docker commands that must change it; `test/swap.test.js` runs every
// case against `createSwap` and `packages/cli/test/deploy-helpers.test.js`
// runs the stop-first ones through the cli's swap. A caller whose sequence
// drifted from this table is the put-back nobody sees until it is needed.
//
// The daemon is a map of name → { image, running }. Only the commands that
// change it are recorded; `ps` and `inspect` are reads.

export const NAME = 'app'

/** A fake daemon answering argv. `healthy(image)` decides a health check. */
export function fakeDaemon(initial = {}) {
  const box = new Map(Object.entries(initial).map(([name, c]) => [name, { ...c }]))
  const log = []
  const ok  = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  const no  = (stderr) => ({ exitCode: 1, stdout: '', stderr })

  function argv([bin, verb, ...rest]) {
    if (bin !== 'docker') return no(`not docker: ${bin}`)
    if (verb === 'ps') return ok([...box.keys()].join('\n'))
    if (verb === 'inspect') {
      const name = rest[rest.length - 1]
      const c = box.get(name)
      if (!c) return no(`Error: No such object: ${name}`)
      if (rest.includes('{{.State.Running}}')) return ok(String(c.running))
      const port = name.endsWith('_next') ? 49153 : 7300
      return ok(JSON.stringify({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] }))
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
      return ok(name)
    }
    if (verb === 'run') {
      const name  = rest[rest.indexOf('--name') + 1]
      const image = rest[rest.length - 1]
      log.push(`run ${name} ${image}`)
      if (image === 'img:broken') return no('docker: Error response from daemon: invalid reference format')
      if (box.has(name)) return no(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use`)
      box.set(name, { image, running: true })
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

  return { argv, find, healthOf, log, box }
}

/** The `docker run` argv after `docker`, as a caller would build it. */
export const runArgv = (name, image) => ['run', '-d', '--name', name, '--restart', 'unless-stopped', image]

const old = { image: 'img:old', running: true }

export const CASES = [
  {
    case: 'first deploy',
    swap: 'stop-first', image: 'img:new', before: {},
    log: ['run app img:new'],
    after: { app: 'img:new' },
  },
  {
    case: 'healthy replace',
    swap: 'stop-first', image: 'img:new', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:new', 'rm app_replaced'],
    after: { app: 'img:new' },
  },
  {
    case: 'unhealthy → put back',
    swap: 'stop-first', image: 'img:sick', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:sick',
          'rm app', 'rename app_replaced app', 'start app'],
    throws: /the new container started and is not healthy — .*; the previous container is serving again/,
    restored: true,
    after: { app: 'img:old' },
  },
  {
    case: 'start fails → put back',
    swap: 'stop-first', image: 'img:broken', before: { app: old },
    log: ['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:broken',
          'rm app', 'rename app_replaced app', 'start app'],
    throws: /the new container did not start — docker run failed \(exit 1\): .*invalid reference format; the previous container is serving again/,
    restored: true,
    after: { app: 'img:old' },
  },
  {
    case: 'unhealthy first deploy → nothing to put back',
    swap: 'stop-first', image: 'img:sick', before: {},
    log: ['run app img:sick', 'rm app'],
    throws: /not healthy — .*; there was no previous container to put back/,
    restored: false, none: true,
    after: {},
  },
  {
    case: 'stale _next and orphan _replaced, stop-first',
    swap: 'stop-first', image: 'img:new',
    before: { app_next: { image: 'img:half', running: true }, app_replaced: { image: 'img:old', running: false } },
    log: ['rm app_next', 'stop app_replaced', 'run app img:new', 'rm app_replaced'],
    after: { app: 'img:new' },
  },
  {
    case: 'start-first happy',
    swap: 'start-first', image: 'img:new', before: { app: old },
    log: ['run app_next img:new', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    routes: [49153],
    port: 49153,
    after: { app: 'img:new' },
  },
  {
    case: 'start-first unhealthy → old untouched',
    swap: 'start-first', image: 'img:sick', before: { app: old },
    log: ['run app_next img:sick', 'rm app_next'],
    throws: /not healthy — .*; the previous container was not touched and is still serving/,
    routes: [],
    after: { app: 'img:old' },
  },
  {
    case: 'stale _next and finished _replaced, start-first',
    swap: 'start-first', image: 'img:new',
    before: { app: old, app_next: { image: 'img:half', running: true }, app_replaced: { image: 'img:older', running: false } },
    log: ['rm app_next app_replaced', 'run app_next img:new', 'rename app app_replaced', 'rename app_next app', 'stop app_replaced', 'rm app_replaced'],
    routes: [49153],
    port: 49153,
    after: { app: 'img:new' },
  },
]

/** What the box holds after, as name → image, to compare with `after`. */
export const imagesOn = (box) => Object.fromEntries([...box].map(([n, c]) => [n, c.image]))
