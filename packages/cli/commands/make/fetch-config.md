---
title: make:fetch-config
description: Scaffold a fetch.config.js for site:fetch — sitemap, frontmatter mapping, image transform, cleanup rules
alias: mkfetchconfig
examples:
  - fli make:fetch-config
  - fli make:fetch-config --name scrape.config.js
  - fli make:fetch-config --force
  - fli make:fetch-config --dry
flags:
  name:
    description: Output filename (relative to cwd)
    defaultValue: fetch.config.js
  force:
    type: boolean
    description: Overwrite if the file already exists
    defaultValue: false
  open:
    type: boolean
    char: o
    description: Open the file in $EDITOR after creating
    defaultValue: false
---

<script>
import { existsSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Self-documenting template. Built as an array of lines to keep the source
// readable and avoid template-literal/backtick nesting issues inside the .md.
const TEMPLATE_LINES = [
  '// fetch.config.js — config for fli site:fetch',
  '//',
  '// Pass with --config ./fetch.config.js',
  '// Flag values on the CLI override values defined here.',
  '',
  'export const config = {',
  '  // ─── Sitemap source ────────────────────────────────────────────────────────',
  '  // Sitemap URL to walk. Sitemap-index files are followed automatically.',
  '  // Override at runtime with --from <url>.',
  "  sitemap: 'https://example.com/sitemap.xml',",
  '',
  '  // ─── URL filtering ─────────────────────────────────────────────────────────',
  '  // Both lists are exact-match against full URLs. Exclude runs first, then',
  '  // include. Leave empty (or omit) to disable.',
  '  excludeList: [',
  "    // 'https://example.com/private/page',",
  '  ],',
  '  includeList: [',
  "    // 'https://example.com/about',",
  "    // 'https://example.com/contact',",
  '  ],',
  '',
  '  // ─── Path mapping ──────────────────────────────────────────────────────────',
  "  // 'strip' removes a leading URL path segment (segment-boundary safe).",
  "  // 'prefix' prepends a folder under siteContent/<dest>. Both also exposed",
  '  // as CLI flags.',
  "  // strip:  '/posts',",
  "  // prefix: 'blog',",
  '',
  '  // ─── Content scoping ───────────────────────────────────────────────────────',
  "  // CSS selector to extract content from. Defaults to 'body' if omitted.",
  "  // select: 'main',",
  "  // select: 'article.post',",
  '',
  '  // ─── Frontmatter ───────────────────────────────────────────────────────────',
  '  // Keys here become YAML frontmatter on every output file.',
  '  // _meta.include maps frontmatter key → HTML <meta> tag name/property.',
  '  // If you omit _meta.include, a sensible default whitelist is used:',
  '  //   title, description, og:title, og:description, og:image, og:type',
  '  frontmatter: {',
  "    layout: 'page',",
  '    // _meta: {',
  '    //   include: {',
  "    //     title:       'og:title',",
  "    //     description: 'og:description',",
  "    //     date:        'article:published_time',",
  "    //     image:       'og:image',",
  '    //   },',
  '    // },',
  '  },',
  '',
  '  // ─── Image transform ───────────────────────────────────────────────────────',
  '  // Called per <img> found in scoped content. Return { component, source, url }',
  '  // to swap the markdown image for a custom component, optionally downloading',
  '  // the image to <siteMedia>/<source> for local hosting.',
  '  //',
  '  //   image.src         → original src attribute (raw, as in HTML)',
  '  //   image.resolvedSrc → src resolved against the page URL (absolute)',
  '  //   image.alt, .width, .height',
  '  //',
  '  //   return.component → string to swap into markdown',
  "  //   return.source    → local path under siteMedia (e.g. '/img/foo.png')",
  '  //   return.url       → absolute URL to download from',
  '  //',
  '  // image: {',
  '  //   transform: (image) => {',
  "  //     const filename = image.resolvedSrc.split('/').pop().split('?')[0]",
  "  //     const source = '/img/' + filename",
  '  //     return {',
  '  //       component: \'<Image src="\' + source + \'" alt="\' + image.alt + \'" />\',',
  '  //       source,',
  '  //       url: image.resolvedSrc,',
  '  //     }',
  '  //   },',
  '  // },',
  '',
  '  // ─── Cleanup rules ─────────────────────────────────────────────────────────',
  '  // Find/replace pairs applied to the final markdown body (after image swap).',
  '  // Useful for stripping site-specific cruft, fixing artifacts from turndown,',
  '  // or normalizing whitespace. `find` may be a string or regex.',
  '  cleanup: [',
  "    // { find: '[edit]',     replace: '' },",
  "    // { find: 'Read more →', replace: '' },",
  "    // { find: /\\n{3,}/g,    replace: '\\n\\n' },",
  '  ],',
  '}',
  '',
].join('\n')
</script>

Scaffold a `fetch.config.js` next to your project root with sensible defaults
and inline documentation for every option. Drop in your sitemap URL, uncomment
the sections you need, and run `fli site:fetch --config ./fetch.config.js`.

```js
const filename = flag.name ?? 'fetch.config.js'
const filePath = resolve(process.cwd(), filename)

if (existsSync(filePath) && !flag.force) {
  log.error(`${filePath} already exists`)
  log.info('use --force to overwrite, or --name <other.js> to write somewhere else')
  return
}

if (flag.dry) {
  log.dry(filePath)
  echo(TEMPLATE_LINES)
  return
}

writeFileSync(filePath, TEMPLATE_LINES, 'utf8')
log.success(`wrote ${filePath}`)
log.info(`edit it, then run: fli site:fetch --config ./${filename}`)

if (flag.open) {
  const editor = process.env.EDITOR || context.env.OPEN_COMMAND || 'vi'
  context.exec({ command: `${editor} "${filePath}"` })
}
```
