// ─── vite-ask.test.js — the browser's "ask Claude to change this" ───────────
//
// The argv is the boundary: the prompt cannot widen what Claude may touch, so
// what is pinned here is that edit mode names one directory, drops every
// settings source an allow rule could ride in on, and denies instead of asking.
// The scope itself was measured against the real CLI when it was written.

import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ASK_EFFORT, EDIT_KINDS, editEffort, EDIT_MAX_HTML, PANEL_EFFORTS, EDIT_RULES, EDIT_SCOPES, askArgv, editPrompt, readAskEvent, resumeCommand, shareBudget } from '../core/ask-claude.js'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
import { markerPath } from '../core/preview.js'
import { admitCaller, askPlugin, createLedger, dirtyPaths, lineDiff, locateText, readAdmit, readImages, sameOrigin, submission, undoEdits } from '../core/vite-ask.js'

const dir = mkdtempSync(join(tmpdir(), 'fli-vite-ask-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('askArgv — edit', () => {

  test('Edit and Write scoped to one path, no settings sources, dontAsk, no Bash', () => {
    const argv = askArgv({ edit: '/app/site/' })
    const at = argv.indexOf('--allowedTools')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write')
    expect(argv.slice(at + 1, at + 5)).toEqual(['Edit(//app/site)', 'Edit(//app/site/**)', 'Read(//app/site)', 'Read(//app/site/**)'])
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(argv).toContain('--strict-mcp-config')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(argv.some(a => /^(Bash|Write)/.test(a))).toBe(false)
    expect(argv.filter(a => a.startsWith('Edit('))).toHaveLength(2)
  })

  test('a file not written yet is a path like a directory: the exact rule is the one that applies', () => {
    const argv = askArgv({ edit: '/repo/IDEAS/new-plan.md', reads: [] })
    expect(argv.filter(a => a.startsWith('Edit('))).toEqual(['Edit(//repo/IDEAS/new-plan.md)', 'Edit(//repo/IDEAS/new-plan.md/**)'])
  })

  test('the path it may edit it may also read: Edit refuses a file it has not read, and one outside the working directory is not readable', () => {
    const argv = askArgv({ edit: '/app/PLAN.md' })
    expect(argv.filter(a => a.startsWith('Read('))).toEqual(['Read(//app/PLAN.md)', 'Read(//app/PLAN.md/**)'])
  })

  test('a follow-up resumes by id', () => {
    const id = '5acea7bb-3850-44cf-81dc-97688510acda'
    expect(askArgv({ edit: '/app', session: id }).slice(-2)).toEqual(['--resume', id])
  })

  test('each read directory is a Read rule beside the Edit rules, and grants no edit', () => {
    const argv = askArgv({ edit: '/app/web', reads: ['/repo/packages/css/', '/app/db'] })
    const at = argv.indexOf('--allowedTools')
    expect(argv.slice(at + 5, at + 7)).toEqual(['Read(//repo/packages/css/**)', 'Read(//app/db/**)'])
    expect(argv.filter(a => a.startsWith('Edit('))).toHaveLength(2)
  })

})

describe('editPrompt', () => {

  const guides = [
    { pkg: 'css',  file: '/r/css/AGENTS.md',  about: 'the styling language' },
    { pkg: 'mesa', file: '/r/mesa/AGENTS.md', about: 'the .mesa language' },
  ]

  test('a first ask lists every guide; a kind names the ones to read first', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'style' })
    expect(p).toContain('- /r/css/AGENTS.md — the styling language\n- /r/mesa/AGENTS.md — the .mesa language')
    expect(p).toContain('Before this change, read: /r/css/AGENTS.md')
    expect(p).not.toContain('read: /r/css/AGENTS.md, /r/mesa')
    expect(editPrompt({ instruction: 'x', guides, kind: 'layout' })).toContain('Before this change, read: /r/css/AGENTS.md, /r/mesa/AGENTS.md')
    expect(editPrompt({ instruction: 'x', guides, kind: 'text' })).not.toContain('Before this change')
  })

  test('a follow-up does not list the guides again, and still names a kind\'s', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'behavior', followUp: true })
    expect(p).not.toContain('one guide per package')
    expect(p).toContain('Before this change, read: /r/mesa/AGENTS.md')
  })

  test('a prompt for another agent lists the guides and leaves the panel\'s rules out', () => {
    const p = editPrompt({ instruction: 'x', guides, kind: 'style', rules: false })
    expect(p).not.toContain(EDIT_RULES)
    expect(p).toContain('- /r/css/AGENTS.md — the styling language')
    expect(p).toContain('Before this change, read: /r/css/AGENTS.md')
  })

  test('a kind runs at its own effort unless one is asked for, and every kind\'s is one the panel offers', () => {
    expect(editEffort('style')).toBe('low')
    expect(editEffort('behavior')).toBe('high')
    expect(editEffort('style', 'max')).toBe('max')
    expect(editEffort(null)).toBe(ASK_EFFORT)
    expect(editEffort('toString')).toBe(ASK_EFFORT)
    for (const k of Object.values(EDIT_KINDS)) expect(PANEL_EFFORTS).toContain(k.effort)
  })

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

  test('a chip is its sentence, and a key that is not one adds nothing', () => {
    const p = editPrompt({ instruction: 'x', kind: 'style', scope: 'every', followUp: true })
    expect(p).toContain(`What to change: ${EDIT_KINDS.style.says}`)
    expect(p).toContain(`How far: ${EDIT_SCOPES.every}`)
    const q = editPrompt({ instruction: 'x', kind: 'toString', scope: '__proto__', followUp: true })
    expect(q).toBe('Change: x')
  })

  test('what the source said about a pick goes under it, and the resources once after all of them', () => {
    const p = editPrompt({ instruction: 'x', followUp: true, data: ['`pins` from src/resources/Pin.mesa — model Pin at ../db/schema.lite:1: id, name'], picks: [{
      loc: 'src/routes/_module.mesa:9:7', html: '<div></div>', repeats: 12,
      loops: [{ head: 'pins as p (p.id)', at: 'src/routes/_module.mesa:4' }],
      files: ['src/routes/workbench/index.mesa:30'],
      inner: [{ head: 'p.files as f', at: 'src/routes/workbench/index.mesa:41' }],
    }] })
    expect(p).toContain([
      '- source: src/routes/_module.mesa:9:7',
      '- drawn 12 times on the page from that source',
      '- inside: {#each pins as p (p.id)} at src/routes/_module.mesa:4',
      '- written in, under it: src/routes/workbench/index.mesa:30',
      '- loops under it: {#each p.files as f} at src/routes/workbench/index.mesa:41',
    ].join('\n'))
    expect(p.endsWith('the resources their files import:\n- `pins` from src/resources/Pin.mesa — model Pin at ../db/schema.lite:1: id, name')).toBe(true)
  })

  test('no instruction yet: no Change line, the picks still go', () => {
    const p = editPrompt({ picks: [{ loc: '/app/site/a.mesa:3:1', html: '<h1>A</h1>' }], followUp: true })
    expect(p).not.toContain('Change:')
    expect(p).toContain('- source: /app/site/a.mesa:3:1')
  })

})

describe('readImages', () => {

  test('none is none, and a good list comes back as type and data only', () => {
    expect(readImages(undefined)).toEqual([])
    expect(readImages([{ type: 'image/png', data: 'iVBORw0KGgo=', thumb: 'x' }])).toEqual([{ type: 'image/png', data: 'iVBORw0KGgo=' }])
  })

  test('what the API would refuse is refused here, by name', () => {
    expect(readImages('x').error).toBe('images is a list')
    expect(readImages(Array(6).fill({ type: 'image/png', data: 'AA==' })).error).toContain('at most 5')
    expect(readImages([{ type: 'image/svg+xml', data: 'AA==' }]).error).toContain('image/svg+xml')
    expect(readImages([{ type: 'image/png', data: 'data:image/png;base64,AA==' }]).error).toContain('not base64')
    expect(readImages([{ type: 'image/png', data: 'A'.repeat(5 * 1024 * 1024 + 4) }]).error).toContain('over 5MB')
  })

  test('the prompt says images follow, and says nothing when there are none', () => {
    expect(editPrompt({ instruction: 'x', followUp: true, images: 2 })).toContain('I pasted 2 images with this; they come after this text.')
    expect(editPrompt({ instruction: 'x', followUp: true, images: 1 })).toContain('I pasted an image with this; it comes after this text.')
    expect(editPrompt({ instruction: 'x', followUp: true })).not.toContain('pasted')
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

  test('a streamed reply is deltas, and a block starting says what the run is doing', () => {
    expect(askArgv({ edit: '/app' })).toContain('--include-partial-messages')
    expect(askArgv({})).not.toContain('--include-partial-messages')
    const stream = e => ({ type: 'stream_event', event: e, parent_tool_use_id: null })
    expect(readAskEvent({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([{ type: 'status', text: 'thinking' }])
    expect(readAskEvent(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Made it ' } }))).toEqual([{ type: 'delta', text: 'Made it ' }])
    expect(readAskEvent(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))).toEqual([{ type: 'status', text: 'thinking' }])
    expect(readAskEvent(stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Edit', input: {} } }))).toEqual([{ type: 'status', text: 'editing' }])
    expect(readAskEvent(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } }))).toEqual([])
    expect(readAskEvent({ ...stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }), parent_tool_use_id: 't' })).toEqual([])
    expect(readAskEvent(stream({ type: 'message_stop' }))).toEqual([])
  })

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

// ─── who may ask, and Submit ─────────────────────────────────────────────────

// A stand-in for the app's API: `account/me` answers a standing per token, the
// way auth's account service does when the app passes `services: { standingLevel }`.
// `perTenant` has a `level` and no standing, which is not the person's answer.
const API_ANSWERS = {
  admin:      { userId: 'u1', standing: 5 },
  member:     { userId: 'u2', standing: 4 },
  unlevelled: { userId: 'u3' },
  perTenant:  { userId: 'u4', level: 5 },
}
const api = Bun.serve({
  port: 0,
  fetch(req) {
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (token === 'broken') return new Response('no', { status: 500 })
    const me = API_ANSWERS[token]
    return me ? Response.json(me) : Response.json({ error: 'no session' }, { status: 401 })
  },
})
afterAll(() => api.stop(true))
const ME = `http://localhost:${api.port}/account/me`
const bearer = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('readAdmit', () => {

  test('unset is a localhost dev server: no second rule', () => {
    expect(readAdmit({})).toBe(null)
    expect(readAdmit({ ASK_ADMIT_URL: '  ' })).toBe(null)
  })

  test('the level is a name from the gate, in any case; anything else is no level', () => {
    expect(readAdmit({ ASK_ADMIT_URL: ME, ASK_ADMIT_LEVEL: 'administrator' })).toEqual({ url: ME, name: 'ADMINISTRATOR', level: 5 })
    expect(readAdmit({ ASK_ADMIT_URL: ME, ASK_ADMIT_LEVEL: '5' }).level).toBe(null)
    expect(readAdmit({ ASK_ADMIT_URL: ME }).level).toBe(null)
  })

})

describe('admitCaller', () => {

  const admit = readAdmit({ ASK_ADMIT_URL: ME, ASK_ADMIT_LEVEL: 'ADMINISTRATOR' })

  test('no rule admits everyone the same-origin check did', async () => {
    expect(await admitCaller(bearer(null), null)).toBe(null)
  })

  test('a caller at the level is admitted', async () => {
    expect(await admitCaller(bearer('admin'), admit)).toBe(null)
  })

  test('no token, a token the API does not know, and one below the level are refused', async () => {
    expect(await admitCaller(bearer(null), admit)).toMatchObject({ status: 401, error: expect.stringContaining('sign in') })
    expect(await admitCaller(bearer('stranger'), admit)).toMatchObject({ status: 401 })
    expect(await admitCaller(bearer('member'), admit)).toEqual({ status: 403, error: 'asking here takes ADMINISTRATOR' })
  })

  test('an answer with no standing is refused, not guessed at — a level is not one', async () => {
    expect(await admitCaller(bearer('unlevelled'), admit)).toMatchObject({ status: 502, error: expect.stringContaining('services: { standingLevel }') })
    expect(await admitCaller(bearer('perTenant'), admit)).toMatchObject({ status: 502, error: expect.stringContaining('no standing') })
    expect(await admitCaller(bearer('broken'), admit)).toMatchObject({ status: 502 })
  })

  test('a rule naming no level refuses every caller, admin included', async () => {
    const r = await admitCaller(bearer('admin'), readAdmit({ ASK_ADMIT_URL: ME, ASK_ADMIT_LEVEL: 'boss' }))
    expect(r).toMatchObject({ status: 500, error: expect.stringContaining("'BOSS', not a level") })
  })

})

describe('dirtyPaths', () => {

  test('each entry, with a rename naming its source too', () => {
    expect(dirtyPaths(' M web/a.mesa\0?? web/new/b.mesa\0R  web/c.mesa\0web/old.mesa\0')).toEqual(['web/a.mesa', 'web/new/b.mesa', 'web/c.mesa', 'web/old.mesa'])
    expect(dirtyPaths('')).toEqual([])
  })

})

describe('submission', () => {

  test('the first ask titles it, and every ask is a line with its session', () => {
    const s = submission({ preview: 'https://p.example', asks: [
      { instruction: 'make the heading bigger', session: SESSION },
      { instruction: 'Text: “Hi” → “Hello”', session: null },
    ] })
    expect(s.title).toBe('make the heading bigger (+1 more)')
    expect(s.body).toBe(`Asked for on the preview at https://p.example, through the ask panel.\n\n- make the heading bigger (session \`${SESSION}\`)\n- Text: “Hi” → “Hello”`)
  })

})

describe('the served client', () => {

  test('runs as served, with the token key the plugin was handed', () => {
    const src = askPlugin({ tokenKey: 'basecamp_token' }).load('\0@frontierjs/cli/ask-client')
    const kinds = Object.fromEntries(Object.entries(EDIT_KINDS).map(([k, v]) => [k, v.effort]))
    expect(src.split('\n')[0]).toBe(`const ASK = ${JSON.stringify({ tokenKey: 'basecamp_token', efforts: PANEL_EFFORTS, effort: ASK_EFFORT, kinds })}`)
    // No window here, so the module returns at its first line — after the
    // prepended one has run against whatever follows it.
    expect(() => new Function(src)()).not.toThrow()
  })

})

describe('the routes — admission and Submit, over HTTP against a real repo', () => {

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const work = join(dir, 'submit')
  const origin = join(dir, 'origin.git')
  const app = join(work, 'web')
  const ghLog = join(dir, 'gh.log')
  const gh = join(dir, 'gh')
  let base, servers = []

  // A stand-in gh: records its argv, has no PR open until one is created.
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${ghLog}\nif [ "$2" = view ]; then [ -f ${ghLog}.made ] && echo https://github.test/o/r/pull/7 && exit 0; exit 1; fi\ntouch ${ghLog}.made\necho Creating pull request\necho https://github.test/o/r/pull/7\n`)
  chmodSync(gh, 0o755)

  async function serve(opts) {
    const p = askPlugin({ bin: '/nonexistent/claude', gh, ...opts })
    p.configResolved({ root: app })
    let handler
    p.configureServer({ middlewares: { use(fn) { handler = fn } } })
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end() }))
    await new Promise(ok => server.listen(0, ok))
    servers.push(server)
    const at = `http://localhost:${server.address().port}`
    return (path, body = {}, token) => fetch(at + path, {
      method: 'POST',
      headers: { origin: at, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, ...(await r.json()) }))
  }

  beforeAll(() => {
    mkdirSync(app, { recursive: true })
    git(dir, 'init', '-q', '--bare', origin)
    git(dir, 'init', '-q', '-b', 'main', work)
    git(work, 'config', 'user.email', 'test@example.test')
    git(work, 'config', 'user.name', 'Test')
    writeFileSync(join(app, 'Page.mesa'), '<h1>Welcome back</h1>\n<p>Other</p>\n')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'base')
    git(work, 'remote', 'add', 'origin', origin)
    base = git(work, 'rev-parse', 'HEAD')
  })
  afterAll(() => { for (const s of servers) s.close() })

  test('with a rule, every route wants a token at the level', async () => {
    const post = await serve({ admit: readAdmit({ ASK_ADMIT_URL: ME, ASK_ADMIT_LEVEL: 'ADMINISTRATOR' }) })
    expect(await post('/__fjs/ask/status')).toMatchObject({ status: 401 })
    expect(await post('/__fjs/ask/submit', {}, 'member')).toMatchObject({ status: 403 })
    expect(await post('/__fjs/ask/text', {}, 'member')).toMatchObject({ status: 403 })
    expect(await post('/__fjs/ask/status', {}, 'admin')).toMatchObject({ status: 200, branch: 'main' })
  })

  test('off a Workbench branch Submit is not offered, and refused if asked', async () => {
    const post = await serve({ admit: null })
    expect(await post('/__fjs/ask/status')).toEqual({ status: 200, branch: 'main', submit: false })
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 409, error: expect.stringContaining('not a Workbench branch') })
  })

  test('on wb/*, Submit commits the panel\'s change, pushes, and opens the PR — and refuses another writer\'s file', async () => {
    git(work, 'checkout', '-q', '-b', 'wb/trial')
    const post = await serve({ admit: null })
    expect(await post('/__fjs/ask/status')).toEqual({ status: 200, branch: 'wb/trial', submit: true })
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 400, error: expect.stringContaining('nothing to submit') })

    const edit = await post('/__fjs/ask/text', { loc: 'Page.mesa:1:1', tag: 'h1', old: 'Welcome back', new: 'Hello again' })
    expect(edit.status).toBe(200)

    writeFileSync(join(work, 'README.md'), 'someone else\n')
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 409, files: ['README.md'] })
    rmSync(join(work, 'README.md'))

    const done = await post('/__fjs/ask/submit')
    expect(done).toEqual({ status: 200, pr: 'https://github.test/o/r/pull/7', created: true, files: ['web/Page.mesa'] })
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(base)
    expect(git(work, 'log', '-1', '--format=%s')).toBe('Text: “Welcome back” → “Hello again”')
    expect(git(work, 'status', '--porcelain')).toBe('')
    expect(git(origin, 'rev-parse', 'wb/trial')).toBe(git(work, 'rev-parse', 'HEAD'))
    const calls = readFileSync(ghLog, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('pr view wb/trial --json url --jq .url')
    expect(calls[1]).toStartWith('pr create --head wb/trial --title Text: “Welcome back” → “Hello again” --body Asked for on the preview at http://localhost:')

    // A second change goes onto the open PR rather than opening another.
    await post('/__fjs/ask/text', { loc: 'Page.mesa:2:1', tag: 'p', old: 'Other', new: 'Another' })
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 200, created: false, files: ['web/Page.mesa'] })
    expect(git(origin, 'rev-parse', 'wb/trial')).toBe(git(work, 'rev-parse', 'HEAD'))
  })

  test('an ask\'s images reach claude on stdin, past the plain body limit, and a bad one starts nothing', async () => {
    const seenAt = join(dir, 'claude-seen.json')
    const bin = join(dir, 'claude-images')
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(seenAt)}, JSON.stringify({ argv: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }))
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
`)
    chmodSync(bin, 0o755)
    const post = await serve({ admit: null, bin })
    expect(await post('/__fjs/ask', { instruction: 'like this', images: [{ type: 'image/bmp', data: 'AA==' }] })).toMatchObject({ status: 400 })
    expect(existsSync(seenAt)).toBe(false)

    const big = 'A'.repeat(400 * 1024)
    const at = servers.at(-1).address().port
    const res = await fetch(`http://localhost:${at}/__fjs/ask`, {
      method: 'POST',
      headers: { origin: `http://localhost:${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'like this', images: [{ type: 'image/png', data: big }] }),
    })
    expect(res.status).toBe(200)
    expect((await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l).type)).toEqual(['run', 'result'])
    const seen = JSON.parse(readFileSync(seenAt, 'utf8'))
    expect(seen.argv).toContain('--input-format')
    const content = JSON.parse(seen.input).message.content
    expect(content[0].text).toContain('I pasted an image with this')
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } })
  })

  test('the panel\'s effort reaches claude, and one it does not name is refused', async () => {
    const seenAt = join(dir, 'claude-effort.json')
    const bin = join(dir, 'claude-effort')
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(seenAt)}, JSON.stringify({ argv: process.argv.slice(2) }))
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
`)
    chmodSync(bin, 0o755)
    const post = await serve({ admit: null, bin })
    await post('/__fjs/ask', { instruction: 'think less', effort: 'low' }).catch(() => {})
    let argv = JSON.parse(readFileSync(seenAt, 'utf8')).argv
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low')
    rmSync(seenAt)
    await post('/__fjs/ask', { instruction: 'no effort named' }).catch(() => {})
    argv = JSON.parse(readFileSync(seenAt, 'utf8')).argv
    expect(argv[argv.indexOf('--effort') + 1]).toBe(ASK_EFFORT)
    rmSync(seenAt)
    await post('/__fjs/ask', { instruction: 'bluer', kind: 'style' }).catch(() => {})
    argv = JSON.parse(readFileSync(seenAt, 'utf8')).argv
    expect(argv[argv.indexOf('--effort') + 1]).toBe(EDIT_KINDS.style.effort)
    rmSync(seenAt)
    await post('/__fjs/ask', { instruction: 'bluer, harder', kind: 'style', effort: 'max' }).catch(() => {})
    argv = JSON.parse(readFileSync(seenAt, 'utf8')).argv
    expect(argv[argv.indexOf('--effort') + 1]).toBe('max')
    rmSync(seenAt)
    await post('/__fjs/ask', { instruction: 'off', effort: 'none' }).catch(() => {})
    expect(existsSync(seenAt)).toBe(false)
  })

  test('a run can be undone from its result, before claude has exited', async () => {
    const bin = join(dir, 'claude-linger')
    writeFileSync(bin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
setTimeout(() => {}, 1500)
`)
    chmodSync(bin, 0o755)
    const post = await serve({ admit: null, bin })
    const at = servers.at(-1).address().port
    const res = await fetch(`http://localhost:${at}/__fjs/ask`, {
      method: 'POST',
      headers: { origin: `http://localhost:${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'and back' }),
    })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    while (!text.includes('"result"')) text += (await reader.read()).value
    const run = JSON.parse(text.split('\n')[0]).id
    expect(await post('/__fjs/ask/undo', { run })).toMatchObject({ status: 200 })
    while (!(await reader.read()).done) {}
  })

  test('a tool line names an app file from the Vite root, not from /', async () => {
    const bin = join(dir, 'claude-tool')
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: join(app, 'Page.mesa') } }] } }
    writeFileSync(bin, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(call))} + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
`)
    chmodSync(bin, 0o755)
    await serve({ admit: null, bin })
    const at = servers.at(-1).address().port
    const res = await fetch(`http://localhost:${at}/__fjs/ask`, {
      method: 'POST',
      headers: { origin: `http://localhost:${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'read it' }),
    })
    const events = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(events.find(e => e.type === 'tool')).toEqual({ type: 'tool', text: 'Read Page.mesa' })
  })

  test('an undone change is nobody\'s to submit', async () => {
    const post = await serve({ admit: null })
    const edit = await post('/__fjs/ask/text', { loc: 'Page.mesa:1:1', tag: 'h1', old: 'Hello again', new: 'Hi' })
    await post('/__fjs/ask/undo', { run: edit.run })
    expect(git(work, 'status', '--porcelain')).toBe('')
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 400 })
  })

  test('in a preview worktree, Submit refuses a branch that changes more than the Vite root, and names its base', async () => {
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'fetch', '-q', 'origin')
    git(work, 'remote', 'set-head', 'origin', 'main')
    writeFileSync(markerPath(work), '')
    const post = await serve({ admit: null })

    mkdirSync(join(work, 'db'))
    writeFileSync(join(work, 'db', 'schema.lite'), 'model Lead { id Int @id }\n')
    git(work, 'add', 'db')
    git(work, 'commit', '-q', '-m', 'not the panel\'s')
    await post('/__fjs/ask/text', { loc: 'Page.mesa:1:1', tag: 'h1', old: 'Hello again', new: 'Hi' })
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 409, error: expect.stringContaining('origin/main'), files: ['db/schema.lite'] })

    git(work, 'rm', '-q', '-r', 'db')
    git(work, 'commit', '-q', '-m', 'take it off')
    rmSync(`${ghLog}.made`)
    expect(await post('/__fjs/ask/submit')).toMatchObject({ status: 200, created: true, files: ['web/Page.mesa'] })
    expect(readFileSync(ghLog, 'utf8')).toContain('pr create --head wb/trial --base main --title Text: “Hello again” → “Hi”')
  })

  test('a handoff carries the chips and what the source says, and a chip the server does not know is refused', async () => {
    const post = await serve({ admit: null })
    writeFileSync(join(app, 'List.mesa'), '<ul>\n  {#each items as it}\n    <li>{it}</li>\n  {/each}\n</ul>\n')
    try {
      const r = await post('/__fjs/ask/handoff', { instruction: 'smaller', kind: 'layout', scope: 'every', picks: [{ loc: 'List.mesa:3:5', html: '<li>a</li>', repeats: 3, inner: ['../x.mesa:1:1', 'List.mesa:3:5'] }] })
      expect(r.status).toBe(200)
      expect(r.text).toContain(`How far: ${EDIT_SCOPES.every}`)
      expect(r.text).toContain(`- inside: {#each items as it} at ${join(app, 'List.mesa')}:2`)
      expect(r.text).toContain('- drawn 3 times')
      expect(r.text).not.toContain('x.mesa')
      expect(r.text).not.toContain(EDIT_RULES)
      expect(await post('/__fjs/ask/handoff', { instruction: 'x', kind: 'rewrite' })).toMatchObject({ status: 400, error: 'no such kind of change: rewrite' })
      expect(await post('/__fjs/ask', { instruction: 'x', scope: 'site' })).toMatchObject({ status: 400, error: 'no such scope: site' })
    } finally { rmSync(join(app, 'List.mesa')) }
  })

  test('Make a plan writes PLAN.md at the app root in a fresh session, names it from the checkout, and undoes like an ask', async () => {
    const seenAt = join(dir, 'claude-plan.json')
    const bin = join(dir, 'claude-plan')
    // A stand-in that writes the plan where its Edit rule points, reporting
    // the call and its result the way the CLI does.
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
const file = argv.find(a => a.startsWith('Edit(/') && !a.endsWith('/**)')).slice(6, -1)
fs.writeFileSync(${JSON.stringify(seenAt)}, JSON.stringify({ argv, input: fs.readFileSync(0, 'utf8') }))
const say = e => process.stdout.write(JSON.stringify(e) + '\\n')
say({ type: 'system', subtype: 'init', session_id: '${SESSION}' })
const content = '# Plan\\n\\n### Phase 0 — Groundwork\\n\\n- [ ] 0.1 Read\\n'
say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: file, content } }] } })
fs.writeFileSync(file, content)
say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'File created successfully at: ' + file }] } })
say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5 })
`)
    chmodSync(bin, 0o755)
    // An app root above the Vite root, as an app's web/ sits beside its db/.
    mkdirSync(join(work, 'db'), { recursive: true })
    writeFileSync(join(work, 'db', 'schema.lite'), 'model Lead { id Int @id }\n')
    const plan = join(work, 'PLAN.md')
    try {
      const post = await serve({ admit: null, bin })
      expect(await post('/__fjs/ask/plan', { goal: '  ' })).toMatchObject({ status: 400, error: 'say what the plan is for' })
      expect(existsSync(seenAt)).toBe(false)

      const at = servers.at(-1).address().port
      const res = await fetch(`http://localhost:${at}/__fjs/ask/plan`, {
        method: 'POST',
        headers: { origin: `http://localhost:${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'a leads export', page: 'http://localhost/leads', session: SESSION }),
      })
      const events = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
      expect(events.map(e => e.type)).toEqual(['run', 'tool', 'diff', 'plan', 'result'])
      expect(events.find(e => e.type === 'plan')).toEqual({ type: 'plan', path: 'PLAN.md' })
      expect(events.find(e => e.type === 'diff').files[0]).toMatchObject({ file: 'PLAN.md', created: true })
      expect(readFileSync(plan, 'utf8')).toContain('### Phase 0')

      const seen = JSON.parse(readFileSync(seenAt, 'utf8'))
      expect(seen.argv.filter(a => a.startsWith('Edit('))).toEqual([`Edit(/${plan})`, `Edit(/${plan}/**)`])
      expect(seen.argv).toContain(`Read(/${join(work, 'db')}/**)`)
      expect(seen.argv).not.toContain(`Read(/${work}/**)`)
      expect(seen.argv).not.toContain('--resume')
      expect(seen.input).toContain(`Write a plan at \`${plan}\``)
      expect(seen.input).toContain('Asked from the page: http://localhost/leads')
      expect(seen.input).toContain('The goal:\n\na leads export')

      // A plan is the Workbench's to commit, never Submit's: off a preview,
      // Submit names it as a file the panel did not change.
      rmSync(markerPath(work))
      const refused = await post('/__fjs/ask/submit')
      writeFileSync(markerPath(work), '')
      expect(refused).toMatchObject({ status: 409, error: expect.stringContaining('this panel did not change') })
      expect(refused.files).toContain('PLAN.md')
      const run = events[0].id
      expect(await post('/__fjs/ask/undo', { run })).toMatchObject({ status: 200, undone: ['PLAN.md (new, removed)'] })
      expect(existsSync(plan)).toBe(false)
    } finally {
      rmSync(join(work, 'db'), { recursive: true, force: true })
      rmSync(plan, { force: true })
    }
  })

})

// ─── the plan prompts ─────────────────────────────────────────────────────────
// Each guardrail is a sentence the prompt must keep: losing *do only this step*
// runs the plan in one session, losing *commit nothing* commits for the owner.

import { buildPlanPrompt, stepPrompt, nextHandoff, HANDOFF_MAX, PLAN_READ_APP, PLAN_READ_REPO } from '../core/ask-claude.js'

describe('plan prompts', () => {
  const step  = { id: '2.2', title: 'Rotate and flip', box: 'open', phase: '2' }
  const phase = { n: '2', title: 'Writes to pixels', doneWhen: 'the drive is green' }

  test('buildPlanPrompt names the one path, forbids building, and states the shape', () => {
    const p = buildPlanPrompt({ goal: 'crop images', path: 'IDEAS/crop.md', today: '2026-10-13' })
    expect(p).toContain('Write a plan at `IDEAS/crop.md`')
    expect(p).toContain('Build nothing, edit no source file')
    expect(p).toContain('counting from 0')
    expect(p).toContain('`Done when:`')
    expect(p).toContain('- **Recommend A** — why')
    expect(p).toContain('Do not answer them')
    expect(p).toContain('The goal:\n\ncrop images')
    expect(p).toContain('dated:` today')
    expect(p).not.toContain('one guide per package')
    expect(p).not.toContain('Asked from the page')
    expect(p).toContain(PLAN_READ_REPO)
    expect(p).not.toContain(PLAN_READ_APP)
  })

  test('from the ask panel it carries the guides an app reads, and the page', () => {
    const guides = [{ pkg: 'sierra', file: '/r/sierra/AGENTS.md', about: 'routes and resources' }]
    const p = buildPlanPrompt({ goal: 'export', path: '/app/PLAN.md', page: 'http://localhost:8010/leads', guides })
    expect(p).toContain('one guide per package')
    expect(p).toContain('- /r/sierra/AGENTS.md — routes and resources')
    expect(p).toContain('Asked from the page: http://localhost:8010/leads')
    expect(p.indexOf('Asked from the page')).toBeLessThan(p.indexOf('The goal:'))
    expect(p).toContain(PLAN_READ_APP)
    expect(p).not.toContain('.claude/skills/')
    expect(buildPlanPrompt({ goal: 'export', path: '/app/PLAN.md', guides: [] })).toContain(PLAN_READ_APP)
  })

  test('stepPrompt carries the step, its phase and every guardrail', () => {
    const p = stepPrompt({ path: 'IDEAS/crop.md', step, phase, today: '2026-10-13' })
    expect(p).toContain('Carry out step 2.2 of the plan at `IDEAS/crop.md`: Rotate and flip')
    expect(p).toContain('Phase 2 — Writes to pixels, done when: the drive is green')
    for (const rule of [
      'Say the step\'s id and title before doing anything else',
      'Do ONLY this step',
      '`decision-rules`',
      'undo your edits to source files',
      'the session\'s job ends at the question',
      'fli file --sev S3',
      'Commit nothing',
      'Run `fli done`',
      'tick the box to `[x]`',
      '`**Done <date>.**`',
      '` — dropped: why`',
      'The reply is handed to the next session',
    ]) expect(p).toContain(rule)
  })

  test('nextHandoff reads the file first, carries the last reply capped, then the step', () => {
    const long = 'x'.repeat(HANDOFF_MAX + 50)
    const p = nextHandoff({ path: 'IDEAS/crop.md', step, phase, lastResult: long, today: '2026-10-13' })
    expect(p.indexOf('Read it first')).toBeLessThan(p.indexOf('The last session\'s reply'))
    expect(p).toContain('…' + 'x'.repeat(HANDOFF_MAX))
    expect(p).not.toContain('x'.repeat(HANDOFF_MAX + 1))
    expect(p.indexOf('The last session\'s reply')).toBeLessThan(p.indexOf('Carry out step 2.2'))
    expect(p).toContain('Do ONLY this step')
  })

  test('nextHandoff with nothing to carry is the read line and the step', () => {
    const p = nextHandoff({ path: 'PLAN.md', step, today: '2026-10-13' })
    expect(p).not.toContain('last session')
    expect(p).toContain('Carry out step 2.2 of the plan at `PLAN.md`')
  })
})
