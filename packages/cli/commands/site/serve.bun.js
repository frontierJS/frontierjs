#!/usr/bin/env bun
// Sidecar for fli site:serve. Spawned by the .md command so the actual
// serving runs under Bun (where Bun.serve exists) regardless of which
// runtime is hosting fli itself.
//
// Usage: bun run serve.bun.js <sitePath> <port>

import path from 'path'

const [, , sitePath, portArg] = process.argv
const port = Number(portArg) || 3000

if (!sitePath) {
  console.error('Missing sitePath argument')
  process.exit(1)
}

const server = Bun.serve({
  port,
  development: false,
  async fetch(req) {
    const url      = new URL(req.url)
    const pathname = decodeURIComponent(url.pathname)
    const target   = path.resolve(sitePath, '.' + pathname)

    // Path traversal protection — must stay inside sitePath
    if (target !== sitePath && !target.startsWith(sitePath + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    // 1) Direct file (handles assets: /main.abc.js, /favicon.ico, etc.)
    let file = Bun.file(target)
    if (await file.exists()) return new Response(file)

    // 2) Folder with index.html (handles /about, /posts/foo)
    file = Bun.file(path.join(target, 'index.html'))
    if (await file.exists()) return new Response(file)

    // 3) Bare .html (handles /about → /about.html for flat-file builds)
    if (!pathname.endsWith('/') && !pathname.endsWith('.html')) {
      file = Bun.file(target + '.html')
      if (await file.exists()) return new Response(file)
    }

    // 4) Custom 404.html if present, else plain text
    const notFound = Bun.file(path.join(sitePath, '404.html'))
    if (await notFound.exists()) {
      return new Response(notFound, { status: 404 })
    }
    return new Response('Not found', { status: 404 })
  },

  error(err) {
    return new Response(`Server error: ${err.message}`, { status: 500 })
  },
})

console.log(`http://localhost:${server.port}`)
console.log(`  Serving ${sitePath}`)
console.log(`  Ctrl+C to stop`)
