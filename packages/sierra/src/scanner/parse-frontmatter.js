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
 * @returns {{ frontmatter: Record<string, unknown>, content: string }}
 */
export function parseFrontmatter(source) {
  const match = source.match(FRONTMATTER_RE)

  if (!match) {
    return { frontmatter: {}, content: source }
  }

  let frontmatter = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed
    }
  } catch {
    // Malformed YAML — treat as no frontmatter
    // Sierra will emit a build warning separately
    frontmatter = {}
  }

  const content = source.slice(match[0].length)
  return { frontmatter, content }
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
  return parseFrontmatter(source).frontmatter
}
