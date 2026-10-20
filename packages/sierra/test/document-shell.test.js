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

import { applyDocument } from '../src/build/document-shell.js'
import { wrapDocument } from '../src/build/prerender.js'
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
    expect(applyDocument(SHELL, {})).toBe(SHELL)
    const own = '<html lang="en"><body class="x"></body></html>'
    expect(applyDocument(own, { bodyAttrs: { id: 'app' } })).toBe('<html lang="en"><body class="x" id="app"></body></html>')
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

async function devShell(target, document) {
  await fixture()
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
})
