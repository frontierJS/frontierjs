/*
 * pdf — a document to a PDF: one page per group, a running header and
 * page X of Y, nothing fetched and nothing run.
 */
import { printDocument } from '../../index.js'

export const name = 'a PDF'

const groups = ['North', 'South', 'West'].map((g) =>
  `<section class="page-group"><h2>${g} region</h2><p>Body of ${g}.</p></section>`).join('')

// Page objects are plain dictionaries in Chrome's output; /Pages is the tree.
const pageCount = (bytes) => (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length

export async function run(t) {
  const { printer } = t
  const css = await Bun.file(new URL('../../src/print.css', import.meta.url)).text()

  const pdf = await printer.pdf(printDocument({
    body: groups, title: 'Regions',
    page: { size: 'A4', top: { left: 'Regional revenue', right: 'USD' }, bottom: { right: 'Page {page} of {pages}' } },
  }))
  t.is(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-', 'is a PDF')
  t.is(pageCount(pdf), 1, 'without print.css nothing breaks: the three groups share a page')
  const broken = await printer.pdf(printDocument({ body: groups, css: [css], page: { bottom: { right: 'Page {page} of {pages}' } } }))
  t.is(pageCount(broken), 3, 'with it, one page per group')
  t.is(printer.stats().launches, 1, 'warm after the first')

  if (!t.hasPoppler) t.skip('carries its running header and page X of Y on every page')
  else {
    const text = t.pdfText(await printer.pdf(printDocument({
      body: groups, css: [css],
      page: { top: { left: 'Regional revenue', right: 'USD' }, bottom: { right: 'Page {page} of {pages}' } },
    })))
    const pages = text.split('\f').filter((p) => p.trim())
    t.is(pages.length, 3, 'three pages of text')
    pages.forEach((p, i) => {
      t.match(p, /Regional revenue/, `page ${i + 1} carries its running header`)
      t.match(p, new RegExp(`Page ${i + 1} of 3`), `page ${i + 1} says Page ${i + 1} of 3`)
    })
    t.match(pages[1], /South region/, 'and the second page is the second group')
  }

  let hits = 0
  const server = Bun.serve({ port: 0, fetch() { hits++; return new Response('x') } })
  try {
    const before = printer.stats().blocked
    const url = `http://127.0.0.1:${server.port}`
    await printer.pdf(printDocument({
      body: `<img src="${url}/pixel.png"><div style="background:url(${url}/bg.png)">x</div>`,
      css: [`@import url("${url}/sheet.css");`],
    }))
    t.is(hits, 0, 'reaches nothing over the network')
    t.ok(printer.stats().blocked - before >= 2, 'and counts what it refused')
  } finally { server.stop(true) }

  if (!t.hasPoppler) t.skip('runs no script the document carries')
  else {
    const text = t.pdfText(await printer.pdf(printDocument({
      body: '<p id="p">landed text</p><script>document.getElementById("p").textContent = "SCRIPT RAN"</script>',
    })))
    t.match(text, /landed text/, 'prints the landed text')
    t.ok(!text.includes('SCRIPT RAN'), 'and runs no script the document carries')
  }
}
