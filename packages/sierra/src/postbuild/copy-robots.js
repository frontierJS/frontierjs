/**
 * copy-robots.js — Copy public/robots.txt to the output directory
 *
 * If the project has a public/robots.txt, copy it to the build output.
 * If none exists, generate a permissive default.
 */

import { copyFile, writeFile, access, mkdir } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string} root   — absolute project root
 * @param {string} outDir — absolute build output directory
 * @returns {Promise<string|null>}
 */
export async function copyRobots(root, outDir) {
  const src  = join(root, 'public', 'robots.txt')
  const dest = join(outDir, 'robots.txt')

  await mkdir(outDir, { recursive: true })

  try {
    await access(src)
    await copyFile(src, dest)
    return 'robots.txt ← public/robots.txt'
  } catch {
    // No public/robots.txt — write a permissive default
    const defaultRobots = [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: /sitemap.xml`,
    ].join('\n')

    await writeFile(dest, defaultRobots, 'utf8')
    return 'robots.txt (default)'
  }
}
