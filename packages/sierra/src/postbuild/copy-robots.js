/**
 * copy-robots.js — Copy public/robots.txt to the output directory
 *
 * If the project has a public/robots.txt, copy it to the build output.
 * If none exists, generate a permissive default.
 */

import { copyFile, writeFile, access, mkdir } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string} root      — absolute project root
 * @param {string} outDir    — absolute build output directory
 * @param {string} [siteUrl] — the origin this will be served from
 * @returns {Promise<string|null>}
 */
export async function copyRobots(root, outDir, siteUrl = '') {
  const src  = join(root, 'public', 'robots.txt')
  const dest = join(outDir, 'robots.txt')

  await mkdir(outDir, { recursive: true })

  try {
    await access(src)
    await copyFile(src, dest)
    return 'robots.txt ← public/robots.txt'
  } catch {
    // No public/robots.txt — write a permissive default.
    //
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

    await writeFile(dest, defaultRobots, 'utf8')
    return base
      ? 'robots.txt (default)'
      : 'robots.txt (default, no Sitemap line — set `siteUrl` in the Sierra config)'
  }
}
