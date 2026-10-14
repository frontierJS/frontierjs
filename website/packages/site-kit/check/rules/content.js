// check/rules/content.js — source rules: read content/ without a build.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { SETTINGS } from '../context.js'
import { didYouMean, finding, proseLines } from '../finding.js'

const GROUP = 'Content'
const at = (c, n) => ({ file: c.rel, line: n })

/* ─── components ─────────────────────────────────────────────────────────────
 *
 * `<Hero />` in a page is auto-imported by name and `layout: Block` names a
 * wrapper, from the directories the build resolves (ctx.sierra). A name found
 * in neither still compiles, and the prerender then fails blaming a browser
 * API rather than the tag (FJS-1495), so this names the file and the line.
 */

/** name → site-relative file, for every .md/.mesa a directory list offers. */
function names(root, dirs, { recursive }) {
  const map = new Map()
  const scan = (dir) => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      const abs = join(dir, f)
      if (statSync(abs).isDirectory()) {
        if (recursive) scan(abs)
      } else if (['.md', '.mesa'].includes(extname(f)) && /^[A-Z]/.test(f)) map.set(f.slice(0, -extname(f).length), relative(root, abs))
    }
  }
  for (const dir of dirs) scan(resolve(root, dir))
  return map
}

const shown = (root, dirs) => dirs.map((d) => relative(root, resolve(root, d)) || '.').map((d) => (d.startsWith('..') ? d.split('/node_modules/').pop() : d)).join(', ')

function components(ctx) {
  const componentDirs = [].concat(ctx.sierra.autoImport?.components ?? [])
  const layoutDirs = ctx.sierra.markdownLayouts ?? []
  const blocks = names(ctx.root, componentDirs, { recursive: true })
  const layouts = names(ctx.root, layoutDirs, { recursive: false })
  const out = []
  const unknown = new Map()

  for (const c of ctx.content) {
    if (c.rel.startsWith('content/settings/')) continue
    const layout = c.attrs.layout
    if (typeof layout === 'string' && !layouts.has(layout)) {
      const guess = didYouMean(layout, [...layouts.keys()])
      out.push(
        finding('error', 'unknown-layout', `layout: ${layout} doesn't match a layout (looked in ${shown(ctx.root, layoutDirs)}).${guess ? ` Did you mean ${guess}?` : ''}`, {
          where: [at(c, 1)]
        })
      )
    }

    // NOTE: A page may still import a component itself: `import A`, `import A, { x as B }`
    const scripts = [...c.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    const declared = new Set()
    for (const [, clause] of scripts.matchAll(/import\s+([^'"]+?)\s+from\s/g)) {
      const named = clause.match(/\{([^}]*)\}/)?.[1] || ''
      for (const part of named.split(',')) declared.add(part.split(/\s+as\s+/).pop().trim())
      for (const part of clause.replace(/\{[^}]*\}/, '').split(',')) declared.add(part.replace(/^\s*\*\s+as\s+/, '').trim())
    }
    for (const m of scripts.matchAll(/\b(?:const|let|var|function|class)\s+([A-Z]\w*)/g)) declared.add(m[1])

    for (const { n, line } of proseLines(c.text)) {
      for (const [, name] of line.matchAll(/<([A-Z]\w*)(?=[\s/>]|$)/g)) {
        if (blocks.has(name) || declared.has(name)) continue
        ;(unknown.get(name) || unknown.set(name, []).get(name)).push(at(c, n))
      }
    }
  }

  for (const [name, where] of unknown) {
    const guess = didYouMean(name, [...blocks.keys()])
    out.push(
      finding(
        'error',
        'unknown-component',
        `<${name} /> doesn't match any block (looked for ${name}.md or ${name}.mesa in ${componentDirs.length ? shown(ctx.root, componentDirs) : 'no directory: the site auto-imports none'}).${guess ? ` Did you mean <${guess} />?` : ''}`,
        { where }
      )
    )
  }
  return out
}

/* ─── {merge} fields ─────────────────────────────────────────────────────────
 *
 * {company_phone} in prose is a site.md key, which site-kit binds in every
 * page; a name site.md doesn't hold is an expression bound to nothing. Only
 * names shaped like a settings key (a known prefix plus _) are checked, so
 * real expressions pass. A site with no site.md has no keys and nothing here.
 */
function mergeFields(ctx) {
  const keys = Object.keys(ctx.settings)
  if (!keys.length) return []
  const known = new Set([...keys, 'now', 'today'])
  const prefixes = new Set(keys.filter((k) => k.includes('_')).map((k) => k.split('_')[0]))
  const hits = new Map()
  for (const c of ctx.content) {
    for (const { n, line } of proseLines(c.text, { frontmatter: true })) {
      for (const m of line.matchAll(/\{([a-z][a-zA-Z0-9]*)_([A-Za-z0-9_]+)\}/g)) {
        const key = `${m[1]}_${m[2]}`
        if (!prefixes.has(m[1]) || known.has(key)) continue
        ;(hits.get(key) || hits.set(key, []).get(key)).push(at(c, n))
      }
    }
  }
  return [...hits].map(([key, where]) => {
    const guess = didYouMean(key, keys)
    return finding(
      'error',
      'unknown-merge-field',
      `{${key}} isn't a key in ${SETTINGS}, so nothing binds it in the page.${guess ? ` Did you mean {${guess}}?` : ''}`,
      { where }
    )
  })
}

/* ─── dividers ───────────────────────────────────────────────────────────────
 *
 * `===` or `====` straight under a line of text isn't a divider: CommonMark
 * makes that text an H1 (or folds the divider into the paragraph).
 */
function dividers(ctx) {
  const where = []
  for (const c of ctx.content) {
    for (const { n, line, prev } of proseLines(c.text)) {
      if (!/^={3,}(\s*\|.*)?\s*$/.test(line)) continue
      if (prev != null && prev.trim() !== '' && !/^={3,}/.test(prev)) where.push(at(c, n))
    }
  }
  const out = []
  if (where.length)
    out.push(
      finding('warn', 'divider-no-blank-line', 'Dividers with no blank line above: the line above becomes an H1 (or swallows the divider). Add a blank line before each.', {
        where
      })
    )
  return out
}

/* ─── front-matter ─────────────────────────────────────────────────────────── */

function frontmatter(ctx) {
  return ctx.content
    .filter((c) => c.fmError)
    .map((c) => finding('error', 'frontmatter-invalid', `Frontmatter isn't valid YAML: ${c.fmError.split('\n')[0]}`, { where: [at(c, 1)] }))
}

export default [
  { id: 'components', group: GROUP, stage: 'source', run: components },
  { id: 'merge-fields', group: GROUP, stage: 'source', run: mergeFields },
  { id: 'dividers', group: GROUP, stage: 'source', run: dividers },
  { id: 'frontmatter', group: GROUP, stage: 'source', run: frontmatter }
]
