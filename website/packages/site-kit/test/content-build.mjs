/*
 * content-build.mjs — a real `site-kit build` reads a site's settings, a
 * collection and a nested menu, all from Markdown.
 *
 * Each crosses the prerender, which compiles outside Vite: a settings key is
 * bound bare through the module site-kit writes, a collection through the
 * eager glob Sierra expands and `collection()`, a menu through `@content`.
 * test/content.mjs pins the pieces; only a build proves the render reaches them.
 * The site also names a preset whose `document` carries a body id and JSON-LD
 * while the site states its own `document.head`: the two merge key by key, and
 * a site's key never costs the preset's. Its public/ ships beneath the site's
 * own, and a path both have is the site's.
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
  write(join(SITE, 'node_modules/demo-preset/package.json'),
    JSON.stringify({ name: 'demo-preset', type: 'module', exports: { './preset': './preset.js' } }))
  write(join(SITE, 'node_modules/demo-preset/preset.js'), `export default ({ settings }) => ({
    sierra: { document: { bodyAttrs: { id: 'app' }, jsonLd: { '@type': 'Organization', name: settings.company_name } } },
  })`)
  write(join(SITE, 'node_modules/demo-preset/public/theme/mark.svg'), '<svg>preset</svg>')
  write(join(SITE, 'node_modules/demo-preset/public/shared.txt'), 'preset')
  write(join(SITE, 'content/public/shared.txt'), 'site')
  write(join(SITE, 'content/settings/site.js'),
    `export default { preset: 'demo-preset', document: { head: '<meta name="site-own" content="1">' } }\n`)
  write(join(SITE, 'content/routes/index.md'), ['---', 'render: static', 'layout: Steps', '---', '', 'Welcome to {company_name}.', ''].join('\n'))
  write(join(SITE, 'content/routes/reviews.md'),
    ['---', 'render: static', 'layout: Block', 'name: Testimonials', '---', '',
      "<script>import Block from '@frontierjs/site-kit/layouts/Block.mesa'</script>", '',
      '<Block name="Reviews">Kind words.</Block>', ''].join('\n'))

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
    const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)
    check("a preset's document jsonLd reaches the page from the site's settings",
      ld && JSON.parse(ld[1]).name === 'Acme Cleaning', ld?.[0])
    check("a site's own document.head keeps the preset's body id and JSON-LD",
      html.includes('<meta name="site-own" content="1">') && /<body[^>]* id="app"/.test(html) && !!ld)
    const read = (path) => { try { return readFileSync(join(SITE, 'dist', path), 'utf8') } catch { return null } }
    check("a preset's public/ file ships at its own path", read('theme/mark.svg') === '<svg>preset</svg>', read('theme/mark.svg'))
    check("a path in both public/ directories ships the site's file", read('shared.txt') === 'site', read('shared.txt'))
    // A Band is 100vw, so a second one inside the first scrolled the page sideways (FJS-2716).
    const reviews = read('reviews/index.html') ?? read('reviews.html') ?? ''
    check('a Block in a Block layout\'s Markdown prerenders as an article, not a second Band',
      (reviews.match(/class="band/g) ?? []).length === 1 && /<article class="reviews"[^>]*>\s*Kind words\./.test(reviews),
      reviews.match(/<section class="band[\s\S]*?<\/section>/)?.[0] ?? reviews.slice(0, 600))
  }
} finally {
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
