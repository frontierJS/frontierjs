#!/usr/bin/env bun
/*
 * serve.js — static server for the site.
 *
 *   bun run dev        serve the source, styled by the real @frontierjs/css
 *   bun run preview    serve dist/, exactly what deploys
 *
 * In dev the page is served at `/`, so its `../packages/css/index.css` link
 * resolves to `/packages/css/index.css` (a browser clamps `..` at the root).
 * That prefix is mapped to the actual package directory, which means dev is
 * always rendering the live stylesheet — edit a token in packages/css and
 * reload. The same reason css/demo serves the package root: a copy drifts.
 *
 * preview serves dist/ with no such mapping, so a broken vendor step shows up
 * as an unstyled page here rather than in production.
 */

import { file } from 'bun'
import { join, normalize, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here    = dirname(fileURLToPath(import.meta.url))
const isDist  = process.argv.includes('--dist')
const root    = isDist ? join(here, 'dist') : here
const cssPkg  = normalize(join(here, '..', 'packages', 'css'))
const port    = Number(process.env.PORT || 3400)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
}

if (isDist && !(await file(join(root, 'index.html')).exists())) {
  console.error('\n  ✗ No dist/index.html — run `bun run build` first.\n')
  process.exit(1)
}

const send = async (target, contain) => {
  // Contain the served path. normalize() collapses any ../ before the check,
  // so /../../etc/passwd resolves and is then rejected for leaving the root.
  if (!target.startsWith(contain)) return new Response('Forbidden', { status: 403 })

  const f = file(target)
  if (!(await f.exists())) return new Response(`Not found: ${target}`, { status: 404 })

  return new Response(f, {
    headers: {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      // No caching, so an edit to a .css or .html file shows on reload.
      'cache-control': 'no-store',
    },
  })
}

const server = Bun.serve({
  port,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname)
    if (path === '/' || path.endsWith('/')) path += 'index.html'

    // Dev only: serve the design system from the package itself, never a copy.
    if (!isDist && path.startsWith('/packages/css/')) {
      return send(normalize(join(cssPkg, path.slice('/packages/css/'.length))), cssPkg)
    }

    return send(normalize(join(root, path)), root)
  },
})

console.log(`\n  FrontierJS site${isDist ? ' (dist)' : ''} → http://localhost:${server.port}\n`)
console.log(`  serving ${root}`)
if (!isDist) console.log(`  stylesheet ${cssPkg} (live)`)
console.log(`  ctrl-c to stop\n`)
