#!/usr/bin/env bun
// bin/site-kit.js — run a site from its content/ folder.
//
//   site-kit dev <dir> [--port N] [--host]       client-routed, how a page is written
//   site-kit build <dir>                         prerendered into <dir>/dist, what ships
//   site-kit preview <dir> [--port N] [--host]   serves <dir>/dist as a static host would
//
// Both servers answer on localhost only; --host opens them to the LAN.
//
// Bun, not Node: the prerender imports each route's companion under the
// running runtime, and a companion may use what only Bun has.

import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
// --host takes no value, so the word after it is still a positional.
const [cmd, dir] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port')
const port = flag('port') ? Number(flag('port')) : undefined
const lan  = args.includes('--host')

const USAGE = 'usage: site-kit <dev|build|preview> <dir> [--port N] [--host]'
if (!dir || !['dev', 'build', 'preview'].includes(cmd)) {
  console.error(USAGE)
  process.exit(2)
}
const root = resolve(dir)

if (cmd === 'preview') {
  const { serveSite } = await import('@frontierjs/sierra/site/serve')
  const server = await serveSite({ dir: resolve(root, 'dist'), port: port ?? 0, host: lan ? '0.0.0.0' : '127.0.0.1' })
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
  } else {
    const server = await vite.createServer(config)
    await server.listen()
    server.printUrls()
  }
}
