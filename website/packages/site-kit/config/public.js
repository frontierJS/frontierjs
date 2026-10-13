// config/public.js — a preset's public/ directory, beneath the site's own.
//
// A preset ships files its blocks and stylesheets name by URL — ksite's fonts
// and icons at /theme/…. Vite has one public directory and it is the site's,
// content/public/, so a preset's files reach neither dev nor the build without
// this. The directory is found, never named: it is public/ at the preset
// package's root, and a site whose public/ has the same path wins it, the way
// a client replaces a theme image without copying the rest.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const TYPES = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.txt': 'text/plain', '.xml': 'application/xml', '.pdf': 'application/pdf',
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

const isFile = (path) => {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * @param {object} opts
 * @param {string} opts.dir — the preset's public/ directory
 * @param {string} opts.site — the site's own public directory, which wins a path
 * @returns {import('vite').Plugin}
 */
export function presetPublic({ dir, site }) {
  dir = resolve(dir)
  return {
    name: 'site-kit:preset-public',

    // Ahead of Vite's own public middleware, so the site's file is checked here.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        let path
        try { path = decodeURIComponent((req.url ?? '').split('?')[0]) } catch { return next() }
        const file = join(dir, path)
        if (!file.startsWith(dir + sep) || !isFile(file) || isFile(join(site, path))) return next()
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },

    // Vite copies the site's public/ into the output itself; emitting a path
    // it also copies would replace one with the other in whichever order runs last.
    generateBundle() {
      for (const file of files(dir)) {
        const path = relative(dir, file).split(sep).join('/')
        if (existsSync(join(site, path))) continue
        this.emitFile({ type: 'asset', fileName: path, source: readFileSync(file) })
      }
    },
  }
}
