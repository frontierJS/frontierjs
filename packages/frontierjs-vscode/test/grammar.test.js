// The TextMate grammars — tokenized, not read.
//
// Run:  npm test  ·  node test/grammar.test.js
//
// A grammar has no compiler and no runtime: a rule that matches nothing colors
// nothing, which is the same picture as a file with nothing to color. Mesa's
// `script-block` began `(<)(script)(>)` and so matched only the bare tag, so
// every `<script module>` block fell through to the HTML element rule and the
// whole data half of every Resource file in a Sierra app — 117 of them here —
// rendered as plain text with `module` reported as a boolean attribute.
//
// So the assertions here are about the SCOPES a real file gets, and every one
// is paired with the shape one character away: a fix that put `source.js` on
// everything would look identical from an assertion that only asks about
// `<script module>`.

'use strict'

const path = require('path')
const fs   = require('fs')

const oniguruma = require('vscode-oniguruma')
const vsctm     = require('vscode-textmate')

const ROOT = path.resolve(__dirname, '..')

// `verify:package` points this at the UNPACKED .vsix, so the same assertions
// grade the artefact — a grammar `.vscodeignore` left out is a file the editor
// never loads and the working tree cannot see.
const SYNTAXES = process.env.FJS_SYNTAXES || path.join(ROOT, 'syntaxes')
const GRAMMARS = {
  'source.mesa':      path.join(SYNTAXES, 'mesa.tmLanguage.json'),
  'source.litestone': path.join(SYNTAXES, 'litestone.tmLanguage.json')
}

let pass = 0, fail = 0, group = ''
const failures = []

function section(name) { group = name; console.log(`\n${name}`) }

function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok    ${name}`) }
  else {
    fail++
    failures.push(`${group} › ${name}${detail ? `\n        ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

async function makeRegistry() {
  const wasm = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
  )
  await oniguruma.loadWASM(wasm.buffer)
  return new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s) => new oniguruma.OnigScanner(s),
      createOnigString:  (s) => new oniguruma.OnigString(s)
    }),
    // VS Code supplies `source.js` and `source.css`; here they are empty stubs.
    // They cannot be left unresolved: a block whose `patterns` is nothing BUT
    // an unresolvable include is dropped whole, so `<style>` would report as
    // broken for a reason that exists only in this harness. Empty is enough —
    // what these assertions read is the block's own `contentName` and the mesa
    // rules beside the include, never JavaScript's own scopes.
    loadGrammar: async (scope) => {
      const file = GRAMMARS[scope]
      if (file) return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file)
      if (scope === 'source.js' || scope === 'source.css') {
        return { scopeName: scope, patterns: [] }
      }
      return null
    }
  })
}

/** Every token of `src`, flattened: { text, scopes, line }. */
function tokenize(grammar, src) {
  const out = []
  let rules = vsctm.INITIAL
  src.split('\n').forEach((text, i) => {
    const r = grammar.tokenizeLine(text, rules)
    rules = r.ruleStack
    for (const t of r.tokens) {
      out.push({ text: text.slice(t.startIndex, t.endIndex), scopes: t.scopes, line: i + 1 })
    }
  })
  return out
}

/** The scopes on the first token whose text contains `needle`. */
function scopesOf(tokens, needle) {
  const t = tokens.find(t => t.text.includes(needle))
  return t ? t.scopes : []
}

async function main() {
  const registry = await makeRegistry()
  const mesa     = await registry.loadGrammar('source.mesa')

  // ── <script module> — the shape that was invisible ────────────────────────

  section('mesa: a script block takes attributes')

  const forms = [
    ['<script>',                  'bare'],
    ['<script module>',           'module'],
    ['<script context="module">', 'context="module"'],
    ["<script lang='js'>",        "lang='js'"]
  ]
  for (const [open, label] of forms) {
    const src = `${open}\n  const x = 1\n</script>\n`
    const tk  = tokenize(mesa, src)
    ok(`${label}: the body is embedded JS`,
      scopesOf(tk, 'const').includes('source.js.embedded.mesa'),
      scopesOf(tk, 'const').join(' ') || '(no scopes)')
    ok(`${label}: the tag is a script tag`,
      scopesOf(tk, 'script').includes('entity.name.tag.html'))
  }

  // `module` says WHEN the block runs, which is the one thing about a Resource
  // file's data half a reader has to see. Paired with `defer`, an attribute
  // that means nothing here, or a rule marking every word would pass too.
  {
    const tk = tokenize(mesa, '<script module>\nconst x = 1\n</script>\n')
    ok('module is marked as the keyword it is',
      scopesOf(tk, 'module').includes('keyword.control.script-module.mesa'),
      scopesOf(tk, 'module').join(' '))
  }
  {
    const tk = tokenize(mesa, '<script defer>\nconst x = 1\n</script>\n')
    ok('an ordinary attribute is not marked as module',
      !scopesOf(tk, 'defer').includes('keyword.control.script-module.mesa'),
      scopesOf(tk, 'defer').join(' '))
  }

  // The negative control for the open-tag regex: `[^>]*` must not let the rule
  // swallow a tag that merely STARTS with the word.
  {
    const tk = tokenize(mesa, '<scripture>\nconst x = 1\n</scripture>\n')
    ok('<scripture> is not a script block',
      !scopesOf(tk, 'const').includes('source.js.embedded.mesa'),
      scopesOf(tk, 'const').join(' '))
  }

  section('mesa: a style block takes attributes')
  for (const open of ['<style>', '<style global>']) {
    const tk = tokenize(mesa, `${open}\n  .a { color: red }\n</style>\n`)
    ok(`${open}: the body is embedded CSS`,
      scopesOf(tk, '.a').includes('source.css.embedded.mesa'),
      scopesOf(tk, '.a').join(' ') || '(no scopes)')
  }

  // ── The mesa annotations, which only fire inside a script block ───────────
  //
  // These live under `script-block.patterns`, so they were unreachable in a
  // module block for the same reason the JS was. Asserting one of each proves
  // the include still resolves through the new begin.

  section('mesa: the annotations reach a module block')
  {
    const tk = tokenize(mesa, '<script module>\nexport const users = 1\n</script>\n')
    ok('export const is an immutable prop',
      scopesOf(tk, 'users').includes('variable.other.immutable.prop.mesa'),
      scopesOf(tk, 'users').join(' '))
  }
  {
    const tk = tokenize(mesa, '<script>\nlet count = 0\n</script>\n')
    ok('let is a reactive signal',
      scopesOf(tk, 'count').includes('variable.other.reactive.mesa'),
      scopesOf(tk, 'count').join(' '))
  }

  // ── Every real .mesa file in the workspace ────────────────────────────────
  //
  // The corpus is the assertion the hand-written cases cannot make: the defect
  // was found by looking at one file, and nothing here had ever looked at all
  // of them. A file whose script body carries no JS scope is one the editor
  // renders as plain text.

  section('mesa: every .mesa file in the workspace')
  const WS = path.resolve(ROOT, '..', '..')
  const files = []
  ;(function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'out') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.mesa')) files.push(p)
    }
  })(WS)

  ok('the corpus was found', files.length > 100, `${files.length} files`)

  // Every script block of every file, not every file: most of these carry a
  // `<script module>` AND a plain `<script>`, so a per-file check is answered
  // by whichever one still works and reports green with half the grammar gone.
  const unlit = []
  for (const file of files) {
    const src   = fs.readFileSync(file, 'utf8')
    const lines = src.split('\n')
    const tk    = tokenize(mesa, src)
    lines.forEach((line, i) => {
      if (!/^\s*<script[^>]*>\s*$/.test(line)) return
      let n = i + 1
      while (n < lines.length && !lines[n].trim()) n++
      if (n >= lines.length || /^\s*<\/script>/.test(lines[n])) return   // an empty block
      const body = tk.filter(t => t.line === n + 1 && t.text.trim())
      if (!body.some(t => t.scopes.includes('source.js.embedded.mesa'))) {
        unlit.push(`${path.relative(WS, file)}:${i + 1} ${line.trim()}`)
      }
    })
  }
  ok('no file has an unhighlighted script block', unlit.length === 0,
    unlit.slice(0, 10).join('\n        ') + (unlit.length > 10 ? `\n        … ${unlit.length - 10} more` : ''))

  // ── Litestone, so the second grammar is not unread ────────────────────────

  section('litestone: the schema language')
  const lite = await registry.loadGrammar('source.litestone')
  {
    const tk = tokenize(lite, 'model Lead {\n  id String @id\n}\n')
    ok('model is a keyword',
      scopesOf(tk, 'model').some(s => s.startsWith('keyword') || s.startsWith('storage')),
      scopesOf(tk, 'model').join(' '))
    ok('@id is an attribute',
      scopesOf(tk, '@id').some(s => s.includes('attribute') || s.startsWith('entity') || s.startsWith('storage')),
      scopesOf(tk, '@id').join(' '))
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    failures.forEach(f => console.log(`  ✗ ${f}`))
  }
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
