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
 * see `config.js` for why each of the three has no safe default.
 */

import { readConfig }            from './config.js'
import { createOutpostServer }   from './server.js'
import { createReporter }        from './report.js'
import { createDocker, createInspector } from './docker.js'
import { createStaticServer }         from './serve.js'
import { createReplicator }           from './replicate.js'

const config    = readConfig()

function serveMachine(config) {
  const docker    = createDocker({ workDir: config.workDir, restoreDir: config.restoreDir, backupDir: config.backupDir, uidFile: config.uidFile, deployKeyDir: config.deployKeyDir })
  const inspector = createInspector({ hostFiles: config.hostFiles })
  const replicator = createReplicator({ configPath: config.litestreamConfig, metaDir: config.litestreamMetaDir, litestream: config.litestreamBin, stageDir: config.replicaStageDir, socketPath: config.litestreamSocket, hostDb: config.hostFiles?.db ?? null })
  const outpost   = createOutpostServer(config, { docker, inspector, replicator })
  const reporter  = createReporter(config, { inspector, replicator })

  const server = Bun.serve({
    port:  config.port,
    tls:   { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) },
    fetch: req => outpost.handle(req),
  })

  // The public half. Separate listener, separate origin, no signature: it serves
  // files anybody may read, and the pages it serves are written by whoever can
  // edit an app. Same process, because it holds no state beyond the filesystem
  // the command half writes — and a second process would need the same directory
  // and its own supervision to gain nothing. Loopback, because Caddy dials it
  // by host and a raw public port answers plain HTTP around Caddy's TLS (FJS-D1459).
  const statics      = createStaticServer({ staticDir: config.staticDir })
  const staticServer = config.staticPort
    ? Bun.serve({ hostname: '127.0.0.1', port: config.staticPort, fetch: req => statics.handle(req) })
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

serveMachine(config)
