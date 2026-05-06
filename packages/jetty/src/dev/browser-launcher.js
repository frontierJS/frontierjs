// browser-launcher.js — spawns `web-ext run` for one or more browsers.
//
// `web-ext` is the standard tool (built by Mozilla) for launching a browser
// with a temporary profile and an extension pre-loaded. Despite the name it
// supports both Chromium and Firefox via `--target=chromium` / `firefox-desktop`.
//
// Why web-ext (vs spawning chrome ourselves):
//   - Cross-platform binary discovery — finds Chrome/Firefox on macOS, Linux, Win
//   - Manages a fresh temp profile per run; doesn't pollute your daily browser
//   - Built-in --reload flag watches the source-dir and reloads the extension
//   - Standard tool; users may already have it
//
// Why we shell out (vs importing as a library):
//   - web-ext is a CLI-first tool; its programmatic API is undocumented and
//     has had breaking changes between minor versions. The CLI surface is stable.
//   - Spawning lets us forward stdin/stdout naturally for log piping.
//   - Auto-installs via `npx web-ext` if not present locally.
//
// Lifecycle:
//   start()  — spawn web-ext for each requested browser; return a controller
//   stop()   — SIGTERM the children; resolves once they've all exited
//
// The orchestrator calls start() ONCE after the initial build, then leaves it
// running. web-ext's own --reload watching takes care of subsequent rebuilds.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const TARGETS = {
  chrome:  'chromium',
  firefox: 'firefox-desktop',
}

/**
 * Launch web-ext for each configured browser.
 *
 * @param {object} opts
 * @param {string} opts.root — extension project root (used to locate dist/<browser>/)
 * @param {string[]} opts.browsers — ['chrome'] | ['firefox'] | ['chrome','firefox']
 * @param {boolean} [opts.verbose] — pipe web-ext stdout to our console
 * @param {string} [opts.startUrl] — initial URL to open (default: about:blank for Firefox, none for Chrome)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startBrowsers({ root, browsers, verbose = false, startUrl }) {
  const log = (...args) => console.log('[jetty:browser]', ...args)

  // Each browser → child process record
  const children = []

  for (const browser of browsers) {
    const distDir = join(root, 'dist', browser)
    if (!existsSync(distDir)) {
      log(`✗ ${browser}: dist/${browser}/ not found — skipping. Run a build first.`)
      continue
    }

    const target = TARGETS[browser]
    if (!target) {
      log(`✗ ${browser}: unsupported (no web-ext target mapping) — skipping`)
      continue
    }

    const args = [
      'web-ext', 'run',
      '--target', target,
      '--source-dir', distDir,
      '--no-input',  // disable interactive prompts (web-ext sometimes asks at exit)
    ]

    // web-ext auto-reloads the extension when files in --source-dir change.
    // For Chromium this requires the developer to enable extension reload by
    // having the extension page open OR using web-ext's built-in mechanism.
    // The default behavior is fine for most cases; we don't need extra flags.

    if (startUrl) args.push('--start-url', startUrl)

    // Use npx so users don't need a global install. The first invocation may
    // download web-ext (a few seconds). Subsequent invocations are instant
    // from npm's cache. We use `npx --yes` to skip the "ok to proceed?" prompt.
    const cmd = 'npx'
    const fullArgs = ['--yes', ...args]

    log(`spawning ${browser}: npx ${fullArgs.join(' ')}`)

    const child = spawn(cmd, fullArgs, {
      cwd: root,
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    if (!verbose) {
      // Pipe output through our logger w/ a [browser] prefix so multi-browser
      // dev mode doesn't interleave indistinguishable lines.
      const prefix = `[web-ext:${browser}]`
      child.stdout?.on('data', (buf) => {
        for (const line of buf.toString().split('\n')) {
          if (line.trim()) console.log(prefix, line)
        }
      })
      child.stderr?.on('data', (buf) => {
        for (const line of buf.toString().split('\n')) {
          if (line.trim()) console.error(prefix, line)
        }
      })
    }

    child.on('error', (err) => {
      console.error(`[jetty:browser] ${browser} spawn error:`, err.message)
    })

    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        console.warn(`[jetty:browser] ${browser} exited with code=${code} signal=${signal}`)
      }
    })

    children.push({ browser, child })
  }

  if (children.length === 0) {
    log('no browsers launched (all skipped or unsupported)')
  }

  return {
    async stop() {
      // Send SIGTERM to all children and wait for exit.
      const exits = children.map(({ browser, child }) => new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        const timer = setTimeout(() => {
          // Force-kill if it doesn't exit in 3s
          try { child.kill('SIGKILL') } catch {}
          resolve()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        try { child.kill('SIGTERM') } catch {}
      }))
      await Promise.all(exits)
    },
    children,
  }
}
