// ─── swap.test.js — the swap's contract and the run flags both paths share ────
// The table is `fixtures/swap-cases.js`, which the cli's suite drives too.

import { describe, test, expect } from 'bun:test'
import { createSwap, runFlags, logArgs, DEFAULT_STOP_GRACE_S } from '../src/swap.js'
import { CASES, NAME, fakeDaemon, runArgv, imagesOn } from './fixtures/swap-cases.js'

describe('createSwap — the contract table', () => {
  for (const c of CASES) {
    test(c.case, async () => {
      const d = fakeDaemon(c.before)
      const routes = []
      const swap = createSwap({
        run:    async (argv) => d.argv(argv),
        find:   async () => d.find(),
        health: async ({ name }) => d.healthOf(name),
      })
      const go = c.swap === 'start-first'
        ? swap.startFirst({ name: NAME, argv: runArgv(`${NAME}_next`, c.image), route: async (port) => { routes.push(port) } })
        : swap.stopFirst({ name: NAME, argv: runArgv(NAME, c.image), port: 7300 })
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
      if (c.routes) expect(routes).toEqual(c.routes)
    })
  }

  test('a route that fails to move puts it back on the old port and leaves the old container serving', async () => {
    const d = fakeDaemon({ app: { image: 'img:old', running: true } })
    const routes = []
    const swap = createSwap({ run: async (a) => d.argv(a), find: async () => d.find(), health: async ({ name }) => d.healthOf(name) })
    const route = async (port) => { routes.push(port); if (port === 49153) throw new Error('caddy said no') }
    await expect(swap.startFirst({ name: NAME, argv: runArgv(`${NAME}_next`, 'img:new'), route }))
      .rejects.toThrow(/moving the route to it failed — caddy said no; the previous container was not touched/)
    expect(routes).toEqual([49153, 7300])
    expect(imagesOn(d.box)).toEqual({ app: 'img:old' })
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

describe('runFlags', () => {
  test('no stop grace is the default, to docker and to Junction alike', () => {
    expect(DEFAULT_STOP_GRACE_S).toBe(40)
    expect(runFlags({}).slice(-4)).toEqual(['--stop-timeout', '40', '-e', 'FRONTIER_STOP_GRACE=40'])
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
    expect(runFlags({ logs: false })).toEqual(['--stop-timeout', '40', '-e', 'FRONTIER_STOP_GRACE=40'])
  })

  test('a named driver takes only its own options, never json-file\'s sizes', () => {
    expect(logArgs({ driver: 'journald' })).toEqual(['--log-driver', 'journald'])
    expect(logArgs({ driver: 'syslog', options: { tag: 'app' }, max_size: '1m' })).toEqual(['--log-driver', 'syslog', '--log-opt', 'tag=app'])
  })
})
