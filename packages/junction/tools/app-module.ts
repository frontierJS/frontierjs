#!/usr/bin/env bun
// tools/app-module.ts
// Reading a BUILT Junction app off a module, for the tools that snapshot one.
//
// `junction surface` and `junction jobs` both answer a question no source scan
// can: what did this app turn out to be once every plugin registered, every
// hook compiled and every route mounted. Both therefore need the same awkward
// half — find the app or its factory, refuse an ambiguous module, run the
// non-host startup phases, and keep the build's own chatter off stdout.
//
// It lives here because two copies of *how do you load an app* is how one tool
// snapshots an app the other never sees. The argument parsing and the `--check`
// byte compare are here for the same reason: every snapshot in this repo is
// reread by one CI phase that has no idea which is which, so they have to fail
// the same way.

import { existsSync, readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

import type { App } from '../src/core/app.ts'

// ─── args ─────────────────────────────────────────────────────────────────────

const argv = Bun.argv.slice(2)

export const flag    = (name: string) => argv.includes(`--${name}`)
export const getFlag = (name: string) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}

export const rel = (p: string) => relative(process.cwd(), p) || basename(p)

export function fatal(message: string): never {
  console.error(`\n  ✗  ${message}\n`)
  process.exit(1)
}

// ─── loading the app ──────────────────────────────────────────────────────────
//
// Ambiguity is refused rather than guessed. A module exporting two factories has
// no obvious answer, and picking one silently would snapshot an app the running
// process never serves.

const isApp = (v: unknown): v is App =>
  !!v && typeof v === 'object' &&
  typeof (v as Record<string, unknown>).service === 'function' &&
  typeof (v as Record<string, unknown>).configure === 'function'

const FACTORY = /^(create|build|make)[A-Z]?\w*(App|Api)?$/

// Building an app is loud — its logger, the loader, and every plugin that
// announces itself write to stdout. With `--stdout` the caller is redirecting
// stdout into a file, so those lines would land INSIDE the snapshot. Moved to
// stderr for the duration of the build rather than silenced: a failure to boot
// has to stay readable, and it is the only diagnosis this tool can offer.
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write

  // console is patched SEPARATELY, and it has to be: Bun's console holds its own
  // binding to the stream, so reassigning `process.stdout.write` does not reach
  // a `console.log`. Measured — Caravan's autoload announces itself that way and
  // the line landed inside a redirected snapshot as its first line, above the
  // `#` heading, which is a committed artefact corrupted by a log.
  const patched = ['log', 'info', 'debug', 'warn', 'dir', 'table'] as const
  const saved = patched.map(k => [k, console[k]] as const)
  for (const k of patched) console[k] = (...args: unknown[]) => console.error(...args)

  try { return await fn() } finally {
    process.stdout.write = write
    for (const [k, fnRef] of saved) console[k] = fnRef as never
  }
}

export async function loadApp(modulePath: string, exportName: string | null, servicesDir: string | null): Promise<App> {
  const abs = resolve(modulePath)
  if (!existsSync(abs)) fatal(`No such module: ${rel(abs)}`)

  const mod = await quietly(() => import(`file://${abs}`)) as Record<string, unknown>

  if (exportName) {
    const picked = mod[exportName]
    if (picked === undefined) fatal(`${rel(abs)} has no export \`${exportName}\` — found: ${Object.keys(mod).join(', ') || '(none)'}`)
    return build(picked, exportName, servicesDir)
  }

  const apps      = Object.entries(mod).filter(([, v]) => isApp(v))
  const factories = Object.entries(mod).filter(([k, v]) => typeof v === 'function' && (k === 'default' || FACTORY.test(k)))

  const candidates = [...apps, ...factories]
  if (!candidates.length)
    fatal(
      `${rel(abs)} exports no app and no factory.\n` +
      `     Export the built app, or a function returning it (\`createApp\`, \`buildApp\`, \`default\`),\n` +
      `     and name it with --export if the module has more than one.`
    )
  if (candidates.length > 1)
    fatal(`${rel(abs)} exports more than one candidate — name one with --export: ${candidates.map(([k]) => k).join(', ')}`)

  return build(candidates[0][1], candidates[0][0], servicesDir)
}

async function build(value: unknown, label: string, servicesDir: string | null): Promise<App> {
  const app = typeof value === 'function'
    ? await quietly(() => Promise.resolve((value as () => App | Promise<App>)()))
    : value
  if (!isApp(app)) fatal(`\`${label}\` is not a Junction app (no .service()/.configure())`)

  // Autoload is a `needsHost` phase — its default directory is resolved against
  // `Bun.main`, which here is this tool, so the test lifecycle skips it and an
  // app whose services are all autoloaded describes as empty. Named explicitly
  // and run in the same position production runs it: before boot, so a plugin's
  // boot() sees every service.
  if (servicesDir) {
    const abs = resolve(servicesDir)
    if (!existsSync(abs)) fatal(`No services directory at ${rel(abs)}`)
    const { autoloadServices } = await import('../src/core/loader.ts')
    await quietly(() => autoloadServices({ dir: abs, app, registry: app.services }))
  }

  // Plugins boot, hooks compile, service routes mount — everything except the
  // phases needing a port. Without it there are no routes to read and no
  // plugin-registered services at all.
  await quietly(() => app._startForTest())
  return app
}


// ─── --check ──────────────────────────────────────────────────────────────────
//
// A byte compare, and the useful output is the lines that moved. Mirrors
// `litestone access --check` / `litestone ddl --check` deliberately: one CI
// phase reruns all three and has no idea which is which.

export function checkSnapshot(outPath: string, body: string, command: string, subject: string): never | void {
  if (!existsSync(outPath))
    fatal(`No snapshot at ${rel(outPath)} — run \`junction surface\` and commit it.`)

  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) {
    console.log(`  ✓  ${rel(outPath)} is current`)
    return
  }

  const was = committed.split('\n')
  const now = body.split('\n')
  const changed: string[] = []
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    if (was[i] === now[i]) continue
    changed.push(`    - ${was[i] ?? '(absent)'}`)
    changed.push(`    + ${now[i] ?? '(absent)'}`)
    if (changed.length >= 20) break
  }

  console.log(`  ✗  ${rel(outPath)} does not match the app\n`)
  console.log(changed.join('\n'))
  if (changed.length >= 20) console.log('    …')
  console.log()
  console.log(`  The ${subject} changed. Run \`${command}\` and review the diff before committing.`)
  console.log()
  process.exit(1)
}

