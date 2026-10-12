/*
 * content-build.mjs — a real `site-kit build` reads a site's settings, a
 * collection and a nested menu, all from Markdown.
 *
 * Each crosses the prerender, which compiles outside Vite: a settings key is
 * bound bare through the module site-kit writes, a collection through the
 * eager glob Sierra expands and `collection()`, a menu through `@content`.
 * test/content.mjs pins the pieces; only a build proves the render reaches them.
 * The site is written under test/ so it resolves @frontierjs/* the way a
 * workspace site does.
 *
 * Run: node test/content-build.mjs   (spawns bun, which the command needs)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'test', `.content-site-${process.pid}`)

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

try {
  write(join(SITE, 'content/settings/site.md'), ['---', 'company_name: Acme Cleaning', '---', ''].join('\n'))
  write(join(SITE, 'content/menus/main.md'), [
    '---',
    'items:',
    '-',
    '  name: Services',
    '  link: /services/',
    '  items:',
    '  -',
    '    name: Deep Cleaning',
    '    link: /services/deep/',
    '---',
    '',
  ].join('\n'))
  write(join(SITE, 'content/collections/steps/2-book.md'), '---\ntitle: Book\n---\n\nPick a time.\n')
  write(join(SITE, 'content/collections/steps/1-call.md'), '---\ntitle: Call\n---\n\nRing us.\n')
  write(join(SITE, 'content/layouts/Steps.mesa'), [
    '<script module>',
    "  import { collection } from '@frontierjs/site-kit/collection'",
    "  import { frontmatter as menu } from '@content/menus/main.md'",
    "  const steps = collection(import.meta.glob('/content/collections/steps/*.md', { eager: true }))",
    '</script>',
    '',
    '<nav>',
    '  {#each menu.items as item}',
    '    <a href={item.link}>{item.name}</a>',
    '    {#each item.items as sub}<a href={sub.link}>{sub.name}</a>{/each}',
    '  {/each}',
    '</nav>',
    '<slot />',
    '<ol>',
    '  {#each steps as { slug, frontmatter, Body }}',
    '    <li data-slug={slug}><b>{frontmatter.title}</b><Body /></li>',
    '  {/each}',
    '</ol>',
  ].join('\n'))
  write(join(SITE, 'content/routes/index.md'), ['---', 'render: static', 'layout: Steps', '---', '', 'Welcome to {company_name}.', ''].join('\n'))

  const built = spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'build', SITE], { encoding: 'utf8' })
  check('the site builds', built.status === 0, `${built.stdout}\n${built.stderr}`.slice(-1200))
  if (built.status === 0) {
    const html = readFileSync(join(SITE, 'dist/index.html'), 'utf8')
    check('a settings key is bound bare in prose', /Welcome to Acme Cleaning\./.test(html), html.slice(0, 600))
    check('a nested menu reads from .md, the sub-item included',
      /<a href="\/services\/"[^>]*>Services<\/a>/.test(html) && /<a href="\/services\/deep\/"[^>]*>Deep Cleaning<\/a>/.test(html))
    const slugs = [...html.matchAll(/data-slug="([^"]+)"/g)].map((m) => m[1])
    check('a collection lists in file-name order', slugs.join() === '1-call,2-book', slugs.join())
    check("each item renders its front-matter and its body", /<b[^>]*>Call<\/b>[\s\S]*Ring us\./.test(html))
  }
} finally {
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
