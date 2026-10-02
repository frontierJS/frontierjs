#!/usr/bin/env bun
// bin/site-kit.js — run a site from its content/ folder.
//
//   site-kit dev <dir> [--port N]       client-routed, how a page is written
//   site-kit build <dir>                prerendered into <dir>/dist, what ships
//   site-kit preview <dir> [--port N]   serves <dir>/dist as a static host would
//
// Bun, not Node: the prerender imports each route's companion under the
// running runtime, and a companion may use what only Bun has.

import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const [cmd, dir] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const port = flag('port') ? Number(flag('port')) : undefined

const USAGE = 'usage: site-kit <dev|build|preview> <dir> [--port N]'
if (!dir || !['dev', 'build', 'preview'].includes(cmd)) {
  console.error(USAGE)
  process.exit(2)
}
const root = resolve(dir)

if (cmd === 'preview') {
  const { serveSite } = await import('@frontierjs/sierra/site/serve')
  const server = await serveSite({ dir: resolve(root, 'dist'), port: port ?? 0 })
  console.log(`\n  ·  serving ${dir}/dist at ${server.url}\n`)
} else {
  const vite = await import('vite')
  const { siteKit } = await import('../config/vite.js')
  const config = await siteKit({ root, port })

  if (cmd === 'build') {
    await vite.build(config)
  } else {
    const server = await vite.createServer(config)
    await server.listen()
    server.printUrls()
  }
}
