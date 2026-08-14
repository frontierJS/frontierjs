#!/usr/bin/env node
// tools/cli.js — the `sierra` bin.
//
//   sierra routes --config config/sierra.config.js          write routes.snapshot.md
//   sierra routes --config config/sierra.config.js --check  exit 1 if it is stale (CI)
//   sierra routes --config config/sierra.config.js --stdout
//
// Run it from the app's WEB ROOT — the directory Vite is rooted at, which is
// what `routesDir` in the config is relative to. The snapshot lands there for
// the same reason: CI reruns the command from the snapshot's own directory.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve }             from 'node:path'

import { buildRoutesSnapshot } from './routes-snapshot.js'

const argv = process.argv.slice(2)

const flag    = (name) => argv.includes(`--${name}`)
const getFlag = (name) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}

const rel = (p) => relative(process.cwd(), p) || basename(p)

function fatal(message) {
  console.error(`\n  ✗  ${message}\n`)
  process.exit(1)
}

// ─── snapshot name ────────────────────────────────────────────────────────────
//
// One config is one target, and an app may have several — the example ships a
// SPA and a prerendered public site. The config's own name carries the
// difference, so the snapshot takes it too:
//
//   sierra.config.js         → routes.snapshot.md
//   sierra.static.config.js  → routes.static.snapshot.md
//
// Anything else keeps its whole basename, rather than being silently collapsed
// onto the default and overwriting the other target's file.

function snapshotNameFor(configPath) {
  const name  = basename(configPath)
  const match = name.match(/^sierra(?:\.([^.]+))?\.config\.(js|mjs|ts)$/)
  if (!match)  return `routes.${name.replace(/\.(js|mjs|ts)$/, '')}.snapshot.md`
  return match[1] ? `routes.${match[1]}.snapshot.md` : 'routes.snapshot.md'
}

// ─── routes ───────────────────────────────────────────────────────────────────

async function cmdRoutes() {
  const configPath = getFlag('config') ?? 'config/sierra.config.js'
  const absConfig  = resolve(configPath)

  if (!existsSync(absConfig))
    fatal(`No Sierra config at ${rel(absConfig)} — name one with --config, and run this from the app's web root`)

  const mod    = await import(`file://${absConfig}`)
  const config = mod.default ?? mod

  const outPath = getFlag('out')
    ? resolve(getFlag('out'))
    : resolve(process.cwd(), snapshotNameFor(absConfig))

  // The config is named RELATIVE TO THE SNAPSHOT: the file is byte-compared,
  // and a cwd-relative path would render differently from the app directory
  // and from the repo root.
  const source  = relative(process.cwd(), absConfig)
  const command = `sierra routes --config ${source}`
  const body    = await buildRoutesSnapshot(config, { source, command })

  if (flag('stdout')) { process.stdout.write(body); return }

  if (flag('check')) {
    if (!existsSync(outPath))
      fatal(`No snapshot at ${rel(outPath)} — run \`sierra routes\` and commit it.`)

    const committed = readFileSync(outPath, 'utf8')
    if (committed === body) {
      console.log(`  ✓  ${rel(outPath)} is current`)
      return
    }

    const was = committed.split('\n')
    const now = body.split('\n')
    const changed = []
    for (let i = 0; i < Math.max(was.length, now.length); i++) {
      if (was[i] === now[i]) continue
      changed.push(`    - ${was[i] ?? '(absent)'}`)
      changed.push(`    + ${now[i] ?? '(absent)'}`)
      if (changed.length >= 20) break
    }

    console.log(`  ✗  ${rel(outPath)} does not match the route tree\n`)
    console.log(changed.join('\n'))
    if (changed.length >= 20) console.log('    …')
    console.log()
    console.log('  The route table changed. Run `sierra routes` and review the diff before committing.')
    console.log()
    process.exit(1)
  }

  writeFileSync(outPath, body, 'utf8')
  console.log(`  ✓  ${rel(outPath)}`)
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

const cmd = argv.find(a => !a.startsWith('--'))

if (cmd === 'routes') {
  await cmdRoutes()
} else {
  console.log('Usage: sierra routes [--config config/sierra.config.js] [--check] [--stdout] [--out <path>]')
  console.log()
  console.log('  routes   write the route table snapshot (--check in CI)')
  console.log()
  console.log('  Run from the app web root — the directory routesDir is relative to.')
  process.exit(cmd ? 1 : 0)
}
