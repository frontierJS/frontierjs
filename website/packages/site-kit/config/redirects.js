// config/redirects.js — a site's own redirects, from content/settings/_redirects.
//
// A ksite client keeps its campaign links there (`/cbf-live/ /?utm_source=cbf`):
// short links with query strings, not moved pages, so a route file each would
// be the wrong home. site-kit only puts the file into the output. Sierra's
// post-build then merges it with the routes' `redirect:` rules and is the one
// writer of dist/_redirects (FJS-D920), and serveSite answers what it holds.
//
// content/public/_redirects is refused rather than read as well: Vite would
// copy it to the same path this emits, and which one shipped would turn on
// plugin order.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {object} opts
 * @param {string} opts.content   — the site's content/ directory
 * @param {string} opts.publicDir — the site's public directory
 * @returns {import('vite').Plugin}
 */
export function siteRedirects({ content, publicDir }) {
  if (existsSync(join(publicDir, '_redirects'))) {
    throw new Error(
      "site-kit: content/public/_redirects — a site's redirects are content/settings/_redirects, " +
      'which the build merges with every route\'s `redirect:`. Move the file there.'
    )
  }
  const file = join(content, 'settings/_redirects')

  return {
    name: 'site-kit:redirects',
    apply: 'build',
    generateBundle() {
      if (!existsSync(file)) return
      this.emitFile({ type: 'asset', fileName: '_redirects', source: readFileSync(file, 'utf8') })
    },
  }
}
