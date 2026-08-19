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

const config    = readConfig()
const docker    = createDocker({ workDir: config.workDir })
const inspector = createInspector()
const outpost   = createOutpostServer(config, { docker, inspector })
const reporter  = createReporter(config, { inspector })

const server = Bun.serve({
  port:  config.port,
  fetch: req => outpost.handle(req),
})

const stopTimers = reporter.start()

console.log(`outpost ${config.version} · server ${config.serverId} · :${server.port} → ${config.basecampUrl}`)

// A machine reboots and a deploy replaces this process; both send a signal, and
// a timer left running holds the event loop open past the point where anything
// is listening.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopTimers()
    server.stop()
    process.exit(0)
  })
}
