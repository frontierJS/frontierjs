#!/usr/bin/env bun
/*
 * serve.js — a static file server for the demo.
 *
 * The demo also opens straight from the filesystem (the @import chain
 * resolves fine over file://), but a server is what you want for
 * DevTools, responsive testing and a phone on the same network.
 *
 * Serves the package root, not demo/, because index.html links
 * ../src/index.css — the real stylesheet, not a copy. That is the whole point:
 * the demo cannot drift from the package.
 */

import { file } from 'bun';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const port = Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);

    /*
     * Redirect rather than rewrite. Serving demo/index.html *at* `/` would
     * leave the browser's base URL at `/`, so the page's own `./demo.css`
     * would resolve to `/demo.css` and 404 — silently, since a missing
     * stylesheet is not an error, just an unstyled page. Redirecting moves
     * the base URL too.
     */
    if (path === '/') {
      return Response.redirect('/demo/', 302);
    }
    if (path === '/demo' || path === '/demo/') path = '/demo/index.html';

    /*
     * Contain the served path to the package root. `normalize` collapses
     * any ../ before the check, so a request for /../../etc/passwd
     * resolves and is then rejected for leaving the root.
     */
    const target = normalize(join(pkgRoot, path));
    if (!target.startsWith(pkgRoot)) {
      return new Response('Forbidden', { status: 403 });
    }

    const f = file(target);
    if (!(await f.exists())) {
      return new Response('Not found: ' + path, { status: 404 });
    }

    return new Response(f, {
      headers: {
        'content-type': TYPES[extname(target)] || 'application/octet-stream',
        /* No caching, so an edit to a .css file shows on reload. */
        'cache-control': 'no-store',
      },
    });
  },
});

console.log(`\n  @frontierjs/css demo → http://localhost:${server.port}\n`);
console.log(`  serving ${pkgRoot}`);
console.log(`  ctrl-c to stop\n`);
