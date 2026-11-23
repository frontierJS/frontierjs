/**
 * test/document-shell.test.js — a static app's `document` in its `index.html`.
 *
 * Dev serves `index.html`, which no prerender wraps, so every static app stated
 * its body class (or id, or site-wide loader) twice: once in `document` for the
 * build and once in `index.html` for dev (`FJS-D971`). These prove dev now
 * applies it, with the prerender's own serializer, and that the second
 * statement is refused rather than merged.
 */

import { describe, test, expect, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer, build } from 'vite'
import { readFileSync } from 'fs'

import { createServer as createHttpServer } from 'http'
import { applyDocument, SKIP_LINK_GUARD_SHEET } from '../src/build/document-shell.js'
import { wrapDocument, sheetFile, SKIP_LINK_GUARD_CSS } from '../src/build/prerender.js'
import { createSierraViteConfig } from '../src/build/index.js'

const SHELL = `<!DOCTYPE html>
<html>
  <head>
    <title>dev</title>
  </head>
  <body>
    <!-- a comment that names the closing tag: </body> -->
    <script type="module" src="virtual:sierra"></script>
  </body>
</html>
`

const DOC = {
  lang: 'fr',
  bodyClass: 'app theme-default',
  bodyAttrs: { id: 'app' },
  meta: [{ name: 'theme-color', content: '#123' }],
  links: [{ rel: 'icon', href: '/favicon.svg' }],
  jsonLd: { '@type': 'Organization', name: 'A </script> B' },
  head: '<script src="/head.js"></script>',
  bodyEnd: '<script defer src="https://example.com/loader.js"></script>',
}

describe('applyDocument', () => {
  test('puts every key where the prerendered page has it', () => {
    const out = applyDocument(SHELL, DOC)
    expect(out).toContain('<html lang="fr">')
    expect(out).toContain('<body class="app theme-default" id="app">')
    expect(out).toContain('<meta name="theme-color" content="#123">')
    expect(out).toContain('<link rel="icon" href="/favicon.svg">')
    expect(out).toContain('"name":"A \\u003c/script> B"')
    expect(out.indexOf('/head.js')).toBeLessThan(out.indexOf('</head>'))
  })

  test('the head tags are byte-for-byte the build page\'s', () => {
    const dev = applyDocument(SHELL, DOC)
    const built = wrapDocument('', { ...DOC, title: 'x' })
    const tags = (html) => html.slice(html.indexOf('<meta name="theme-color"'), html.indexOf('</head>')).trim()
    expect(tags(dev)).toBe(tags(built))
  })

  test('bodyEnd lands before the real closing tag, not the one in a comment', () => {
    const out = applyDocument(SHELL, DOC)
    const loader = out.indexOf('loader.js')
    expect(loader).toBeGreaterThan(out.indexOf('virtual:sierra'))
    expect(loader).toBeLessThan(out.lastIndexOf('</body>'))
    expect(out).toContain('names the closing tag: </body> -->')
  })

  test('an attribute index.html also states is refused by name', () => {
    expect(() => applyDocument('<html><body id="app"></body></html>', { bodyAttrs: { id: 'app' } }))
      .toThrow(/<body> states 'id', and document\.bodyAttrs\.id/)
    expect(() => applyDocument('<html><body class="app"></body></html>', { bodyClass: 'app' }))
      .toThrow(/<body> states 'class', and document\.bodyClass/)
    expect(() => applyDocument('<html lang="en"><body></body></html>', { lang: 'fr' }))
      .toThrow(/<html> states 'lang', and document\.lang/)
  })

  test('a key document does not state leaves the shell alone', () => {
    const own = '<html lang="en"><body class="x"><a class="skip-link" href="#top">Skip</a></body></html>'
    expect(applyDocument(own, {})).toBe(own)
    expect(applyDocument(own, { bodyAttrs: { id: 'app' } }))
      .toBe('<html lang="en"><body class="x" id="app"><a class="skip-link" href="#top">Skip</a></body></html>')
  })
})

// The two facts every shell carries (`FJS-D836`): a page a screen reader picks
// a voice for, and a link a keyboard user leaves the navigation by.
describe('the shell facts', () => {
  test('lang defaults to the prerendered page\'s, and the skip link comes first in body', () => {
    const out = applyDocument(SHELL, {})
    expect(out).toContain('<html lang="en">')
    expect(out).toMatch(/<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/)
    expect(out.match(/class="skip-link"/g)).toHaveLength(1)
  })

  // An SPA's stylesheet arrives with its JS, so until then the link is bare
  // text at the top of the page. The guard is first in <head> so its layer
  // ranks below every one the design system declares. FJS-4590: linked, since
  // style-src 'self' refuses an inline <style>, and named as prerender names it.
  test('the link it writes is off-screen before any stylesheet loads', () => {
    const out = applyDocument(SHELL, {})
    expect(out).toMatch(new RegExp(`<head>\\n {2}<link rel="stylesheet" href="/${SKIP_LINK_GUARD_SHEET}">`))
    expect(SKIP_LINK_GUARD_SHEET).toBe(sheetFile('sierra-shell', SKIP_LINK_GUARD_CSS))
    expect(out.indexOf(SKIP_LINK_GUARD_SHEET)).toBeLessThan(out.indexOf('<title>'))
    expect(out).not.toContain('<style')

    const bare = applyDocument('<body><div id="app"></div></body>', {})
    expect(bare).toMatch(/<body>\n {2}<link rel="stylesheet" href="[^"]+">\n {2}<a class="skip-link"/)
    expect(bare.match(/sierra-shell-/g)).toHaveLength(1)

    expect(applyDocument(SHELL, {}, { base: '/app/' })).toContain(`<link rel="stylesheet" href="/app/${SKIP_LINK_GUARD_SHEET}">`)
  })

  test('a shell that states either keeps its own', () => {
    const own = '<!DOCTYPE html>\n<html lang="fr"><body><a class="skip-link" href="#x">Aller au contenu</a></body></html>'
    expect(applyDocument(own, {})).toBe(own)
  })

  test('a shell with no <html> tag is given one', () => {
    const bare = '<!doctype html>\n<meta charset="utf-8">\n<body class="app"><div id="app"></div></body>'
    const out = applyDocument(bare, {})
    expect(out.startsWith('<!doctype html>\n<html lang="en">\n<meta')).toBe(true)
    expect(applyDocument('<body></body>', {}).startsWith('<html lang="en">\n<body>')).toBe(true)
  })

  test('the prerendered page writes the same link, once', () => {
    expect(wrapDocument('<main id="main">x</main>', { title: 'x' }))
      .toMatch(/<body>\n<a class="skip-link" href="#main">Skip to content<\/a>\n<main/)
    const own = wrapDocument('<a class="skip-link" href="#top">Skip</a><main>x</main>', { title: 'x' })
    expect(own.match(/skip-link/g)).toHaveLength(1)
    expect(wrapDocument('', { title: 'x' })).toContain('<html lang="en">')
  })

  // FJS-4523: an app that does not load css a11y showed the link as bare text.
  // FJS-4585: linked, since style-src 'self' refuses an inline <style>.
  test('the prerendered page links the guard first in <head>, only with the link it writes', () => {
    const sheets = new Map()
    const out = wrapDocument('<main id="main">x</main>', { title: 'x', stylesheets: ['/a.css'], sheets })
    const href = out.match(/<head>\n {2}<link rel="stylesheet" href="\/(assets\/sierra-shell-[A-Za-z0-9_-]{8}\.css)">/)
    expect(href).not.toBeNull()
    expect(sheets.get(href[1])).toBe(SKIP_LINK_GUARD_CSS)
    expect(out).not.toContain('<style')
    expect(out.indexOf('sierra-shell-')).toBeLessThan(out.indexOf('/a.css'))
    const own = wrapDocument('<a class="skip-link" href="#top">Skip</a><main>x</main>', { title: 'x' })
    expect(own).not.toContain('sierra-shell-')
  })
})

// A real dev server's own transformIndexHtml, so what is proved is the plugin
// registered for the target and run in Vite's HTML pipeline, not the function
// called by hand. Inside the package: a root in the system temp directory has
// no node_modules above it and the dep scan walks until it runs out of heap.
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, 'tmp-document-shell')
const servers = []

async function fixture() {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await mkdir(join(root, 'src/routes'), { recursive: true })
  await writeFile(join(root, 'src/routes/index.mesa'), '<h1>x</h1>\n', 'utf8')
}

async function devShell(target, document, files = {}) {
  await fixture()
  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), source, 'utf8')
  }
  const server = await createServer(createSierraViteConfig({
    target,
    document,
    vite: {
      root,
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
    },
  }))
  servers.push(server)
  return server.transformIndexHtml('/index.html', SHELL)
}

afterAll(async () => {
  for (const s of servers) await s.close()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('the dev server', () => {
  test('a static app\'s shell carries its document', async () => {
    const html = await devShell('static', { bodyClass: 'app theme-default', bodyEnd: '<script src="/end.js"></script>' })
    expect(html).toMatch(/<body class="app theme-default">/)
    expect(html).toContain('<script src="/end.js"></script>')
  })

  test('an spa\'s shell is its index.html: document is a static-target key', async () => {
    const html = await devShell('spa', { bodyClass: 'app theme-default' })
    expect(html).not.toContain('theme-default')
  })

  test('an spa\'s shell still carries lang and the skip link', async () => {
    const html = await devShell('spa', undefined)
    expect(html).toContain('<html lang="en">')
    expect(html).toMatch(/<body>\s*<a class="skip-link" href="#main">/)
  })

  // FJS-3556: a layout renders at runtime, so the shell cannot see its link in the HTML.
  test('an spa whose layout writes its own skip link gets no second one from the shell', async () => {
    const html = await devShell('spa', undefined, {
      'src/routes/_module.mesa': '<a class="skip-link" href="#top">Aller au contenu</a>\n<main id="top"><slot /></main>\n<style>.skip-link { left: 0 }</style>\n',
    })
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain('class="skip-link"')
    expect(html).not.toContain('sierra-skip-link')
  })

  // FJS-4590: the shell links the guard sheet, so dev serves it.
  test('an spa\'s shell links the guard sheet, and the dev server serves it', async () => {
    const html = await devShell('spa', undefined)
    expect(html).not.toContain('<style')
    expect(html).toContain(`<link rel="stylesheet" href="/${SKIP_LINK_GUARD_SHEET}">`)
    const http = createHttpServer(servers.at(-1).middlewares)
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    try {
      const res = await fetch(`http://127.0.0.1:${http.address().port}/${SKIP_LINK_GUARD_SHEET}`)
      expect(res.headers.get('content-type')).toMatch(/^text\/css/)
      expect(await res.text()).toBe(SKIP_LINK_GUARD_CSS)
    } finally {
      await new Promise((r) => http.close(r))
    }
  })

  test('a skip-link rule in a stylesheet is not a skip link', async () => {
    const html = await devShell('spa', undefined, {
      'src/routes/_module.mesa': '<main><slot /></main>\n<style>.skip-link { left: 0 }</style>\n',
    })
    expect(html).toMatch(/<body>\s*<a class="skip-link" href="#main">/)
  })
})

describe('the build', () => {
  test('a home route that is not prerendered publishes the shell with its document', async () => {
    await fixture()
    await writeFile(join(root, 'index.html'), SHELL, 'utf8')
    await writeFile(join(root, 'src/main.js'), "document.title = 'x'\n", 'utf8')
    await build(createSierraViteConfig({
      target: 'static',
      document: { bodyClass: 'app theme-default' },
      vite: { root, logLevel: 'silent', build: { outDir: 'dist/client', emptyOutDir: true } },
    }))
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8')
    expect(html).toMatch(/<body class="app theme-default">/)
  }, 60_000)

  // FJS-4590: an SPA's built shell links the guard, so the sheet ships beside it.
  test('an spa\'s built shell links the guard sheet, written beside it', async () => {
    await fixture()
    await writeFile(join(root, 'index.html'), SHELL, 'utf8')
    await build(createSierraViteConfig({
      target: 'spa',
      vite: { root, logLevel: 'silent', build: { outDir: 'dist/client', emptyOutDir: true } },
    }))
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8')
    expect(html).not.toContain('<style')
    expect(html).toContain(`<link rel="stylesheet" href="/${SKIP_LINK_GUARD_SHEET}">`)
    expect(readFileSync(join(root, 'dist/client', SKIP_LINK_GUARD_SHEET), 'utf8')).toBe(SKIP_LINK_GUARD_CSS)
  }, 60_000)
})
