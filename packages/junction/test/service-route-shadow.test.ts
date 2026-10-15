// test/service-route-shadow.test.ts
//
// FJS-1511. A service named `health` mounts at `GET /{service}`, and a fixed
// route beats a dynamic one — so with the health plugin installed, `/health`
// answered the probe and the service's `find` was unreachable. Nothing said so:
// the app booted green and the service looked mounted in `app.services`.

import { describe, it, expect } from 'bun:test'
import { createTestApp } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'
import { healthPlugin, collectMetrics } from '../src/transport/health.ts'
import { channels } from '../src/transport/channels.ts'

const mk = (name: string) => () => createService({ name, find: async () => [] })

describe('a service shadowed by a fixed route is refused at start, naming both', () => {

  it('`health` beside the health plugin', async () => {
    const app = await createTestApp({ services: [mk('health')] })
    app.configure(healthPlugin())
    await expect(app._startForTest()).rejects.toThrow(/Service 'health'.*GET \/health/s)
  })

  it('a raw route under the service name shadows its /{id}', async () => {
    const app = await createTestApp({ services: [mk('reports')] })
    app.get('/reports/summary', (ctx) => ctx.json({ ok: true }))
    await expect(app._startForTest()).rejects.toThrow(/Service 'reports'.*GET \/reports\/summary/s)
  })

  it('honors apiPrefix', async () => {
    const app = await createTestApp({ services: [mk('health')], config: { apiPrefix: '/api' } })
    app.configure(healthPlugin())
    await expect(app._startForTest()).rejects.toThrow(/Service 'health'.*GET \/api\/health/s)
  })

  it('a service beside the health plugin under another name boots', async () => {
    const app = await createTestApp({ services: [mk('widgets')] })
    app.configure(healthPlugin())
    await app._startForTest()
  })

  it('a health plugin mounted at a custom path leaves a `health` service alone', async () => {
    const app = await createTestApp({ services: [mk('health')] })
    app.configure(healthPlugin({ path: '/_internal' }))
    await app._startForTest()
  })
})

// FJS-2897. A framework plugin's route takes a name an app may want for a
// service: `channels()` mounted `GET /channels/stats`, and basecamp's
// notification-channel service `channels` was refused at boot. The counts are
// a metrics section, read where every other plugin's are.
describe('a framework plugin leaves the service namespace to the app', () => {

  it('a `channels` service beside the channels plugin boots', async () => {
    const app = await createTestApp({ services: [mk('channels')] })
    app.configure(channels())
    await app._startForTest()
  })

  it('channel counts are a /metrics section, with no channel name in it', async () => {
    const app = await createTestApp({ services: [mk('widgets')] })
    app.configure(channels())
    await app._startForTest()
    const metrics = collectMetrics(app, Date.now()) as unknown as Record<string, unknown>
    expect(metrics.channels).toEqual({ connections: 0, channels: 0 })
  })
})
