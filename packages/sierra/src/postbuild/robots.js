/**
 * robots.js — a robots.txt for every build
 *
 * The app's own robots.txt is in Vite's public directory, which Vite copies into
 * the output before this runs, wherever `publicDir` points. So one already in
 * the output is the app's, and stays. Only a build without one gets a default.
 * Copying `<root>/public/robots.txt` here instead overwrote the app's file with
 * the default whenever `publicDir` was anywhere else, as in a site-kit site.
 */

import { access, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string} outDir    — absolute build output directory
 * @param {string} [siteUrl] — the origin this will be served from
 * @returns {Promise<string>}
 */
export async function writeRobots(outDir, siteUrl = '') {
  const dest = join(outDir, 'robots.txt')

  try {
    await access(dest)
    return 'robots.txt ← the public directory'
  } catch {
    // `Sitemap:` takes an ABSOLUTE URL. A relative one is not a sitemap a
    // crawler tries and fails to fetch, it is a line every crawler discards —
    // so the default emitted `Sitemap: /sitemap.xml` and advertised nothing,
    // while looking in the output exactly like a site that had.
    //
    // With no `siteUrl` the line is OMITTED rather than written relative,
    // because the two are worth the same to a crawler and only one of them
    // says so. The postbuild line reports which happened, since a missing
    // config value is the operator's to fix and nothing else would mention it.
    const base = siteUrl.replace(/\/$/, '')
    const defaultRobots = [
      'User-agent: *',
      'Allow: /',
      ...(base ? ['', `Sitemap: ${base}/sitemap.xml`] : []),
    ].join('\n') + '\n'

    await mkdir(outDir, { recursive: true })
    await writeFile(dest, defaultRobots, 'utf8')
    return base
      ? 'robots.txt (default)'
      : 'robots.txt (default, no Sitemap line — set `siteUrl` in the Sierra config)'
  }
}
