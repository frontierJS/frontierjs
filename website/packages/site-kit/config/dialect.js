// config/dialect.js — site-kit's Markdown dialect, as one value siteKit() hands
// to Sierra: the remark and rehype passes every page compiles under, and the
// post-build check that the class words a divider names exist.
//
// A divider word that is not a css look word is the site's own class, and
// nothing renders it wrong: a misspelt one leaves a band unstyled. The check
// runs once the pages are written, over every stylesheet in the output, so it
// sees what the site actually ships, whichever preset or preprocessor made it.
// `vite dev` has no output to read and does not check.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import remarkDividers from './dividers.js'
import rehypeProse from './prose.js'

/** Every class a selector in `css` names, read loosely: a false extra is harmless here. */
export function classesIn(css) {
  const bare = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')
  return new Set([...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))
}

function stylesheetsIn(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...stylesheetsIn(path))
    else if (entry.name.endsWith('.css')) out.push(readFileSync(path, 'utf8'))
    else if (entry.name.endsWith('.html')) {
      out.push(...[...readFileSync(path, 'utf8').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]))
    }
  }
  return out
}

export function siteDialect() {
  const words = new Map()

  const check = {
    name: 'site-kit:divider-words',
    // Sierra calls a config plugin's closeBundle after the pages are written.
    closeBundle({ outDir, root }) {
      const defined = new Set(stylesheetsIn(outDir).flatMap((css) => [...classesIn(css)]))
      const missing = [...words].flatMap(([file, list]) =>
        list.filter(({ word }) => !defined.has(word)).map((w) => ({ file: relative(root, file), ...w })))
      if (!missing.length) return
      const lines = missing.map(({ file, divider, word }) => `    ${file}  ${divider}  "${word}"`)
      throw new Error(
        `[site-kit] ${missing.length === 1 ? 'a divider names a class' : `${missing.length} divider words name classes`} no stylesheet in ${relative(root, outDir) || '.'} defines:\n` +
        `${lines.join('\n')}\n` +
        '  A divider word is a css look word (a Layout helper, a tone, treatment or density, align-start|center|end) ' +
        'or a class the site\'s own stylesheet defines.',
      )
    },
  }

  return {
    remarkPlugins: [[remarkDividers, { words }]],
    rehypePlugins: [rehypeProse],
    check,
  }
}
