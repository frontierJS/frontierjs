/*
 * verify-studio-compare.mjs — the Compare panel: what this branch did.
 *
 * Every other Studio panel answers *what is true now*. This one answers *what
 * changed*, and it is the only panel whose input is not the schema on disk — it
 * reads a second schema out of git and grades the pair. Two things follow, and
 * they are what this file is for.
 *
 * THE REF IS A LOOKUP, NEVER AN INTERPOLATION. The value ends up on a git
 * command line, and `loadBaselineSchema` reads a plain FILE when one exists by
 * that name — so a panel that accepted a typed ref would let whoever has the
 * page open name a path on the disk. The server enumerates the candidates and
 * the client picks one BY NAME from that list. Every refusal here is asserted
 * BESIDE a listed ref that still answers, because a server that refused every
 * ref would satisfy any test that only asks about the refusal (FJS-351).
 *
 * TWO VERDICTS, NEVER ONE BADGE. Deploy and Access are read off one walk of the
 * same two surfaces and they disagree by construction — removing a `@@gate` is
 * an `expand` for a deploy and the widest thing a schema change can do to
 * access. A single headline has to pick one and is wrong about the other every
 * time it matters, so the panel renders both and this asserts each is answered
 * in its own vocabulary.
 *
 *   node packages/litestone/test/verify-studio-compare.mjs
 *
 * Starts and stops its own server on 7505 — test-tier tooling, inside the port
 * scheme so `fli ps` can see it. Nothing to launch first. Needs Chrome on PATH
 * or $FJS_CHROME, and a git repository: with none, the panel says so and this
 * file asserts that sentence instead of skipping.
 *
 * WHAT IT DOES NOT PIN. Nothing here names a model, a commit or a count from
 * `example`'s history. A drive that asserted `Colour becomes Color` goes red on
 * the day somebody rewrites a branch, which is a fixture that stopped
 * describing its subject rather than a regression (the lesson `verify:studio:models`
 * paid for in FJS-773). What is asserted is the SHAPE of the answer and the
 * refusals, plus one real comparison whose baseline the server chose.
 */

import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'

const PORT   = process.env.STUDIO_PORT ?? '7505'
const UI     = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const REPO   = pathResolve(import.meta.dirname, '../../..')
const SCHEMA = join(REPO, 'example/db/schema.lite')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the server, started and stopped by this file ─────────────────────────

const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')
// `--no-open` or every run opens a tab over whatever somebody was typing into.
// cwd is the APP ROOT: `.env` lives there and `example` declares @encrypted
// columns, so studio refuses to start with no encryption key.
const studio = spawn('bun', [CLI, 'studio', '--schema', SCHEMA, '--port', PORT, '--no-open'], {
  cwd: join(REPO, 'example'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let studioOut = ''
studio.stdout.on('data', d => { studioOut += d })
studio.stderr.on('data', d => { studioOut += d })

let chromeProc = null
let chromeProfile = null
function cleanup() {
  try { process.kill(-studio.pid) } catch {}
  if (chromeProc) { try { chromeProc.kill('SIGKILL') } catch {} ; chromeProc = null }
  if (chromeProfile) {
    // Chrome writes its profile back while it shuts down; removing it straight
    // after the kill SUCCEEDS and leaves megabytes behind. An exit handler
    // cannot await, so block.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    chromeProfile = null
  }
}
process.on('exit', cleanup)
process.on('SIGINT',  () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
process.on('uncaughtException',  (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${UI}/api/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).ok) break } catch {}
  await new Promise(r => setTimeout(r, 500))
  if (i === 59) { console.error('studio never came up:\n' + studioOut); process.exit(1) }
}

const post = async (path, body) => {
  const res = await fetch(UI + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// ─── the server half — the refusals, before a browser is involved ─────────

const refs = (await post('/api/refs')).json.refs ?? []

// The list is what makes the ref a lookup. Nothing else here is meaningful if
// it comes back empty, so it is asserted first and by shape.
t('refs.everyRowCarriesAResolvedSha',
  refs.length > 0 && refs.every(r => typeof r.sha === 'string' && /^[0-9a-f]{40}$/.test(r.sha) && r.name && r.kind),
  true)

// One row per COMMIT. A monorepo tags every package at one sha, and the first
// version of this listing was eight `@frontierjs/*@x.y.z` rows resolving to a
// single commit, crowding out the entries whose answer is not `unchanged`.
t('refs.oneRowPerCommit', new Set(refs.map(r => r.sha)).size, refs.length)

// The commits that touched the schema are the only ones that can differ, so
// they are listed ahead of the tags rather than behind them.
const kinds = refs.map(r => r.kind)
t('refs.schemaCommitsRankAboveTags',
  !kinds.includes('tag') || !kinds.includes('schema-commit') ||
  kinds.indexOf('schema-commit') < kinds.indexOf('tag'),
  true)

// ── the refusals, each paired with a listed ref that still answers ──

const listed = refs.find(r => r.kind === 'schema-commit') ?? refs[refs.length - 1]

t('server.answersARefItListed', (await post('/api/compare', { ref: listed.name })).status, 200)

// A real ref, resolvable by git, that this server did not offer. The point of
// the design: resolvable is not the test, LISTED is.
t('server.refusesARealRefItDidNotList', (await post('/api/compare', { ref: 'HEAD~1' })).status, 400)

// A PATH. `loadBaselineSchema` reads a plain file when one exists by that name,
// which is the whole reason the ref may not be typed.
t('server.refusesAPathThatExists', (await post('/api/compare', { ref: 'db/schema.lite' })).status, 400)

// Shell metacharacters. `git()` spawns with shell:false so this was never an
// injection, but a value that reaches a command line at all must be one this
// server produced — asserted so that a later switch to a shell cannot go
// unnoticed.
t('server.refusesShellPunctuation', (await post('/api/compare', { ref: 'HEAD; touch /tmp/pwned' })).status, 400)
t('server.refusesNothing',          (await post('/api/compare', {})).status, 400)

// ── the two axes ──

const cmp = (await post('/api/compare', { ref: listed.name })).json

const DEPLOY = ['unchanged', 'expand', 'unknown', 'contract']
const ACCESS = ['unchanged', 'new', 'narrows', 'unknown', 'widens']

t('compare.eachAxisAnswersInItsOwnVocabulary', {
  deploy: DEPLOY.includes(cmp.deploy?.verdict),
  access: ACCESS.includes(cmp.access?.verdict),
}, { deploy: true, access: true })

t('compare.everyFindingNamesItsSubjectAndSaysWhat',
  [...(cmp.deploy?.findings ?? []), ...(cmp.access?.findings ?? [])]
    .every(f => f.subject && (f.detail || f.accessDetail)),
  true)

// The counts are the findings, counted. A headline computed separately from the
// list under it is the shape that disagrees with itself.
const d = cmp.deploy ?? { counts: {}, findings: [] }
t('compare.theCountsAreTheFindings',
  d.counts.expand + d.counts.unknown + d.counts.contract, d.findings.length)

// ── the negative control ──
//
// A panel that always finds something is indistinguishable from one that works.
// HEAD against the working tree is `unchanged` on both axes when the schema file
// is committed — which the drive checks rather than assumes, because a run over
// an edited schema would otherwise go red for the one reason that is not a bug.
const dirty = spawnSync('git', ['status', '--porcelain', '--', SCHEMA],
  { cwd: REPO, encoding: 'utf8' }).stdout.trim() !== ''
const head = (await post('/api/compare', { ref: 'HEAD' })).json
t('compare.headAgainstACleanTreeMovesNothing',
  dirty
    ? 'skipped — schema.lite has uncommitted changes'
    : { deploy: head.deploy?.verdict, access: head.access?.verdict },
  dirty
    ? 'skipped — schema.lite has uncommitted changes'
    : { deploy: 'unchanged', access: 'unchanged' })

// A package fragment is read from the WORKING TREE, and the note says so.
// `import "@frontierjs/auth/schema.lite"` resolves through node_modules, which a
// ref does not have — joined as a path it asks git for
// `db/@frontierjs/auth/schema.lite`, which is nothing, so every model the
// package ships read as newly added on every comparison, for ever. The control
// is the row above: with the fragments absent, HEAD against a clean tree
// reported six `new` models.
t('compare.aPackageFragmentIsBorrowedAndSaidSo',
  /package fragment/.test(head.note ?? ''), true)

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = tempDir('fjs-studio-')
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chromeProc = chrome
chromeProfile = profile
chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((res, rej) => {
  let buf = ''
  const timer = setTimeout(() => rej(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (dd) => {
    buf += dd
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); res(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej })
    setTimeout(() => pending.has(id) && rej(new Error(`${method} timed out`)), 30000)
  })
}

const consoleErrors = []
browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: rs, reject: rj } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rj(new Error(msg.error.message)) : rs(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type))
    consoleErrors.push('error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const cmd = (m, p) => send(m, p, sessionId)
await cmd('Page.enable')
await cmd('Runtime.enable')

async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// A probe that threw used to take the whole report with it — the run went red
// naming a line number and every assertion after it never ran.
async function probe(expression) {
  try { return await evaluate(expression) }
  catch (e) { return 'THREW: ' + String(e.message ?? e).split('\n')[0] }
}

await cmd('Page.navigate', { url: UI + '/#compare' })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (document.querySelector('#cmpPanel .card') || document.querySelector('#cmpPanel .alert')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

// ─── the panel ────────────────────────────────────────────────────────────

t('panel.opensOnItsOwnHash', await probe(`
  return {
    shown: !document.getElementById('panelCompare').hidden,
    nav:   document.querySelector('[aria-current="page"]').textContent.trim(),
  };
`), { shown: true, nav: 'Compare' })

// The security property, visible in the DOM: there is nowhere to TYPE a ref.
// A text box here would be the whole defect, and it is the kind of thing a
// later convenience edit adds without noticing.
t('panel.theRefIsChosenNotTyped', await probe(`
  const p = document.getElementById('panelCompare');
  return {
    select: !!p.querySelector('select#cmpRef'),
    typed:  p.querySelectorAll('input[type=text], input:not([type]), textarea, [contenteditable]').length,
  };
`), { select: true, typed: 0 })

// Every option is a ref the server listed. The client cannot invent one, and a
// panel that built its own option values would pass every server-side assertion
// above while sending something nobody enumerated.
t('panel.everyOptionIsARefTheServerListed', await probe(`
  const names = ${JSON.stringify(refs.map(r => r.name))};
  return [...document.querySelectorAll('#cmpRef option')].every(o => names.includes(o.value));
`), true)

// The default is not HEAD. Comparing HEAD against a clean tree answers
// `unchanged` for everybody, which reads as the panel being broken rather than
// as a question honestly answered.
t('panel.doesNotOpenOnHeadAgainstItself', await probe(`
  return document.getElementById('cmpRef').value !== 'HEAD';
`), refs.length > 1)

// TWO verdicts. The claim the panel exists to make: they are separate answers
// off one comparison, in two vocabularies, and neither is a summary of the other.
t('panel.rendersBothVerdictsSeparately', await probe(`
  const badges = [...document.querySelectorAll('#cmpPanel .surface-header .badge')].map(b => b.textContent.trim());
  return {
    deploy: badges.filter(b => b.startsWith('Deploy:')).length,
    access: badges.filter(b => b.startsWith('Access:')).length,
  };
`), { deploy: 1, access: 1 })

// A verdict that stops a deploy must not be rendered in the tone of one that
// does not. The tone comes off a table keyed by verdict, so this asserts the
// lookup ran rather than that a particular colour is on screen.
t('panel.theVerdictToneFollowsTheVerdict', await probe(`
  const b = [...document.querySelectorAll('#cmpPanel .badge')].find(x => x.textContent.startsWith('Deploy:'));
  const v = b.textContent.split(':')[1].trim();
  const tone = [...b.classList].find(c => ['success','warning','danger','muted'].includes(c));
  return { v, tone };
`), { deploy: 'x' }.deploy === 'x'
  ? { v: cmp.deploy.verdict, tone: { unchanged: 'success', expand: 'success', unknown: 'warning', contract: 'danger' }[cmp.deploy.verdict] }
  : null)

// The note is a WARNING and not a footnote. The commonest one says a package
// fragment came from the working tree; left small, it is a panel quietly
// comparing something other than what its dropdown says.
t('panel.theNoteIsAWarningNotAFootnote', await probe(`
  const a = document.querySelector('#cmpPanel .alert');
  return { present: !!a, warning: !!a && a.classList.contains('warning') };
`), { present: true, warning: true })

// Changing the ref re-runs the comparison — asserted by watching the panel be
// REWRITTEN, not by diffing its text. Two adjacent commits often leave the
// schema untouched, so both answer `unchanged` and render identically; a
// content diff there cannot tell *it did not re-run* from *it re-ran and the
// answer is the same*, and the first version of this row reported the second as
// a failure. A marker the render destroys answers the question that was asked.
t('panel.changingTheRefAsksAgain', await probe(`
  const sel = document.getElementById('cmpRef');
  const other = [...sel.options].find(o => o.value !== sel.value);
  if (!other) return 'only one ref to choose from';
  const panel = document.getElementById('cmpPanel');
  const marker = document.createElement('i');
  marker.id = 'cmpMarker';
  panel.appendChild(marker);
  sel.value = other.value;
  sel.dispatchEvent(new Event('change'));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (!document.getElementById('cmpMarker')) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return 'the panel was never rewritten';
`), refs.length > 1 ? true : 'only one ref to choose from')

// The subject line follows the choice. Two commits both called `updates` are
// indistinguishable by sha alone, and the sha is what the option shows.
t('panel.theCommitSubjectFollowsTheChoice', await probe(`
  const sel = document.getElementById('cmpRef');
  const said = document.getElementById('cmpSubject').textContent.trim();
  return said.length > 0;
`), true)

// ─── The palette ──────────────────────────────────────────────────────────
//
// Thirteen panels, forty models and a hundred words of the language, reachable
// only by knowing which panel owned them. It rides in this drive rather than
// its own because it is a way THROUGH Studio rather than a panel with an answer
// of its own, and because everything it can reach is already up in this tab.

await evaluate(`palClose(); return true;`)

t('palette.opensOnTheShortcutAndClosesOnEscape', await probe(`
  const box = document.getElementById('palette');
  const before = box.hidden;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const opened = !box.hidden;
  const focused = document.activeElement === document.getElementById('palInput');
  document.getElementById('palInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { wasClosed: before, opened, focused, closedAgain: box.hidden };
`), { wasClosed: true, opened: true, focused: true, closedAgain: true })

// It DOES open from inside a text field, unlike the rail's `\\` — a palette you
// cannot reach while the cursor is in the SQL box is one nobody reaches for.
// The pair matters: the rail shortcut must still refuse the same field.
t('palette.opensFromInsideAField', await probe(`
  const input = document.getElementById('cmpRef') || document.querySelector('input, select');
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  const opened = !document.getElementById('palette').hidden;
  palClose();
  return opened;
`), true)

// Empty query lists the panels and nothing else — every model and every word
// would be four hundred rows of noise before a key is pressed.
t('palette.opensOnThePanels', await probe(`
  await palOpen();
  const groups = [...document.querySelectorAll('#palResults .pal-group')].map(g => g.textContent);
  const rows = document.querySelectorAll('#palResults .pal-row').length;
  palClose();
  return { groups, hasRows: rows > 5 };
`), { groups: ['Panels'], hasRows: true })

// A model. This is the reach the palette exists for: the name is in the sidebar
// and in the diagram and in no search box anywhere.
t('palette.findsAModelAndOpensItInBrowse', await probe(`
  await palOpen();
  const input = document.getElementById('palInput');
  input.value = 'orderline';
  palSearch();
  const first = document.querySelector('#palResults .pal-row');
  const name = first?.querySelector('.pal-name')?.textContent;
  first.click();
  await new Promise(r => setTimeout(r, 300));
  return { name, closed: document.getElementById('palette').hidden, panel: location.hash };
`), { name: 'OrderLine', closed: true, panel: '#browse' })

// A word of the language, WITH its sigil, reached by typing it without one.
t('palette.findsAWordEitherWayItIsTyped', await probe(`
  const shown = async (q) => {
    await palOpen();
    document.getElementById('palInput').value = q;
    palSearch();
    const names = [...document.querySelectorAll('#palResults .pal-row .pal-name')].map(n => n.textContent);
    palClose();
    return names;
  };
  const bare = await shown('gate');
  const sigil = await shown('@@gate');
  return { bare: bare.includes('@@gate'), sigil: sigil.includes('@@gate') };
`), { bare: true, sigil: true })

// The synonyms the catalogue already carries. Somebody who does not know this
// language yet types `rbac`, not `@@gate` — and that mapping is in the data, so
// not reading it is the palette declining to answer a question it can.
t('palette.findsAWordByAWordItIsNotCalled', await probe(`
  await palOpen();
  document.getElementById('palInput').value = 'rbac';
  palSearch();
  const names = [...document.querySelectorAll('#palResults .pal-row .pal-name')].map(n => n.textContent);
  palClose();
  return names.includes('@@gate');
`), true)

// A panel found by what it ANSWERS rather than by its name. The panel names are
// this tool's vocabulary; `policy` and `EXPLAIN` are the reader's.
t('palette.findsAPanelByTheQuestionItAnswers', await probe(`
  await palOpen();
  document.getElementById('palInput').value = 'policy';
  palSearch();
  const names = [...document.querySelectorAll('#palResults .pal-row .pal-name')].map(n => n.textContent);
  palClose();
  return names.includes('Access');
`), true)

// Rank is WHERE the match is, and the three tiers are asserted on the function
// rather than inferred from an order — an ordering can agree with the right
// answer for the wrong reason, and the first version of this row did: `Order`
// sorts before `OrderLine` alphabetically too, so it passed with the whole
// ranking replaced by `localeCompare`.
t('palette.rankIsWhereTheMatchIs', await probe(`
  return {
    prefix:   palHit('Order', 'order').rank,
    boundary: palHit('OrderLine', 'line').rank,
    inside:   palHit('ProductVariant', 'ant').rank,
    miss:     palHit('Order', 'zzz'),
  };
`), { prefix: 0, boundary: 1, inside: 2, miss: null })

// The tie-break, which is the half an ordering CAN show: four models match
// `line` at the same rank, and the shorter name is the one somebody typing four
// letters meant. Alphabetical would put InvoiceLine second.
t('palette.theShorterNameWinsATie', await probe(`
  await palOpen();
  document.getElementById('palInput').value = 'line';
  palSearch();
  const names = [...document.querySelectorAll('#palResults .pal-row .pal-name')].map(n => n.textContent);
  palClose();
  return names.slice(0, 2);
`), ['CartLine', 'OrderLine'])

// Arrow keys move the selection and Enter opens what is selected. A palette
// that only answers the mouse is one a keyboard user cannot use at all.
t('palette.theKeyboardMovesAndOpens', await probe(`
  await palOpen();
  const input = document.getElementById('palInput');
  input.value = 'order';
  palSearch();
  const firstSel = document.querySelector('[aria-selected="true"]')?.id;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const moved = document.querySelector('[aria-selected="true"]')?.id;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const back = document.querySelector('[aria-selected="true"]')?.id;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return { firstSel, movedOff: moved !== firstSel, cameBack: back === firstSel, hash: location.hash,
           closed: document.getElementById('palette').hidden };
`), { firstSel: 'palRow0', movedOff: true, cameBack: true, hash: '#browse', closed: true })

// A query that is also markup is just a query. What the row RENDERS comes from
// the corpus — a model name, a panel name, a word — and every piece of it is
// escaped; the query only picks where the underline starts and stops. So this
// is not an injection test and is not named as one: it asserts the box survives
// input nobody sanitised on the way in, which is the shape that used to throw.
t('palette.aQueryThatIsMarkupIsJustAQuery', await probe(`
  await palOpen();
  document.getElementById('palInput').value = '<img src=x onerror=1>';
  palSearch();
  const injected = document.querySelectorAll('#palResults img').length;
  const empty = !!document.querySelector('.pal-empty');
  palClose();
  return { injected, empty };
`), { injected: 0, empty: true })

// The half that IS about escaping, and the only one that can be: a name from
// the corpus rendered through the marker. Driven by calling `palMark` with a
// hostile name directly, because no schema can declare one — a model name is an
// identifier — so the guard is otherwise unreachable and would rot.
t('palette.aHostileNameIsMarkedAsText', await probe(`
  // The hostile text has to land INSIDE the marked span, not beside it: the
  // three slices are escaped separately, so a probe that put it in the leading
  // slice passes with the span's own escape removed.
  document.getElementById('palInput').value = '<img src=x onerror=1>';
  const html = palMark('<img src=x onerror=1>x', { rank: 0, at: 0 });
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return { imgs: probe.querySelectorAll('img').length, text: probe.textContent };
`), { imgs: 0, text: '<img src=x onerror=1>x' })

// …and again with the markup OUTSIDE the span. The three slices are escaped
// separately, so one row can only ever cover one of them, and a guard on the
// leading slice with no test is a guard that gets deleted.
t('palette.theUnmatchedRemainderIsTextToo', await probe(`
  document.getElementById('palInput').value = 'x';
  const html = palMark('x<img src=y onerror=1>', { rank: 0, at: 0 });
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return { imgs: probe.querySelectorAll('img').length, text: probe.textContent };
`), { imgs: 0, text: 'x<img src=y onerror=1>' })

// Nothing matched is a sentence, not an empty box. An empty list and a broken
// search look identical.
t('palette.sayingNothingMatchedIsAnAnswer', await probe(`
  await palOpen();
  document.getElementById('palInput').value = 'zzzznotathing';
  palSearch();
  const said = document.querySelector('#palResults .pal-empty')?.textContent.trim();
  palClose();
  return said;
`), 'Nothing here matches that.')

// Focus goes back where it came from. Left on a hidden input, a keyboard user is
// typing into nothing.
t('palette.focusGoesBackWhereItCameFrom', await probe(`
  const anchor = document.getElementById('navAccess');
  anchor.focus();
  await palOpen();
  palClose();
  return document.activeElement === anchor;
`), true)

t('consoleErrors', consoleErrors, [])

// ─── report ───────────────────────────────────────────────────────────────

let failed = 0
for (const { name, actual, expected } of results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`)
}

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${results.length} assertions passed`)

try { browser.close() } catch {}
cleanup()
process.exit(failed ? 1 : 0)
