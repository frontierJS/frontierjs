#!/usr/bin/env bun
// bin/site-kit.js — run a site from its content/ folder.
//
//   site-kit dev <dir> [--port N] [--host]       client-routed, how a page is written
//   site-kit build <dir> [--binary]              prerendered into <dir>/dist, what ships;
//                                                --binary then compiles it into <dir>/bin/site
//   site-kit preview <dir> [--port N] [--host]   serves <dir>/dist as a static host would
//   site-kit check <dir> [--source] [--live] [--url U] [--only a,b] [--offline] [--json] [--all]
//                                                what is broken or unfinished before it ships:
//                                                content/, and dist/ when there is one; exits 1
//                                                on an error. Any other --flag reaches the
//                                                preset's rules (ksite reads --launch).
//   site-kit fetch <dir> <url|sitemap> [--from U] [--config F] [--select S] [--prefix P]
//                  [--strip P] [--limit N] [--delay ms] [--timeout ms] [--retry]
//                  [--user-agent UA] [--meta-only] [--no-images] [--dry]
//                                                an existing site's pages into
//                                                <dir>/content/routes as Markdown
//
// Both servers answer on localhost only; --host opens them to the LAN.
//
// Bun, not Node: the prerender imports each route's companion under the
// running runtime, and a companion may use what only Bun has.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
// --host takes no value, so the word after it is still a positional.
const VALUED = ['--port', '--url', '--only', '--from', '--config', '--select', '--prefix', '--strip', '--limit', '--delay', '--timeout', '--user-agent']
const [cmd, dir, target] = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]))
const port   = flag('port') ? Number(flag('port')) : undefined
const lan    = args.includes('--host')
const binary = args.includes('--binary')

const USAGE = 'usage: site-kit <dev|build|preview|check|fetch> <dir> [--port N] [--host] [--binary]'
if (!dir || !['dev', 'build', 'preview', 'check', 'fetch'].includes(cmd)) {
  console.error(USAGE)
  process.exit(2)
}
if (binary && cmd !== 'build') {
  console.error('site-kit: --binary compiles what a build wrote, so it goes with build')
  console.error(USAGE)
  process.exit(2)
}
const root = resolve(dir)

// The entry the last build wrote for the site's host functions, when its Sierra
// config names a directory (Sierra's `.sierra/functions.js`, beside routes.js).
async function functionsEntry() {
  const { resolveSite } = await import('../config/vite.js')
  if (!(await resolveSite({ root })).sierra.functions) return undefined
  const entry = resolve(root, '.sierra/functions.js')
  if (!existsSync(entry)) {
    console.error('site-kit: no .sierra/functions.js — the build writes it; run build first')
    process.exit(1)
  }
  return entry
}

if (cmd === 'fetch') {
  const { runFetch, loadFetchConfig, validateFetchConfig } = await import('../fetch/run.js')
  const say = (mark) => (msg) => console.log(`  ${mark} ${msg}`)
  const log = { info: say('·'), success: say('✓'), dry: say('dry'), warn: (m) => console.warn(`  ⚠ ${m}`) }
  const num = (name) => flag(name) === undefined ? undefined : Number(flag(name))
  try {
    const config = flag('config') ? await loadFetchConfig(flag('config')) : {}
    const { errors, warnings } = validateFetchConfig(config)
    for (const w of warnings) log.warn(w)
    if (errors.length) throw new Error(`${flag('config')} is not a fetch config:\n    ${errors.join('\n    ')}`)
    const { skipped } = await runFetch({
      root, target, config,
      from:      flag('from'),
      select:    flag('select'),
      prefix:    flag('prefix'),
      strip:     flag('strip'),
      limit:     num('limit'),
      delay:     num('delay'),
      timeout:   num('timeout'),
      userAgent: flag('user-agent'),
      retry:     args.includes('--retry'),
      metaOnly:  args.includes('--meta-only'),
      images:    !args.includes('--no-images'),
      dry:       args.includes('--dry'),
      log,
    })
    process.exitCode = skipped.length ? 1 : 0
  } catch (e) {
    console.error(`site-kit fetch: ${e.message}`)
    process.exit(2)
  }
} else if (cmd === 'check') {
  const { runCheck } = await import('../check/run.js')
  const { printCheck } = await import('../check/print.js')
  const known = new Set(['--source', '--live', '--url', '--only', '--offline', '--json', '--all'])
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--') && !known.has(a)).map((a) => [a.slice(2), true]))
  let result
  try {
    result = await runCheck({
      root,
      stages:  args.includes('--source') ? ['source'] : undefined,
      live:    args.includes('--live'),
      url:     flag('url'),
      only:    flag('only')?.split(',').filter(Boolean),
      offline: args.includes('--offline'),
      flags,
    })
  } catch (e) {
    console.error(`site-kit check: ${e.message}`)
    process.exit(2)
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else printCheck(result, { all: args.includes('--all') })
  // exitCode, not exit(): exit() cuts off output still flushing to a pipe
  process.exitCode = result.counts.error ? 1 : 0
} else if (cmd === 'preview') {
  const { serveSite } = await import('@frontierjs/sierra/site/serve')
  const server = await serveSite({
    dir: resolve(root, 'dist'), port: port ?? 0, host: lan ? '0.0.0.0' : '127.0.0.1',
    functions: await functionsEntry(), env: process.env,
  })
  console.log(`\n  ·  serving ${dir}/dist at ${server.url}\n`)
} else {
  // The site's vite, which is a peer: Vite finds a preset's preprocessors
  // (ksite's sass) beside its own copy. A bare import from a linked site-kit
  // finds the workspace's copy instead, and every .scss fails to compile.
  let vitePath
  try {
    vitePath = Bun.resolveSync('vite', root)
  } catch {
    console.error(`site-kit: vite does not resolve from ${root}; the site installs it, as a peer of @frontierjs/site-kit`)
    process.exit(1)
  }
  const vite = await import(vitePath)
  const { siteKit } = await import('../config/vite.js')
  const config = await siteKit({ root, port, host: lan })

  if (cmd === 'build') {
    await vite.build(config)
    if (binary) {
      const { compileSite } = await import('@frontierjs/sierra/site/compile')
      const made = compileSite({ dir: resolve(root, 'dist'), outfile: resolve(root, 'bin/site'), functions: await functionsEntry() })
      console.log(`\n  ·  ${made.files} files from ${dir}/dist → ${dir}/bin/site\n     run it: ${dir}/bin/site --port 8080\n`)
    }
  } else {
    const server = await vite.createServer(config)
    await server.listen()
    server.printUrls()
  }
}
