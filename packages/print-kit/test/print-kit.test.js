// print-kit — what the printer promises without a browser: the document it
// builds and the plugin's claim. Everything that prints is `test/run.mjs`, over
// a real Chrome.

import { describe, expect, test } from 'bun:test'
import { pageRules, printDocument, printerPlugin } from '../index.js'

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
