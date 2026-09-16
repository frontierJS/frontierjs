/*
 * verify-automations.mjs — orion's screens, mounted at /automations/, against a
 * real shop.
 *
 * `IDEAS/orion-port.md` phase 7. Orion's suites prove the engine, the services
 * and tenancy through a real Junction app; what none of them can see is the
 * package's `.mesa` routes compiled in THIS app's Vite root and driven by a
 * person: a flow drafted in the drawer, a definition the compiler refuses shown
 * with the compiler's own sentence, an activation, a write somewhere else in
 * the shop starting a run, and that run read back on its own page.
 *
 * **The flow is a real one.** When a Customer is created, a `model.patch` writes
 * a note onto that customer, as the flow's owner. So the run is graded by
 * `Customer`'s own `@@gate` and its field `@allow`, and the note is read back
 * off the row rather than off the run — a run that says `completed` over a
 * write the boundary dropped is the failure this is shaped to catch.
 *
 * **Who reads it is a pair.** Alex (ADMINISTRATOR, 5) owns the flow and reads its
 * runs. Sam (staff) and Robin (a shopper) are both USER(4) and read none of it —
 * not the flow, not the run, not the customer row its trigger holds — and a pause
 * either asks for is refused as not found (`FJS-D295`). The owner's reads above
 * are the other half of every refusal below.
 *
 * **Who drafts is a pair too.** Sam drafts a flow and Robin is refused one, since
 * the shop narrows orion's USER(4) create to staff (`FJS-1169`). Alex then
 * activates Sam's flow and watches its run arrive on the open runs screen — a
 * run on somebody ELSE's flow, which reaches an administrator's live store only
 * because the row policy reads the level (`FJS-1170`, `FJS-D296`).
 *
 *   bun run verify:automations
 *
 * Starts and stops its own API and its own web server, and seeds first. Needs
 * Chrome on PATH or $FJS_CHROME. Signs in four times, inside the login
 * limiter's ten.
 *
 * **It leaves nothing active.** An active flow on `Customer` create would patch
 * every customer every other drive creates, so the run opens by archiving any
 * flow an earlier run of this drive left behind, and closes by archiving its
 * own — as Alex, since pausing another person's flow is an administrator's.
 *
 * Harness rules, repeated from verify-payroll.mjs: never return a bare `null`
 * from a probe (CDP omits `value`, so it reads back as `undefined`), and never
 * start an evaluated expression with `return` on its own line.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE   = dirname(fileURLToPath(import.meta.url))
const ROOT   = join(HERE, '../..')
const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// Every flow this drive writes carries it, which is how the next run finds the
// ones a crashed run left active.
const PREFIX = 'verify:automations'
// Imported by the page through its real path, which is where the host's Vite
// resolved the mounted route's own import to.
const FLOW_MODULE = '/@fs' + join(ROOT, '../packages/orion/web/resources/Flow.mesa')
const RUN_ID = Date.now().toString(36)
const NOTE   = 'Welcomed by an automation'

// ─── servers ──────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  // `detached`, so stopAll can signal the GROUP — `npx vite` is a launcher and
  // SIGTERM to the handle here leaves vite itself holding the port.
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

async function waitForServer(url, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

if (!await waitForServer(`${API}/api/health`, 'api')) { stopAll(); process.exit(1) }
if (!await waitForServer(UI, 'web'))                 { stopAll(); process.exit(1) }

// An API booted without orion answers every screen here with `Service 'flows'
// not found`, which reads like an empty list.
const mounted = await (await fetch(`${API}/api/manifest`)).json()
const names   = (mounted.services ?? []).map(s => s.name)
for (const want of ['flows', 'runs', 'flowCredentials', 'customers']) {
  if (!names.includes(want)) {
    console.error(`the API is up and does not serve '${want}' — it booted without orion installed.`)
    stopAll(); process.exit(1)
  }
}

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-automations-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })
process.on('exit', () => { try { chrome.kill('SIGTERM') } catch {} })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const noise   = []

function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 60000)
  })
}

browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    noise.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
    noise.push('error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** Navigate and wait for the shell — the SPA boots once and routes after. */
async function go(path) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  await evaluate(`
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (document.querySelector('#app .shell')) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('the app never mounted at ${path}');
  `)
}

/** Wait until `probe` (an expression) is truthy, answering whether it became so. */
const until = (probe, ms = 12000) => evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < ${ms}) {
    if (${probe}) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
`)
const waitFor = (sel, ms) => until(`document.querySelector(${JSON.stringify(sel)})`, ms)

// Whitespace collapsed: a StatCard's label and value are two elements, and the
// markup between them is not something a reader sees.
const text  = (sel) => evaluate(`return (document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`)
const attr  = (sel, name) => evaluate(`return document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? ''`)
const exists = (sel) => evaluate(`return Boolean(document.querySelector(${JSON.stringify(sel)}))`)
const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); return true`)

/** A bound control only hears an input event, not an assigned value. */
const type = (sel, value) => evaluate(`
  const el = document.querySelector(${JSON.stringify(sel)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`)

const signInAs = (email) => evaluate(`
  const { signOut, signIn, session } = await import('/src/session.js');
  if (session.user) await signOut();
  await signIn(${JSON.stringify(email)}, 'correct-horse-battery');
  return true;
`)

/** Every flow this drive left, archived. Answers how many it moved. */
const archiveLeftovers = () => evaluate(`
  const { flows } = await import(${JSON.stringify(FLOW_MODULE)});
  const found = await flows.service.find({ status: { in: ['draft', 'active', 'paused'] } }, { limit: 200 });
  const rows  = Array.isArray(found) ? found : found?.data ?? [];
  let moved = 0;
  for (const f of rows.filter(f => f.name.startsWith(${JSON.stringify(PREFIX)}))) {
    await flows.service.invoke('archive', f.id);
    moved++;
  }
  return moved;
`)

// A definition is JSON in the textarea until the canvas exists, so the drive
// writes one the way a person pastes one.
const lit = (value) => ({ type: 'literal', value })
const definition = (model) => ({
  name:  `${PREFIX} ${RUN_ID}`,
  nodes: {
    t:       { id: 't', type: 'trigger.model', config: { model: lit('Customer'), on: lit(['create']) } },
    welcome: { id: 'welcome', type: 'model.patch', config: {
      model: lit(model),
      id:    { type: 'ref', path: '$.trigger.record.id' },
      // Customer is `@version`, so a patch carries the revision the trigger
      // read, and a customer edited in between refuses the run's write.
      data:  { type: 'object', properties: { notes: lit(NOTE), version: { type: 'ref', path: '$.trigger.record.version' } } },
    } },
  },
  edges: [{ id: 't-welcome', from: 't', to: 'welcome' }],
})

// A throw part-way still reaches the cleanup, so a flow this run activated is
// not left patching the customers the next drive creates.
let flowId = ''
try {
  // ─── the administrator drafts ─────────────────────────────────────────────

  await go('/')
  await signInAs('alex@shop.test')
  await go('/automations/')

  t('admin.theNavOffersAutomations', await waitFor('#nav-automations', 5000), true)
  t('admin.theListRenders', await waitFor('#orion-new'), true)
  t('admin.anEarlierRunLeftNothingActive', typeof await archiveLeftovers(), 'number')

  await click('#orion-new')
  t('admin.theDrawerOpensOnTheFlowForm', await waitFor('#orion-save'), true)
  await type('form [name="name"]', `${PREFIX} ${RUN_ID}`)
  await click('#orion-save')

  t('admin.creatingLandsOnTheFlowsPage', await until(`/\\/automations\\/flows\\/[^/]+\\/$/.test(location.pathname)`), true)
  flowId = await evaluate(`return location.pathname.split('/').filter(Boolean).pop()`)
  t('admin.theNewFlowIsADraft', await until(`document.querySelector('#flow-status')?.getAttribute('data-status') === 'draft'`), true)
  t('admin.withNoVersion', await text('#flow-version'), 'Current version —')

  // ─── the compiler refuses on screen ───────────────────────────────────────
  //
  // The whole of what an author learns from a bad definition is this sentence,
  // so it is asserted to NAME the thing that was wrong rather than to exist.

  await type('#flow-definition', JSON.stringify(definition('Custmer'), null, 2))
  await click('#flow-save')
  t('compile.theRefusalIsShown', await waitFor('#flow-error'), true)
  t('compile.andNamesTheModelThatIsNotThere', (await text('#flow-error')).includes('Custmer'), true)
  t('compile.andNoVersionWasWritten', await text('#flow-version'), 'Current version —')

  await type('#flow-definition', JSON.stringify(definition('Customer'), null, 2))
  await click('#flow-save')
  t('compile.aDefinitionThatCompilesIsVersionOne',
    await until(`document.querySelector('#flow-version')?.textContent.includes('1')`), true)
  t('compile.andTheRefusalIsGone', await text('#flow-error'), '')

  // A model trigger is not a manual one, so the page does not offer to run it.
  t('admin.runNowIsNotOfferedWithoutAManualTrigger', await evaluate(`return document.querySelector('#flow-run').disabled`), true)

  // ─── activation ───────────────────────────────────────────────────────────

  t('admin.activateIsOfferedAtFive', await waitFor('#flow-activate', 4000), true)
  await click('#flow-activate')
  t('admin.theFlowIsActive', await until(`document.querySelector('#flow-status')?.getAttribute('data-status') === 'active'`), true)
  t('admin.andActivateIsNoLongerOffered', await until(`!document.querySelector('#flow-activate')`, 4000), true)

  // ─── a write elsewhere in the shop starts a run ───────────────────────────
  //
  // The runs screen is open BEFORE the customer is created, so the run arriving
  // on it is the live store and not a reload.

  await go('/automations/runs/')
  t('runs.theScreenRenders', await until(`document.querySelector('table')`), true)
  const before = await evaluate(`return [...document.querySelectorAll('[data-run]')].map(r => r.getAttribute('data-run'))`)

  const email    = `automation-${RUN_ID}@buyer.test`
  const customer = await evaluate(`
    const { customers } = await import('/src/resources/Customer.mesa');
    const c = await customers.service.create({ name: 'Automation ${RUN_ID}', firstName: 'Auto', lastName: 'Mation', email: ${JSON.stringify(email)} });
    return { id: c.id, notes: c.notes ?? 'none' };
  `)
  t('runs.theCustomerIsCreatedWithNoNote', customer.notes, 'none')

  const fresh = `[...document.querySelectorAll('[data-run]')].find(r => !${JSON.stringify(before)}.includes(r.getAttribute('data-run')))`
  t('runs.theRunArrivesWithoutAReload', await until(fresh, 15000), true)
  t('runs.andReachesCompleted', await until(`${fresh}?.querySelector('[data-status="completed"]')`, 15000), true)
  const runId = await evaluate(`return ${fresh}?.getAttribute('data-run') ?? ''`)
  t('runs.theMetricsCountIt', await until(`document.querySelector('#runs-metrics')`, 4000), true)

  // ─── the run, read back ───────────────────────────────────────────────────

  await go(`/automations/runs/${runId}/`)
  t('run.theStatusIsCompleted', await until(`document.querySelector('#run-status')?.getAttribute('data-status') === 'completed'`), true)
  t('run.theStepIsListed', await waitFor('[data-step="welcome"]'), true)
  t('run.andItCompleted', await attr('[data-step="welcome"] [data-status]', 'data-status'), 'completed')
  t('run.theTriggerNamesTheCustomer', await until(`document.body.textContent.includes(${JSON.stringify(email)})`, 4000), true)
  t('run.itRanAsTheOwner', await evaluate(`
    const { session } = await import('/src/session.js');
    return document.body.textContent.includes(String(session.user.userId ?? session.user.id));
  `), true)

  // The note is read off the CUSTOMER. The run's own status is the engine's word
  // for it; the row is the boundary's.
  t('run.theNoteIsOnTheCustomer', await evaluate(`
    const { customers } = await import('/src/resources/Customer.mesa');
    return (await customers.service.get(${customer.id})).notes ?? 'none';
  `), NOTE)

  // ─── another USER reads none of it ─────────────────────────────────────
  //
  // A flow, its runs and their triggers are read by the flow's owner and an
  // administrator (`FJS-D295`). Staff are USER(4) and so is a shopper, and a run's
  // trigger is a customer's row — the shopper reading it out of `/api/runs` while
  // `/api/customers/:id` refused them was `FJS-1167`. Every refusal here is paired
  // with the owner reading the same thing above.

  const RUN_MODULE = '/@fs' + join(ROOT, '../packages/orion/web/resources/Run.mesa')
  const readsNothing = () => evaluate(`
    const { flows } = await import(${JSON.stringify(FLOW_MODULE)});
    const { runs }  = await import(${JSON.stringify(RUN_MODULE)});
    const rows = (v) => Array.isArray(v) ? v : v?.data ?? [];
    const status = async (p) => { try { await p; return 200 } catch (e) { return e?.code ?? e?.status ?? String(e) } };
    return {
      flowListed: rows(await flows.service.find({}, { limit: 200 })).some(f => f.id === ${JSON.stringify(flowId)}),
      flow:       await status(flows.service.get(${JSON.stringify(flowId)})),
      runListed:  rows(await runs.service.find({}, { limit: 200 })).some(r => r.id === ${JSON.stringify(runId)}),
      run:        await status(runs.service.get(${JSON.stringify(runId)})),
      steps:      await status(runs.service.invoke('steps', ${JSON.stringify(runId)})),
      pause:      await status(flows.service.invoke('pause', ${JSON.stringify(flowId)})),
    };
  `)
  const NOTHING = { flowListed: false, flow: 404, runListed: false, run: 404, steps: 404, pause: 404 }

  await signInAs('sam@shop.test')
  await go(`/automations/flows/${flowId}/`)

  t('staff.theNavOffersAutomationsAtFour', await waitFor('#nav-automations', 5000), true)
  t('staff.anotherPersonsFlowIsNotFound', await waitFor('#flow-error'), true)
  t('staff.andNothingOfItIsDrawn', await exists('#flow-status'), false)
  t('staff.readNoneOfItAndAreRefusedWithoutBeingToldItExists', await readsNothing(), NOTHING)

  await go('/automations/credentials/')
  t('staff.credentialsAreAnAdministratorsAndSaySo', await waitFor('#cred-refused'), true)
  t('staff.andNoTableIsDrawn', await exists('[data-credential]'), false)

  // Staff draft. The flow is Sam's, so the live half below watches a run on a
  // flow the watching administrator does not own.
  const staffFlowId = await evaluate(`
    const { flows } = await import(${JSON.stringify(FLOW_MODULE)});
    const f = await flows.service.create({ name: ${JSON.stringify(`${PREFIX} ${RUN_ID} staff`)} });
    await flows.service.invoke('save', f.id, { definition: ${JSON.stringify(definition('Customer'))} });
    return f.id;
  `)
  t('staff.draftAFlowOfTheirOwn', typeof staffFlowId === 'string' && staffFlowId.length > 0, true)

  await signInAs('robin@buyer.test')
  await go('/')
  t('shopper.readsNoRunAndSoNoCustomersRow', await readsNothing(), NOTHING)
  t('shopper.theNavDoesNotOfferAutomations', await exists('#nav-automations'), false)
  t('shopper.andDraftingAFlowIsRefused', await evaluate(`
    const { flows } = await import(${JSON.stringify(FLOW_MODULE)});
    try { await flows.service.create({ name: ${JSON.stringify(`${PREFIX} ${RUN_ID} shopper`)} }); return 'created' }
    catch (e) { return e?.code ?? e?.status ?? String(e) }
  `), 403)

  // ─── an administrator watches somebody else's run ─────────────────────────
  //
  // Alex's own flow is archived first, or one customer would start two runs
  // patching one row and the second would lose on the version.

  await signInAs('alex@shop.test')
  await go('/automations/')
  t('others.theAdministratorsOwnFlowIsArchived', await evaluate(`
    const { flows } = await import(${JSON.stringify(FLOW_MODULE)});
    await flows.service.invoke('archive', ${JSON.stringify(flowId)});
    const moved = await flows.service.invoke('activate', ${JSON.stringify(staffFlowId)});
    return moved.status;
  `), 'active')

  await go('/automations/runs/')
  t('others.theRunsScreenRenders', await until(`document.querySelector('table')`), true)
  const seen = await evaluate(`return [...document.querySelectorAll('[data-run]')].map(r => r.getAttribute('data-run'))`)
  await evaluate(`
    const { customers } = await import('/src/resources/Customer.mesa');
    await customers.service.create({ name: 'Automation ${RUN_ID} b', firstName: 'Auto', lastName: 'Mation', email: ${JSON.stringify(`automation-${RUN_ID}-b@buyer.test`)} });
    return true;
  `)
  const theirs = `[...document.querySelectorAll('[data-run]')].find(r => !${JSON.stringify(seen)}.includes(r.getAttribute('data-run')))`
  t('others.aRunOnStaffsFlowArrivesWithoutAReload', await until(theirs, 15000), true)
  t('others.andReachesCompleted', await until(`${theirs}?.querySelector('[data-status="completed"]')`, 15000), true)

  t('consoleErrors', noise, [])
} catch (e) {
  t('drive.ranToTheEnd', e.message, 'no exception')
}

// ─── cleanup ──────────────────────────────────────────────────────────────

try {
  await signInAs('alex@shop.test')
  await go('/automations/')
  await archiveLeftovers()
  t('cleanup.nothingThisRunDraftedIsLeft', await archiveLeftovers(), 0)
} catch (e) {
  t('cleanup.ran', e.message, 'no exception')
}

// ─── Result ───────────────────────────────────────────────────────────────

let failed = 0
for (const { name, actual, expected } of results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`)
}
console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${results.length} assertions passed`)

try { browser.close() } catch {}
stopAll()
process.exit(failed ? 1 : 0)
