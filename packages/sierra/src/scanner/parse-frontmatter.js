/**
 * parse-frontmatter.js — YAML frontmatter extraction
 *
 * Handles frontmatter in both .mesa and .md files.
 * Mesa compiler exposes ctx.frontmatter for both file types —
 * Sierra reads it directly from there after compilation.
 *
 * This module is used by the scanner to read frontmatter
 * from source files without invoking the full Mesa compiler.
 * Useful for fast route table generation at build time.
 */

import { load as parseYaml } from 'js-yaml'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/**
 * Parse YAML frontmatter from a source string.
 *
 * @param {string} source — raw file contents
 * @returns {{ frontmatter: Record<string, unknown>, content: string, error: string|null }}
 */
export function parseFrontmatter(source) {
  const match = source.match(FRONTMATTER_RE)

  if (!match) {
    return { frontmatter: {}, content: source }
  }

  let frontmatter = {}
  let error = null
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed
    }
  } catch (err) {
    // Reported, not swallowed. The comment here used to say Sierra emitted a
    // warning separately and nothing did: a route whose frontmatter would not
    // parse got `{}`, which on a static target means no `render: static`, so
    // the page was never emitted and the build said it succeeded. An
    // unquoted colon in a description is enough to do it (`FJS-509`).
    error = err.message
    frontmatter = {}
  }

  const content = source.slice(match[0].length)
  return { frontmatter, content, error }
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
    // Thrown rather than warned. Frontmatter is how a route says what it IS —
    // its title, and on a static target whether it exists at all — so a file
    // whose block will not parse has no correct interpretation, and the
    // failure it produces otherwise is a page that is simply absent.
    const err = new Error(`${filePath}: frontmatter is not valid YAML — ${error}`)
    err.code = 'SIERRA_BAD_FRONTMATTER'
    throw err
  }
  return frontmatter
}
