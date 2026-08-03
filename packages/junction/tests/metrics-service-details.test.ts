// tests/metrics-service-details.test.ts
//
// /metrics reported service detail by reading keys off the built service that
// the built service does not have:
//
//   actions:   Object.keys(svc.actions ?? {})   → there is no `actions` key.
//              createService copies custom methods straight onto the service
//              object, so this was `[]` for every service, forever, while
//              /manifest listed them correctly off customMethodNames().
//   allowBulk: svc.allowBulk                    → never carried onto the built
//              service, so this was `false` for every service, including ones
//              configured `allowBulk: true`.
//
// Both failed silently and plausibly: an empty action list and a conservative
// `false` are exactly what a correct implementation would report for a plain
// CRUD service, so nothing looked wrong. These tests pin the values against a
// service that genuinely has actions and genuinely allows bulk.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, createService, healthPlugin, defaultConfig } from '../index.ts'

const PORT = 3385
let app: any

beforeAll(async () => {
  app = createApp({
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  app.configure(healthPlugin())

  app.services.register(createService({
    name:      'servers',
    allowBulk: true,
    async find()     { return [] },
    async reboot()   { return { ok: true } },
    async getStats() { return { n: 1 } },
  }))

  app.services.register(createService({
    name: 'plain',
    async find() { return [] },
  }))

  await app.start()
})

afterAll(async () => { await app?.stop() })

const details = async () =>
  (await (await fetch(`http://localhost:${PORT}/metrics`)).json()).services.details

describe('/metrics service details', () => {
  it('lists custom action names', async () => {
    const d = await details()
    expect(d.servers.actions.sort()).toEqual(['getStats', 'reboot'])
  })

  it('reports an empty action list only when there really are none', async () => {
    const d = await details()
    expect(d.plain.actions).toEqual([])
  })

  it('never reports a CRUD method as an action', async () => {
    const d = await details()
    for (const crud of ['find', 'get', 'create', 'update', 'patch', 'remove', 'restore']) {
      expect(d.servers.actions).not.toContain(crud)
    }
  })

  it('reflects the configured allowBulk instead of always false', async () => {
    const d = await details()
    expect(d.servers.allowBulk).toBe(true)
    expect(d.plain.allowBulk).toBe(false)
  })

  it('agrees with the service object itself — one source of truth', async () => {
    const d   = await details()
    const svc = app.services.get('servers')
    expect(typeof svc.reboot).toBe('function')
    expect(typeof svc.getStats).toBe('function')
    expect(svc.allowBulk).toBe(true)
    expect(d.servers.actions.sort()).toEqual(['getStats', 'reboot'])
  })
})
