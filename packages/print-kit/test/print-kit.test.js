// print-kit — what the printer promises, against a real Chrome.
//
// The text of a PDF is read back with poppler's pdftotext: a PDF's text is
// compressed and glyph-encoded, so grepping its bytes proves nothing. Without
// Chrome or pdftotext the tests that need them say so and skip.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '@frontierjs/mesa/drive'
import { createPrinter, pageRules, printDocument, printerPlugin } from '../index.js'

const hasChrome  = !!findChrome()
const hasPoppler = spawnSync('sh', ['-c', 'command -v pdftotext']).status === 0
const scratch    = mkdtempSync(join(tmpdir(), 'print-kit-'))

function pdfText(bytes) {
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.pdf`)
  writeFileSync(file, bytes)
  return spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).stdout
}
// Page objects are plain dictionaries in Chrome's output; /Pages is the tree.
const pageCount = (bytes) => (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length
const pngSize = (bytes) => { const b = Buffer.from(bytes); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } }

const printer = createPrinter()
afterAll(() => printer.close())

describe('the document', () => {
  test('a margin box holds data as a string it cannot leave', () => {
    const css = pageRules({ top: { left: 'Acme "Q3" </style><script>x</script>' } })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('"Q3"')
    expect(css).toContain('@top-left { content: "Acme \\22 Q3\\22  \\3c /style\\3e ')
  })

  test('{page} and {pages} are the counters, everything else is text', () => {
    expect(pageRules({ bottom: { right: 'Page {page} of {pages}' } }))
      .toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages); }')
  })

  test('a paper size or a slot it does not know is refused, not guessed', () => {
    expect(() => pageRules({ size: 'A11' })).toThrow(/page size 'A11'/)
    expect(() => pageRules({ top: { middle: 'x' } })).toThrow(/top.middle is not a slot/)
    expect(() => pageRules({ margin: '1cm; } body { display: none' })).toThrow(/not a length list/)
  })

  test('the title is escaped and a stylesheet cannot close its element', () => {
    expect(printDocument({ body: '', title: '<b>R&D</b>' })).toContain('<title>&lt;b&gt;R&amp;D&lt;/b&gt;</title>')
    expect(() => printDocument({ body: '', css: ['a{}</style><p>'] })).toThrow(/<\/style>/)
  })
})

describe.skipIf(!hasChrome)('a PDF', () => {
  const groups = ['North', 'South', 'West'].map((g) =>
    `<section class="page-group"><h2>${g} region</h2><p>Body of ${g}.</p></section>`).join('')
  const doc = printDocument({
    body: groups, title: 'Regions',
    page: { size: 'A4', top: { left: 'Regional revenue', right: 'USD' }, bottom: { right: 'Page {page} of {pages}' } },
  })

  test('is a PDF, one page per group, warm after the first', async () => {
    const pdf = await printer.pdf(doc)
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    // Without print.css nothing breaks: the three groups share a page.
    expect(pageCount(pdf)).toBe(1)

    const css = await Bun.file(new URL('../src/print.css', import.meta.url)).text()
    const broken = await printer.pdf(printDocument({ body: groups, css: [css], page: { bottom: { right: 'Page {page} of {pages}' } } }))
    expect(pageCount(broken)).toBe(3)
    expect(printer.stats().launches).toBe(1)
  }, 30000)

  test.skipIf(!hasPoppler)('carries its running header and page X of Y on every page', async () => {
    const css = await Bun.file(new URL('../src/print.css', import.meta.url)).text()
    const text = pdfText(await printer.pdf(printDocument({
      body: groups, css: [css],
      page: { top: { left: 'Regional revenue', right: 'USD' }, bottom: { right: 'Page {page} of {pages}' } },
    })))
    const pages = text.split('\f').filter((p) => p.trim())
    expect(pages).toHaveLength(3)
    pages.forEach((p, i) => {
      expect(p).toContain('Regional revenue')
      expect(p).toContain(`Page ${i + 1} of 3`)
    })
    expect(pages[1]).toContain('South region')
  }, 30000)

  test('reaches nothing over the network, and counts what it refused', async () => {
    let hits = 0
    const server = Bun.serve({ port: 0, fetch() { hits++; return new Response('x') } })
    try {
      const before = printer.stats().blocked
      const url = `http://127.0.0.1:${server.port}`
      await printer.pdf(printDocument({
        body: `<img src="${url}/pixel.png"><div style="background:url(${url}/bg.png)">x</div>`,
        css: [`@import url("${url}/sheet.css");`],
      }))
      expect(hits).toBe(0)
      expect(printer.stats().blocked - before).toBeGreaterThanOrEqual(2)
    } finally { server.stop(true) }
  }, 30000)

  test.skipIf(!hasPoppler)('runs no script the document carries', async () => {
    const text = pdfText(await printer.pdf(printDocument({
      body: '<p id="p">landed text</p><script>document.getElementById("p").textContent = "SCRIPT RAN"</script>',
    })))
    expect(text).toContain('landed text')
    expect(text).not.toContain('SCRIPT RAN')
  }, 30000)
})

describe.skipIf(!hasChrome)('a PNG', () => {
  test('is the element alone, at the scale asked for', async () => {
    const png = await printer.png(printDocument({
      body: '<p>above</p><svg id="chart" width="200" height="100" style="display:block"><rect width="200" height="100" fill="teal"/></svg>',
    }), { selector: '#chart', scale: 2 })
    expect(Buffer.from(png.slice(1, 4)).toString()).toBe('PNG')
    expect(pngSize(png)).toEqual({ width: 400, height: 200 })
  }, 30000)

  test('names a selector that matches nothing', async () => {
    await expect(printer.png(printDocument({ body: '<p>x</p>' }), { selector: '#nope' })).rejects.toThrow(/nothing in the document matches #nope/)
  }, 30000)
})

describe('the plugin', () => {
  test('is claimed as app.printer, and refuses to boot with no Chrome', async () => {
    const claimed = {}
    const plugin = printerPlugin({ find: () => null })
    plugin.register({ claim: (name, value) => { claimed[name] = value } })
    expect(typeof claimed.printer.pdf).toBe('function')
    expect(() => plugin.boot()).toThrow(/no Chrome on this machine/)
    await plugin.shutdown()
    await expect(claimed.printer.pdf('<p>')).rejects.toThrow(/closed/)
  })
})
