/**
 * parse-frontmatter.js — frontmatter extraction
 *
 * Handles frontmatter in both .mesa and .md files.
 * Mesa compiler exposes ctx.frontmatter for both file types —
 * Sierra reads it directly from there after compilation.
 *
 * This module is used by the scanner to read frontmatter
 * from source files without invoking the full Mesa compiler.
 * Useful for fast route table generation at build time.
 */

import { parseFrontmatter as readBlock, splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'

/**
 * Parse frontmatter from a source string.
 *
 * The meaning of the block is `@frontierjs/toolbelt/frontmatter`'s, which mesa's
 * `.md` compiler reads too, so `page.meta` and a module's `frontmatter` are one
 * object (`FJS-D549`). It refuses anchors and aliases, so the block's size is
 * the size of its text and the route table cannot be inflated by it (`FJS-821`).
 *
 * @param {string} source — raw file contents
 * @returns {{ frontmatter: Record<string, unknown>, content: string, error: string|null }}
 */
export function parseFrontmatter(source) {
  try {
    const { frontmatter, body } = readBlock(source)
    return { frontmatter, content: body, error: null }
  } catch (err) {
    // Reported, not swallowed. A route whose frontmatter is refused gets `{}`,
    // which on a static target means no `render: static`, so the page is never
    // emitted and the build says it succeeded (`FJS-509`).
    return { frontmatter: {}, content: splitFrontmatter(source).body, error: `frontmatter ${err.message}` }
  }
}

/**
 * Read and parse frontmatter from a file on disk.
 *
 * @param {string} filePath — absolute path
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readFrontmatter(filePath) {
  const { readFile } = await import('fs/promises')
  const source = await readFile(filePath, 'utf8')
  const { frontmatter, error } = parseFrontmatter(source)
  if (error) {
    // Thrown rather than warned, and naming the file: a block that will not
    // parse becomes `{}`, which on a static target is a page that is simply
    // absent. Frontmatter is how a route says what it IS.
    const err = new Error(`${filePath}: ${error}`)
    err.code = 'SIERRA_BAD_FRONTMATTER'
    throw err
  }
  return frontmatter
}
