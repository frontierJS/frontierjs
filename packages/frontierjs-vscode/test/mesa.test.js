// Mesa editor support — behavioral tests against the built out/mesa/.
//
// Run:  npm test            (builds first — a stale out/ tests the previous fix)
//       node test/mesa.test.js
//
// Mesa is not a language server: it registers vscode providers directly, so
// there is nothing to drive over stdio. test/vscode-stub.js stands in for the
// editor; the MESA COMPILER IS REAL, resolved the same way it is at runtime,
// because the defect this exists for was a resolver looking for a package name
// that had been renamed away.
//
// Every case is a defect that shipped, or the thing that would have caught it:
// the three providers were plain JS that tsc never emitted, so activation threw
// on its first require — which is why `startMesaClient` was commented out.

'use strict'

const path = require('path')
const fs   = require('fs')
const stub = require('./vscode-stub')

const ROOT  = path.resolve(__dirname, '..')
const REPO  = path.resolve(ROOT, '..', '..')
const MESA  = path.join(REPO, 'packages', 'mesa')

// FJS_MESA_CLIENT points the suite at another copy of the client, the way
// FJS_LSP_SERVER does for the language server.
const CLIENT = process.env.FJS_MESA_CLIENT || path.join(ROOT, 'out', 'mesa', 'client.js')

const api = stub.install()

// ─── Tiny harness ─────────────────────────────────────────────────────────────

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Poll until `fn()` is truthy. Nothing here awaits validate() — the editor doesn't either. */
async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined && v !== null && v !== false) return v
    await sleep(5)
  }
  return undefined
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID = [
  '<script>',
  '  export let label = "Add"',
  '  let count = 0',
  '  const doubled = count * 2',
  '  function bump() { count++ }',
  '</script>',
  '',
  '<button on:click={bump}>{label} {count} {doubled}</button>',
  ''
].join('\n')

// An ANALYSIS error: compile() returns normally and reports it on ctx.analysis.
const ANALYSIS_ERROR = [
  '<script>',
  '  let a = 1',
  '</script>',
  '',
  '<input type="checkbox" bind:group={missing} />',
  ''
].join('\n')

// A PARSE error: compile() throws, and the whole file has no positions at all.
const PARSE_ERROR = [
  '<script>',
  '  let ok = true',
  '</script>',
  '{#if ok}',
  '  <p>yes</p>',
  ''
].join('\n')

const REAL_ROUTE = path.join(REPO, 'example', 'web', 'src', 'routes', 'index.mesa')

// ─── Driving the client ───────────────────────────────────────────────────────

/**
 * Load a FRESH copy of the client — module state (`_compile`, the resolved path)
 * is cached for the life of the module, which is exactly what each resolution
 * case needs to not inherit.
 */
function freshClient() {
  for (const key of Object.keys(require.cache))
    if (key.includes(path.join('out', 'mesa'))) delete require.cache[key]
  api._.providers.hover.length      = 0
  api._.providers.completion.length = 0
  api._.providers.symbol.length     = 0
  api._.messages.length             = 0
  api._.diagnosticCollections.length = 0
  api.workspace.workspaceFolders = []
  api._.settings.clear()
  return require(CLIENT)
}

function doc(fsPath, text) { return new stub.TextDocument(fsPath, text, 'mesa') }

/** Fire the save listener — the one path that validates with no debounce. */
function save(document) { api._.listeners.save.forEach(fn => fn(document)) }

const collection = () => api._.diagnosticCollections[api._.diagnosticCollections.length - 1]

/** Save `document` and wait for the diagnostics that follow. Undefined = never validated. */
async function diagnose(document, ms = 5000) {
  const store = collection()
  store.delete(document.uri)
  save(document)
  return await until(() => store.get(document.uri), ms)
}

const errorsOf   = d => (d ?? []).filter(x => x.severity === api.DiagnosticSeverity.Error)
const warningsOf = d => (d ?? []).filter(x => x.severity === api.DiagnosticSeverity.Warning)

// ─── Cases ────────────────────────────────────────────────────────────────────

async function main() {
  // ── Activation ──────────────────────────────────────────────────────────────
  section('Activation')

  let client, context
  try {
    client  = freshClient()
    context = stub.extensionContext(ROOT)
    await client.startMesaClient(context)
    ok('startMesaClient resolves', true)
  } catch (err) {
    ok('startMesaClient resolves', false, String(err && err.stack || err))
    report()
    return
  }

  ok('hover provider registered',   api._.providers.hover.length === 1)
  ok('symbol provider registered',  api._.providers.symbol.length === 1)

  const completion = api._.providers.completion[0]
  ok('completion provider registered', !!completion)
  ok('completion triggers are $ { : | <',
    completion && ['$', '{', ':', '|', '<'].every(c => completion.triggers.includes(c)),
    completion ? `got [${completion.triggers}]` : '')

  ok('diagnostic collection created', collection() && collection().name === 'mesa')
  ok('everything registered is disposable', context.subscriptions.length >= 7,
    `got ${context.subscriptions.length}`)

  // ── Compiler resolution ─────────────────────────────────────────────────────
  // The old candidate list hunted @mesa/compiler/compiler.js, a name that no
  // longer exists — every probe missed and diagnostics offered to be configured.
  section('Compiler resolution')

  {
    // Walking up from the edited file: this repo has packages/mesa above it.
    const d = doc(path.join(REPO, 'example', 'web', 'src', 'routes', 'probe.mesa'), ANALYSIS_ERROR)
    const diags = await diagnose(d)
    ok('resolved by walking up from the edited file', errorsOf(diags).length === 1,
      `messages: ${api._.messages.join(' | ')}`)
    ok('no "compiler not found" prompt when it is found',
      !api._.messages.some(m => String(m).includes('not found')))
  }

  {
    // A file outside any checkout, with the workspace folder as the only clue.
    client = freshClient()
    api.workspace.workspaceFolders = [{ uri: { fsPath: REPO } }]
    await client.startMesaClient(stub.extensionContext('/nonexistent/extension'))
    const d = doc('/tmp/no-such-workspace/Probe.mesa', ANALYSIS_ERROR)
    ok('resolved from the workspace folder', errorsOf(await diagnose(d)).length === 1)
  }

  {
    // Dev/F5 in this monorepo: the extension's own sibling package, and nothing
    // else. __dirname cannot answer this — it is out/ bundled and out/mesa/ not.
    client = freshClient()
    await client.startMesaClient(stub.extensionContext(ROOT))
    const d = doc('/tmp/no-such-workspace/Probe.mesa', ANALYSIS_ERROR)
    ok('resolved from the extension\'s sibling package', errorsOf(await diagnose(d)).length === 1)
  }

  {
    // mesa.compilerPath naming the package DIRECTORY rather than the file.
    client = freshClient()
    api._.settings.set('mesa.compilerPath', MESA)
    await client.startMesaClient(stub.extensionContext('/nonexistent/extension'))
    const d = doc('/tmp/no-such-workspace/Probe.mesa', ANALYSIS_ERROR)
    ok('mesa.compilerPath may name the package directory', errorsOf(await diagnose(d)).length === 1)
  }

  {
    // mesa.compilerPath naming the file itself.
    client = freshClient()
    api._.settings.set('mesa.compilerPath', path.join(MESA, 'src', 'compiler.js'))
    await client.startMesaClient(stub.extensionContext('/nonexistent/extension'))
    const d = doc('/tmp/no-such-workspace/Probe.mesa', ANALYSIS_ERROR)
    ok('mesa.compilerPath may name compiler.js', errorsOf(await diagnose(d)).length === 1)
  }

  {
    // No compiler anywhere: one prompt, no diagnostics, nothing thrown.
    client = freshClient()
    await client.startMesaClient(stub.extensionContext('/nonexistent/extension'))
    const d = doc('/tmp/no-such-workspace/Probe.mesa', ANALYSIS_ERROR)
    const diags = await diagnose(d, 800)
    ok('no compiler → no diagnostics', diags === undefined)
    ok('no compiler → one prompt', api._.messages.filter(m => String(m).includes('not found')).length === 1,
      `messages: ${api._.messages.join(' | ')}`)
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────
  section('Diagnostics')

  client = freshClient()
  await client.startMesaClient(stub.extensionContext(ROOT))

  {
    const d = doc(path.join(REPO, 'x', 'Valid.mesa'), VALID)
    ok('a valid component reports nothing', (await diagnose(d) ?? ['?']).length === 0)
  }

  {
    const d = doc(path.join(REPO, 'x', 'Analysis.mesa'), ANALYSIS_ERROR)
    const diags = await diagnose(d) ?? []
    const first = diags[0]
    ok('an analysis error is an Error diagnostic', errorsOf(diags).length === 1)
    ok('the message names the offending variable',
      !!first && first.message.includes("'missing'"), first && first.message)
    // A diagnostic at 0:0 is the fallback range — it underlines the file, not the bug.
    ok('it is located at the offending variable',
      !!first && !(first.range.start.line === 0 && first.range.start.character === 0),
      first && `${first.range.start.line}:${first.range.start.character}`)
    ok('the range covers the identifier',
      !!first && d.getText(first.range) === 'missing',
      first && JSON.stringify(d.getText(first.range)))
  }

  {
    // compile() THROWS on a syntax error — the normal mid-keystroke state, and
    // the one case with no positions to report against.
    const d = doc(path.join(REPO, 'x', 'Parse.mesa'), PARSE_ERROR)
    const diags = await diagnose(d) ?? []
    ok('a parse error is reported, not swallowed', diags.length === 1)
    ok('it is an Error, and says so is a parse error',
      diags[0] && diags[0].severity === api.DiagnosticSeverity.Error &&
      diags[0].message.startsWith('Mesa parse error:'), diags[0] && diags[0].message)
    // The editor sees this on almost every keystroke — it must not take the
    // provider down or leave the previous file's diagnostics behind.
    const after = await diagnose(doc(path.join(REPO, 'x', 'Parse.mesa'), VALID))
    ok('a file that parses again clears its diagnostics', (after ?? ['?']).length === 0)
  }

  {
    const d = doc(REAL_ROUTE, fs.readFileSync(REAL_ROUTE, 'utf8'))
    ok('a real route from example/ is clean', errorsOf(await diagnose(d)).length === 0,
      (await diagnose(d) ?? []).map(x => x.message).join(' | '))
  }

  {
    // A compiler WARNING is a Warning, not an Error and not silence.
    const src = [
      '<script>',
      '  let n = 1',
      '</script>',
      '<mesa:boundary>',
      '  <p>{n}</p>',
      '</mesa:boundary>',
      ''
    ].join('\n')
    const d = doc(path.join(REPO, 'x', 'Warn.mesa'), src)
    const diags = await diagnose(d) ?? []
    ok('a compiler warning surfaces as a Warning', warningsOf(diags).length >= 1 && errorsOf(diags).length === 0,
      diags.map(x => `${x.severity}:${x.message}`).join(' | '))
  }

  {
    const d = doc(path.join(REPO, 'x', 'Closed.mesa'), ANALYSIS_ERROR)
    await diagnose(d)
    api._.listeners.close.forEach(fn => fn(d))
    ok('closing a file clears its diagnostics', collection().get(d.uri) === undefined)
  }

  // ── On-type validation ──────────────────────────────────────────────────────
  section('On-type validation')

  {
    const d = doc(path.join(REPO, 'x', 'Typing.mesa'), ANALYSIS_ERROR)
    api._.settings.set('mesa.validateOnType', true)
    api._.settings.set('mesa.validateDelay', 20)
    api._.listeners.change.forEach(fn => fn({ document: d }))
    ok('typing validates after the debounce', errorsOf(await until(() => collection().get(d.uri))).length === 1)

    collection().delete(d.uri)
    api._.settings.set('mesa.validateOnType', false)
    api._.listeners.change.forEach(fn => fn({ document: d }))
    await sleep(120)
    ok('mesa.validateOnType false stops it', collection().get(d.uri) === undefined)
  }

  {
    // Every listener filters on languageId — a .lite file must not reach the
    // Mesa compiler, which would report a parse error on a perfectly good schema.
    const lite = new stub.TextDocument(path.join(REPO, 'x', 'schema.lite'), 'model Post {\n  id Int @id\n}\n', 'litestone')
    save(lite)
    await sleep(120)
    ok('a non-mesa document is ignored', collection().get(lite.uri) === undefined)
  }

  // ── Providers ───────────────────────────────────────────────────────────────
  section('Providers')

  const hoverProvider  = api._.providers.hover[0].p
  const completionProv = api._.providers.completion[0].p
  const symbolProvider = api._.providers.symbol[0].p

  {
    const src = ['<script>', '  const theme = $context.theme', '</script>', '<p>{theme}</p>', ''].join('\n')
    const d = doc(path.join(REPO, 'x', 'Hover.mesa'), src)
    const h = hoverProvider.provideHover(d, new stub.Position(1, 20))   // inside $context
    ok('hover answers on $context', !!h && String(h.contents.value).length > 0)
    const none = hoverProvider.provideHover(d, new stub.Position(3, 2))  // plain markup
    ok('hover answers null off a known token', none === null)
  }

  {
    const src = ['<script>', '  let x = $', '</script>', '<p>x</p>', ''].join('\n')
    const d = doc(path.join(REPO, 'x', 'Complete.mesa'), src)
    const items = completionProv.provideCompletionItems(d, new stub.Position(1, 11), null, { triggerCharacter: '$' })
    const labels = (items ?? []).map(i => i.label)
    ok('$ in a script offers the runtime globals', labels.some(l => String(l).startsWith('$context')),
      `got ${labels.slice(0, 8).join(',')}`)

    const template = doc(path.join(REPO, 'x', 'Complete2.mesa'), '<script>\n  let ok = true\n</script>\n{')
    const blocks = completionProv.provideCompletionItems(template, new stub.Position(3, 1), null, { triggerCharacter: '{' })
    ok('{ in the template offers block keywords',
      (blocks ?? []).some(i => String(i.label).includes('#if')),
      (blocks ?? []).map(i => i.label).slice(0, 8).join(','))
  }

  {
    const d = doc(path.join(REPO, 'x', 'Symbols.mesa'), VALID)
    const symbols = symbolProvider.provideDocumentSymbols(d) ?? []
    const names = symbols.map(s => s.name)
    ok('the outline groups props and state', names.some(n => /Props/i.test(n)) && names.some(n => /State/i.test(n)),
      `got ${names.join(',')}`)
    const props = symbols.find(s => /Props/i.test(s.name))
    ok('a prop appears under Props', !!props && props.children.some(c => c.name.includes('label')),
      props ? props.children.map(c => c.name).join(',') : '')
  }

  await client.stopMesaClient()
  ok('stopMesaClient disposes the collection', collection().disposed === true)

  report()
}

function report() {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    failures.forEach(f => console.log(`  ✗ ${f}`))
  }
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
