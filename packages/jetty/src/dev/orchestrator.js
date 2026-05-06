// orchestrator.js — `fli dev:ext` top-level coordinator.
//
// Responsibilities:
//   1. Read jetty.config.js → validate dev.port (FJS scheme)
//   2. Initial build (debug-mode, dev plugin injected)
//   3. Start dev WS server on dev.port
//   4. Watch src/, config/, public/ via chokidar
//   5. On change: classify → rebuild affected target → broadcast event
//   6. Optionally launch browser(s) via web-ext (deferred — Phase 5 ships
//      WS + classifier; web-ext launch wired but optional)
//
// Watch scope: src/, config/, public/ only. node_modules deliberately
// ignored — monorepo packages (Mesa/Sierra internals) require dev-server
// restart to pick up.
//
// Rebuild precision: for now, every reload-event-class rebuilds the WHOLE
// extension. Faster per-target rebuilds (only-rebuild-the-changed-island)
// are a future optimization. The dev WS still broadcasts the precise event
// so clients reload only what's needed.

import chokidar from 'chokidar'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

import { loadConfig }    from '../build/config-loader.js'
import { discover }      from '../build/discover.js'
import { buildExtension } from '../build/index.js'
import { classifyChange } from './classifier.js'
import { DevServer }      from './server.js'
import { assertExtDevPort } from './fjs-ports.js'
import { startBrowsers }  from './browser-launcher.js'

const WATCH_DIRS = ['src', 'config', 'public']

export async function startDev({ root, browser = 'chrome', verbose = false, launch = false, startUrl } = {}) {
  const log = (...args) => console.log('[jetty:dev]', ...args)

  // Normalize browser arg to array. Accept 'chrome', 'firefox', 'both', or array.
  const browsers = Array.isArray(browser)
    ? browser
    : browser === 'both'
      ? ['chrome', 'firefox']
      : [browser]
  for (const b of browsers) {
    if (b !== 'chrome' && b !== 'firefox') {
      throw new Error(`startDev: unsupported browser "${b}"`)
    }
  }

  // Resolve and validate dev port. The port is the same regardless of
  // browser — the dev WS serves all loaded browsers from one socket.
  const config = await loadConfig({ root, browser: browsers[0] })
  const port = assertExtDevPort(config.dev?.port, { source: 'jetty.config.js' })
  log(`config loaded; dev.port=${port}; browsers=[${browsers.join(', ')}]`)

  // Initial build for each browser
  log('initial build…')
  for (const b of browsers) {
    await buildExtension({ root, browser: b, verbose, dev: { port } })
  }
  log('initial build done')

  // Start dev WS server (one socket for all browsers)
  const server = new DevServer({ port })
  await server.start()

  // Optionally launch the browser(s) — wraps web-ext run.
  // The browser starts AFTER the WS server is up so the dev-client connects
  // immediately on first load.
  let browserHandle = null
  if (launch) {
    log('launching browser(s) via web-ext…')
    browserHandle = await startBrowsers({ root, browsers, verbose, startUrl })
  }

  // Watcher
  const watchPaths = WATCH_DIRS
    .map((d) => resolve(root, d))
    .filter((p) => existsSync(p))

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])\.\.?$/,             // dot-files
      /node_modules/,
      /\.jetty-cache/,
      /\bdist\b/,
      /\.git\//,
    ],
    awaitWriteFinish: {
      // Avoid firing twice on save in editors that write atomically
      stabilityThreshold: 60,
      pollInterval: 20,
    },
  })

  let rebuildPromise = Promise.resolve()
  let rebuildQueued  = false

  const onChange = async (changedPath) => {
    const relPath = changedPath.replace(root + '/', '').replace(root + '\\', '')

    // Re-discover to pick up new islands/piers etc.
    let found
    try {
      found = discover({ root })
    } catch (e) {
      log('discover error:', e.message)
      return
    }

    const event = classifyChange({ relPath, found })
    if (event.kind === 'noop') return

    log(`change: ${relPath} → ${event.kind}${event.target ? `:${event.target}` : ''}${event.islandId ? `:${event.islandId}` : ''}`)

    // Coalesce rebuilds — if one's running, queue exactly one more.
    if (rebuildQueued) {
      // Already a rebuild queued; this event piggy-backs on the next pass.
      return
    }
    rebuildQueued = true

    rebuildPromise = rebuildPromise.then(async () => {
      rebuildQueued = false
      try {
        // Build each configured browser. Sequential to avoid cache races.
        for (const b of browsers) {
          await buildExtension({ root, browser: b, verbose: false, dev: { port } })
        }
        server.broadcast(event)
      } catch (e) {
        console.error('[jetty:dev] rebuild failed:', e.message)
      }
    })
  }

  watcher.on('add',    onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)

  log(`watching: ${watchPaths.map((p) => p.replace(root + '/', '')).join(', ')}`)

  // Return a stop handle for tests / programmatic use
  return {
    server,
    watcher,
    browserHandle,
    async stop() {
      if (browserHandle) {
        try { await browserHandle.stop() } catch {}
      }
      await watcher.close()
      await server.stop()
    },
  }
}
