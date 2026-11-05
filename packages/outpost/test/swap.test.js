// ─── swap.test.js — the swap's contract and the run flags both paths share ────
// The table is `fixtures/swap-cases.js`, which the cli's suite drives too.

import { describe, test, expect } from 'bun:test'
import { createSwap, runFlags, logArgs, repointRoutes, healthBudgetS, healthyStatus, DEFAULT_STOP_GRACE_S, DEFAULT_HEALTH_TIMEOUT_S, HEALTH_INTERVAL_S, HEALTH_CHECK_TIMEOUT_S, HEALTHY_STATUS } from '../src/swap.js'
import { CASES, NAME, fakeDaemon, runArgv, imagesOn } from './fixtures/swap-cases.js'

describe('createSwap — the contract table', () => {
  for (const c of CASES) {
    test(c.case, async () => {
      const d = fakeDaemon(c.before, { dials: c.dials, refuses: c.refuses })
      const swap = createSwap({
        run:    async (argv) => d.argv(argv),
        find:   async () => d.find(),
        health: async ({ name }) => d.healthOf(name),
      })
      const go = c.swap === 'start-first'
        ? swap.startFirst({ name: NAME, argv: runArgv(`${NAME}_next`, c.image), route: d.route, routed: d.routed })
        : swap.stopFirst({ name: NAME, argv: runArgv(NAME, c.image), port: 7300, route: d.route, routed: d.routed })
      if (c.throws) {
        const err = await go.then(() => null, e => e)
        expect(err?.message).toMatch(c.throws)
        if ('restored' in c) expect(err.restored).toBe(c.restored)
        if ('none' in c) expect(err.none).toBe(c.none)
      } else {
        const out = await go
        expect(out.containerId).toBe(`id-${c.image}`)
        if (c.port) expect(out.port).toBe(c.port)
      }
      expect(d.log).toEqual(c.log)
      expect(imagesOn(d.box)).toEqual(c.after)
    })
  }

  test('a stop-first route that fails to move keeps _replaced and says the new one is live', async () => {
    const d = fakeDaemon({ app: { image: 'img:old', running: true } })
    const swap = createSwap({ run: async (a) => d.argv(a), find: async () => d.find(), health: async ({ name }) => d.healthOf(name) })
    const route = async () => { throw new Error('caddy said no') }
    await expect(swap.stopFirst({ name: NAME, argv: runArgv(NAME, 'img:new'), port: 7300, route }))
      .rejects.toThrow(/the new container answers on :7300 and moving the route to it failed — caddy said no/)
    expect(imagesOn(d.box)).toEqual({ app: 'img:new', app_replaced: 'img:old' })
  })

  test('a put-back whose route fails to follow still says the old container is back', async () => {
    const d = fakeDaemon({ app: { image: 'img:old', running: true } })
    const swap = createSwap({ run: async (a) => d.argv(a), find: async () => d.find(), health: async ({ name }) => d.healthOf(name) })
    const route = async () => { throw new Error('caddy said no') }
    const err = await swap.stopFirst({ name: NAME, argv: runArgv(NAME, 'img:sick'), port: 7300, route }).catch(e => e)
    expect(err.message).toMatch(/the previous container is serving again, and moving the route back to it failed — caddy said no/)
    expect(err.restored).toBe(true)
  })

  test('a route that fails to move puts it back on the old port and leaves the old container serving', async () => {
    const d = fakeDaemon({ app: { image: 'img:old', running: true } })
    const routes = []
    const swap = createSwap({ run: async (a) => d.argv(a), find: async () => d.find(), health: async ({ name }) => d.healthOf(name) })
    const route = async (port) => { routes.push(port); if (port === 49153) throw new Error('caddy said no') }
    await expect(swap.startFirst({ name: NAME, argv: runArgv(`${NAME}_next`, 'img:new'), route, routed: async () => [7300] }))
      .rejects.toThrow(/moving the route to it failed — caddy said no; the previous container was not touched/)
    expect(routes).toEqual([49153, 7300])
    expect(imagesOn(d.box)).toEqual({ app: 'img:old' })
  })

  // FJS-4020: a start-first that died after its route moved leaves the serving
  // release named `_next`, and the sequences remove any `_next` they find.
  const serving = { app_replaced: { image: 'img:old', running: true }, app_next: { image: 'img:new', running: true, port: 49153, picked: true } }
  const swapOn = (d, routed) => createSwap({ run: async (a) => d.argv(a), find: async () => d.find(), health: async ({ name }) => d.healthOf(name) })
    .startFirst({ name: NAME, argv: runArgv(`${NAME}_next`, 'img:newer'), route: d.route, routed })

  test('a rename that failed after the route moved is retried by the next swap, which never removes the serving container', async () => {
    const first = fakeDaemon({ app: { image: 'img:old', running: true } }, { refuses: ['rename app_next app'] })
    await expect(swapOn(first, first.routed)).rejects.toThrow(/it keeps serving as app_next/)
    expect(await first.routed()).toEqual([49153])

    const second = fakeDaemon(Object.fromEntries(first.box), { dials: 49153 })
    await swapOn(second, second.routed)
    expect(second.log).not.toContain('rm app_next')
    expect(second.log[0]).toBe('rename app_next app')
    expect(imagesOn(second.box)).toEqual({ app: 'img:newer' })
  })

  test('a _next the route does not dial is removed, as before', async () => {
    const d = fakeDaemon(serving, { dials: 7300 })
    await swapOn(d, d.routed)
    expect(d.log[0]).toBe('rm app_next')
  })

  test('a route that cannot be read refuses the swap with the leftover _next untouched', async () => {
    const d = fakeDaemon(serving)
    await expect(swapOn(d, async () => { throw new Error('caddy did not answer') })).rejects.toThrow(/caddy did not answer/)
    expect(d.log).toEqual([])
    expect(imagesOn(d.box)).toEqual({ app_replaced: 'img:old', app_next: 'img:new' })
  })

  test('a start-first with no routed() is refused before anything runs', async () => {
    const d = fakeDaemon(serving)
    await expect(swapOn(d, undefined)).rejects.toThrow(/needs routed\(\)/)
    expect(d.log).toEqual([])
  })

  test('the put-back is asked about as the previous container', async () => {
    const d = fakeDaemon({ app: { image: 'img:old', running: true } })
    const asked = []
    const swap = createSwap({
      run: async (a) => d.argv(a), find: async () => d.find(),
      health: async (q) => { asked.push(q); return d.healthOf(q.name) },
    })
    await swap.stopFirst({ name: NAME, argv: runArgv(NAME, 'img:sick'), port: 7300, path: '/health' }).catch(() => {})
    expect(asked).toEqual([
      { name: 'app', port: 7300, path: '/health' },
      { name: 'app', port: 7300, path: '/health', previous: true },
    ])
  })
})

describe('healthBudgetS', () => {
  // FJS-4029: the budget both deploy paths wait is seconds on a deadline, so a
  // check that hangs cannot stretch it.
  test('no budget is the default, a stated one is kept', () => {
    expect(healthBudgetS(null)).toBe(DEFAULT_HEALTH_TIMEOUT_S)
    expect(healthBudgetS(undefined)).toBe(DEFAULT_HEALTH_TIMEOUT_S)
    expect(healthBudgetS(120)).toBe(120)
  })

  test('a budget outside 5 to 600 whole seconds is refused', () => {
    for (const bad of [4, 0, -5, 601, 2.5, '30', NaN])
      expect(() => healthBudgetS(bad)).toThrow(/healthTimeout must be a whole number of seconds, 5 to 600/)
  })
})

describe('healthyStatus', () => {
  // FJS-4019: Outpost took any 2xx and fli deploy only 200, so one release
  // could go live on one path and be put back on the other.
  test('exactly 200 is healthy, as Kamal reads it', () => {
    expect(HEALTHY_STATUS).toBe(200)
    expect(healthyStatus(200)).toBe(true)
    expect(healthyStatus('200')).toBe(true)
  })

  test('another 2xx, a redirect, an error or no answer is not', () => {
    for (const status of [201, 204, 299, 301, 404, 500, 503, 0, '000', null, undefined])
      expect(healthyStatus(status)).toBe(false)
  })

  test('each ask gets 5 s, inside a poll loop that still waits the budget', () => {
    expect(HEALTH_CHECK_TIMEOUT_S).toBe(5)
    expect(HEALTH_CHECK_TIMEOUT_S).toBeLessThan(DEFAULT_HEALTH_TIMEOUT_S)
  })
})

describe('runFlags', () => {
  test('no stop grace is the default, to docker and to Junction alike', () => {
    expect(DEFAULT_STOP_GRACE_S).toBe(50)
    expect(runFlags({}).slice(-4)).toEqual(['--stop-timeout', '50', '-e', 'FRONTIER_STOP_GRACE=50'])
  })

  test('a stated grace is passed as stated', () => {
    expect(runFlags({ stopGrace: 25 }).slice(-4)).toEqual(['--stop-timeout', '25', '-e', 'FRONTIER_STOP_GRACE=25'])
  })

  test('a grace that leaves Junction no drain is refused', () => {
    for (const bad of [1, 0, -5, 2.5, '30', NaN])
      expect(() => runFlags({ stopGrace: bad })).toThrow(/stopGrace must be a whole number of seconds, at least 2/)
  })

  test('the log cap defaults to json-file, 10m × 5', () => {
    expect(logArgs(undefined)).toEqual(['--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=5'])
    expect(logArgs({ max_size: '50m', max_files: 3 })).toEqual(['--log-driver', 'json-file', '--log-opt', 'max-size=50m', '--log-opt', 'max-file=3'])
  })

  test('logs: false leaves the daemon\'s own driver standing', () => {
    expect(logArgs(false)).toEqual([])
    expect(runFlags({ logs: false })).toEqual(['--stop-timeout', '50', '-e', 'FRONTIER_STOP_GRACE=50'])
  })

  test('a named driver takes only its own options, never json-file\'s sizes', () => {
    expect(logArgs({ driver: 'journald' })).toEqual(['--log-driver', 'journald'])
    expect(logArgs({ driver: 'syslog', options: { tag: 'app' }, max_size: '1m' })).toEqual(['--log-driver', 'syslog', '--log-opt', 'tag=app'])
  })
})

describe('repointRoutes (FJS-D1890)', () => {
  const proxy = (dial, extra = {}) => ({ handler: 'reverse_proxy', upstreams: [{ dial }], ...extra })
  const route = (id, ...handle) => ({ '@id': id, match: [{ host: ['shop.example.com'] }], handle, terminal: true })

  test('a loopback upstream on another port is rewritten, and what moved is answered', () => {
    const { routes, moved } = repointRoutes([route('fjs-a', proxy('127.0.0.1:32806'))], 32807)
    expect(routes[0].handle[0].upstreams).toEqual([{ dial: '127.0.0.1:32807' }])
    expect(moved).toEqual([{ id: 'fjs-a', from: 32806, to: 32807 }])
  })

  test('a fli route nests its proxy in subroutes, and every level is walked', () => {
    const inner = { handler: 'subroute', routes: [{ handle: [proxy('127.0.0.1:1111')] }, { handle: [{ handler: 'file_server', root: '/srv' }] }] }
    const { routes, moved } = repointRoutes([route('fli-a', { handler: 'subroute', routes: [{ handle: [inner] }] })], 2222)
    expect(routes[0].handle[0].routes[0].handle[0].routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:2222')
    expect(moved).toEqual([{ id: 'fli-a', from: 1111, to: 2222 }])
  })

  test('a dial already on the port, a remote upstream and a non-proxy handler stay as they are', () => {
    const input = [
      route('fjs-a', proxy('127.0.0.1:2222')),
      route('fjs-b', proxy('10.0.0.5:1111'), { handler: 'static_response', status_code: 308 }),
      route('fjs-c', proxy('localhost:1111')),
    ]
    const { routes, moved } = repointRoutes(input, 2222)
    expect(moved).toEqual([])
    expect(routes).toEqual(input)
  })

  test('a proxy that sets Host is the static origin, not a container, and stays', () => {
    const headers = { request: { set: { Host: ['x.localhost'] } } }
    const input = [route('fjs-a', proxy('127.0.0.1:1', { headers }))]
    const { routes, moved } = repointRoutes(input, 2)
    expect(moved).toEqual([])
    expect(routes).toEqual(input)
  })

  test('the route\'s other fields ride through', () => {
    const headers = { response: { set: { 'X-Frame-Options': ['DENY'] } } }
    const { routes } = repointRoutes([route('fjs-a', proxy('127.0.0.1:1', { headers }))], 2)
    expect(routes[0]).toEqual(route('fjs-a', proxy('127.0.0.1:2', { headers })))
  })

  test('the input is never mutated', () => {
    const input = [route('fjs-a', proxy('127.0.0.1:1'))]
    const before = structuredClone(input)
    repointRoutes(input, 2)
    expect(input).toEqual(before)
  })
})
