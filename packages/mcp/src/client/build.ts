/*
 * src/client/build.ts — an app's `cli/` surface compiled into one binary, the
 * release `FJS-D397` names: a person runs `basecamp servers status` with no bun,
 * no node_modules and no source tree.
 *
 *   fli cli:build                                     this machine → cli/dist/<name>
 *   fli cli:build --target bun-darwin-arm64,bun-linux-x64
 *
 * which runs this file with bun (`--root <app>/cli`), resolved out of the app's
 * own node_modules; `buildCli` is the same thing as a function.
 *
 * Two things a plain `bun build --compile cli/src/main.js` gets wrong, and
 * neither says so:
 *   - a route is read off `cli/src/routes/` at run time, which the bundler
 *     cannot follow, so the binary offers every derived command and none of the
 *     app's own. Every route file goes in as an entrypoint of its own, and the
 *     count is stated as `process.env.FJS_CLI_ROUTES`, which `loadRoutes`
 *     checks inside a binary — the hand-built one refuses to start;
 *   - two entrypoints are two bundles, so a route would import its own copy of
 *     this package and `instanceof CallRefused` would fail across the seam.
 *     `splitting` gives them one copy.
 *
 * The binary's name is `cli/config/cli.config.js`'s `name`, which is also whose
 * profiles and cache it reads, so the file a person runs and the directories it
 * writes cannot disagree.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve }                   from 'node:path'
import { pathToFileURL }                   from 'node:url'
import { routeFiles }                      from './routes.ts'
import type { CliConfig }                  from './main.ts'

export interface BuildOptions {
  /** The surface — an app's `cli/`. */
  root:     string
  /** Bun compile targets (`bun-darwin-arm64`); none builds for this machine. Bun refuses an unknown one. */
  targets?: string[]
}

export interface Built {
  /** `null` is this machine. */
  target:  string | null
  outfile: string
  bytes:   number
  routes:  number
  /** Where a first `login` goes with no `--url` — a dev origin here ships to every user of the binary. */
  url:     string | null
}

const ENTRIES = ['src/main.js', 'src/main.ts']

export async function buildCli({ root, targets = [] }: BuildOptions): Promise<Built[]> {
  root = resolve(root)
  const entry = ENTRIES.map(e => join(root, e)).find(p => existsSync(p))
  if (!entry) throw new Error(`${root}: no ${ENTRIES.join(' or ')} — the entry a binary is built from`)

  const configFile = join(root, 'config', 'cli.config.js')
  const config: CliConfig = existsSync(configFile) ? (await import(pathToFileURL(configFile).href)).default ?? {} : {}
  if (!config.name) throw new Error(`${configFile}: names no program — the binary is called what \`name\` says`)

  const routes = routeFiles(join(root, 'src', 'routes'))
  const dist   = join(root, 'dist')
  mkdirSync(dist, { recursive: true })

  const built: Built[] = []
  for (const target of targets.length ? targets : [null]) {
    const windows = target ? target.includes('windows') : process.platform === 'win32'
    const outfile = join(dist, `${config.name}${target ? `-${target.replace(/^bun-/, '')}` : ''}${windows ? '.exe' : ''}`)
    const result  = await Bun.build({
      entrypoints: [entry, ...routes.map(r => r.file)],
      splitting:   true,
      compile:     target ? { outfile, target: target as Bun.Build.Target } : { outfile },
      define:      { 'process.env.FJS_CLI_ROUTES': JSON.stringify(String(routes.length)) },
    })
    if (!result.success)
      throw new Error(`${config.name}${target ? ` (${target})` : ''}: ${result.logs.map(l => l.message).join('\n')}`)
    built.push({ target, outfile, bytes: statSync(outfile).size, routes: routes.length, url: config.url ?? null })
  }
  return built
}

// ─── As a program ────────────────────────────────────────────────────────

if (import.meta.main) {
  const args  = process.argv.slice(2)
  const value = (name: string) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i < 0) return undefined
    return args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1]
  }
  try {
    const targets = (value('target') ?? '').split(',').map(t => t.trim()).filter(Boolean)
    for (const b of await buildCli({ root: value('root') ?? 'cli', targets }))
      console.log(`✓ ${b.outfile}  ${(b.bytes / 1024 / 1024).toFixed(1)} MB · ${b.routes} route(s) · first login → ${b.url ?? 'needs --url'}`)
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
