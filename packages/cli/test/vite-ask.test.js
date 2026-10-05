// ─── vite-ask.test.js — the browser's "ask Claude to change this" ───────────
//
// The argv is the boundary: the prompt cannot widen what Claude may touch, so
// what is pinned here is that edit mode names one directory, drops every
// settings source an allow rule could ride in on, and denies instead of asking.
// The scope itself was measured against the real CLI when it was written.

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDIT_MAX_HTML, EDIT_RULES, askArgv, editPrompt, readAskEvent, resumeCommand, shareBudget } from '../core/ask-claude.js'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
import { createLedger, lineDiff, locateText, sameOrigin, undoEdits } from '../core/vite-ask.js'

const dir = mkdtempSync(join(tmpdir(), 'fli-vite-ask-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('askArgv — edit', () => {

  test('Edit and Write scoped to one directory, no settings sources, dontAsk, no Bash', () => {
    const argv = askArgv({ edit: '/app/site/' })
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Edit(//app/site/**)')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(argv).toContain('--strict-mcp-config')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(argv.some(a => /^(Bash|Write)/.test(a))).toBe(false)
    expect(argv.filter(a => a.startsWith('Edit('))).toHaveLength(1)
  })

  test('a follow-up resumes by id', () => {
    const id = '5acea7bb-3850-44cf-81dc-97688510acda'
    expect(askArgv({ edit: '/app', session: id }).slice(-2)).toEqual(['--resume', id])
  })

})

describe('editPrompt', () => {

  test('a first pick carries the rules, the change, the page, the source and the HTML', () => {
    const p = editPrompt({ instruction: 'make it bold', picks: [{ loc: 'content/routes/index.mesa:4:3', html: '<h1>Hi</h1>' }], page: 'http://localhost:8690/' })
    expect(p.startsWith(EDIT_RULES)).toBe(true)
    expect(p).toContain('Change: make it bold')
    expect(p).toContain('The page: http://localhost:8690/')
    expect(p).toContain('The element:\n- source: content/routes/index.mesa:4:3')
    expect(p).toContain('<h1>Hi</h1>')
    expect(p).not.toContain(' of 1:')
  })

  test('several picks are numbered, each with its own source', () => {
    const p = editPrompt({ instruction: 'x', picks: [
      { loc: 'content/routes/index.mesa:2:3', html: '<h1>A</h1>' },
      { loc: 'content/parts/Lede.mesa:1:1',   html: '<h2>B</h2>' },
    ] })
    expect(p).toContain('Element 1 of 2:\n- source: content/routes/index.mesa:2:3')
    expect(p).toContain('Element 2 of 2:\n- source: content/parts/Lede.mesa:1:1')
    expect(p.indexOf('<h1>A</h1>')).toBeLessThan(p.indexOf('<h2>B</h2>'))
  })

  test('a follow-up drops the rules, and a long outerHTML is cut and says so', () => {
    const p = editPrompt({ instruction: 'x', picks: [{ html: 'a'.repeat(EDIT_MAX_HTML + 10) }], followUp: true })
    expect(p).not.toContain(EDIT_RULES)
    expect(p).toContain(`first ${EDIT_MAX_HTML} of ${EDIT_MAX_HTML + 10}`)
  })

  test('the page cut the HTML already: the whole size is still what it reports', () => {
    const p = editPrompt({ instruction: 'x', picks: [{ html: 'a'.repeat(EDIT_MAX_HTML), size: 50_000 }] })
    expect(p).toContain(`first ${EDIT_MAX_HTML} of 50000`)
  })

  test('the HTML budget is one for the whole prompt, however many picks', () => {
    const picks = Array.from({ length: 10 }, () => ({ html: 'z'.repeat(EDIT_MAX_HTML) }))
    const p = editPrompt({ instruction: 'x', picks, followUp: true })
    expect((p.match(/z/g) || []).length).toBe(EDIT_MAX_HTML)
  })

  test('no instruction yet: no Change line, the picks still go', () => {
    const p = editPrompt({ picks: [{ loc: '/app/site/a.mesa:3:1', html: '<h1>A</h1>' }], followUp: true })
    expect(p).not.toContain('Change:')
    expect(p).toContain('- source: /app/site/a.mesa:3:1')
  })

})

describe('resumeCommand', () => {

  test('cd to the root the runs were spawned in, then resume by id', () => {
    expect(resumeCommand('/app/site', SESSION)).toBe(`cd /app/site && claude --resume ${SESSION}`)
  })

  test('a root a shell would split or expand is quoted, and only a session id is let in', () => {
    expect(resumeCommand("/a b/it's $HOME", SESSION)).toBe(`cd '/a b/it'\\''s $HOME' && claude --resume ${SESSION}`)
    expect(resumeCommand('/app', `${SESSION}; rm -rf ~`)).toBe(null)
    expect(resumeCommand('/app', null)).toBe(null)
  })

})

describe('shareBudget', () => {

  test('what a short pick leaves over goes to the long ones', () => {
    expect(shareBudget([100, 5000, 5000], 4000)).toEqual([100, 1950, 1950])
  })

  test('nothing is cut when everything fits, and the total is never passed', () => {
    expect(shareBudget([10, 20], 4000)).toEqual([10, 20])
    const cut = shareBudget([3999, 3999, 3999], 4000)
    expect(cut.reduce((a, b) => a + b)).toBeLessThanOrEqual(4000)
  })

})

describe('locateText', () => {

  const MESA = [
    '<script>',
    "  const title = 'Hello'",   // the words inside an expression are not text
    '</script>',
    '',
    '<section title="Hello">',
    '  <h1 id="t">Hello',
    '    world</h1>',
    '  <p>Hello <em>there</em></p>',
    '  <h2>{title}</h2>',
    '  <ul><li>Item</li><li>Item</li></ul>',
    '  <h3>Items</h3>',
    '</section>',
  ].join('\n')
  const at = (o) => locateText(MESA, { ext: 'mesa', next: 'Changed', ...o })
  const swap = (src, r, next) => src.slice(0, r.start) + next + src.slice(r.end)

  test('the element\'s text, wrapped across lines, is found once inside its own tags', () => {
    const r = at({ line: 6, col: 3, tag: 'h1', old: 'Hello world' })
    expect(r.why).toBeUndefined()
    expect(swap(MESA, r, 'Changed')).toContain('<h1 id="t">Changed</h1>')
    expect(MESA.slice(r.from, r.to)).toBe('<h1 id="t">Hello\n    world</h1>')
  })

  test('not in an attribute, not in an expression, not in a script', () => {
    // "Hello" is in the section's title attribute and the script too; only the
    // text runs of the region count.
    const r = at({ line: 5, col: 1, tag: 'section', old: 'Hello world' })
    expect(r.why).toBeUndefined()
  })

  test('interpolated text is refused rather than guessed', () => {
    expect(at({ line: 9, col: 3, tag: 'h2', old: 'Hello' }).why).toMatch(/interpolated/)
  })

  test('text split by inline markup is refused', () => {
    expect(at({ line: 8, col: 3, tag: 'p', old: 'Hello there' }).why).toMatch(/interpolated, or split/)
  })

  test('twice in the region is refused, and a word inside a longer one is not a hit', () => {
    expect(at({ line: 10, col: 3, tag: 'ul', old: 'Item' }).why).toMatch(/2 times/)
    const r = at({ line: 11, col: 3, tag: 'h3', old: 'Items' })
    expect(swap(MESA, r, 'X')).toContain('<h3>X</h3>')
    expect(at({ line: 10, col: 7, tag: 'li', old: 'Item' }).why).toBeUndefined()
  })

  test('new text carrying an expression is the model\'s job; HTML\'s three are written as entities', () => {
    expect(at({ line: 6, col: 3, tag: 'h1', old: 'Hello world', next: 'a {b}' }).why).toMatch(/markup/)
    const r = at({ line: 6, col: 3, tag: 'h1', old: 'Hello world', next: 'Fish & <chips>' })
    expect(swap(MESA, r, r.text)).toContain('<h1 id="t">Fish &amp; &lt;chips&gt;</h1>')
  })

  test('text the source wrote as an entity is found by the character the page shows', () => {
    const src = '<p>Before &amp; after &mdash; done</p>\n'
    const r = locateText(src, { ext: 'mesa', line: 1, col: 1, tag: 'p', old: 'Before & after — done', next: 'Later' })
    expect(swap(src, r, r.text)).toBe('<p>Later</p>\n')
  })

  test('a loc the source no longer matches is refused', () => {
    expect(at({ line: 99, col: 1, tag: 'h1', old: 'Hello' }).why).toMatch(/changed since/)
    expect(at({ line: 4, col: 1, tag: 'h1', old: 'Hello' }).why).toMatch(/not where/)
  })

  test('Markdown: the body is searched, never the frontmatter, and emphasis is not plain text', () => {
    const MD = '---\ntitle: The heading\n---\n\n# The heading\n\nSome *para* text.\n'
    const r = locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: 'New heading' })
    expect(swap(MD, r, 'New heading')).toBe('---\ntitle: The heading\n---\n\n# New heading\n\nSome *para* text.\n')
    expect(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'p', old: 'Some para text.', next: 'x' }).why).toMatch(/split/)
    expect(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: '*bold*' }).why).toMatch(/markup/)
    expect(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: 'a <b>' }).why).toMatch(/markup/)
  })

})

describe('readAskEvent — edits', () => {

  test('an Edit call is reported with its hunk, and a refused result names the call', () => {
    const call = readAskEvent({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/app/a.mesa', old_string: 'a', new_string: 'b' } },
    ] } })
    expect(call).toContainEqual({ type: 'edit', id: 't1', file: '/app/a.mesa', old: 'a', new: 'b', all: false })
    expect(readAskEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }))
      .toEqual([{ type: 'refused', id: 't1' }])
    expect(readAskEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } }))
      .toEqual([{ type: 'landed', id: 't2' }])
  })

  test('a Read and a Write are reported by file, a Write with its content', () => {
    const out = readAskEvent({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/app/a.mesa' } },
      { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/app/b.mesa', content: 'x\n' } },
    ] } })
    expect(out).toContainEqual({ type: 'read', id: 'r', file: '/app/a.mesa' })
    expect(out).toContainEqual({ type: 'write', id: 'w', file: '/app/b.mesa', content: 'x\n' })
    expect(readAskEvent({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'w', content: [{ type: 'text', text: 'File created successfully at: /app/b.mesa' }] },
    ] } })).toEqual([{ type: 'landed', id: 'w', created: true }])
  })

})

describe('undoEdits', () => {

  test('reverses hunks newest first, and leaves a concurrent writer\'s lines alone', () => {
    const f = join(dir, 'a.mesa')
    writeFileSync(f, '<h1>Bye</h1>\n<p>someone else</p>\n<p>two</p>\n')
    const r = undoEdits(dir, [
      { file: f, old: 'Hi', new: 'Hello', all: false },
      { file: f, old: 'Hello', new: 'Bye', all: false },
    ])
    expect(r.undone).toEqual(['a.mesa', 'a.mesa'])
    expect(readFileSync(f, 'utf8')).toBe('<h1>Hi</h1>\n<p>someone else</p>\n<p>two</p>\n')
  })

  test('refuses what it cannot place: gone, ambiguous, replace-all, a deletion, outside the app', () => {
    const f = join(dir, 'b.mesa')
    writeFileSync(f, 'x x\n')
    const r = undoEdits(dir, [
      { file: f, old: 'y', new: 'z', all: false },
      { file: f, old: 'y', new: 'x', all: false },
      { file: f, old: 'y', new: 'x', all: true },
      { file: f, old: 'y', new: '', all: false },
      { file: '/etc/hosts', old: 'y', new: 'x', all: false },
    ])
    expect(r.undone).toEqual([])
    expect(r.skipped.map(s => s.why)).toEqual([
      'outside the app',
      'a deletion leaves nothing to find it by',
      'a replace-all edit has no single hunk to reverse',
      'the changed text now occurs more than once',
      'the change is no longer in the file',
    ])
    expect(readFileSync(f, 'utf8')).toBe('x x\n')
  })

})

describe('createLedger — undo', () => {

  // The order the CLI runs one: the Read, the call, the write, the result.
  let n = 0
  function edit(ledger, file, change, { read = true } = {}) {
    const id = `c${++n}`
    if (read) ledger.see({ type: 'read', id: `r${n}`, file })
    ledger.see({ type: 'edit', id, file, all: false, ...change })
    const src = readFileSync(file, 'utf8')
    writeFileSync(file, change.all ? src.split(change.old).join(change.new) : src.replace(change.old, change.new))
    ledger.result({ type: 'landed', id })
  }
  function write(ledger, file, content) {
    const id = `c${++n}`
    ledger.see({ type: 'write', id, file, content })
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
    ledger.result({ type: 'landed', id })
  }
  const file = (name, text) => { const f = join(dir, name); writeFileSync(f, text); return f }

  test('restores the whole original for the three a hunk cannot place', () => {
    const all = file('all.mesa', '<li>Item</li>\n<li>Item</li>\n')
    const del = file('del.mesa', 'keep\ndrop\nkeep\n')
    const two = file('two.mesa', 'Hi\nHello\n')
    const ledger = createLedger(dir)
    edit(ledger, all, { old: 'Item', new: 'Thing', all: true })
    edit(ledger, del, { old: 'drop', new: '' })
    edit(ledger, two, { old: 'Hi', new: 'Hello' })
    expect(ledger.count).toBe(3)
    const r = ledger.undo()
    expect(r.skipped).toEqual([])
    expect(r.undone).toEqual(['two.mesa', 'del.mesa', 'all.mesa'])
    expect(readFileSync(all, 'utf8')).toBe('<li>Item</li>\n<li>Item</li>\n')
    expect(readFileSync(del, 'utf8')).toBe('keep\ndrop\nkeep\n')
    expect(readFileSync(two, 'utf8')).toBe('Hi\nHello\n')
  })

  test('a file another writer touched since falls back to hunks, and keeps their line', () => {
    const f = file('shared.mesa', '<h1>Hi</h1>\n<p>one</p>\n')
    const ledger = createLedger(dir)
    edit(ledger, f, { old: 'Hi', new: 'Bye' })
    writeFileSync(f, readFileSync(f, 'utf8') + '<p>theirs</p>\n')
    expect(ledger.undo().undone).toEqual(['shared.mesa'])
    expect(readFileSync(f, 'utf8')).toBe('<h1>Hi</h1>\n<p>one</p>\n<p>theirs</p>\n')
  })

  test('a replace-all another writer touched since is left exactly as they left it', () => {
    const f = file('shared-all.mesa', 'a a\n')
    const ledger = createLedger(dir)
    edit(ledger, f, { old: 'a', new: 'b', all: true })
    writeFileSync(f, 'b b\nmine\n')
    const r = ledger.undo()
    expect(r.undone).toEqual([])
    expect(r.skipped[0].why).toBe('a replace-all edit has no single hunk to reverse')
    expect(readFileSync(f, 'utf8')).toBe('b b\nmine\n')
  })

  // Restoring that copy would put back the edited text; the hunk puts back the original.
  test('a copy taken after the write is not trusted', () => {
    const f = file('late.mesa', 'x\n')
    const ledger = createLedger(dir)
    writeFileSync(f, 'y\n')
    ledger.see({ type: 'edit', id: 'late', file: f, old: 'x', new: 'y', all: false })
    ledger.result({ type: 'landed', id: 'late' })
    expect(ledger.undo().undone).toEqual(['late.mesa'])
    expect(readFileSync(f, 'utf8')).toBe('x\n')
  })

  test('a new file is removed with the directories it made, unless it changed since', () => {
    const made = join(dir, 'sections', 'deep', 'Note.mesa')
    const kept = join(dir, 'Kept.mesa')
    const ledger = createLedger(dir)
    write(ledger, made, '<p>note</p>\n')
    write(ledger, kept, '<p>kept</p>\n')
    writeFileSync(kept, '<p>kept, then edited</p>\n')
    const r = ledger.undo()
    expect(r.undone).toEqual(['sections/deep/Note.mesa (new, removed)'])
    expect(r.skipped).toEqual([{ file: 'Kept.mesa', why: 'it is new from this run, and has changed since' }])
    expect(existsSync(join(dir, 'sections'))).toBe(false)
    expect(readFileSync(kept, 'utf8')).toBe('<p>kept, then edited</p>\n')
  })

  test('a new file the look at the call saw already written is still known new by its result', () => {
    const f = join(dir, 'Raced.mesa')
    const ledger = createLedger(dir)
    writeFileSync(f, 'x\n')
    ledger.see({ type: 'write', id: 'raced', file: f, content: 'x\n' })
    ledger.result({ type: 'landed', id: 'raced', created: true })
    expect(ledger.undo().undone).toEqual(['Raced.mesa (new, removed)'])
    expect(existsSync(f)).toBe(false)
  })

  test('a refused call is not undone, and a file outside the app is not tracked', () => {
    const f = file('refused.mesa', 'same\n')
    const ledger = createLedger(dir)
    ledger.see({ type: 'edit', id: 'no', file: f, old: 'same', new: 'other', all: false })
    ledger.result({ type: 'refused', id: 'no' })
    ledger.see({ type: 'write', id: 'out', file: '/etc/x', content: 'x' })
    ledger.result({ type: 'landed', id: 'out' })
    expect(ledger.count).toBe(0)
    expect(ledger.undo()).toEqual({ undone: [], skipped: [] })
  })

})

describe('createLedger — diff', () => {

  test('each changed file, removed and added lines, a new file all added', () => {
    const f = join(dir, 'diff.mesa')
    writeFileSync(f, '<h1>Hi</h1>\n<p>one</p>\n')
    const ledger = createLedger(dir)
    ledger.see({ type: 'read', id: 'r', file: f })
    ledger.see({ type: 'edit', id: 'e', file: f, old: 'Hi', new: 'Bye', all: false })
    writeFileSync(f, '<h1>Bye</h1>\n<p>one</p>\n')
    ledger.result({ type: 'landed', id: 'e' })
    const nf = join(dir, 'New.mesa')
    ledger.see({ type: 'write', id: 'w', file: nf, content: 'a\nb\n' })
    writeFileSync(nf, 'a\nb\n')
    ledger.result({ type: 'landed', id: 'w' })
    expect(ledger.diff()).toEqual([
      { file: 'diff.mesa', created: false, lines: [['-', '<h1>Hi</h1>'], ['+', '<h1>Bye</h1>'], [' ', '<p>one</p>']] },
      { file: 'New.mesa',  created: true,  lines: [['+', 'a'], ['+', 'b']] },
    ])
  })

  test('unchanged runs past the context fold to a count', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    const after  = before.replace('l10', 'L10')
    expect(lineDiff(before, after, 1)).toEqual([
      ['…', '9 unchanged line(s)'], [' ', 'l9'], ['-', 'l10'], ['+', 'L10'], [' ', 'l11'], ['…', '8 unchanged line(s)'],
    ])
  })

})

describe('sameOrigin', () => {

  const req = (headers) => ({ headers: { host: 'localhost:8690', 'content-type': 'application/json', ...headers } })

  test('a page this server served, posting JSON', () => {
    expect(sameOrigin(req({ origin: 'http://localhost:8690', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  test('another origin, no origin, a cross-site fetch, or a form body is refused', () => {
    expect(sameOrigin(req({ origin: 'http://evil.test' }))).toBe(false)
    expect(sameOrigin(req({}))).toBe(false)
    expect(sameOrigin(req({ origin: 'http://localhost:8690', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(sameOrigin(req({ origin: 'http://localhost:8690', 'content-type': 'text/plain' }))).toBe(false)
  })

})
