#!/usr/bin/env node
// web/test/verify-atlas.mjs — /atlas/ reads the workspace's registers,
// rules on a question, and hands a row to Claude in the workbench; and
// /atlas/decide/ walks the open questions on a phone-sized screen.
//
//   bun web/test/verify-atlas.mjs
//   API_PORT=7120 UI_PORT=7020 bun web/test/verify-atlas.mjs   # pin the ports
//
// Starts and stops its own database, API, web server and Chrome. The registers
// are the REAL workspace's — the screen exists to describe the tree it runs in
// — and nothing here writes them: the ruling is driven to the button and then
// refused at the API by a section DECISIONS.md does not have, and the file is
// hashed before and after.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   The counts are fli's: each tile is held against `collectRegisterAtlas`,
//   and each ring card, document and invariant against `dataOf(collect())`,
//   read here, in this process, over the same tree.
//
//   A send is a real workbench run — the checkout pinned under a scratch
//   WORKBENCH_DIR and Claude Code as a stand-in (CLAUDE_BIN) that records the
//   prompt it was handed and answers in stream-json — followed on the screen
//   from working to done, and the chat it names is the card the link opens.
//
//   The Autopilot town is held against the loops' logs read in this process
//   (`readLoopLog`): five lanes, the Dock's patches, the Registry's tables
//   against the rings data, the CI gate against .cache/ci-last.txt, the
//   Switch against ~/.config/fli/autopilot.json, and one DAY row per event.
//
//   The decide screen's queue is `openDecisions`' order, swiped with real
//   touch events at 390px wide; Explain is the read-only ask (its argv is
//   recorded), a follow-up resumes its session, and a ruling waits out its
//   undo window and is refused by fli for a planted section.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   The stand-in runs in the real workspace root, so it writes only into the
//   scratch directory, by absolute path.
//   A run ending starts the checkout's own `fli done`, detached; it reads the
//   tree and is left to finish on its own.
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

// Workbench lives in the global port block, which has no slot for a drive, so
// both servers take an OS-chosen port and nothing is held.
export const holds = []

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'
import { collectRegisterAtlas } from '../../../cli/core/register-atlas.js'
import { openDecisions }       from '../../../cli/core/decisions.js'
import { collect }             from '../../../cli/core/repo-map.js'
import { dataOf }              from '../../../cli/core/repo-rings.js'
import { readLoopLog }         from '../../../cli/core/loop-log.js'
import { readSchedule }        from '../../../cli/core/autopilot.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const ROOT     = join(PKG, '..', '..')
// Ask the OS for a free port, then give it back for the server to bind.
const freePort = () => new Promise((done, fail) => {
  const s = createServer()
  s.on('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)) })
})
const API_PORT = Number(process.env.API_PORT ?? await freePort())
const WEB_PORT = Number(process.env.UI_PORT ?? await freePort())
const BASE     = `http://localhost:${WEB_PORT}`
const API      = `http://localhost:${API_PORT}`
const KEY      = 'workbench-drive-key'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0
let browser = null

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child: `bun run web` spawns vite, so killing the direct
// child leaves the server holding its port.
async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} } }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

const SCRATCH   = mkdtempSync(join(tmpdir(), 'workbench-atlas-'))
const DB        = join(SCRATCH, 'workbench.db')
const WORKBENCH = join(SCRATCH, 'workbench')
const PROMPT    = join(SCRATCH, 'prompt.txt')
const ARGV      = join(SCRATCH, 'argv.json')
const dbEnv     = { DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit.db') }

const FAKE_CLAUDE = join(SCRATCH, 'fake-claude')
writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
fs.writeFileSync(${JSON.stringify(PROMPT)}, input)
fs.writeFileSync(${JSON.stringify(ARGV)}, JSON.stringify(process.argv.slice(2)))
const out = l => process.stdout.write(JSON.stringify(l) + '\\n')
out({ type: 'system', subtype: 'init', session_id: '0b5b4c3e-6a51-4c8e-9a52-0d1f3c7e2a10' })
setTimeout(() => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Placed it.' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, num_turns: 2 })
}, 4000)
`, { mode: 0o755 })

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...dbEnv, FRONTIER_APP_URL: BASE, PORT: String(API_PORT), WORKBENCH_KEY: KEY,
         WORKBENCH_DIR: WORKBENCH, CLAUDE_BIN: FAKE_CLAUDE },
}))
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) { try { await fetch(url); return } catch {} await sleep(500) }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

browser = await openChrome().catch(async (e) => { console.error(`\n✗ ${e.message}\n`); await cleanup(); process.exit(1) })
const send = browser.cmd

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}
const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const fill = fields => evaluate(`(() => { ${Object.entries(fields).map(([id, v]) =>
  `{ const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}
     el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n')} })()`)
const textOf = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`)
const clickText = (sel, text) => evaluate(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)}))
  if (!b) throw new Error('nothing under ${sel} reads ${text}')
  b.click(); return true
})()`)

const consoleErrors = []
browser.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return
  const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
  if (!/favicon|\[vite\]/i.test(t)) consoleErrors.push(t)
})

const hash = f => createHash('sha1').update(readFileSync(join(ROOT, f))).digest('hex')
const decisionsBefore = hash('DECISIONS.md')
const issuesBefore    = hash('ISSUES.md')

const atlas = collectRegisterAtlas(ROOT)
const open  = atlas.issues.filter(i => !i.closed)
const count = sev => open.filter(i => i.severity === sev).length
const top   = atlas.ready.map(id => open.find(i => i.id === id)).find(Boolean) ?? open[0]
const question = atlas.questions.find(q => q.state === 'decidable' && q.recommend && q.options.length > 1)

try {
  await goto('/login/')
  await until(`!!document.getElementById('key')`, v => v, 'the sign-in form never rendered')
  await fill({ key: KEY })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/home/', 'sign-in never landed on home')
  ok('signed in with the pass-phrase')

  console.log('\n  /atlas/ — the counts are fli\'s')
  await goto('/atlas/')
  await until(`!!document.getElementById('atlas-tiles')`, v => v, 'the tiles never rendered', 30_000)
  for (const sev of ['S2', 'S3', 'S4', 'decision']) {
    const tile = await textOf(`[data-severity="${sev}"]`)
    check(`the ${sev} tile reads ${count(sev)}, as collectRegisterAtlas does`, new RegExp(`\\b${count(sev)}\\b`).test(tile ?? ''), tile)
  }
  const headline = await textOf('.atlas-wrong')
  check('the Issues tab opens on every open defect counted', headline?.startsWith(`${open.filter(i => i.severity !== 'decision').length} things are wrong`), headline)

  console.log('\n  The rings — the project half of fli ws:atlas --as=rings')
  const rings   = dataOf(collect({ root: ROOT }), { root: ROOT })
  const defects = rings.issues.filter(i => i[2] !== 'decision')
  const owed    = rings.issues.filter(i => i[2] === 'decision')
  const tabExpr = `document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? ''`
  await until(`!!document.getElementById('atlas-cards')`, v => v, 'the ring cards never rendered', 30_000)
  if (process.env.FJS_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await Bun.write(process.env.FJS_DRIVE_SHOT, Buffer.from(data, 'base64'))
  }
  check('the headline is the rings page\'s', (await textOf('.atlas-headline')) === 'How the work is run.')
  const cards = { core: rings.docs.length, invariants: rings.invariants.length, decisions: rings.decCount, issues: defects.length, ideas: rings.ideas.count }
  for (const [id, n] of Object.entries(cards)) {
    const card = await textOf(`#atlas-cards [data-ring="${id}"]`)
    check(`the ${id} card reads ${n.toLocaleString()}, as dataOf does`, card?.includes(n.toLocaleString()), card)
  }
  const ring3 = await textOf('#atlas-cards [data-ring="decisions"]')
  check('Ring 3 counts its topics', ring3?.includes(`${rings.decisions.filter(s => s.rows.length).length} topics`), ring3)
  const ring4 = await textOf('#atlas-cards [data-ring="issues"]')
  check('Ring 4 names the questions owed a ruling and the rows closed',
    ring4?.includes(`${owed.length} questions owed a ruling`) && ring4.includes(`${rings.closedCount} closed recently`), ring4)
  const map = await evaluate(`[...document.querySelectorAll('.atlas-rings-map circle')].map(c => c.dataset.ring)`)
  check('the map draws the five rings, center out', JSON.stringify(map) === JSON.stringify(Object.keys(cards)), map)

  await evaluate(`document.querySelector('#atlas-cards [data-ring="core"]').click()`)
  await until(tabExpr, t => t.startsWith('Documents'), 'the Ring 1 card never opened Documents')
  ok('the Ring 1 card opens the Documents tab')
  const docs = await evaluate(`[...document.querySelectorAll('#atlas-docs [data-file]')].map(e => e.dataset.file)`)
  check(`the Documents tab lists every root document, ${rings.docs.length}, in reading order`,
    JSON.stringify(docs) === JSON.stringify(rings.docs.map(d => d.file)), docs)
  const edit = await evaluate(`document.querySelector('#atlas-docs [data-file] a')?.getAttribute('href')`)
  check('a document opens in VS Code', edit === `vscode://file${join(ROOT, rings.docs[0].file)}`, edit)

  await evaluate(`document.querySelector('#atlas-legend [data-ring="invariants"]').click()`)
  await until(tabExpr, t => t.startsWith('Invariants'), 'the map\'s key never opened Invariants')
  ok('the map\'s Invariants key opens the Invariants tab')
  const invs = await evaluate(`[...document.querySelectorAll('#atlas-invariants [data-n]')].map(e => Number(e.dataset.n))`)
  check(`the Invariants tab lists every invariant, ${rings.invariants.length}`,
    JSON.stringify(invs) === JSON.stringify(rings.invariants.map(i => Number(i[0]))), invs)
  const groups = await evaluate(`Object.fromEntries([...document.querySelectorAll('#atlas-proof [data-group]')]
    .map(g => [g.dataset.group, [g.querySelector('.atlas-proof-count').textContent, g.querySelectorAll('li').length]]))`)
  for (const [key, rows] of Object.entries({ checks: rings.checks, snapshots: rings.snapshots, drives: rings.drives, ci: rings.ciPhases }))
    check(`the ${key} group counts ${rows.length} and lists each`, groups[key]?.[0] === String(rows.length) && groups[key][1] === rows.length, groups[key])

  await evaluate(`document.querySelector('.atlas-rings-map circle[data-ring="decisions"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  await until(tabExpr, t => t.startsWith('Rulings'), 'the Decisions ring never opened Rulings')
  ok('a click on the Decisions ring opens Rulings')
  await evaluate(`document.querySelector('#atlas-cards [data-ring="issues"]').click()`)
  await until(tabExpr, t => t.startsWith('Issues'), 'the Ring 4 card never opened Issues')
  ok('the Ring 4 card opens Issues')

  console.log('\n  Narrowing — a tile, a package, a search')
  await evaluate(`document.querySelector('[data-severity="S2"]').click()`)
  const s2 = await until(`[...document.querySelectorAll('#atlas-issues [data-id]')].map(e => e.querySelector('.pill')?.textContent.trim())`,
    v => v.length > 0 && v.every(s => s === 'S2'), 'the S2 tile never narrowed the list')
  check('the S2 tile leaves only S2 rows', s2.length === Math.min(count('S2'), 150), `${s2.length}`)
  await evaluate(`document.querySelector('[data-severity="S2"]').click()`)
  const pkg = top.pkg[0]
  await evaluate(`[...document.querySelectorAll('.atlas-pkg')].find(b => b.querySelector('.text-sm').textContent === ${JSON.stringify(pkg)}).click()`)
  const inPkg = await until(`document.querySelectorAll('#atlas-issues [data-id]').length`, n => n > 0, 'the package bar never narrowed')
  const want  = open.filter(i => i.pkg.includes(pkg)).length
  check(`a package bar leaves ${pkg}'s ${want} rows`, inPkg === Math.min(want, 150), `${inPkg}`)
  await fill({ 'atlas-search': top.id })
  const ids = await until(`[...document.querySelectorAll('#atlas-issues [data-id]')].map(e => e.dataset.id)`,
    v => v.includes(top.id), `searching ${top.id} never found it`)
  check(`a search for ${top.id} finds it`, ids.includes(top.id), ids.join(', '))

  console.log('\n  A row — read whole, then handed to Claude')
  await evaluate(`document.querySelector('[data-id=${JSON.stringify(top.id)}] .atlas-open').click()`)
  const record = await until(`document.getElementById('atlas-record')?.textContent ?? ''`, t => t.includes(top.title.slice(0, 40)), 'the row never opened')
  check('the drawer shows the row\'s title', record.includes(top.title.slice(0, 40)))
  check('and where it lives', record.includes(`${top.at.file}:${top.at.line}`), top.at.file)
  await clickText('#atlas-record button', 'Discuss with Claude')
  const text = await until(`document.getElementById('atlas-text')?.value ?? ''`, v => v.startsWith(top.id), 'Discuss never filled the box')
  check('Discuss fills the box with the id and title', text.startsWith(`${top.id} — `), text.slice(0, 80))
  check('and the id is recognized as a chip', ((await textOf('#atlas-known')) ?? '').includes(top.id))
  check('with Discuss as the intent', await evaluate(`document.querySelector('input[name=intent]:checked')?.value`) === 'discuss')

  await evaluate(`document.getElementById('atlas-send').click()`)
  const working = await until(`document.getElementById('atlas-run')?.dataset.state ?? null`, s => !!s, 'the send never showed a run')
  check('the send shows the run working', working === 'working', working)
  const prompt = await (async () => { for (let i = 0; i < 80 && !existsSync(PROMPT); i++) await sleep(250); return existsSync(PROMPT) ? readFileSync(PROMPT, 'utf8') : '' })()
  check('Claude was handed the text', prompt.startsWith(`${top.id} — `), prompt.slice(0, 80))
  check('with the row cited at its line', prompt.includes(`- ${top.id} — issue, ${top.severity}`) && prompt.includes(`${top.at.file}:${top.at.line}`), prompt.slice(0, 400))
  check('and told to change no file', prompt.includes('Change no file'))
  const done = await until(`document.getElementById('atlas-run')?.dataset.state ?? null`, s => s === 'done', 'the run never finished on screen', 30_000)
  check('the screen follows the run to done, without being asked', done === 'done')
  check('with what it cost', /\$0\.12 · 2 turns/.test((await textOf('#atlas-run')) ?? ''))

  const href = await evaluate(`[...document.querySelectorAll('#atlas-run a')].find(a => /Open the chat/.test(a.textContent))?.getAttribute('href')`)
  check('Open the chat names the card', /^\/workbench\/#workbench-/.test(href ?? ''), href)

  console.log('\n  Refusals — said, not guessed')
  await fill({ 'atlas-text': 'a toast stacks forever' })
  await evaluate(`[...document.querySelectorAll('input[name=intent]')].find(i => i.value === 'fix').click()`)
  await evaluate(`document.getElementById('atlas-send').click()`)
  const refusal = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => !!t, 'a fix with no id was never refused')
  check('Fix with no row is refused by name', /fix takes the id of an open row/.test(refusal), refusal)

  if (question) {
    console.log(`\n  A ruling — ${question.id}, nothing preselected`)
    await goto(`/atlas/#${encodeURIComponent(question.id)}`)
    await until(`!!document.getElementById('atlas-decide')`, v => v, 'the question never opened from the hash', 30_000)
    check('no option is checked to start', await evaluate(`!document.querySelector('#atlas-decide input[name=pick]:checked')`))
    const rule = () => evaluate(`document.querySelector('#atlas-decide button[type=submit]').disabled`)
    check('and Rule cannot be pressed', await rule())
    const other = question.options.find(o => o.letter !== question.recommend.letter).letter
    await evaluate(`document.querySelector('#atlas-decide [data-letter="${other}"] input').click()`)
    await evaluate(`(() => { const s = document.getElementById('atlas-section'); s.value = ${JSON.stringify(atlas.sections[0])}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    check(`picking ${other} against the recommendation asks why first`, await rule() && /required/.test((await textOf('#atlas-decide')) ?? ''))

    // The select offers only real sections; one more is planted so the press
    // goes through the screen and is refused by fli's decide, writing nothing.
    await evaluate(`document.querySelector('#atlas-decide [data-letter="${question.recommend.letter}"] input').click()`)
    await evaluate(`(() => {
      const s = document.getElementById('atlas-section')
      s.add(new Option('No such section', 'No such section')); s.value = 'No such section'
      s.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    check('the recommendation needs no reason', !(await rule()))
    await evaluate(`document.querySelector('#atlas-decide button[type=submit]').click()`)
    const refused = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => /section/.test(t), 'the ruling was never refused')
    check('a section DECISIONS.md lacks is refused by fli\'s decide', /no section named/.test(refused), refused)
  } else {
    bad('no decidable question in the registers to drive the ruling against')
  }

  check('DECISIONS.md is untouched', hash('DECISIONS.md') === decisionsBefore)
  check('ISSUES.md is untouched', hash('ISSUES.md') === issuesBefore)

  console.log('\n  The chat it names')
  await goto(href)
  // The card renders before its transcript is read, so wait on the reply, not the card.
  const card = await until(`document.getElementById(decodeURIComponent(location.hash.slice(1)))?.textContent ?? null`, t => t?.includes('Placed it.'), 'the linked card never rendered')
    .catch(e => e.message)
  check('the workbench draws the card the link names', card.includes('Placed it.'), card.slice(0, 160))

  await decideScreen()
  await autopilotScreen()

  check('DECISIONS.md is still untouched', hash('DECISIONS.md') === decisionsBefore)
  check('no console errors on the screens', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 300))
} catch (e) {
  bad('the drive stopped', e.message + (consoleErrors.length ? ` | console: ${consoleErrors.join(' | ').slice(0, 400)}` : ''))
}

async function decideScreen() {
  console.log('\n  /atlas/decide/ — one question at a time, on a phone')
  const queued = openDecisions(ROOT).decidable
  if (queued.length < 2) return bad('fewer than two questions with options to walk', `${queued.length}`)
  const [first, second] = queued

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await evaluate(`localStorage.removeItem('workbench.atlas.section'); localStorage.removeItem('workbench.atlas.skipped')`)
  await goto('/atlas/decide/')
  const id = () => evaluate(`document.getElementById('decide-card')?.dataset.id ?? null`)
  await until(`document.getElementById('decide-card')?.dataset.id ?? null`, v => !!v, 'no card rendered', 30_000)
  check(`the first card is fli decide's first question, ${first.id}`, await id() === first.id, await id())
  check('with every option', await evaluate(`document.querySelectorAll('#decide-options [data-letter]').length`) === first.options.length)
  check('and its prose', !first.body || ((await textOf('#decide-body')) ?? '').length > 20)
  check('all of it — the prose is not cut off at phone width', !first.body ||
    await evaluate(`(e => e.scrollHeight <= e.clientHeight + 1)(document.getElementById('decide-body'))`))
  if (first.recommend) check(`the big button is the recommendation, ${first.recommend.letter}`,
    (await textOf('#decide-accept'))?.startsWith(`${first.recommend.letter} · Recommended`), await textOf('#decide-accept'))
  check('nothing is wider than the phone', await evaluate(`document.documentElement.scrollWidth <= innerWidth`),
    `${await evaluate('document.documentElement.scrollWidth')}px`)
  check('the buttons sit inside the screen', await evaluate(`document.getElementById('decide-bar').getBoundingClientRect().bottom <= innerHeight + 1`))

  await goto(`/atlas/decide/?ids=${encodeURIComponent(`${second.id},not-a-question,${first.id}`)}`)
  await until(`document.getElementById('decide-card')?.dataset.id ?? null`, v => v === second.id, '?ids= did not lead with its first id', 30_000)
  check(`?ids= walks its own order, ${second.id} first`, await id() === second.id, await id())
  check('and only those, an unknown id dropped', (await textOf('#decide-count'))?.includes('2 left'), await textOf('#decide-count'))
  await goto('/atlas/decide/')
  await until(`document.getElementById('decide-card')?.dataset.id ?? null`, v => v === first.id, 'the plain walk did not come back', 30_000)

  if (first.recommend) {
    await evaluate(`document.getElementById('decide-accept').click()`)
    const said = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => !!t, 'a pick with no section was never stopped')
    check('a ruling with no section chosen is stopped on the screen', /section/i.test(said) && await id() === first.id, said)
    check('and the press lands on the section picker', await evaluate(`document.activeElement?.id === 'decide-section'`))
  }

  // A real touch drag: touch-action pan-y hands the horizontal move to the card.
  const swipe = async (by) => {
    // The card sits below the screen's error banner, and a press that starts on
    // a button is the button's, never a drag: scroll it up and start on bare card.
    const box = await evaluate(`(() => {
      const card = document.getElementById('decide-card')
      card.scrollIntoView({ block: 'start', behavior: 'instant' })
      const r = card.getBoundingClientRect()
      const x = r.left + r.width / 2
      for (let y = r.top + 8; y < Math.min(r.bottom, innerHeight) - 8; y += 8) {
        const hit = document.elementFromPoint(x, y)
        if (hit && card.contains(hit) && !hit.closest('button, a, input, textarea, select, summary, form')) return { x, y }
      }
      return { x, y: r.top + 8 }
    })()`)
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] })
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + by * i / 8, y: box.y + i }] })
      await sleep(16)
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(500)
  }

  await swipe(-260)
  check(`a swipe left skips to ${second.id}`, await id() === second.id, await id())
  check('and the skip is remembered', (await evaluate(`localStorage.getItem('workbench.atlas.skipped')`))?.includes(first.id))
  check('the count says one skipped', /1 skipped/.test((await textOf('#decide-count')) ?? ''), await textOf('#decide-count'))

  console.log('\n  Explain — Claude, read-only, on the card')
  await evaluate(`document.getElementById('decide-explain').click()`)
  await until(`document.getElementById('decide-explanation')?.dataset.state ?? null`, s => s === 'working', 'Explain never showed a run')
  ok('Explain shows Claude working on the card')
  const done = await until(`document.getElementById('decide-explanation')?.dataset.state ?? null`, s => s !== 'working', 'the explanation never finished', 30_000)
  check('and follows it to done without a reload', done === 'done', done)
  check('the reply is on the card', ((await textOf('#decide-explanation')) ?? '').includes('Placed it.'))
  if (process.env.FJS_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(process.env.FJS_DRIVE_SHOT.replace(/(\.png)?$/, '-decide.png'), Buffer.from(data, 'base64'))
  }
  const asked = readFileSync(PROMPT, 'utf8')
  check('Claude was handed the question at its line', asked.includes(`${second.id} — ${second.file}:${second.line}`), asked.slice(0, 200))
  check('with every option', second.options.every(o => asked.includes(`- **${o.letter}** — `)))
  const argv = JSON.parse(readFileSync(ARGV, 'utf8'))
  check('as the read-only ask — tools listed, no bypass', argv.includes('--tools') && !argv.includes('bypassPermissions'), argv.join(' ').slice(0, 200))

  await fill({ 'decide-follow': 'what breaks if we wait?' })
  await evaluate(`document.querySelector('.decide-follow button[type=submit]').click()`)
  await until(`document.getElementById('decide-explanation')?.dataset.state ?? null`, s => s === 'working', 'the follow-up never ran')
  await until(`document.getElementById('decide-explanation')?.dataset.state ?? null`, s => s === 'done', 'the follow-up never finished', 30_000)
  const resumed = JSON.parse(readFileSync(ARGV, 'utf8'))
  check('a follow-up resumes the same session', resumed.includes('--resume') && resumed.includes('0b5b4c3e-6a51-4c8e-9a52-0d1f3c7e2a10'), resumed.join(' ').slice(0, 200))
  check('and sends only the follow-up', readFileSync(PROMPT, 'utf8') === 'what breaks if we wait?')
  check('the card shows the follow-up asked', ((await textOf('#decide-explanation')) ?? '').includes('what breaks if we wait?'))

  console.log('\n  Ruling — the undo window, then fli refuses a planted section')
  const other = second.options.find(o => o.letter !== second.recommend?.letter)
  await evaluate(`document.querySelector('#decide-actions [data-letter="${other.letter}"]').click()`)
  await until(`!!document.getElementById('decide-why')`, v => v, 'a pick against the recommendation never asked why')
  check(`${other.letter} asks why before it can rule`, await evaluate(`document.querySelector('#decide-reason button[type=submit]').disabled`))
  await clickText('#decide-reason button', 'Cancel')

  // Only real sections are offered; one more is planted so the ruling reaches
  // fli's decide and is refused there, writing nothing.
  await evaluate(`(() => {
    const s = document.getElementById('decide-section')
    s.add(new Option('No such section', 'No such section')); s.value = 'No such section'
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  if (!second.recommend) return bad(`${second.id} carries no recommendation to swipe to`)
  await swipe(280)
  await until(`!!document.getElementById('decide-undo')`, v => v, 'a swipe right never opened the undo window')
  check('a swipe right rules the recommendation, inside an undo window', ((await textOf('#decide-undo')) ?? '').includes(`Ruling ${second.recommend.letter}`))
  check('and the next card is already up', await id() !== second.id)
  await evaluate(`document.getElementById('decide-undo-button').click()`)
  await sleep(400)
  check('Undo puts the question back on top', await id() === second.id, await id())

  await evaluate(`document.getElementById('decide-accept').click()`)
  const refused = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => /not ruled/.test(t), 'the ruling was never sent and refused', 15_000)
  check('after the window the ruling is sent, and fli refuses the section', /no section named/.test(refused), refused)
  await until(`document.getElementById('decide-card')?.dataset.id ?? null`, v => v === second.id, 'the refused question never came back')
  ok('the refused question is back on top')

  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.clearDeviceMetricsOverride', {})
}

async function autopilotScreen() {
  console.log('\n  /atlas/autopilot/ — the town is the logs\'')
  // Lines land while the screen loads and the window slides with the clock, so
  // the log is read on both sides of the screen's read and a count may sit
  // anywhere between the two.
  const before = readLoopLog({ root: ROOT })
  await goto('/atlas/autopilot/')
  await until(`document.querySelectorAll('[data-lane]').length`, v => v === 5, 'the five lanes never drew', 30_000)
  const after = readLoopLog({ root: ROOT })

  if (process.env.FJS_DRIVE_SHOT_TOWN) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await Bun.write(process.env.FJS_DRIVE_SHOT_TOWN, Buffer.from(data, 'base64'))
  }
  check('five lanes are drawn', await evaluate(`document.querySelectorAll('[data-lane]').length`) === 5)
  const dock = await evaluate(`Number(document.getElementById('ap-dock-patches')?.dataset.count)`)
  const patches = [before.dock.patches.length, after.dock.patches.length]
  check(`the Dock holds the patches directory's ${patches[1]}`, dock >= Math.min(...patches) && dock <= Math.max(...patches), String(dock))

  const rings = dataOf(collect({ root: ROOT }), { root: ROOT })
  const moves = rings.issues.filter(i => i[2] !== 'decision').map(i => i[4])
  const ready = moves.filter(m => ['ready', 'hand', 'env'].includes(m)).length
  const blocked = moves.filter(m => ['ruling', 'row'].includes(m)).length
  const reg = async name => Number(await textOf(`#ap-reg-${name}`))
  check(`the Registry's ready table reads ${ready}, the rings' ready + by hand + env`, await reg('ready') === ready, String(await reg('ready')))
  check(`and its blocked table ${blocked}, the rings' ruling + row`, await reg('blocked') === blocked, String(await reg('blocked')))
  // Read again here: other sessions edit ISSUES.md while the drive runs.
  const readyNow = collectRegisterAtlas(ROOT).ready.length
  check(`and its ready table is collectRegisterAtlas's ${readyNow}`, await reg('ready') === readyNow, String(await reg('ready')))

  let ci = 'none'
  try { ci = /CI passed/.test(readFileSync(join(ROOT, '.cache', 'ci-last.txt'), 'utf8')) ? 'green' : 'red' } catch {}
  const gate = await evaluate(`document.getElementById('ap-ci')?.dataset.ci`)
  check(`the CI gate is ${ci}, as .cache/ci-last.txt says`, gate === ci, gate)

  let on = false
  try { on = JSON.parse(readFileSync(join(homedir(), '.fli', 'autopilot.json'), 'utf8')).on === true } catch {}
  check(`the Switch on the map reads ${on ? 'ON' : 'OFF'}`, (await textOf('#ap-sw-map')) === (on ? 'ON' : 'OFF'), await textOf('#ap-sw-map'))

  await clickText('[role=tab]', 'Schedule')
  await until(`document.getElementById('ap-sw-state')?.offsetParent !== null`, v => v, 'the Schedule tab never showed')
  check('the Schedule tab reads the Switch the same way', (await textOf('#ap-sw-state'))?.startsWith(on ? 'ON' : 'OFF'), await textOf('#ap-sw-state'))

  // The Schedule table is the file's, through the same reader: one row per
  // entry with Run now, which is never clicked here — a click opens a lane and
  // pays for a session. A file the reader refuses is drawn as its refusal.
  let schedule = null, refusedFile = null
  try { schedule = readSchedule() } catch (err) { refusedFile = err.message }
  const entries = schedule?.entries.length ?? 0
  const sched = await evaluate(`document.querySelectorAll('#ap-schedule tr[data-entry]').length`)
  check(`the Schedule table lists the file's ${entries} entries`, sched === entries, String(sched))
  if (entries) check('and each has Run now, or says it is running', await evaluate(`[...document.querySelectorAll('#ap-schedule tr[data-entry]')].every(r => r.querySelector('button') || r.dataset.running === 'true')`) === true)
  const day = await textOf('#ap-day')
  check(`the day line reads today's scheduled spend${schedule?.day ? ' against the day cap' : ', with no cap set'}`, day?.startsWith('Today:') && day.includes(schedule?.day?.attempts != null ? `${schedule.day.attempts} attempts` : 'unset'), day)
  check('the last tick line reads the job\'s own record, or says there is none', (await textOf('#ap-tick'))?.startsWith('Last tick:'), await textOf('#ap-tick'))
  // Never clicked: a turn writes the owner's own file, and On would let this API's tick job start a loop.
  const held = !!refusedFile || !schedule?.exists || (!on && schedule.missing.length > 0)
  check(`and its toggle is ${held ? 'held' : 'live'}, as the file ${held ? 'is not whole' : 'has every cap set'}`, await evaluate(`document.querySelector('[role=switch]').disabled`) === held, await textOf('#ap-sw-why'))
  if (refusedFile) check('a refused schedule file is said on the Switch', (await textOf('#ap-refused'))?.includes(refusedFile.slice(-40)), await textOf('#ap-refused'))
  if (schedule?.missing.length) check(`and the ${schedule.missing.length} caps not set are listed`, (await textOf('#ap-missing'))?.includes(schedule.missing[0]), await textOf('#ap-missing'))

  // The Dock tab lists each patch with the command that applies it; the command is copied, never run here.
  await clickText('[role=tab]', 'Dock')
  await until(`document.getElementById('ap-dock')?.offsetParent !== null`, v => v, 'the Dock tab never showed')
  const dockRows = await evaluate(`document.querySelectorAll('#ap-dock tr[data-patch]').length`)
  check(`the Dock tab lists the ${patches[1]} patches`, dockRows >= Math.min(...patches) && dockRows <= Math.max(...patches), String(dockRows))
  if (dockRows) check('and each names the git apply that lands it in this tree', await evaluate(`[...document.querySelectorAll('#ap-dock tr[data-patch]')].every(r => { const c = r.querySelector('.ap-apply code')?.textContent ?? ''; return c.startsWith('git -C ') && c.includes(' apply ') && c.endsWith(r.dataset.patch) })`) === true)
  check('and nothing on it applies a patch', await evaluate(`[...document.querySelectorAll('#ap-dock button')].every(b => b.textContent.trim() === 'Copy')`) === true)

  await clickText('[role=tab]', 'Day')
  await until(`document.querySelectorAll('tr[data-event]').length`, v => v > 0 || before.events.length === 0, 'the Day tab listed no events', 30_000)
  const rows = await evaluate(`document.querySelectorAll('tr[data-event]').length`)
  const events = [before.events.length, after.events.length]
  check(`the Day tab lists the log's ${events[1]} events`, rows >= Math.min(...events) && rows <= Math.max(...events), String(rows))

  await clickText('[role=tab]', 'Town')
  await evaluate(`document.querySelector('[data-b="registry"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  await until(`document.getElementById('ap-place')?.dataset.place`, v => v === 'registry', 'a click on the Registry never opened its place card')
  await evaluate(`document.getElementById('ap-open').click()`)
  await until(`location.pathname`, p => p === '/atlas/', 'the Registry never opened /atlas/', 15_000)
  const opened = await until(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? ''`, v => v !== '', 'the Atlas showed no tab', 30_000)
  check('a click on the Registry lands on /atlas/ with the Issues tab active', opened.startsWith('Issues'), opened)

  await goto('/atlas/autopilot/')
  await until(`!!document.querySelector('[data-b="council"]')`, v => v, 'the town never drew again', 30_000)
  await evaluate(`document.querySelector('[data-b="council"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  await evaluate(`document.getElementById('ap-open').click()`)
  const council = await until(`location.pathname === '/atlas/' ? (document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '') : ''`, v => v !== '', 'the Council never opened /atlas/', 30_000)
  check('and the Council lands there with the Questions tab active', council.startsWith('Questions'), council)
}

await cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
