/*
 * grammars.spec.js — the tokenizer and the eight grammars it ships.
 *
 * A line is tokenized from the state it starts in, and a wrong grammar is
 * silent: the text still paints, with a string where a comment ought to be.
 * The cases pin each language's traps; the states are compared with `===`
 * because that is the contract `createLineStates`-style stores rely on.
 */

import {
  ELEMENT, STRUCTURE, css, grammarFor, html, initialState, js, json, lineHTML, lite, markdown, mesa, plain,
  stateGrammar, stateStack, tokenizeLine, ts, yaml,
} from '../../src/grammars/grammars.js'

const G = { css, html, js, json, lite, markdown, mesa, plain, ts, yaml }

let suite = ''
const describe = (name, fn) => {
  suite = name
  fn()
}
const t = (name, fn) => test(`${suite}: ${name}`, fn)
const has = (list, item) => list.some((x) => JSON.stringify(x) === JSON.stringify(item))

/** A line's typed runs, merged, as [type, text] pairs. */
function jsRuns(text, state = initialState(js)) {
  return runs('js', text, state)
}

/** A line's typed runs, merged, as [type, text] pairs. */
function runs(name, text, state = initialState(G[name])) {
  const out = []
  const end = tokenizeLine(text, state, (type, from, to) => {
    const last = out[out.length - 1]
    if (last && last[0] === type) last[1] += text.slice(from, to)
    else out.push([type, text.slice(from, to)])
  })
  return { runs: out.filter(([t]) => t !== null), end }
}

/** Every line of a document: its typed runs, carrying the state down. */
function doc(name, text) {
  let state = initialState(G[name])
  return text.split('\n').map((line) => {
    const r = runs(name, line, state)
    state = r.end
    return r.runs
  })
}

describe('tokenizeLine', () => {
  t('keywords, strings, numbers and comments', () => {
    assert.deepEqual(jsRuns('const x = "a\\"b" + 0x1F // done').runs, [
      ['keyword', 'const'],
      ['string', '"a\\"b"'],
      ['number', '0x1F'],
      ['comment', '// done'],
    ])
  })

  t('a hashbang is a comment, not a regex', () => {
    assert.deepEqual(jsRuns('#!/usr/bin/env bun').runs, [['comment', '#!/usr/bin/env bun']])
  })

  t('a keyword inside an identifier is not one', () => {
    assert.deepEqual(jsRuns('$if x_const constant').runs, [])
  })

  t('a block comment carries to the next line and closes there', () => {
    const a = jsRuns('let a /* open')
    assert.equal(stateStack(a.end).length, 1)
    const b = jsRuns('still */ let', a.end)
    assert.deepEqual(b.runs, [
      ['comment', 'still */'],
      ['keyword', 'let'],
    ])
    assert.equal(b.end, initialState(js))
  })

  t('a line that closes nothing it did not open ends in the state it started in', () => {
    const open = jsRuns('/*').end
    assert.equal(tokenizeLine('more comment', open), open)
  })

  t('an unclosed quote ends at the line', () => {
    const r = jsRuns('x = "abc')
    assert.deepEqual(r.runs, [['string', '"abc']])
    assert.equal(r.end, initialState(js))
  })

  t('a template literal: text is a string, ${} is code, and it spans lines', () => {
    const a = jsRuns('`a ${b + 1} c')
    assert.deepEqual(a.runs, [
      ['string', '`a '],
      ['punctuation', '${'],
      ['number', '1'],
      ['punctuation', '}'],
      ['string', ' c'],
    ])
    assert.deepEqual(jsRuns('d`', a.end).runs, [['string', 'd`']])
  })

  t('a regex after an operator, a division after a value', () => {
    assert.deepEqual(jsRuns('x = /a[/]b/g').runs, [['regexp', '/a[/]b/g']])
    assert.deepEqual(jsRuns('a / b / c').runs, [])
  })

  t('function calls and type names', () => {
    assert.deepEqual(jsRuns('new Map(); run (x)').runs, [
      ['keyword', 'new'],
      ['function', 'Map'],
      ['function', 'run'],
    ])
    assert.deepEqual(jsRuns('let m = Foo').runs, [
      ['keyword', 'let'],
      ['type', 'Foo'],
    ])
  })

  t('an empty match makes progress', () => {
    const g = { name: 'empty-test', rules: [{ match: /x*/, type: 'x' }] }
    assert.deepEqual(jsRuns('abxx', initialState(g)).runs, [['x', 'xx']])
  })

  t('a syntax region hands its inside to another grammar', () => {
    const g = {
      name: 'embed-test',
      rules: [{ begin: /<s>/, end: /<\/s>/, type: 'tag', syntax: js }],
    }
    const a = jsRuns('t <s>let', initialState(g))
    assert.deepEqual(a.runs, [
      ['tag', '<s>'],
      ['keyword', 'let'],
    ])
    assert.deepEqual(jsRuns('if</s> if', a.end).runs, [
      ['keyword', 'if'],
      ['tag', '</s>'],
    ])
  })
})

describe('lineHTML', () => {
  t('escapes, and leaves untyped text bare', () => {
    assert.equal(lineHTML('a < "<b>" & c', initialState(js)), 'a &lt; <em>"&lt;b&gt;"</em> &amp; c')
  })

  t('a type with no color role is a classed span', () => {
    const g = { name: 'structure-test', rules: [{ match: /#.*/, type: 'heading' }, { match: /\*\w+\*/, type: 'emphasis' }] }
    assert.equal(lineHTML('*a*', initialState(g)), '<span class="t-emphasis">*a*</span>')
    // A structural type with a color role keeps its class for the weight.
    assert.equal(lineHTML('# Title', initialState(g)), '<label class="t-heading"># Title</label>')
  })
})

describe('grammarFor', () => {
  t('every extension maps to its grammar', () => {
    const want = { 'a.yml': 'yaml', 'a.yaml': 'yaml', 'a.json': 'json', 'a.jsonc': 'json', 'a.css': 'css', 'a.html': 'html', 'a.htm': 'html', 'a.md': 'markdown', 'a.markdown': 'markdown', 'a.lite': 'lite', 'a.mesa': 'mesa', 'a.ts': 'ts', 'a.txt': 'plain' }
    for (const [path, name] of Object.entries(want)) assert.equal(grammarFor(path).name, name)
  })

  t('answers the grammar object, plain for an unknown extension', () => {
    assert.equal(grammarFor('src/a.ts?x#y'), ts)
    assert.equal(grammarFor('README'), plain)
    assert.equal(grammarFor('a.unknown'), plain)
    assert.equal(stateGrammar(initialState(grammarFor('a.css'))), css)
  })
})

describe('json', () => {
  t('keys, strings, numbers and constants', () => {
    assert.deepEqual(runs('json', '  "a\\"b": [1, -2.5e3, "s", true, null]').runs, [
      ['property', '"a\\"b"'],
      ['number', '1'],
      ['number', '-2.5e3'],
      ['string', '"s"'],
      ['constant', 'true'],
      ['constant', 'null'],
    ])
  })

  t('jsonc comments, one of them over two lines', () => {
    const lines = doc('json', '{ "a": 1 } // c\n/* open\nstill */ "b": 2')
    assert.deepEqual(lines[0].at(-1), ['comment', '// c'])
    assert.deepEqual(lines[1], [['comment', '/* open']])
    assert.deepEqual(lines[2], [
      ['comment', 'still */'],
      ['property', '"b"'],
      ['number', '2'],
    ])
  })

  t('an unclosed string ends at its line', () => {
    const r = runs('json', '"open')
    assert.deepEqual(r.runs, [['string', '"open']])
    assert.equal(r.end, initialState(json))
  })
})

describe('css', () => {
  t('a rule: selectors, properties, values', () => {
    const lines = doc('css', 'a.b:hover > #c {\n  color: #fff !important;\n  margin: -.5em 10px;\n  width: calc(100% - 2rem);\n}')
    assert.deepEqual(lines[0], [
      ['type', 'a.b'],
      ['keyword', ':hover'],
      ['type', '#c'],
      ['punctuation', '{'],
    ])
    assert.deepEqual(lines[1], [
      ['property', 'color'],
      ['number', '#fff'],
      ['special', '!important'],
    ])
    assert.deepEqual(lines[2], [
      ['property', 'margin'],
      ['number', '-.5em'],
      ['number', '10px'],
    ])
    assert.deepEqual(lines[3], [
      ['property', 'width'],
      ['function', 'calc'],
      ['number', '100%'],
      ['number', '2rem'],
    ])
    assert.deepEqual(lines[4], [['punctuation', '}']])
  })

  t('at-rules keep their prelude plain and nest a rule inside', () => {
    const lines = doc('css', '@media screen and (min-width: 600px) {\n  .a:hover { color: red }\n}')
    assert.deepEqual(lines[0], [
      ['special', '@media'],
      ['punctuation', '{'],
    ])
    assert.deepEqual(lines[1], [
      ['type', '.a'],
      ['keyword', ':hover'],
      ['punctuation', '{'],
      ['property', 'color'],
      ['punctuation', '}'],
    ])
    assert.equal(stateStack(runs('css', '}', runs('css', '@media x {').end).end).length, 0)
  })

  t('strings, url() and a comment over two lines', () => {
    const lines = doc('css', 'a { background: url(a.png) "x"; /* open\nstill */ b: 1 }')
    assert.deepEqual(lines[0], [
      ['type', 'a'],
      ['punctuation', '{'],
      ['property', 'background'],
      ['function', 'url'],
      ['string', 'a.png'],
      ['string', '"x"'],
      ['comment', '/* open'],
    ])
    assert.deepEqual(lines[1][0], ['comment', 'still */'])
  })
})

describe('html', () => {
  t('a tag, its attributes and an entity', () => {
    assert.deepEqual(runs('html', '<div class="a b" id=x disabled>Hi &amp; bye</div>').runs, [
      ['tag', '<div'],
      ['attribute', 'class'],
      ['string', '"a b"'],
      ['attribute', 'id'],
      ['string', 'x'],
      ['attribute', 'disabled'],
      ['tag', '>'],
      ['escape', '&amp;'],
      ['tag', '</div>'],
    ])
  })

  t('a doctype, and a comment over two lines', () => {
    const lines = doc('html', '<!DOCTYPE html>\n<!-- a\nb --><p>')
    assert.deepEqual(lines[0], [['keyword', '<!DOCTYPE html>']])
    assert.deepEqual(lines[1], [['comment', '<!-- a']])
    assert.deepEqual(lines[2], [
      ['comment', 'b -->'],
      ['tag', '<p>'],
    ])
  })

  t('attributes wrap over lines, a quoted value too', () => {
    const lines = doc('html', '<input\n  disabled\n  value="a\n b"\n/>after')
    assert.deepEqual(lines[0], [['tag', '<input']])
    assert.deepEqual(lines[1], [['attribute', 'disabled']])
    assert.deepEqual(lines[2], [
      ['attribute', 'value'],
      ['string', '"a'],
    ])
    assert.deepEqual(lines[3], [['string', ' b"']])
    assert.deepEqual(lines[4], [['tag', '/>']])
  })

  t('a script body is JavaScript and a style body is CSS', () => {
    const lines = doc('html', '<script type="module">\n  const a = "x"\n</script>\n<style>\n  a { color: red }\n</style>\n<p>')
    assert.deepEqual(lines[0], [['tag', '<script type="module">']])
    assert.deepEqual(lines[1], [
      ['keyword', 'const'],
      ['string', '"x"'],
    ])
    assert.deepEqual(lines[2], [['tag', '</script>']])
    assert.deepEqual(lines[4], [
      ['type', 'a'],
      ['punctuation', '{'],
      ['property', 'color'],
      ['punctuation', '}'],
    ])
    assert.deepEqual(lines[5], [['tag', '</style>']])
    assert.deepEqual(lines[6], [['tag', '<p>']])
  })

  t('a JSON script is JSON, and the state returns to the top after', () => {
    const a = runs('html', '<script type="application/ld+json">')
    const b = runs('html', '{ "a": 1 }', a.end)
    assert.deepEqual(b.runs, [
      ['property', '"a"'],
      ['number', '1'],
    ])
    assert.equal(runs('html', '</script>', b.end).end, initialState(html))
  })
})

describe('markdown', () => {
  t('headings, emphasis, strong, code and links', () => {
    assert.deepEqual(runs('markdown', '## A *b* **c** `d` [e](f) <https://x.y>').runs, [
      ['heading', '## A *b* **c** `d` [e](f) <https://x.y>'],
    ])
    assert.deepEqual(runs('markdown', 'a *b* **c** `d` [e](f) ![g](h) <https://x.y>').runs, [
      ['emphasis', '*b*'],
      ['strong', '**c**'],
      ['code', '`d`'],
      ['link', '[e](f)'],
      ['link', '![g](h)'],
      ['link', '<https://x.y>'],
    ])
  })

  t('snake_case is not emphasis, an escaped star is not either', () => {
    assert.deepEqual(runs('markdown', 'a snake_case_name and \\*x\\* here').runs, [
      ['escape', '\\*'],
      ['escape', '\\*'],
    ])
  })

  t('list and quote markers, a thematic break', () => {
    assert.deepEqual(runs('markdown', '  - item').runs, [['punctuation', '  -']])
    assert.deepEqual(runs('markdown', '12. item').runs, [['punctuation', '12.']])
    assert.deepEqual(runs('markdown', '> > deep').runs, [['punctuation', '> > ']])
    assert.deepEqual(runs('markdown', '---').runs, [['punctuation', '---']])
    assert.deepEqual(runs('markdown', '* * *').runs, [['punctuation', '* * *']])
  })

  t('a fence with a known language holds that grammar', () => {
    const lines = doc('markdown', 'text\n```js\nconst a = "x"\n```\n```json\n{ "k": 1 }\n```\n```css\na { color: red }\n```\nafter *em*')
    assert.deepEqual(lines[1], [['code', '```js']])
    assert.deepEqual(lines[2], [
      ['keyword', 'const'],
      ['string', '"x"'],
    ])
    assert.deepEqual(lines[3], [['code', '```']])
    assert.deepEqual(lines[5], [
      ['property', '"k"'],
      ['number', '1'],
    ])
    assert.ok(has(lines[8], ['property', 'color']))
    assert.deepEqual(lines[10], [['emphasis', '*em*']])
  })

  t('a fence with another language, or none, is code', () => {
    const lines = doc('markdown', '```sh\nls *.js # not *emphasis*\n```\n~~~\nplain\n~~~\n*em*')
    assert.deepEqual(lines[1], [['code', 'ls *.js # not *emphasis*']])
    assert.deepEqual(lines[4], [['code', 'plain']])
    assert.deepEqual(lines[6], [['emphasis', '*em*']])
  })

  t('mesa, lite, html and ts fences', () => {
    const lines = doc('markdown', '```mesa\n{#if a}\n```\n```lite\nmodel A {\n```\n```ts\nlet a: string\n```\n```html\n<b>\n```')
    assert.ok(has(lines[1], ['keyword', '#if']))
    assert.ok(has(lines[4], ['keyword', 'model']))
    assert.ok(has(lines[7], ['type', 'string']))
    assert.deepEqual(lines[10], [['tag', '<b>']])
  })
})

describe('front matter', () => {
  t('a --- on the first line opens YAML that the next --- closes', () => {
    const lines = doc('markdown', '---\nstatus: proposed\ntags: [a, b] # c\n---\n# Title')
    assert.deepEqual(lines[0], [['punctuation', '---']])
    assert.deepEqual(lines[1], [
      ['property', 'status'],
      ['punctuation', ':'],
    ])
    assert.deepEqual(lines[2], [
      ['property', 'tags'],
      ['punctuation', ':'],
      ['punctuation', '['],
      ['punctuation', ','],
      ['punctuation', ']'],
      ['comment', '# c'],
    ])
    assert.deepEqual(lines[3], [['punctuation', '---']])
    assert.deepEqual(lines[4], [['heading', '# Title']])
  })

  t('a --- pair below the first line is two thematic breaks', () => {
    const lines = doc('markdown', 'text\n---\nstatus: x\n---')
    assert.deepEqual(lines[2], [])
  })

  t('the first state is the first line\'s alone', () => {
    const first = initialState(markdown)
    const end = runs('markdown', 'text', first).end
    assert.ok(end !== first)
    assert.deepEqual(runs('markdown', '---', end).runs, [['punctuation', '---']])
    assert.equal(stateStack(runs('markdown', '---', end).end).length, 0)
    assert.equal(stateStack(runs('markdown', '', first).end).length, 0)
  })
})

describe('yaml', () => {
  t('keys, scalars, comments and anchors', () => {
    const lines = doc('yaml', 'a: "x # y" # c\n- b c: 1.5\n  d: true\n  e: *ref\n  url: http://x.y')
    assert.deepEqual(lines[0], [
      ['property', 'a'],
      ['punctuation', ':'],
      ['string', '"x # y"'],
      ['comment', '# c'],
    ])
    assert.deepEqual(lines[1], [
      ['punctuation', '-'],
      ['property', 'b c'],
      ['punctuation', ':'],
      ['number', '1.5'],
    ])
    assert.deepEqual(lines[2], [
      ['property', 'd'],
      ['punctuation', ':'],
      ['constant', 'true'],
    ])
    assert.deepEqual(lines[3], [
      ['property', 'e'],
      ['punctuation', ':'],
      ['special', '*ref'],
    ])
    assert.deepEqual(lines[4], [
      ['property', 'url'],
      ['punctuation', ':'],
    ])
  })
})

describe('lite', () => {
  t('a model: declaration, fields, types, attributes', () => {
    const lines = doc('lite', '/// Who.\nmodel Lead {\n  id   Int @id\n  name String? @length(2, 16) @default("x")\n  at DateTime @default(now())\n  @@gate(3.8.8.8)\n}')
    assert.deepEqual(lines[0], [['comment', '/// Who.']])
    assert.deepEqual(lines[1], [
      ['keyword', 'model'],
      ['type', 'Lead'],
    ])
    assert.deepEqual(lines[2], [
      ['property', 'id'],
      ['type', 'Int'],
      ['special', '@id'],
    ])
    assert.deepEqual(lines[3], [
      ['property', 'name'],
      ['type', 'String'],
      ['special', '@length'],
      ['number', '2'],
      ['number', '16'],
      ['special', '@default'],
      ['string', '"x"'],
    ])
    assert.ok(has(lines[4], ['function', 'now']))
    assert.deepEqual(lines[5], [
      ['special', '@@gate'],
      ['number', '3.8.8.8'],
    ])
  })

  t('a field named like a declaration is a field', () => {
    assert.deepEqual(runs('lite', '  type String').runs, [
      ['property', 'type'],
      ['type', 'String'],
    ])
    assert.deepEqual(runs('lite', '  scope String?').runs[0], ['property', 'scope'])
  })

  t('operator words and gate names inside a policy', () => {
    assert.deepEqual(runs('lite', '  @@allow(read, id == auth().id and role is ADMINISTRATOR)').runs, [
      ['special', '@@allow'],
      ['function', 'auth'],
      ['keyword', 'and'],
      ['keyword', 'is'],
      ['constant', 'ADMINISTRATOR'],
    ])
  })

  t('enum, extend and a block comment over two lines', () => {
    assert.deepEqual(runs('lite', 'enum UserKind { user bot }').runs, [
      ['keyword', 'enum'],
      ['type', 'UserKind'],
    ])
    assert.deepEqual(runs('lite', 'extend model X { @@tenant(none) }').runs.slice(0, 2), [
      ['keyword', 'extend model'],
      ['type', 'X'],
    ])
    const lines = doc('lite', '/* a\nb */ true')
    assert.deepEqual(lines[1], [
      ['comment', 'b */'],
      ['constant', 'true'],
    ])
  })
})

describe('mesa', () => {
  t('script module is JavaScript, style is CSS', () => {
    const lines = doc('mesa', '<script module>\n  export let a = 1\n</script>\n<style>\n  .a { color: red }\n</style>')
    assert.deepEqual(lines[0], [['tag', '<script module>']])
    assert.deepEqual(lines[1], [
      ['keyword', 'export'],
      ['keyword', 'let'],
      ['number', '1'],
    ])
    assert.ok(has(lines[4], ['property', 'color']))
    assert.deepEqual(lines[5], [['tag', '</style>']])
  })

  t('interpolation in text, in a value and as an attribute', () => {
    assert.deepEqual(runs('mesa', '<p>{a + 1} &amp;</p>').runs, [
      ['tag', '<p>'],
      ['punctuation', '{'],
      ['number', '1'],
      ['punctuation', '}'],
      ['escape', '&amp;'],
      ['tag', '</p>'],
    ])
    assert.deepEqual(runs('mesa', `<a class="x {b ? 'y' : 'z'}" {@attach f} onclick={go}>`).runs, [
      ['tag', '<a'],
      ['attribute', 'class'],
      ['string', '"x '],
      ['punctuation', '{'],
      ['string', "'y'"],
      ['string', "'z'"],
      ['punctuation', '}'],
      ['string', '"'],
      ['punctuation', '{'],
      ['keyword', '@attach'],
      ['punctuation', '}'],
      ['attribute', 'onclick'],
      ['punctuation', '{'],
      ['punctuation', '}'],
      ['tag', '>'],
    ])
  })

  t('block tags type their word as a keyword and the rest as JavaScript', () => {
    assert.deepEqual(runs('mesa', '{#if a > 1}').runs, [
      ['punctuation', '{'],
      ['keyword', '#if'],
      ['number', '1'],
      ['punctuation', '}'],
    ])
    assert.ok(has(runs('mesa', '{:else if b}').runs, ['keyword', ':else if']))
    assert.ok(has(runs('mesa', '{/each}').runs, ['keyword', '/each']))
    assert.ok(has(runs('mesa', '{@html line}').runs, ['keyword', '@html']))
    assert.deepEqual(runs('mesa', '{#each xs as x, i}').runs, [
      ['punctuation', '{'],
      ['keyword', '#each'],
      ['keyword', 'as'],
      ['punctuation', '}'],
    ])
    assert.ok(has(runs('mesa', '{#virtual each view as line, i height=18}').runs, ['keyword', '#virtual each']))
  })

  t('an expression over several lines closes where its brace does', () => {
    const lines = doc('mesa', '<p>{\n  a ? "x" : 1\n}</p>')
    assert.deepEqual(lines[1], [
      ['string', '"x"'],
      ['number', '1'],
    ])
    assert.deepEqual(lines[2], [
      ['punctuation', '}'],
      ['tag', '</p>'],
    ])
  })

  t('front matter is a comment', () => {
    const lines = doc('mesa', '---\ntitle: x\n---\n<p>')
    assert.deepEqual(lines.slice(0, 3), [[['comment', '---']], [['comment', 'title: x']], [['comment', '---']]])
    assert.deepEqual(lines[3], [['tag', '<p>']])
  })
})

describe('painting', () => {
  // Every type a rule can emit, walked from the grammars' own rules, so a new
  // type cannot ship as a bare span with no color and no class styled.
  t('every token type is a code.css element or a structural class', () => {
    const types = new Set()
    const seen = new Set()
    const walk = (rules) => {
      if (!Array.isArray(rules) || seen.has(rules)) return
      seen.add(rules)
      for (const r of rules) {
        if (r.type) types.add(r.type)
        if (r.inside) types.add(r.inside)
        walk(r.rules?.rules ?? r.rules)
      }
    }
    for (const g of Object.values(G)) walk(g.rules)
    assert.ok(types.size > 15)
    const unstyled = [...types].filter((t) => !ELEMENT[t] && !STRUCTURE.has(t))
    assert.deepEqual(unstyled, [])
  })
})
