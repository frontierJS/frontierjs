// Spawned by shutdown.test.ts: boots an app, prints READY, and leaves on
// SIGTERM through the app's own signal handler. argv[2] is 'plugin' (a
// shutdown() that outlasts pluginTimeout), 'request' (a request that outlasts
// http.drainTimeout), 'derived' (a 2 s plugin shutdown with no budget stated,
// so FRONTIER_STOP_GRACE decides) or 'clean'.
import { createApp } from '../../index.ts'

const mode = process.argv[2]
const app = createApp({
  logLevel: 'silent',
  config: mode === 'derived' ? { port: 0 } : {
    port: 0,
    http: { drainTimeout: 100 },
    shutdown: { pluginTimeout: 100, timeout: 5_000 },
  },
})
if (mode === 'plugin') {
  app.configure({ name: 'slow', register() {}, async shutdown() { await Bun.sleep(1_500) } })
}
if (mode === 'derived') {
  app.configure({ name: 'slow', register() {}, async shutdown() { await Bun.sleep(2_000) } })
}
if (mode === 'request') {
  app.get('/slow', async (ctx: { json: (d: unknown) => Response }) => { await Bun.sleep(1_500); return ctx.json({ ok: true }) })
}
await app.start()
if (mode === 'request') fetch(`http://localhost:${app.http.port}/slow`).catch(() => {})
await Bun.sleep(100)
console.log('READY')
