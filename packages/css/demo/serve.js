#!/usr/bin/env bun
/*
 * serve.js — a static file server for the demo.
 *
 * The demo also opens straight from the filesystem (the @import chain
 * resolves fine over file://), but a server is what you want for
 * DevTools, responsive testing and a phone on the same network.
 *
 * Serves a root ABOVE demo/, because index.html links ../src/index.css — the
 * real stylesheet, not a copy. That is the whole point: the demo cannot drift
 * from the package.
 *
 * Inside the monorepo the root is the workspace, not the package, because the
 * guide imports glow from @frontierjs/toolbelt by relative path. A browser clamps
 * `..` at the origin, so serving only packages/css would 404 that request
 * while the same page opened over file:// worked — the kind of split where
 * the guide looks fine until someone runs the server.
 */

import { file } from 'bun';
import { join, normalize, extname, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgRoot = normalize(join(fileURLToPath(import.meta.url), '..', '..'));

/* Walk up for the package.json that declares workspaces. Outside a checkout
   — an installed copy — there is none, and the package root is the root. */
function findWorkspaceRoot(from) {
  let dir = from;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir;
      } catch {
        /* an unreadable manifest is not a workspace root; keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const root = findWorkspaceRoot(pkgRoot) || pkgRoot;
/* Where packages/css sits inside whatever root we settled on, as a URL path. */
const base = pkgRoot.slice(root.length).split(/[\\/]/).filter(Boolean).join('/');
const prefix = base ? '/' + base : '';

// dev/fe, project 4 — the FJS port scheme, packages/cli/core/ports.js
const port = Number(process.env.PORT || 8040);

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
    if (path === '/' || path === '/demo' || path === '/demo/') {
      return Response.redirect(`${prefix}/demo/`, 302);
    }
    if (path === '/guide' || path === '/guide/') {
      return Response.redirect(`${prefix}/guide/`, 302);
    }
    if (path.endsWith('/')) path += 'index.html';

    /*
     * Contain the served path to the root. `normalize` collapses any ../
     * before the check, so a request for /../../etc/passwd resolves and is
     * then rejected for leaving the root.
     */
    const target = normalize(join(root, path));
    if (!target.startsWith(root)) {
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

console.log(`\n  @frontierjs/css demo  → http://localhost:${server.port}${prefix}/demo/`);
console.log(`  @frontierjs/css guide → http://localhost:${server.port}${prefix}/guide/\n`);
console.log(`  serving ${root}`);
console.log(`  ctrl-c to stop\n`);
