/*
 * markdown.spec.js — the text is somebody else's, so nothing in it is markup.
 *
 * The first block is the property the kit exists for (`IDEAS/markdown-kit.md`,
 * option C): no input reaches the page as a tag or an attribute this file did
 * not write, and no link goes anywhere but the web, mail or this site. The
 * rest pin the subset a model's reply and a `@syntax(md)` column use.
 */

import { markdown, markdownText, safeUrl } from '../../src/markdown/markdown.js'

/* Every tag in the answer, by name — the only ones allowed are ours. */
const OURS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li',
  'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
  // glow's paint inside a fence
  'b', 'i', 'sup', 'sub', 'u', 'dfn', 'mark', 'label', 'ins', 's', 'span'])
const tags = (html) => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase())
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])

/* ── Nothing the text says is markup ───────────────────────────────── */

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '**<b onclick=alert(1)>x</b>**',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x](javascript&#58;alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox)',
  '![x](javascript:alert(1))',
  '<javascript:alert(1)>',
  '[x](https://a.test "a\\" onmouseover=\\"alert(1)")',
  '[x](https://a.test" onmouseover="alert(1))',
  '`<script>`',
  '```html\n<script>alert(1)</script>\n```',
  '```"><script>\nx\n```',
  '| a | b |\n| - | - |\n| <i>x</i> | [y](javascript:z) |',
  '- [ ] <svg onload=alert(1)>',
  '> <iframe src=//evil>',
  '&lt;script&gt; &#x3c;script&#x3e;',
  'https://a.test/"onmouseover="alert(1)',
  'www.a.test/<script>',
]

test('markdown: no input writes a tag of its own', function () {
  for (const src of HOSTILE) {
    const html = markdown(src)
    for (const t of tags(html)) assert.ok(OURS.has(t), `${JSON.stringify(src)} wrote <${t}>: ${html}`)
    // An attribute's quoted value is text; what is left of a tag is its names.
    const names = html.replace(/"[^"]*"/g, '""')
    assert.ok(!/<[^>]*\son[a-z]+=/i.test(names), `${JSON.stringify(src)} wrote a handler: ${html}`)
    assert.ok(!/<(?:script|img|svg|iframe)/i.test(html), `${JSON.stringify(src)}: ${html}`)
  }
})

test('markdown: no link goes anywhere but http, https, mailto or this site', function () {
  for (const src of HOSTILE) {
    for (const h of hrefs(markdown(src))) {
      // Decoded once, as the browser reads an attribute: `&amp;#58;` is the
      // text `&#58;`, a relative path, and never a colon.
      const bare = h.replace(/&amp;/g, '&').replace(/[\u0000- ]/g, '').toLowerCase()
      assert.ok(/^(https?:|mailto:|\/|#|[^:]*$)/.test(bare), `${JSON.stringify(src)} linked to ${h}`)
    }
  }
})

test('markdown: a refused link keeps its text', function () {
  assert.equal(markdown('[click](javascript:alert(1))'), '<p>click</p>')
})

test('markdown: an attribute cannot be closed from inside a URL or a title', function () {
  const html = markdown('[x](https://a.test "say \\"hi\\"")')
  assert.equal(html, '<p><a href="https://a.test" title="say &quot;hi&quot;" target="_blank" rel="noopener noreferrer">x</a></p>')
})

test('markdown: an image is a link to it, never loaded', function () {
  assert.equal(markdown('![a cat](https://a.test/cat.png)'), '<p><a href="https://a.test/cat.png" target="_blank" rel="noopener noreferrer">a cat</a></p>')
})

test('markdown: safeUrl reads the scheme the browser would', function () {
  assert.equal(safeUrl('https://a.test/x'), 'https://a.test/x')
  assert.equal(safeUrl('/apps/1'), '/apps/1')
  assert.equal(safeUrl('#top'), '#top')
  assert.equal(safeUrl('mailto:a@b.test'), 'mailto:a@b.test')
  assert.equal(safeUrl(' java\nscript:x'), null)
  assert.equal(safeUrl('\u0001javascript:x'), null)
  assert.equal(safeUrl('DATA:text/html,x'), null)
})

/* ── Inline ────────────────────────────────────────────────────────── */

test('markdown: emphasis, strong and strikethrough', function () {
  assert.equal(markdown('*a* _b_ **c** __d__ ~~e~~'), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong> <del>e</del></p>')
  assert.equal(markdown('***both***'), '<p><em><strong>both</strong></em></p>')
  assert.equal(markdown('**a *b* c**'), '<p><strong>a <em>b</em> c</strong></p>')
  assert.equal(markdown('*a **b***'), '<p><em>a <strong>b</strong></em></p>')
})

test('markdown: a delimiter that flanks nothing is a character', function () {
  assert.equal(markdown('2 * 3 * 4'), '<p>2 * 3 * 4</p>')
  assert.equal(markdown('snake_case_name'), '<p>snake_case_name</p>')
  assert.equal(markdown('**unclosed'), '<p>**unclosed</p>')
  assert.equal(markdown('~one~'), '<p>~one~</p>')
})

test('markdown: a code span is literal, emphasis and all', function () {
  assert.equal(markdown('`Model.field_name` and `**x**`'), '<p><code>Model.field_name</code> and <code>**x**</code></p>')
  assert.equal(markdown('`` a ` b ``'), '<p><code>a ` b</code></p>')
  assert.equal(markdown('`open'), '<p>`open</p>')
})

test('markdown: a backslash escapes punctuation', function () {
  assert.equal(markdown('\\*not em\\*'), '<p>*not em*</p>')
})

test('markdown: links, autolinks and bare URLs', function () {
  assert.equal(markdown('[the **docs**](/docs/)'), '<p><a href="/docs/">the <strong>docs</strong></a></p>')
  assert.equal(markdown('<https://a.test>'), '<p><a href="https://a.test" target="_blank" rel="noopener noreferrer">https://a.test</a></p>')
  assert.equal(markdown('see https://a.test/x.'), '<p>see <a href="https://a.test/x" target="_blank" rel="noopener noreferrer">https://a.test/x</a>.</p>')
  assert.equal(markdown('(https://a.test/wiki/A_(b))'), '<p>(<a href="https://a.test/wiki/A_(b)" target="_blank" rel="noopener noreferrer">https://a.test/wiki/A_(b)</a>)</p>')
  assert.equal(markdown('www.a.test'), '<p><a href="https://www.a.test" target="_blank" rel="noopener noreferrer">www.a.test</a></p>')
  assert.equal(markdown('[a](https://a.test?x=1&y=2)'), '<p><a href="https://a.test?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">a</a></p>')
})

// FJS-3604: a link off this site must not replace the page the reader is on.
test('markdown: a link off this site opens in a new tab, one on it does not', function () {
  const T = ' target="_blank" rel="noopener noreferrer"'
  assert.equal(markdown('[a](https://a.test)'), '<p><a href="https://a.test"' + T + '>a</a></p>')
  assert.equal(markdown('[a](HTTP://a.test)'), '<p><a href="HTTP://a.test"' + T + '>a</a></p>')
  assert.equal(markdown('[a](//a.test/x)'), '<p><a href="//a.test/x"' + T + '>a</a></p>')
  assert.equal(markdown('<https://a.test>'), '<p><a href="https://a.test"' + T + '>https://a.test</a></p>')
  assert.equal(markdown('[a](/docs)'), '<p><a href="/docs">a</a></p>')
  assert.equal(markdown('[a](#top)'), '<p><a href="#top">a</a></p>')
  assert.equal(markdown('[a](mailto:x@a.test)'), '<p><a href="mailto:x@a.test">a</a></p>')
  assert.equal(markdown('<x@a.test>'), '<p><a href="mailto:x@a.test">x@a.test</a></p>')
})

test('markdown: an entity in text stands, a bare ampersand is escaped', function () {
  assert.equal(markdown('A &amp; B & C &copy;'), '<p>A &amp; B &amp; C &copy;</p>')
})

test('markdown: hard breaks, and `breaks` for chat', function () {
  assert.equal(markdown('a  \nb'), '<p>a<br>\nb</p>')
  assert.equal(markdown('a\\\nb'), '<p>a<br>\nb</p>')
  assert.equal(markdown('a\nb'), '<p>a\nb</p>')
  assert.equal(markdown('a\nb', { breaks: true }), '<p>a<br>\nb</p>')
})

/* ── Blocks ────────────────────────────────────────────────────────── */

test('markdown: headings, shifted by headingBase', function () {
  assert.equal(markdown('# One\n## Two ##'), '<h1>One</h1>\n<h2>Two</h2>')
  assert.equal(markdown('# One\n###### Six', { headingBase: 3 }), '<h3>One</h3>\n<h6>Six</h6>')
  assert.equal(markdown('#hashtag'), '<p>#hashtag</p>')
})

// FJS-2610: a base from an attribute is a string, and 0 or 9 is no heading level.
test('markdown: headingBase is a number from 1 to 6 however it arrives', function () {
  assert.equal(markdown('# One\n## Two', { headingBase: '3' }), '<h3>One</h3>\n<h4>Two</h4>')
  assert.equal(markdown('# One', { headingBase: 0 }), '<h1>One</h1>')
  assert.equal(markdown('# One', { headingBase: 9 }), '<h6>One</h6>')
  assert.equal(markdown('# One', { headingBase: 'big' }), '<h1>One</h1>')
})

test('markdown: paragraphs split on a blank line', function () {
  assert.equal(markdown('one\ntwo\n\nthree'), '<p>one\ntwo</p>\n<p>three</p>')
})

test('markdown: a fence is escaped, and painted when it names a language', function () {
  assert.equal(markdown('```\n<b>\n  x\n```'), '<pre><code>&lt;b&gt;\n  x</code></pre>')
  const js = markdown('```js\nconst a = "<x>"\n```')
  assert.ok(js.startsWith('<pre><code language="js">'), js)
  assert.ok(js.includes('&lt;x&gt;'), js)
  assert.equal(markdown('~~~\nunclosed'), '<pre><code>unclosed</code></pre>')
  assert.equal(markdown('````\n```\n````'), '<pre><code>```</code></pre>')
})

test('markdown: a thematic break and a block quote', function () {
  assert.equal(markdown('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>')
  assert.equal(markdown('> quoted\n> **still**'), '<blockquote>\n<p>quoted\n<strong>still</strong></p>\n</blockquote>')
})

test('markdown: a tight list draws its items as text', function () {
  assert.equal(markdown('- one\n- two'), '<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
  assert.equal(markdown('3. three\n4. four'), '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>')
})

test('markdown: a loose list keeps its paragraphs', function () {
  assert.equal(markdown('- one\n\n- two'), '<ul>\n<li><p>one</p></li>\n<li><p>two</p></li>\n</ul>')
})

test('markdown: a list nests by indentation', function () {
  assert.equal(markdown('- a\n  - b\n  - c\n- d'),
    '<ul>\n<li>a\n<ul>\n<li>b</li>\n<li>c</li>\n</ul></li>\n<li>d</li>\n</ul>')
  assert.equal(markdown('1. a\n   - b'), '<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ol>')
})

test('markdown: a wrapped bullet continues its item', function () {
  assert.equal(markdown('- a long line\nthat wrapped\n- next'), '<ul>\n<li>a long line\nthat wrapped</li>\n<li>next</li>\n</ul>')
})

test('markdown: a list after a paragraph, and one that is not', function () {
  assert.equal(markdown('Changes:\n- one'), '<p>Changes:</p>\n<ul>\n<li>one</li>\n</ul>')
  assert.equal(markdown('In\n2024. was a year'), '<p>In\n2024. was a year</p>')
})

test('markdown: a list ends at a paragraph that is not indented', function () {
  assert.equal(markdown('- a\n\nafter'), '<ul>\n<li>a</li>\n</ul>\n<p>after</p>')
})

test('markdown: task items', function () {
  assert.equal(markdown('- [ ] todo\n- [x] done'),
    '<ul>\n<li><input type="checkbox" disabled> todo</li>\n<li><input type="checkbox" disabled checked> done</li>\n</ul>')
})

test('markdown: a pipe table, aligned', function () {
  assert.equal(markdown('| Model | Rows |\n| :-- | --: |\n| `Lead` | 3 |\n| a \\| b |'),
    '<table>\n<thead>\n<tr><th align="left">Model</th><th align="right">Rows</th></tr>\n</thead>\n' +
    '<tbody>\n<tr><td align="left"><code>Lead</code></td><td align="right">3</td></tr>\n' +
    '<tr><td align="left">a | b</td><td align="right"></td></tr>\n</tbody>\n</table>')
})

test('markdown: a table carries the class the caller names', function () {
  assert.ok(markdown('| a |\n| - |', { classes: { table: 'table compact' } }).startsWith('<table class="table compact">'))
})

test('markdown: a pipe in a sentence is not a table', function () {
  assert.equal(markdown('a | b\nc'), '<p>a | b\nc</p>')
})

test('markdown: empty in, empty out', function () {
  assert.equal(markdown(''), '')
  assert.equal(markdown(null), '')
  assert.equal(markdown('\n\n'), '')
})

/* ── markdownText ──────────────────────────────────────────────────── */

test('markdown: markdownText is the words alone', function () {
  assert.equal(markdownText('## Added **Lead**\n\n- `email` & a <b>'), 'Added Lead email & a <b>')
})
