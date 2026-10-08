// test/verify-otlp.mjs — the otlp() export, decoded by a real collector (`FJS-D662`)
//
//   bun run verify:otlp          needs docker; pulls otel/opentelemetry-collector
//
// test/otlp.test.ts asserts the bodies against a receiver this repo wrote, so it
// proves the translation only as far as our own reading of the spec. This drive
// sends the same three signals to the OpenTelemetry Collector, which decodes
// OTLP/JSON with the reference implementation: a field it does not know, a hex
// id it cannot parse or a nanosecond time sent as the wrong type is a 400, and
// the plugin counts a 400 as `failed`. Then the collector's debug exporter is
// read back for the trace id, the span names, the log body and a metric — what
// arrived, not only that something was accepted.
//
// Traps:
//   - 7151 is the collector's OTLP/HTTP port on the host (junction's test slot,
//     docs/PORTS.md). A port that already answers is refused, not reused: a
//     stale collector from an earlier run would answer and prove nothing.
//   - The container is removed in `finally`, including on a failed assertion.
//   - The debug exporter prints asynchronously; the read polls for a while.
//   - The config rides an env var, not a bind mount: a daemon in another mount
//     namespace (a sandbox, a remote host) cannot see this process's tmpdir.

import { spawnSync } from 'node:child_process'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService, defaultConfig, $ } from '../index.ts'
import { createLogger } from '../src/core/logger.ts'
import { otlp } from '../src/plugins/otlp/index.ts'

const IMAGE     = 'otel/opentelemetry-collector:0.111.0'
const PORT      = 7151
const CONTAINER = `fjs-verify-otlp-${process.pid}`
const TRACE     = '0af7651916cd43dd8448eb211c80319c'
const PARENT    = 'b7ad6b7169203331'

let failures = 0
const check = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failures++ }
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' })

async function answers(port) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); return true }
  catch { return false }
}

const COLLECTOR = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:  { receivers: [otlp], exporters: [debug] }
    logs:    { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
`

if (docker('version', '--format', '{{.Server.Version}}').status !== 0) {
  console.error('verify:otlp needs a running docker daemon')
  process.exit(1)
}
if (await answers(PORT)) {
  console.error(`port ${PORT} already answers — stop whatever holds it; a stale collector would prove nothing`)
  process.exit(1)
}

let app = null

try {
  console.log(`collector ${IMAGE} on ${PORT}`)
  const run = docker('run', '-d', '--rm', '--name', CONTAINER, '-p', `${PORT}:4318`,
    '-e', `COLLECTOR_CONFIG=${COLLECTOR}`, IMAGE, '--config=env:COLLECTOR_CONFIG')
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)

  // The receiver answers 405 on GET / once it is listening; anything that
  // answers at all is enough.
  const deadline = Date.now() + 30_000
  while (!(await answers(PORT))) {
    if (Date.now() > deadline) throw new Error(`collector never answered on ${PORT}:\n${docker('logs', CONTAINER).stderr}`)
    await new Promise(r => setTimeout(r, 250))
  }

  const db = await createClient({ schema: `
    database main { path ":memory:" }
    model Order { id Int @id  status String }
  ` })
  const exporter = otlp({ endpoint: `http://localhost:${PORT}` })
  app = createApp({
    db, logger: createLogger({ level: 'info', writers: [] }),
    config: { name: 'verify-otlp', version: '0.0.1', port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 250 } },
  })
  app.configure(exporter)
  app.services.register(createService({
    name: 'orders', model: 'Order', db,
    hooks: { before: { create: [() => { $.log.info('placing an order') }] } },
  }))
  await app.start()

  const res = await fetch(`http://localhost:${app.http.port}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', traceparent: `00-${TRACE}-${PARENT}-01` },
    body: JSON.stringify({ id: 1, status: 'new' }),
  })
  check(res.status === 201, 'the request succeeded')

  exporter.readMetrics()
  await exporter.flush()
  const s = exporter.stats()
  check(s.failed === 0, `the collector accepted every POST (failed: ${s.failed})`)
  check(s.exported > 0, `records were exported (${s.exported})`)

  let out = ''
  const until = Date.now() + 10_000
  const want = [TRACE, 'orders.create', 'placing an order', 'otlp.exported', PARENT]
  while (Date.now() < until) {
    const logs = docker('logs', CONTAINER)
    out = `${logs.stdout}${logs.stderr}`
    if (want.every(w => out.includes(w))) break
    await new Promise(r => setTimeout(r, 250))
  }
  check(out.includes(`Trace ID       : ${TRACE}`), 'a span arrived on the caller\'s trace')
  check(out.includes(`Parent ID      : ${PARENT}`), 'the top span hangs off the caller\'s span')
  check(out.includes('orders.create'), 'the call span is named for the service and method')
  check(/Kind\s+:\s+Client/.test(out), 'a query span arrived')
  check(!out.includes('INSERT'), 'no query span carried SQL')
  check(out.includes('placing an order'), 'the log line arrived')
  check(out.includes('otlp.exported'), 'metric sources arrived as gauges')
  check(out.includes('service.name: Str(verify-otlp)'), 'the resource names the app')
  if (failures) console.log(`\n── collector output ──\n${out.slice(-4000)}`)
} catch (err) {
  console.error(err)
  failures++
} finally {
  await app?.stop().catch(() => {})
  docker('rm', '-f', CONTAINER)
}

console.log(failures ? `\n✗ ${failures} failed` : '\n✓ verify:otlp passed')
process.exit(failures ? 1 : 0)
