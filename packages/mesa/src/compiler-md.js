/**
 * @frontierjs/mesa-compiler-md — Markdown + frontmatter compiler for Mesa.
 *
 * Compiles a .md file to the same output as compile() from compiler.js.
 * Returns the same ctx shape plus ctx.frontmatter, ctx.layout, ctx.markdownHTML.
 *
 * Pipeline:
 *   1. Parse frontmatter (--- block)
 *   2. Extract <script> block if present
 *   3. Protect Mesa block directives with HTML comment placeholders
 *      (Mesa components pass through naturally via allowDangerousHtml)
 *   4. Run unified / remark-gfm / rehype
 *   5. Restore placeholders
 *   6. Reconstruct as .mesa source and feed to compile()
 */

import { unified }     from 'unified'
import remarkParse     from 'remark-parse'
import remarkGfm       from 'remark-gfm'
import remarkRehype    from 'remark-rehype'
import rehypeSlug      from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import { glow }        from '@frontierjs/toolbelt/glow'
import { compile }     from './compiler.js'

// ─── Frontmatter ──────────────────────────────────────────────────────────────

/**
 * Parse YAML-ish frontmatter from a .md source string.
 * Handles: strings, numbers, booleans, null, inline arrays, multi-line arrays.
 *
 * Inline array:   tags: [a, b, c]
 * Quoted inline:  tags: ["tag one", "tag two"]
 * Multi-line:     tags:
 *                   - alpha
 *                   - beta
 *
 * @param {string} src
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(src) {
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: {}, body: src }

  const body  = src.slice(match[0].length)
  const fm    = {}
  const lines = match[1].split('\n')
  let i = 0

  while (i < lines.length) {
    const line  = lines[i]
    const colon = line.indexOf(':')
    if (colon === -1) { i++; continue }

    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    if (!key) { i++; continue }

    // Multi-line array — key with no value, followed by `  - item` lines
    if (raw === '') {
      const items = []
      let j = i + 1
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(parseScalar(lines[j].replace(/^\s+-\s+/, '').trim()))
        j++
      }
      if (items.length > 0) {
        fm[key] = items
        i = j
        continue
      }
      // No list items — treat as null
      fm[key] = null
      i++
      continue
    }

    fm[key] = parseScalar(raw)
    i++
  }

  return { frontmatter: fm, body }
}

/**
 * Parse a single scalar YAML value from a raw string.
 * Handles: booleans, null, numbers, quoted strings, inline arrays, plain strings.
 */
function parseScalar(raw) {
  if (raw === 'true')  return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === '~' || raw === '') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)

  // Inline array: [a, b, c] or ["x", 'y', 1, true]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    // Split on commas not inside quotes
    const items = []
    let current = ''
    let inQuote = null
    for (const ch of inner) {
      if ((ch === '"' || ch === "'") && !inQuote) { inQuote = ch; continue }
      if (ch === inQuote) { inQuote = null; continue }
      if (ch === ',' && !inQuote) {
        items.push(parseScalar(current.trim()))
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) items.push(parseScalar(current.trim()))
    return items
  }

  // Quoted string
  if (/^['"]/.test(raw)) return raw.replace(/^['"]|['"]$/g, '')

  return raw
}

// ─── Script block ─────────────────────────────────────────────────────────────

/**
 * Extract the first <script> block from Markdown body.
 * Returns { script: string (with tags), body: string (without script block) }.
 */
function extractScript(body) {
  const match = body.match(/(<script[^>]*>[\s\S]*?<\/script>)/)
  if (!match) return { script: '', body }
  return {
    script: match[1],
    body: body.slice(0, match.index) + body.slice(match.index + match[0].length)
  }
}

/**
 * In the developer's script block, `export const name` and `export let name`
 * without initializers are valid Mesa but invalid JS (acorn rejects const).
 * Add `= undefined` so the Mesa compiler can parse them.
 */
function fixUninitialized(script) {
  return script.replace(
    /\b(export\s+(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*)(\s*[,;\n])/g,
    (m, decl, end) => {
      // Skip if it already has an initializer ( = something )
      if (/=/.test(m)) return m
      return `${decl} = undefined${end}`
    }
  )
}

// ─── Placeholder system ───────────────────────────────────────────────────────

// Block-level Mesa directives get wrapped in <p> by remark.
// Replace them with HTML comments (block-level, preserved by rehype).
// Mesa component tags (<Counter />) pass through with allowDangerousHtml — no protection needed.
// Inline expressions ({title}, {count}, etc.) survive Markdown intact.

const PLACEHOLDER_RE = /<!--MESA:(\d+)-->/g

function protect(src) {
  const map = []
  const store = (s) => {
    const i = map.length
    map.push(s)
    return `<!--MESA:${i}-->`
  }

  // Block-level directives: lines whose trimmed content is ONLY a Mesa directive.
  // These are: {#if ...}, {:else}, {:else if ...}, {/if},
  //            {#each ...}, {/each}, {#await ...}, {:then ...}, {:catch ...}, {/await},
  //            {#snippet ...}, {/snippet}, {@html ...}
  // Match the whole line including leading/trailing whitespace.
  src = src.replace(
    /^[ \t]*(\{[#/:@][^{}]*\})[ \t]*$/gm,
    (_, directive) => store(directive)
  )

  return { protected: src, map }
}

function restore(src, map) {
  return src.replace(PLACEHOLDER_RE, (_, idx) => map[Number(idx)] ?? '')
}

// ─── Markdown processor ───────────────────────────────────────────────────────

// Default (no user plugins) — singleton for performance
const _defaultProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeSlug)
  .use(rehypeStringify, { allowDangerousHtml: true })

/**
 * Build a processor with user-supplied remark/rehype plugins inserted
 * after the built-in plugins. User remark plugins run after remarkGfm;
 * user rehype plugins run after rehypeSlug.
 *
 * Each entry in remarkPlugins/rehypePlugins is either:
 *   - a function (the plugin itself)
 *   - [plugin, options]  (plugin with options)
 */
function buildProcessor(remarkPlugins = [], rehypePlugins = []) {
  let p = unified()
    .use(remarkParse)
    .use(remarkGfm)

  for (const entry of remarkPlugins) {
    const [plugin, opts] = Array.isArray(entry) ? entry : [entry]
    p = opts !== undefined ? p.use(plugin, opts) : p.use(plugin)
  }

  p = p.use(remarkRehype, { allowDangerousHtml: true })
       .use(rehypeSlug)

  for (const entry of rehypePlugins) {
    const [plugin, opts] = Array.isArray(entry) ? entry : [entry]
    p = opts !== undefined ? p.use(plugin, opts) : p.use(plugin)
  }

  return p.use(rehypeStringify, { allowDangerousHtml: true })
}

async function markdownToHTML(src, { remarkPlugins, rehypePlugins } = {}) {
  const hasPlugins = (remarkPlugins?.length ?? 0) + (rehypePlugins?.length ?? 0) > 0
  const processor = hasPlugins
    ? buildProcessor(remarkPlugins, rehypePlugins)
    : _defaultProcessor
  return String(await processor.process(src))
}

// ─── Frontmatter → export declarations ───────────────────────────────────────

/**
 * Generate export declarations for frontmatter keys not already declared
 * in the developer's script block.
 * Inlines the actual frontmatter value as the default so the component works
 * standalone (REPL, direct render) without a parent passing props.
 * Declared as const because frontmatter values are immutable.
 */
function frontmatterToExports(fm, innerScript) {
  const declared = new Set()
  const re = /\bexport\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
  let m
  while ((m = re.exec(innerScript)) !== null) declared.add(m[1])

  return Object.keys(fm)
    .filter((k) => !declared.has(k))
    .map((k) => `  export const ${k} = ${JSON.stringify(fm[k])}`)
    .join('\n')
}

// ─── Fenced-code decoding ─────────────────────────────────────────────────────

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g

/**
 * HTML-decode a fence body on its way to glow(), which re-encodes what it emits.
 *
 * ONE pass, never a chain of replaces: rehype writes `<` as `&#x3C;` and `&` as
 * `&#x26;`, so decoding the numeric forms first and the named ones second turns
 * a source line that literally reads `&lt;` (`&#x26;lt;` on the wire) into a
 * `<`, and the reader is shown something nobody wrote. A single pass cannot
 * decode its own output.
 */
function decodeEntities(str) {
  return str.replace(ENTITY, (whole, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    return name in NAMED ? NAMED[name] : whole
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Compile a .md file to the same output format as compile().
 *
 * @param {string} source   — raw .md file contents
 * @param {object} [config] — same options as compile()
 * @returns {Promise<object>} ctx — same as compile(), plus:
 *   ctx.frontmatter  {object}       — parsed frontmatter values
 *   ctx.layout       {string|null}  — frontmatter.layout value
 *   ctx.markdownHTML {string}       — raw HTML from the Markdown step
 */
export async function compileMd(source, config = {}) {
  // 1. Frontmatter
  const { frontmatter, body: afterFm } = parseFrontmatter(source)

  // 2. Script block
  const { script: scriptBlock, body: mdBody } = extractScript(afterFm)
  const innerScript = scriptBlock
    ? fixUninitialized(
        scriptBlock
          .replace(/^<script[^>]*>\s*/m, '')
          .replace(/\s*<\/script>$/m, '')
      )
    : ''

  // 3. Protect block-level Mesa directives
  const { protected: protectedMd, map } = protect(mdBody)

  // 4. Markdown → HTML
  const rawHTML = await markdownToHTML(protectedMd, {
    remarkPlugins: config.remarkPlugins,
    rehypePlugins: config.rehypePlugins,
  })

  // 5. Restore
  const html = restore(rawHTML, map)

  // 5b. Syntax-highlight fenced code blocks that have a language tag,
  //     then escape { } inside all remaining <code> content so Mesa
  //     doesn't treat inline code as reactive expressions.
  const safeHtml = html
    // Fenced code blocks with a language: run glow(), wrap in <pre>
    .replace(/<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, encoded) => {
        // rehype already HTML-encoded the content — decode before passing to glow
        const code = decodeEntities(encoded)
        // Strip the class suffix rehype adds (e.g. "js mn3k01re1" → "js")
        const language = lang.split(' ')[0]
        const highlighted = glow(code.trimEnd(), { language, prefix: false, mark: false })
        return `<pre>${highlighted}</pre>`
      }
    )
    // Fenced code blocks without a language: just escape {}
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, content) =>
      '<pre><code>' + content.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;') + '</code></pre>'
    )
    // Inline code: escape {}
    .replace(/<code([^>]*)>([\s\S]*?)<\/code>/g, (_, attrs, content) =>
      `<code${attrs}>${content.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')}</code>`
    )

  // 6. Build merged <script> block
  const fmExports = frontmatterToExports(frontmatter, innerScript)
  const mergedScript = [fmExports, innerScript].filter(Boolean).join('\n\n').trim()

  const mesaSource = [
    mergedScript ? `<script>\n${mergedScript}\n</script>` : '',
    safeHtml.trim()
  ]
    .filter(Boolean)
    .join('\n\n')

  // 7. Compile as Mesa
  const ctx = await compile(mesaSource, config)

  // 8. Attach metadata
  ctx.frontmatter  = frontmatter
  ctx.layout       = frontmatter.layout ?? null
  ctx.markdownHTML = safeHtml

  return ctx
}
