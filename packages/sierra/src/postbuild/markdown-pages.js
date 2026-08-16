/**
 * markdown-pages.js — Generate per-page markdown alongside rendered HTML.
 *
 * For each indexed route, reads the rendered index.html, extracts the main
 * content (prefers <main> or <article>, falls back to <body>), converts to
 * markdown, and writes index.md in the same directory.
 *
 * Designed for LLM consumption — clean prose, structured headings, no noise.
 *
 * Activated by config.markdownPages = true (or 'auto' to overwrite).
 *
 * Config:
 *   markdownPages: true      — generate, skip if index.md already exists
 *   markdownPages: 'auto'    — always regenerate
 *   markdownPages: false     — disabled (default)
 */

import { readFile, writeFile, access } from 'fs/promises'
import { join } from 'path'

// ── HTML → Markdown ───────────────────────────────────────────────────────────

/**
 * Minimal HTML→Markdown converter optimised for marketing page content.
 * No dependencies. Handles the elements that matter for prose content.
 */
function htmlToMarkdown(html) {
  // 1. Strip elements that add no content value
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 2. Block-level elements → markdown
  s = s
    // Headings
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${_text(t)}\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${_text(t)}\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${_text(t)}\n`)
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${_text(t)}\n`)
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${_text(t)}\n`)
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${_text(t)}\n`)
    // Paragraphs
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n${_text(t)}\n`)
    // Block code
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_, t) => `\n\`\`\`\n${_decode(t)}\n\`\`\`\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, t) => `\n\`\`\`\n${_decode(t)}\n\`\`\`\n`)
    // Lists
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, t) => `\n${_listItems(t, '-')}\n`)
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => `\n${_listItems(t, '1.')}\n`)
    // Blockquote
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, t) => `\n> ${_text(t).replace(/\n/g, '\n> ')}\n`)
    // Horizontal rule
    .replace(/<hr\b[^>]*\/?>/gi, '\n---\n')
    // Line breaks
    .replace(/<br\b[^>]*\/?>/gi, '  \n')

  // 3. Inline elements
  s = s
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${_text(t)}**`)
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${_text(t)}**`)
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `_${_text(t)}_`)
    .replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `_${_text(t)}_`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${_decode(t)}\``)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, t) => {
        const label = _text(t).trim()
        const url = href.startsWith('http') ? href : href  // keep relative links
        return label ? `[${label}](${url})` : url
      })
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi,
      (_, alt, src) => alt ? `![${alt}](${src})` : '')
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
      (_, src, alt) => alt ? `![${alt}](${src})` : '')

  // 4. Strip remaining tags
  s = s.replace(/<[^>]+>/g, '')

  // 5. Decode HTML entities
  s = _decode(s)

  // 6. Normalise whitespace — collapse blank lines to max 2
  s = s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return s
}

function _text(html) {
  return htmlToMarkdown(html).trim()
}

function _decode(s) {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

function _listItems(html, bullet) {
  return html
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `${bullet} ${_text(t)}`)
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .filter(l => l.trim().startsWith(bullet))
    .join('\n')
}

// ── Extract main content ──────────────────────────────────────────────────────

function extractContent(html) {
  // Prefer <main>, then <article>, then <body>
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
  if (mainMatch) return mainMatch[1]

  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
  if (articleMatch) return articleMatch[1]

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) return bodyMatch[1]

  return html
}

// ── Frontmatter from <meta> tags ──────────────────────────────────────────────

function extractFrontmatter(html, routeMeta = {}) {
  const title = (
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ??
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ??
    routeMeta.title ??
    ''
  ).trim()

  const description = (
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] ??
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ??
    routeMeta.description ??
    ''
  ).trim()

  const fields = []
  if (title)       fields.push(`title: "${title.replace(/"/g, '\\"')}"`)
  if (description) fields.push(`description: "${description.replace(/"/g, '\\"')}"`)

  return fields.length ? `---\n${fields.join('\n')}\n---\n\n` : ''
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object}   config   — sierra.config.js
 * @param {object}   routeTable — { indexed, tree }
 * @param {string}   outDir
 * @param {object}   [routeMetaMap] — path → meta object
 */
export async function generateMarkdownPages(config, routeTable, outDir, routeMetaMap = {}) {
  if (!config.markdownPages) return null

  const indexed = (routeTable.indexed ?? []).filter(
    p => !p.includes(':') && !p.includes('*')
  )

  let written = 0
  let skipped = 0

  await Promise.all(indexed.map(async (routePath) => {
    // Resolve to filesystem path: /about/ → outDir/about/index.html
    const rel       = routePath.replace(/^\//, '').replace(/\/$/, '')
    const htmlFile  = rel ? join(outDir, rel, 'index.html') : join(outDir, 'index.html')
    const mdFile    = rel ? join(outDir, rel, 'index.md')   : join(outDir, 'index.md')

    // Skip if md already exists and mode isn't 'auto'
    if (config.markdownPages !== 'auto') {
      try { await access(mdFile); skipped++; return } catch { /* write it */ }
    }

    let html
    try {
      html = await readFile(htmlFile, 'utf8')
    } catch {
      return  // HTML not rendered yet (SPA routes won't have individual files)
    }

    const meta     = routeMetaMap[routePath] ?? {}
    const fm       = extractFrontmatter(html, meta)
    const content  = extractContent(html)
    const markdown = htmlToMarkdown(content)

    if (!markdown.trim()) return  // nothing meaningful to write

    await writeFile(mdFile, fm + markdown, 'utf8')
    written++
  }))

  if (written === 0 && skipped === 0) return null
  return `markdown pages: ${written} written${skipped ? `, ${skipped} skipped` : ''}`
}
