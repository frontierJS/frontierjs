/*
 * fetch.mjs — `site-kit fetch` against a site this test serves: a sitemap
 * index is walked to its pages, an <image:loc> is not fetched as a page, each
 * page lands under content/routes with its <meta> as front-matter, a
 * transformed image is downloaded under content/public and swapped into the
 * Markdown, and a config with a bad key stops the command.
 *
 * Run: bun test/fetch.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeFileFor, runFetch } from '../fetch/run.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'test', `.fetch-site-${process.pid}`)

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}
const quiet = { info() {}, success() {}, dry() {}, warn() {} }

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const page = (title, body) =>
  `<html><head><title>${title}</title><meta name="description" content="${title} page"></head>` +
  `<body><nav>menu</nav><main>${body}</main></body></html>`

const hits = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const { pathname } = new URL(req.url)
    hits.push(pathname)
    const o = server.url.origin
    const html = (s) => new Response(s, { headers: { 'content-type': 'text/html' } })
    if (pathname === '/sitemap.xml') return new Response(`<sitemapindex><sitemap><loc>${o}/pages.xml</loc></sitemap></sitemapindex>`)
    if (pathname === '/pages.xml') {
      return new Response(`<urlset><url><loc>${o}/</loc><image:loc>${o}/img/team.png</image:loc></url><url><loc>${o}/about/</loc></url></urlset>`)
    }
    if (pathname === '/') return html(page('Home', '<h1>Welcome</h1><p>Hello [edit]</p>'))
    if (pathname === '/about/') return html(page('About', '<h2>Team</h2><img src="/img/team.png" alt="Our team">'))
    if (pathname === '/img/team.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    return new Response('nope', { status: 404 })
  },
})

try {
  const origin = server.url.origin
  const config = {
    select: 'main',
    frontmatter: { layout: 'Page' },
    cleanup: [{ find: ' [edit]', replace: '' }],
    image: {
      transform: (img) => {
        const source = `/media/${img.resolvedSrc.split('/').pop()}`
        return { component: `<Image src="${source}" alt="${img.alt}" />`, source, url: img.resolvedSrc }
      },
    },
  }
  const { written, skipped } = await runFetch({ root: SITE, target: `${origin}/sitemap.xml`, config, delay: 0, log: quiet })

  check('a sitemap index is walked to both pages', written.length === 2 && skipped.length === 0, JSON.stringify({ written, skipped }))
  check('an <image:loc> is not fetched as a page', hits.filter((p) => p === '/img/team.png').length === 1, hits.join(' '))

  const home = join(SITE, 'content/routes/index.md')
  const about = join(SITE, 'content/routes/about.md')
  const homeText = existsSync(home) ? readFileSync(home, 'utf8') : ''
  const aboutText = existsSync(about) ? readFileSync(about, 'utf8') : ''
  check('pages land under content/routes', Boolean(homeText && aboutText))
  check('<meta> and the config become front-matter', homeText.startsWith('---\ntitle: "Home"\ndescription: "Home page"\nlayout: "Page"\n---\n'), homeText)
  check('select scopes the body and cleanup runs', homeText.includes('# Welcome') && !homeText.includes('menu') && !homeText.includes('[edit]'), homeText)
  check('a transformed image is swapped into the Markdown', aboutText.includes('<Image src="/media/team.png" alt="Our team" />'), aboutText)
  const media = join(SITE, 'content/public/media/team.png')
  check('and downloaded under content/public', existsSync(media) && readFileSync(media).equals(PNG))

  const routesDir = join(SITE, 'content/routes')
  check('--prefix puts a root URL at <prefix>/index.md', routeFileFor(`${origin}/`, { origin, routesDir, prefix: 'blog' }) === join(routesDir, 'blog/index.md'))
  check('--strip cuts on a segment boundary only', routeFileFor(`${origin}/postscript/`, { origin, routesDir, strip: '/posts' }) === join(routesDir, 'postscript.md'))

  const cfg = join(SITE, 'bad.config.js')
  mkdirSync(SITE, { recursive: true })
  writeFileSync(cfg, `export const config = { select: 3, excludelist: [] }\n`)
  const bad = spawnSync('bun', [join(ROOT, 'bin/site-kit.js'), 'fetch', SITE, `${origin}/`, '--config', cfg], { encoding: 'utf8' })
  check('a config with a bad value stops the command, exit 2', bad.status === 2 && bad.stderr.includes(`'select' must be a string`), bad.stderr)
  check('and an unknown key warns by name', bad.stderr.includes(`unknown config key 'excludelist'`), bad.stderr)
} finally {
  server.stop(true)
  rmSync(SITE, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
