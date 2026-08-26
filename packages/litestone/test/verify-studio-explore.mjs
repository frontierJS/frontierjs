/*
 * verify-studio-explore.mjs — the Explore panel, in a browser.
 *
 * Explore is a claim about COMPLETENESS: every word of the .lite language, with
 * the ones this schema does not use dimmed rather than hidden. Nothing about
 * that is provable by reading the file, and the failure mode is silence — a
 * word that stops rendering looks exactly like a word nobody uses.
 *
 *   node packages/litestone/test/verify-studio-explore.mjs
 *
 * Starts and stops its own server on 5098 — nothing to launch first. Needs
 * Chrome on PATH or $FJS_CHROME.
 *
 * The server is spawned from `src/tools/cli.js` by path rather than through
 * `bunx litestone`, because bun resolves a workspace dependency to a COPY under
 * node_modules/.bun: a drive run through the binary would test the tree as it
 * was at the last install and pass against a broken working copy.
 *
 * Traps inherited from verify-studio-access.mjs: never return a bare `null`
 * from a probe (CDP serialises it with no `value` key and it reads back as
 * `undefined`), and never assert against a poll without awaiting it.
 */

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'
import { CATALOG, docFor, UNDOCUMENTED } from '../src/core/catalog.js'
import { RULES, VISIBILITY } from '../src/core/advise.js'
import { OPPORTUNITIES } from '../src/core/opportunities.js'

const PORT   = process.env.STUDIO_PORT ?? '5098'
const UI     = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const REPO   = pathResolve(import.meta.dirname, '../../..')
const SCHEMA = join(REPO, 'example/db/schema.lite')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the server, started and stopped by this file ─────────────────────────

const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')
const studio = spawn('bun', [CLI, 'studio', '--schema', SCHEMA, '--port', PORT], {
  cwd: join(REPO, 'example/db'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let studioOut = ''
studio.stdout.on('data', d => { studioOut += d })
studio.stderr.on('data', d => { studioOut += d })

// Everything this run started, torn down from one place. Chrome joins the set
// once it is spawned, below — before this, cleanup() killed the studio server
// and left the browser, which does not notice its launcher has gone: it is
// reparented to init and stays up forever, holding a profile that keeps
// growing. Four of them were found alive here, and 52 profiles in one day
// (FJS-361). Synchronous throughout — an exit handler cannot await.
let chromeProc = null
let chromeProfile = null
function cleanup() {
  try { process.kill(-studio.pid) } catch {}
  if (chromeProc) { try { chromeProc.kill('SIGKILL') } catch {} ; chromeProc = null }
  if (chromeProfile) {
    // The wait is not optional. Removing the profile straight after the kill
    // does not fail, it SUCCEEDS, and Chrome writes the directory back while
    // it shuts down — measured in mesa's drive.mjs, where 0ms left 16MB back
    // on disk and 200ms did not. An exit handler cannot await, so block.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    chromeProfile = null
  }
}
process.on('exit', cleanup)
process.on('SIGINT',  () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
// The default handler for either of these exits without an ordinary exit path.
process.on('uncaughtException',  (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${UI}/api/catalog`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 500))
  if (i === 59) { console.error('studio never came up:\n' + studioOut); process.exit(1) }
}

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
  chrome.stderr.on('data', (d) => {
    buf += d
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


await cmd('Page.navigate', { url: UI + '/#explore' })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.querySelector('#exBody .ex-box')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

// ─── the panel opens from the URL ─────────────────────────────────────────

t('panel.visible', await evaluate(`return !document.getElementById('panelExplore').hidden`), true)
t('nav.current',   await evaluate(`return document.getElementById('navExplore').getAttribute('aria-current')`), 'page')

// ─── every word is on the page ────────────────────────────────────────────
//
// The count comes from the served catalog, never from a number written here:
// a drive that restates the total passes the day a word stops rendering AND
// stops being served, which is the pair most likely to move together.

t('catalog.served', await evaluate(`return (await api('/catalog')).catalog.length > 0`), true)

// The expectation is the MODULE's own count, read in node — not a literal, and
// not the served list either. Comparing the browser against the server alone
// passes the day a word stops being rendered AND stops being served, which is
// the pair most likely to move together.
const DECLARATIONS = CATALOG.filter(r => r.level === 'schema').length

t('home.declarationBoxes', await evaluate(`
  const served = _catalog.filter(r => r.level === 'schema').length;
  const boxes = [...document.querySelectorAll('#exBody section')][0].querySelectorAll('.ex-box').length;
  return { served, boxes };
`), { served: DECLARATIONS, boxes: DECLARATIONS })

t('home.everyGroupBoxed', await evaluate(`
  const groups = new Set(_catalog.filter(r => r.level !== 'schema').map(r => r.level + ':' + r.group));
  // Sections 2 and 3 are the attribute groups; section 4 is the interview and
  // the rule set, which are not groups.
  const boxes  = [...document.querySelectorAll('#exBody section')].slice(1, 3)
    .reduce((n, s) => n + s.querySelectorAll('.ex-box').length, 0);
  return { groups: groups.size, boxes };
`), await (async () => {
  const cat = await (await fetch(`${UI}/api/catalog`)).json()
  const groups = new Set(cat.catalog.filter(r => r.level !== 'schema').map(r => r.level + ':' + r.group))
  return { groups: groups.size, boxes: groups.size }
})())

// ─── a word with nothing behind it is DIMMED, not hidden ──────────────────
//
// The whole panel rests on this: a grey box is the only way someone finds a
// feature they have never heard of, and `hidden` or `disabled` would take it
// out of reach exactly where it is needed.

t('empty.dimmedNotHidden', await evaluate(`
  const boxes = [...document.querySelectorAll('#exBody .ex-box')];
  const empty = boxes.filter(b => b.dataset.empty === 'true');
  return {
    some:      empty.length > 0,
    visible:   empty.every(b => b.offsetParent !== null),
    clickable: empty.every(b => !b.disabled),
    faded:     empty.every(b => parseFloat(getComputedStyle(b).opacity) < 1),
  };
`), { some: true, visible: true, clickable: true, faded: true })

// Which words the fixture leaves unused is the fixture's business — naming them
// here makes the drive red the day somebody adds a view to example/. What has to
// hold is the LINK: a box is grey exactly when its count is zero.
t('empty.greyMatchesTheCount', await evaluate(`
  const use   = exUsage();
  const boxes = [...document.querySelectorAll('#exBody section')][0].querySelectorAll('.ex-box');
  const wrong = [...boxes].filter(b => {
    const word = b.querySelector('.ex-word').textContent;
    return (b.dataset.empty === 'true') !== ((use.get('schema:' + word) || 0) === 0);
  }).map(b => b.querySelector('.ex-word').textContent);
  return wrong;
`), [])

// ─── clicking a declaration shows cards for its instances ─────────────────

t('drill.modelCards', await evaluate(`
  exGo({ kind: 'top', word: 'model' });
  const names = [...document.querySelectorAll('#exBody .ex-card .ex-word')].map(e => e.textContent);
  const models = (schema.models || []).map(m => m.name);
  return models.every(m => names.includes(m)) && models.length > 0;
`), true)

t('drill.modelCardCarriesTheGate', await evaluate(`
  exGo({ kind: 'top', word: 'model' });
  return document.querySelector('#exBody .ex-card').textContent.includes('gate');
`), true)

t('drill.enumValues', await evaluate(`
  exGo({ kind: 'top', word: 'enum' });
  const first = (schema.enums || [])[0];
  if (!first) return 'no enum in the fixture';
  const txt = document.getElementById('exBody').textContent;
  return first.values.every(v => txt.includes(v.name ?? v));
`), true)

// A word the schema does not use opens its CARD — the teaching path, and the
// only reason a grey box is worth clicking.
t('drill.emptyWordOpensItsCard', await evaluate(`
  const use  = exUsage();
  const word = _catalog.filter(r => r.level === 'schema').map(r => r.word)
    .find(w => (use.get('schema:' + w) || 0) === 0);
  if (!word) return 'the fixture uses every declaration — nothing to walk';
  exGo({ kind: 'top', word });
  const txt = document.getElementById('exBody').textContent;
  return { card: !!document.querySelector('#exBody .ex-card'), says: txt.includes('not used here') };
`), { card: true, says: true })

// ─── trait and import are counted off the FILE, not the parse ─────────────
//
// Both are erased at parse — spliced and inlined — so both read zero against
// db.$schema however many the file holds. Counting them off the source is the
// one place the panel may not trust the parse.

t('erased.countedFromSource', await evaluate(`
  const src = (await api('/schema-source')).source;
  const traits  = (src.match(/^[ \\t]*trait[ \\t]+[A-Za-z_]/gm)  || []).length;
  const imports = (src.match(/^[ \\t]*import[ \\t]+["']/gm)      || []).length;
  const use = exUsage();
  return {
    parseSaysZero: (schema.traits || []).length === 0 && (schema.imports || []).length === 0,
    trait:  use.get('schema:trait')  === traits,
    import: use.get('schema:import') === imports,
  };
`), { parseSaysZero: true, trait: true, import: true })

// ─── attribute usage is counted, and the written word wins ────────────────
//
// @@unique parses to `uniqueIndex` and @allow on a field to `fieldAllow`. The
// catalog is keyed by what you type, so the walker has to translate or those
// two words are permanently zero while the schema plainly uses them.

t('usage.writtenWordNotNodeKind', await evaluate(`
  const use = exUsage();
  const declaredUnique = (schema.models || [])
    .reduce((n, m) => n + (m.attributes || []).filter(a => a.kind === 'uniqueIndex').length, 0);
  return { translated: (use.get('model:unique') || 0) === declaredUnique, none: use.get('model:uniqueIndex') === undefined };
`), { translated: true, none: true })

// db.$schema is the AUGMENTED parse: it carries a log model per logger database
// and a stub per view, so a count taken off it reports declarations nobody made.
// That is the same class of lie as counting `trait` off the parse, and it is the
// only panel where it matters.
t('usage.excludesWhatLitestoneWrote', await evaluate(`
  const gen = exGenerated();
  const use = exUsage();
  const own = (schema.models || []).filter(m => !gen.has(m.name));
  return {
    someGenerated: gen.size > 0,
    modelCount:    use.get('schema:model') === own.length,
    idPerOwnModel: (use.get('field:id') || 0) === own.length,
  };
`), { someGenerated: true, modelCount: true, idPerOwnModel: true })

t('usage.generatedModelIsShownAndLabelled', await evaluate(`
  exGo({ kind: 'top', word: 'model' });
  const gen = [...exGenerated()][0];
  const card = [...document.querySelectorAll('#exBody .ex-card')].find(c => c.textContent.includes(gen));
  return { listed: !!card, labelled: card.textContent.includes('generated') };
`), { listed: true, labelled: true })

// ─── search reaches both the language and this schema ─────────────────────

t('search.findsAWord', await evaluate(`
  exGo({ kind: 'home' });
  const box = document.getElementById('exSearch');
  box.value = 'full-text'; exRender();
  return document.getElementById('exBody').textContent.includes('@@fts');
`), true)

t('search.findsADeclaredThing', await evaluate(`
  const first = (schema.models || [])[0].name;
  const box = document.getElementById('exSearch');
  box.value = first; exRender();
  return document.getElementById('exBody').textContent.includes(first);
`), true)

t('search.emptyIsSaidRatherThanBlank', await evaluate(`
  const box = document.getElementById('exSearch');
  box.value = 'zzzznothing'; exRender();
  return document.querySelector('#exBody .empty-text') !== null;
`), true)

// ─── the way out: placement, not a blind append ───────────────────────────
//
// Appending @@fts to the end of the file writes a second model called Example,
// which is not what anybody meant by "add full-text search". The card asks which
// model, and the insert is surgery on the editor's current text.

t('insert.modelAttributeLandsInsideTheChosenModel', await evaluate(`
  const box = document.getElementById('exSearch'); box.value = ''; exRender();
  await liteInit();
  const before = document.getElementById('liteEditor').value;
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;

  exGo({ kind: 'word', word: 'fts', level: 'model' });
  document.getElementById('exTargetModel').value = target;
  await exApply('fts', 'model', { model: target });

  const ta = document.getElementById('liteEditor');
  const block = exFindBlock(ta.value, 'model', target);
  const at = ta.value.indexOf('@@fts');
  return {
    grew:    ta.value.length > before.length,
    inside:  at > block.open && at < block.close,
    once:    (ta.value.match(/@@fts/g) || []).length === 1,
    noModel: !/model Example\b/.test(ta.value),
    unsaved: before === _liteSource,
  };
`), { grew: true, inside: true, once: true, noModel: true, unsaved: true })

// A field attribute goes onto the column you picked, on its own line, not as a
// new field with a name from the example.
t('insert.fieldAttributeLandsOnTheChosenField', await evaluate(`
  await liteReload();
  const model = (schema.models || []).find(m => !exGenerated().has(m.name) &&
    m.fields.some(f => f.type.kind !== 'relation' && !(f.attributes||[]).some(a => a.kind === 'omit')));
  const field = model.fields.find(f => f.type.kind !== 'relation' && !(f.attributes||[]).some(a => a.kind === 'omit')).name;

  exGo({ kind: 'word', word: 'omit', level: 'field' });
  await exApply('omit', 'field', { model: model.name, field });

  const ta = document.getElementById('liteEditor');
  const line = ta.value.split('\\n').find(l => new RegExp('^\\\\s*' + field + '\\\\b').test(l) && l.includes('@omit'));
  return { onThatLine: !!line, once: (ta.value.match(/@omit/g) || []).length === 1 };
`), { onThatLine: true, once: true })

// A word can also be the reason to write a new column — the whole example line
// goes in, inside the model.
t('insert.newFieldGoesInsideTheModel', await evaluate(`
  await liteReload();
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  exGo({ kind: 'word', word: 'markdown', level: 'field' });
  await exApply('markdown', 'field', { model: target, where: 'newField' });

  const ta = document.getElementById('liteEditor');
  const block = exFindBlock(ta.value, 'model', target);
  const at = ta.value.indexOf('@markdown');
  return { inside: at > block.open && at < block.close };
`), { inside: true })

// A brace inside a string must not close the model early.
//
// The fixture's own template-quoted @generated is `{a} {b}`, which is BALANCED,
// so a naive counter agrees with the scanner on it and proves nothing. The
// shape that breaks a counter is an unbalanced brace inside a quote — legal in
// a @check or an @@sql — so the scanner is put against one directly, and the
// naive count is run beside it to show the two genuinely disagree.
t('insert.bracesInsideStringsDoNotCloseTheBlock', await evaluate(`
  const src = [
    'model Probe {',
    '  id   Int    @id',
    '  path String @check("path LIKE \\'%{%\\'")',
    '  name String',
    '}',
    '',
    'model After { id Int @id }',
  ].join('\\n');

  const b = exFindBlock(src, 'model', 'Probe');

  let depth = 0, naive = -1;
  for (let i = b.open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { naive = i; break } }
  }

  const row  = _catalog.find(r => r.word === 'fts' && r.level === 'model');
  const plan = exPlan(src, row, { model: 'Probe' });
  const at   = plan.src.indexOf('@@fts');
  const b2   = exFindBlock(plan.src, 'model', 'Probe');

  return {
    naiveIsWrong:     naive !== b.close,   // here it runs off the end (-1); an extra '}' would close early
    scannerHoldsName: src.slice(b.open, b.close).includes('name String'),
    insertInside:     at > b2.open && at < b2.close,
    afterUntouched:   plan.src.includes('model After { id Int @id }'),
  };
`), { naiveIsWrong: true, scannerHoldsName: true, insertInside: true, afterUntouched: true })

// And the fixture's real brace-in-a-template is handled too.
t('insert.fixtureTemplateBracesAreFine', await evaluate(`
  await liteReload();
  const src = document.getElementById('liteEditor').value;
  const quoted = /['"\\x60][^\\n'"\\x60]*[{}]/;
  const owner = (schema.models || []).map(m => ({ m, b: exFindBlock(src, 'model', m.name) }))
    .find(x => x.b && quoted.test(src.slice(x.b.open, x.b.close)));
  if (!owner) return 'no fixture model puts a brace inside a string';
  const body = src.slice(owner.b.open, owner.b.close);
  const last = owner.m.fields.filter(f => f.type.kind !== 'relation').slice(-1)[0];
  return { closesAfterTheString: owner.b.close > body.search(quoted) + owner.b.open,
           lastFieldInside: body.includes(last.name) };
`), { closesAfterTheString: true, lastFieldInside: true })

// Handing the text over IS the handoff: the editor's own input handler runs the
// live validation and queues the schema diff, so nothing here restates them.
t('insert.editorValidatesWhatWasInserted', await evaluate(`
  await liteReload();
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  exGo({ kind: 'word', word: 'markdown', level: 'field' });
  await exApply('markdown', 'field', { model: target, where: 'newField' });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const text = document.getElementById('liteStatusText').textContent;
    if (/Valid|error|warning/i.test(text))
      return { reported: true, saveOffered: !document.getElementById('liteSaveBtn').disabled, unsaved: document.getElementById('liteEditor').value !== _liteSource };
    await new Promise(r => setTimeout(r, 100));
  }
  return 'the editor never reported on the inserted text';
`), { reported: true, saveOffered: true, unsaved: true })

// A model the file does not hold — an imported one — is refused by name rather
// than appended somewhere it will not help.
t('insert.unknownModelIsRefused', await evaluate(`
  await liteReload();
  const row = _catalog.find(r => r.word === 'fts' && r.level === 'model');
  const plan = exPlan(document.getElementById('liteEditor').value, row, { model: 'NoSuchModel' });
  return { refused: !!plan.error, named: (plan.error || '').includes('NoSuchModel'), untouched: !plan.src };
`), { refused: true, named: true, untouched: true })

await evaluate(`await liteReload(); return true`)

// ─── the consequence preview ──────────────────────────────────────────────
//
// The point of the panel is that a word's effects are visible BEFORE the write.
// Four engines answer for it and each is asked against the proposed text, so
// what is asserted here is that they disagree with the current schema in the
// ways the language says they should.

// Raising a gate takes reads away from a release that is still serving them, so
// it is a contract for the deploy AND a narrowing of who may do what — the two
// axes that disagree by construction, which is why both are shown.
//
// Every fixture model already declares a gate, so this raises one rather than
// adding one, and the proposed text is built here: exPlan only ever inserts.
t('preview.raisingAGateIsContractAndNarrows', await evaluate(`
  await liteReload();
  const src   = document.getElementById('liteEditor').value;
  const model = (schema.models || []).find(m => !exGenerated().has(m.name) &&
    (m.attributes || []).some(a => a.kind === 'gate' && String(a.value).split('.').every(n => Number(n) < 7)));
  if (!model) return 'no fixture model has a gate that can be raised';

  const b   = exFindBlock(src, 'model', model.name);
  const cur = (model.attributes.find(a => a.kind === 'gate').value + '').trim();
  const body = src.slice(b.open, b.close).replace('@@gate("' + cur + '")', '@@gate("7")');
  const proposed = src.slice(0, b.open) + body + src.slice(b.close);

  const p = await api('/preview', { source: proposed, model: model.name });
  return {
    deploy:  p.release.verdict,
    reach:   p.reach.verdict,
    raised:  p.access.before.gateSource !== p.access.after.gateSource,
    unsaved: document.getElementById('liteEditor').value === _liteSource,
  };
`), { deploy: 'contract', reach: 'narrows', raised: true, unsaved: true })

// A canned example names fields a chosen model may not have, and the preview is
// what says so — before the insert rather than after the save.
t('preview.exampleNamingMissingFieldsIsRefusedByName', await evaluate(`
  await liteReload();
  const target = (schema.models || []).find(m => !exGenerated().has(m.name) &&
    !(m.attributes || []).some(a => a.kind === 'fts') &&
    !m.fields.some(f => f.name === 'title'));
  exGo({ kind: 'word', word: 'fts', level: 'model' });
  await exPreviewPlan('fts', 'model', { model: target.name });
  return {
    refused: _exPreview.valid === false,
    names:   (_exPreview.errors || []).join(' ').includes('title'),
    shown:   document.getElementById('exPreview').textContent.includes('does not parse'),
  };
`), { refused: true, names: true, shown: true })

// @@fts emits a VIRTUAL table and nothing else, which is the case that found a
// real gap: the DDL pane asked for the table and its indexes by hand and could
// see neither the FTS index nor the updatedAt trigger, so adding @@fts previewed
// as no change at all. generateModelDDL is the one owner now, and generateDDL
// calls it too.
t('preview.ftsShowsItsVirtualTable', await evaluate(`
  const src   = document.getElementById('liteEditor').value;
  const model = (schema.models || []).find(m => !exGenerated().has(m.name) &&
    !(m.attributes || []).some(a => a.kind === 'fts') &&
    m.fields.some(f => f.type.name === 'String' && f.type.kind === 'scalar'));
  const col   = model.fields.find(f => f.type.name === 'String' && f.type.kind === 'scalar').name;

  const b = exFindBlock(src, 'model', model.name);
  const at = src.lastIndexOf('\\n', b.close) + 1;
  const proposed = src.slice(0, at) + '  @@fts([' + col + '])\\n' + src.slice(at);

  const p = await api('/preview', { source: proposed, model: model.name });
  return {
    valid:        p.valid,
    ddlChanged:   p.ddl.before !== p.ddl.after,
    virtualTable: /CREATE VIRTUAL TABLE/.test(p.ddl.after || ''),
    deploy:       p.release.verdict,
  };
`), { valid: true, ddlChanged: true, virtualTable: true, deploy: 'unchanged' })

t('preview.aRequiredColumnIsAContract', await evaluate(`
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  exGo({ kind: 'word', word: 'email', level: 'field' });
  await exPreviewPlan('email', 'field', { model: target, where: 'newField' });
  return {
    deploy:     _exPreview.release.verdict,
    ddlChanged: _exPreview.ddl.before !== _exPreview.ddl.after,
    jsonChanged: JSON.stringify(_exPreview.json.before) !== JSON.stringify(_exPreview.json.after),
  };
`), { deploy: 'contract', ddlChanged: true, jsonChanged: true })

// parse() is more permissive than the layers above it. A gate string it accepts
// and deriveAccess refuses used to come back as a bare 500 that said nothing
// about the other three realms.
t('preview.aRefusedPaneIsNamedRatherThan500', await evaluate(`
  const row    = _catalog.find(r => r.word === 'fts' && r.level === 'model');
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  const bad    = document.getElementById('liteEditor').value
    .replace('model ' + target + ' {', 'model ' + target + ' {\\n  @@gate("4.2.4.5")');

  const res = await fetch(API + '/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ source: bad, model: target }),
  });
  const p = await res.json();
  return {
    status:   res.status,
    valid:    p.valid,
    named:    (p.rejected || []).some(r => r.pane.startsWith('access')),
    ddlStill: typeof p.ddl.after === 'string',
  };
`), { status: 200, valid: true, named: true, ddlStill: true })

// A pane that could not be computed shows the reason. With `after` null a
// removed value and a refused derivation render identically, and while a schema
// is being written the second is the likelier of the two.
t('preview.refusedPaneRendersTheReasonNotADiff', await evaluate(`
  _exPreview = {
    valid: true, ddl: { before: 'a', after: 'b' },
    access: { before: { gate: 1 }, after: null }, json: { before: null, after: null },
    release: null, reach: null, warnings: [],
    rejected: [{ pane: 'access (after)', message: 'levels must be non-decreasing' }],
  };
  exRenderPreview();
  const txt = document.getElementById('exPreview').textContent;
  return { reason: txt.includes('non-decreasing'), notDecidable: txt.includes('not decidable') };
`), { reason: true, notDecidable: true })

// A word that changes none of the three derived surfaces says so, rather than
// showing three empty panes that read as a broken preview.
t('preview.quietWordSaysSo', await evaluate(`
  await liteReload();
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  const field  = (schema.models || []).find(m => m.name === target)
    .fields.find(f => f.type.kind !== 'relation' && !(f.attributes||[]).some(a => a.kind === 'omit')).name;
  exGo({ kind: 'word', word: 'omit', level: 'field' });
  await exPreviewPlan('omit', 'field', { model: target, field });
  return document.getElementById('exPreview').textContent.includes('changes none of the three');
`), true)

// Preview must not write. It is the whole difference between this and Insert.
t('preview.neverTouchesTheEditor', await evaluate(`
  await liteReload();
  showTool('explore');
  const before = document.getElementById('liteEditor').value;
  const target = (schema.models || []).find(m => !exGenerated().has(m.name)).name;
  exGo({ kind: 'word', word: 'fts', level: 'model' });
  await exPreviewPlan('fts', 'model', { model: target });
  return { editorUntouched: document.getElementById('liteEditor').value === before,
           stillOnExplore:  !document.getElementById('panelExplore').hidden };
`), { editorUntouched: true, stillOnExplore: true })

await evaluate(`await liteReload(); return true`)

// ─── where a word is legal ────────────────────────────────────────────────
//
// `level` says which switch parses a word; it is not the same question as where
// the word is LEGAL, and the panel has to answer the second one — @id is a
// model's field and nothing else, @label reaches an enum member.

t('positions.servedPerRow', await evaluate(`
  const cat = await api('/catalog');
  const by  = w => cat.catalog.find(r => r.word === w && r.level === 'field').positions;
  return {
    id:     by('id').join(' '),
    label:  by('label').join(' '),
    length: by('length').join(' '),
    named:  Object.keys(cat.positions).length,
  };
`), { id: 'field', label: 'field typeField traitField enumMember',
      length: 'field typeField traitField', named: 6 })

// The interesting answer is the NARROW one. A word legal everywhere its level
// allows says nothing, or every card would carry a badge nobody reads.
t('positions.onlyTheNarrowOnesAreBadged', await evaluate(`
  showTool('explore');
  const narrow = () => { exGo({ kind: 'word', word: 'id', level: 'field' });
    return document.querySelector('#exBody .ex-card').textContent; };
  const wide   = () => { exGo({ kind: 'word', word: 'length', level: 'field' });
    return document.querySelector('#exBody .ex-card').textContent; };
  const n = narrow(), w = wide();
  return { narrowSaysOnly: n.includes('only'), wideSaysNothing: !w.includes('only') };
`), { narrowSaysOnly: true, wideSaysNothing: true })

t('positions.enumMemberIsNamedOnTheLabelCard', await evaluate(`
  exGo({ kind: 'word', word: 'label', level: 'field' });
  return document.querySelector('#exBody .ex-card').textContent.includes('enum member');
`), true)

// ─── the interview ────────────────────────────────────────────────────────
//
// The index answers "what is this word". This answers the question people
// arrive with: *I need a column nobody may read — what do I write?* It is a
// lookup into litestone's own visibility table, not a tree drawn beside it.

t('interview.reachableFromHome', await evaluate(`
  showTool('explore');
  exGo({ kind: 'home' });
  const box = [...document.querySelectorAll('#exBody .ex-box')]
    .find(b => b.textContent.includes('Which word do I want'));
  box.click();
  return { opened: _exView.kind === 'interview',
           asks: document.querySelectorAll('#exBody .ex-card').length >= 4 };
`), { opened: true, asks: true })

t('interview.holdsBackUntilAllThreeAreAnswered', await evaluate(`
  exGo({ kind: 'interview' });
  _ivAnswer = { stored: null, callerWrites: null, callerReads: null, perCaller: false };
  exRender();
  const before = document.getElementById('exBody').textContent.includes('more to answer');
  exAnswer('callerReads', false);
  exAnswer('callerWrites', false);
  const still = document.getElementById('exBody').textContent.includes('more to answer');
  exAnswer('stored', true);
  const after = document.getElementById('exBody').textContent.includes('more to answer');
  return { before, still, after };
`), { before: true, still: true, after: false })

// The four rows people confuse, walked as answers. These are the parser's own
// table: no column + caller reads is @computed, no column + caller writes is
// @transient, column + only the app writes is @system, column + neither is
// @guarded.
t('interview.landsOnTheParserOwnTable', await evaluate(`
  const ask = (stored, callerWrites, callerReads) => {
    _ivAnswer = { stored, callerWrites, callerReads, perCaller: false };
    exRender();
    // The LAST heading: the first one belongs to the questions.
    const hs = document.querySelectorAll('#exBody .section-header h2');
    return hs[hs.length - 1].textContent.trim();
  };
  exGo({ kind: 'interview' });
  return {
    computed:  ask(false, false, true),
    transient: ask(false, true,  false),
    system:    ask(true,  false, true),
    guarded:   ask(true,  false, false),
    encrypted: ask(true,  true,  false),
  };
`), { computed: '@computed', transient: '@transient', system: '@system', guarded: '@guarded', encrypted: '@encrypted' })

// A combination with no word must say what it is rather than answering nothing.
t('interview.aCombinationWithNoWordSaysWhy', await evaluate(`
  exGo({ kind: 'interview' });
  _ivAnswer = { stored: true, callerWrites: true, callerReads: true, perCaller: false };
  exRender();
  const ordinary = document.getElementById('exBody').textContent.includes('ordinary column');
  _ivAnswer = { stored: false, callerWrites: true, callerReads: true, perCaller: false };
  exRender();
  const cannot = document.getElementById('exBody').textContent.includes('not expressible');
  return { ordinary, cannot };
`), { ordinary: true, cannot: true })

// "It depends who is asking" is not a fourth axis — it multiplies with every
// row rather than partitioning them, so it is shown BESIDE the answer.
t('interview.perCallerIsShownBesideTheAnswer', await evaluate(`
  exGo({ kind: 'interview' });
  _ivAnswer = { stored: true, callerWrites: false, callerReads: true, perCaller: true };
  exRender();
  const txt = document.getElementById('exBody').textContent;
  return { keptTheWord: txt.includes('@system'), addedThePolicy: txt.includes("@allow('read'") };
`), { keptTheWord: true, addedThePolicy: true })

// The one line on a card that leads OUT of the catalog. Named rather than
// linked: the docs ship inside the package, and Studio serves the app.

t('card.saysWhereToReadMore', await evaluate(`
  exGo({ kind: 'word', level: 'model', word: 'fts' });
  const card = document.querySelector('.ex-card');
  const doc  = card && card.querySelector('.ex-doc');
  return { text: doc ? doc.textContent.replace(/\\s+/g, ' ').trim() : null };
`), { text: 'read more · docs/full-text-search.md in @frontierjs/litestone' })

// The negative case carries the card count with it. Asking only whether
// `.ex-doc` is absent passes against a page that rendered no card at all —
// which is exactly what a wrong `kind:` did to the assertion above.
t('card.aWordWithNoPageShowsNoLine', await evaluate(`
  exGo({ kind: 'word', level: 'field', word: 'check' });
  const card = document.querySelector('.ex-card');
  return { card: !!card, doc: !!(card && card.querySelector('.ex-doc')) };
`), { card: true, doc: false })

// ─── legal and wrong ──────────────────────────────────────────────────────
//
// Every rule fires on a schema the parser accepts — that is the class, and it
// is the one thing the panel can say about a schema nobody is editing.

t('rules.servedAndReachable', await evaluate(`
  const a = await api('/advise');
  exGo({ kind: 'rules' });
  return { table: a.visibility.length, rules: a.rules.length,
           rendered: document.getElementById('exBody').textContent.length > 0 };
`), { table: VISIBILITY.length, rules: RULES.length, rendered: true })

// ─── declared by nobody ───────────────────────────────────────────────────
//
// The question no generated artefact can ask, and the one this whole panel
// exists for: not what did you declare, but what could you have and did not.

t('missing.servedBesideTheRules', await evaluate(`
  const a = await api('/advise');
  exGo({ kind: 'rules' });
  const text = document.getElementById('exBody').textContent;
  return { checks: a.opportunities.length,
           bothRendered: text.includes('Legal and worth a look') && text.includes('Declared by nobody') };
`), { checks: OPPORTUNITIES.length, bothRendered: true })

t('missing.everyFindingRoutesToItsWord', await evaluate(`
  const a = await api('/advise');
  exGo({ kind: 'rules' });
  const btns = [...document.querySelectorAll('.ex-missing-word')].map(b => b.textContent.trim());
  // Every finding offers its word, and every word offered is one the catalog
  // knows — a route that lands nowhere is worse than no route.
  const known = btns.every(w => _catalog.some(r =>
    r.word === w.replace(/^@@?/, '') &&
    r.level === (w.startsWith('@@') ? 'model' : w.startsWith('@') ? 'field' : 'schema')));
  return { count: btns.length, findings: a.missing.length, known };
`), await (async () => {
  const a = await (await fetch(`${UI}/api/advise`)).json()
  return { count: a.missing.length, findings: a.missing.length, known: true }
})())

t('missing.theWordOpensItsCard', await evaluate(`
  exGo({ kind: 'rules' });
  const btn = document.querySelector('.ex-missing-word');
  if (!btn) return { clicked: false };
  const word = btn.textContent.trim();
  btn.click();
  const card = document.querySelector('.ex-card .ex-word');
  return { clicked: true, landedOn: card ? card.textContent.trim() : null, asked: word };
`), await (async () => {
  const a = await (await fetch(`${UI}/api/advise`)).json()
  return { clicked: true, landedOn: a.missing[0].word, asked: a.missing[0].word }
})())

t('rules.aLegalButWrongEditIsReported', await evaluate(`
  await liteReload();
  const src   = document.getElementById('liteEditor').value;
  const model = (schema.models || []).find(m => !exGenerated().has(m.name));
  const b     = exFindBlock(src, 'model', model.name);
  const at    = src.lastIndexOf('\\n', b.close) + 1;
  const proposed = src.slice(0, at) + '  secretToken String @guarded\\n' + src.slice(at);

  const p = await api('/preview', { source: proposed, model: model.name });
  const hit = (p.rules || []).find(f => f.id === 'required-guarded-uncreatable');
  return { parses: p.valid, reported: !!hit, isNew: hit ? hit.preexisting === false : null,
           severity: hit?.severity };
`), { parses: true, reported: true, isNew: true, severity: 'error' })

// A finding already true of the file is marked, because a warning that was
// there before this edit is not this edit's fault.
t('rules.preexistingFindingsAreMarked', await evaluate(`
  const src = document.getElementById('liteEditor').value;
  const p = await api('/preview', { source: src, model: null });
  const before = (await api('/advise')).findings;
  return { same: (p.rules || []).length === before.length,
           allMarked: (p.rules || []).every(f => f.preexisting === true) };
`), { same: true, allMarked: true })

t('rules.previewShowsThem', await evaluate(`
  await liteReload();
  const src   = document.getElementById('liteEditor').value;
  const model = (schema.models || []).find(m => !exGenerated().has(m.name));
  const b     = exFindBlock(src, 'model', model.name);
  const at    = src.lastIndexOf('\\n', b.close) + 1;
  // exGo clears the preview — a new card must not show the last one's answer —
  // so the card is opened first and the answer put in after.
  exGo({ kind: 'word', word: 'guarded', level: 'field' });
  _exPreview = await api('/preview', { source: src.slice(0, at) + '  tok String @guarded\\n' + src.slice(at), model: model.name });
  exRenderPreview();
  return document.getElementById('exPreview').textContent.includes('uncreatable');
`), true)

await evaluate(`await liteReload(); return true`)

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
