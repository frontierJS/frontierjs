#!/usr/bin/env bun
/*
 * index.js — the Outpost process.
 *
 * Two halves and nothing else: a signed HTTP server basecamp sends commands to,
 * and two timers that tell basecamp what this machine has on it. Both are
 * assembled here so `server.js` and `report.js` stay testable without a port or
 * a network.
 *
 * It refuses to start without a server id, a secret and a control-plane URL —
 * see `config.js` for why each of the three has no safe default. The one
 * exception is the installation's own host, which `OUTPOST_HOST_KEY` makes a
 * posture timer and nothing else: no listener, no Server row.
 */

import { readConfig }            from './config.js'
import { createOutpostServer }   from './server.js'
import { createReporter }        from './report.js'
import { createDocker, createInspector } from './docker.js'
import { createStaticServer }         from './serve.js'

const config    = readConfig()

// The installation's own host: posture over loopback and no listener at all,
// so the control plane gains no second command port (`FJS-D925`).
function reportHost(config) {
  const reporter = createReporter(config, { inspector: createInspector({ hostFiles: config.hostFiles }) })
  const stop     = reporter.start()
  console.log(`outpost ${config.version} · host, report-only → ${config.basecampUrl}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0) })
}

function serveMachine(config) {
  const docker    = createDocker({ workDir: config.workDir, restoreDir: config.restoreDir, backupDir: config.backupDir })
  const inspector = createInspector()
  const outpost   = createOutpostServer(config, { docker, inspector })
  const reporter  = createReporter(config, { inspector })

  const server = Bun.serve({
    port:  config.port,
    tls:   { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) },
    fetch: req => outpost.handle(req),
  })

  // The public half. Separate listener, separate origin, no signature: it serves
  // files anybody may read, and the pages it serves are written by whoever can
  // edit an app. Same process, because it holds no state beyond the filesystem
  // the command half writes — and a second process would need the same directory
  // and its own supervision to gain nothing.
  const statics      = createStaticServer({ staticDir: config.staticDir })
  const staticServer = config.staticPort
    ? Bun.serve({ port: config.staticPort, fetch: req => statics.handle(req) })
    : null

  const stopTimers = reporter.start()

  // The firewall unit reloads its exposed set empty at boot, so every exposed app
  // is dropped until this refills it.
  docker.syncExposed().catch(err => console.error(`outpost: the firewall's exposed set was not refilled — ${err.message}`))

  console.log(
    `outpost ${config.version} · server ${config.serverId} · :${server.port} → ${config.basecampUrl}` +
    (staticServer ? ` · static :${staticServer.port}` : ' · static disabled'))

  // A machine reboots and a deploy replaces this process; both send a signal, and
  // a timer left running holds the event loop open past the point where anything
  // is listening.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopTimers()
      server.stop()
      staticServer?.stop()
      process.exit(0)
    })
  }
}

if (config.host) reportHost(config)
else serveMachine(config)
