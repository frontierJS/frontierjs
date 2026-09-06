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
 * How many values a frontmatter block may expand to.
 *
 * YAML aliases are shared references, so a block that PARSES in six
 * milliseconds can serialize to hundreds of megabytes: nine anchors each
 * repeating the one above it nine times is 9^8 leaves, which `JSON.stringify`
 * turned into a 205 MB string inside the generated `config/routes.js`, and one
 * level further makes the build die with an allocation failure naming nothing
 * (`FJS-821` (f)). It matters because a `.md` route's frontmatter is written by
 * whoever writes the content, which on a documentation site is not whoever runs
 * the build.
 *
 * Counted rather than measured on the serialized string: counting aborts at the
 * budget, where stringifying to find out how big it is has already paid the
 * cost. Anything an author writes by hand is three orders of magnitude below
 * this — the largest frontmatter block in this repo is 14 values.
 */
const MAX_FRONTMATTER_VALUES = 10_000

/**
 * Count the values a parsed block expands to, stopping at `budget`.
 *
 * Deliberately follows an alias every time it appears rather than remembering
 * the object: what is being bounded is what the SERIALIZER will write, and the
 * serializer has no memory either. A cycle terminates for the same reason —
 * the budget runs out.
 *
 * @returns {number} the count, or a number greater than `budget` on overflow
 */
function countValues(value, budget) {
  let seen = 0
  const walk = (v) => {
    if (seen > budget) return
    seen++
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const item of v) walk(item) }
    else { for (const key of Object.keys(v)) walk(v[key]) }
  }
  walk(value)
  return seen
}

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
    error = `frontmatter is not valid YAML — ${err.message}`
    frontmatter = {}
  }

  // Bounded AFTER the parse and before anything serializes it. The parse itself
  // is cheap — the expansion is the cost, and it is paid by whoever writes the
  // value out.
  if (!error) {
    const count = countValues(frontmatter, MAX_FRONTMATTER_VALUES)
    if (count > MAX_FRONTMATTER_VALUES) {
      error =
        `frontmatter expands to more than ${MAX_FRONTMATTER_VALUES} values, which is a YAML ` +
        `alias repeated into a route table nothing here can write. Frontmatter holds what a ` +
        `route IS — a title, a render mode — so remove the anchors (&x) and aliases (*x).`
      frontmatter = {}
    }
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
    // Thrown rather than warned, and naming the file, because the alternative
    // failures name nothing: a block that will not parse becomes `{}`, which on
    // a static target is a page that is simply absent, and a block that expands
    // past the bound kills the build with an allocation failure pointing at no
    // file at all. Frontmatter is how a route says what it IS.
    const err = new Error(`${filePath}: ${error}`)
    err.code = 'SIERRA_BAD_FRONTMATTER'
    throw err
  }
  return frontmatter
}
