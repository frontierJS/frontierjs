/*
 * test/browser/console.mjs — one `fli gui`, two frames: Chrome over CDP and a
 * pty, asked whether they show the same rows (`IDEAS/one-console.md` 1.3).
 * Then the keys (2.3): the legend, a `/` filter, each pane after `:run`
 * reached by its digit, and `:` back — asked of both frames the same way.
 * `:map` (2.4) is counted by its issues in both. `:live` (3.1) reads a real
 * app this drive boots, with devtools and a Caravan queue holding one job that
 * failed on purpose: both frames count its calls and jobs, then Chrome presses
 * what acts on the queue — the payload, retry run through to done, run now.
 * `:call` (3.2) calls the same app: both frames count its methods, then Chrome
 * creates a note as a member, sees the call and its announcement on `:live`,
 * and sees the same create as nobody refused. `:data` (3.3) reads the same
 * app: both frames count its models, then Chrome reads a gated model as
 * nobody (refused) and as a member (the row). `:ask` (5.1) points an agent
 * at the same app as somebody: both frames count its tools, then Chrome
 * sees a guest offered fewer, its create refused by the app, and a member's
 * land. The agent is a stand-in `claude` that makes the MCP call it is asked.
 *
 * `Console.mesa` is one file compiled for two targets, and the claim the console
 * rests on is that a person at either sees the same thing. Nothing else asks
 * it: the browser drive beside this one reads the old page, and a unit test
 * over `/api/runnables` passes with either frame drawing nothing. So the drive
 * starts `fli gui` under a pty, the way a person does, then opens THAT
 * process's `/console/` in Chrome, and diffs the two row by row: group, count,
 * name, state word, command and the actions offered.
 *
 * Traps:
 * - The pty is util-linux `script`, as `example`'s `verify:tui` uses. It is
 *   opened tall enough for every row, since a row scrolled off the bottom is
 *   not on the screen to compare. The renderer writes only the cells that
 *   changed, so a frame is the stream replayed onto a grid, never the stream.
 * - Each frame polls `/api/state` on its own clock, so a process that starts
 *   or stops between the two reads is a real difference neither frame is
 *   wrong about. The diff is asked again after a poll before it fails.
 * - Both frames are empty when either read fails, and two empty frames agree.
 *   So the row count is held to `/api/runnables`' before any diff is trusted.
 * - The app's devtools is on the test tier's slot, never 5503, so a dev's own
 *   app is not what `:live` grades; `fli gui --devtools-port` points it there.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI  = resolve(HERE, '../..')
const REPO = resolve(CLI, '../..')
const FLI  = resolve(CLI, 'bin/fli.js')

// The test tier's tooling slot beside `test:browser`'s 7500, so the two
// drives and a `fli gui` somebody has open on their dev slot never meet.
const PORT   = Number(process.env.FLI_CONSOLE_TEST_PORT ?? 7501)
const origin = `http://localhost:${PORT}`
const ROWS = 400, COLS = 160
const DEVTOOLS = Number(process.env.FLI_CONSOLE_DEVTOOLS_PORT ?? 7503)
const APP_PORT = Number(process.env.FLI_CONSOLE_APP_PORT ?? 7961)

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await sleep(100) }
  return false
}
const answers = () => fetch(`${origin}/api/state`).then(() => true, () => false)

const held = (port) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)
for (const [port, what, knob] of [[PORT, 'the console', 'FLI_CONSOLE_TEST_PORT'], [DEVTOOLS, "the app's devtools", 'FLI_CONSOLE_DEVTOOLS_PORT'], [APP_PORT, 'the app', 'FLI_CONSOLE_APP_PORT']]) {
  if (await held(port)) {
    console.error(`:${port} already answers — this drive starts ${what} it tests; ${knob} picks another`)
    process.exit(2)
  }
}

// ─── the agent `:ask` starts ──────────────────────────────────────────
//
// A `claude` first on the console's PATH, since the real one costs money and
// a login. It is handed what the real one is — the argv, the prompt on stdin
// — and makes the call the question names over the MCP config it was given,
// so the standing the call is graded at is the URL's and nothing this drive
// says. It answers in Claude Code's stream-json.

const binDir = mkdtempSync(join(tmpdir(), 'fjs-console-claude-'))
writeFileSync(join(binDir, 'claude'), `#!/usr/bin/env bun
const argv   = process.argv.slice(2)
const server = Object.values(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers)[0]
const out    = (e) => process.stdout.write(JSON.stringify(e) + '\\n')
const say    = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const rpc    = (method, params) => fetch(server.url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then(r => r.json())
const prompt = await Bun.stdin.text()
out({ type: 'system', subtype: 'init', session_id: '5acea7bb-3850-44cf-81dc-97688510acda' })
const bare = argv[argv.indexOf('--tools') + 1] === '' && argv.includes('--strict-mcp-config') && argv[argv.indexOf('--allowedTools') + 1] === 'mcp__app'
if (!bare) say('argv: more than the app is reachable')
const [, name, input] = /^Question: call (\\S+) (.*)$/m.exec(prompt) ?? []
const listed = (await rpc('tools/list', {})).result?.tools ?? []
if (!listed.some(t => t.name === name)) say(name + ' is not offered at this standing')
else {
  const args = JSON.parse(input)
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__app__' + name, input: args }] } })
  const r = (await rpc('tools/call', { name, arguments: args })).result ?? {}
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: !!r.isError, content: r.content ?? [] }] } })
  say(r.isError ? 'the app refused it' : 'done')
}
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0 })
`, { mode: 0o755 })

// ─── the app `:live` reads ────────────────────────────────────────────
//
// A separate process: devtools binds its own server, held for the app's life.
// The job fails its first attempt and succeeds on the next, so a retry pressed
// in the pane has an outcome to see; one that always threw would re-fail
// inside a poll and the button would look like it did nothing.

const appDir = mkdtempSync(join(tmpdir(), 'fjs-console-live-'))
const PKG = resolve(CLI, '..')
writeFileSync(join(appDir, 'app.ts'), `
import { createClient } from '${PKG}/litestone/src/index.js'
import { createApp, createService, createStubAuth, health, defaultConfig } from '${PKG}/junction/index.ts'
import { devtools } from '${PKG}/junction/src/plugins/devtools/index.ts'
import { mcp } from '${PKG}/mcp/index.ts'
import { caravan, defineJob } from '${PKG}/caravan/src/index.ts'
let runs = 0
const flaky = defineJob({ name: 'flaky-job', maxAttempts: 1, timeout: 5000, handler: async () => {
  if (runs++ === 0) throw new Error('handler exploded')
  return 1
} })
const sweep = defineJob({ name: 'nightly-sweep', cron: '0 3 * * *', handler: async () => 1 })
// A person to call as, a model only a person may write, for the call pane,
// and one a guest may not read at all, for the data pane.
const db = await createClient({ db: ':memory:', schema: \`
  model User { id Int @id @default(autoincrement())  email String  @@auth }
  model Note { id Int @id @default(autoincrement())  body String  @@allow(all, auth() != null) }
  model Memo { id Int @id @default(autoincrement())  body String  @@gate(3) }\` })
await db.asSystem().user.create({ data: { email: 'ann@x.test' } })
await db.asSystem().memo.create({ data: { body: 'for members' } })
const app = createApp({
  db,
  auth:   createStubAuth({ users: [{ id: '1', role: 'member' }] }),
  system: { id: 'app', role: 'system' },
  config: { port: ${APP_PORT}, http: { ...defaultConfig.http, drainTimeout: 200 } },
})
const queue = caravan({ db: '${join(appDir, 'jobs.db')}', pollInterval: 50 })
queue.handle(flaky); queue.handle(sweep)
app.configure(queue)
app.configure(health())
app.configure(devtools({ port: ${DEVTOOLS} }))
app.configure(mcp())
app.services.register(createService({ name: 'things', async find() { return [] } }))
app.services.register(createService({ name: 'notes', model: 'Note' }))
app.services.register(createService({ name: 'memos', model: 'Memo' }))
await app.start()
await queue.dispatch(flaky, { orderId: 'ord_42' })
console.log('READY')
`)
const appProc = spawn('bun', ['run', join(appDir, 'app.ts')], { stdio: ['ignore', 'pipe', 'pipe'] })
const appReady = await new Promise((done) => {
  const timer = setTimeout(() => done(false), 20000)
  appProc.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(timer); done(true) } })
  appProc.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
})
if (!appReady) { console.error('the app :live reads never said READY'); appProc.kill(); process.exit(2) }
// Two calls before either frame opens, so the feed each one is handed holds them.
for (let i = 0; i < 2; i++) await fetch(`http://127.0.0.1:${APP_PORT}/things`)

/** The grid a person would see after `stream`, as `verify-tui.mjs` replays it. */
function screen(stream, rows = ROWS, cols = COLS) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  let r = 0, c = 0
  const seq = /\x1b\[([0-9;?<>$ ]*)([a-zA-Z~])|\x1b[()][A-Z0-9]|\x1b[=>78]|\x1b[\]P_][^\x07\x1b]*(?:\x07|\x1b\\)/y
  for (let i = 0; i < stream.length;) {
    seq.lastIndex = i
    const m = seq.exec(stream)
    if (m) {
      if (m[2] === 'H') { const [y = 1, x = 1] = (m[1] || '1;1').split(';').map(Number); r = y - 1; c = x - 1 }
      i = seq.lastIndex
      continue
    }
    const ch = String.fromCodePoint(stream.codePointAt(i))
    i += ch.length
    if (ch === '\r') { c = 0; continue }
    if (ch === '\n') { r++; continue }
    if (r < rows && c < cols) grid[r][c] = ch
    c++
  }
  return grid.map((l) => l.join('').trimEnd())
}

const squash = (s) => s.replace(/\s+/g, ' ').trim()
// A button is `[ start ]` in the terminal and `start` in the browser.
const actionsOf = (s) => squash(s.replace(/[[\]]/g, ' '))

/** The terminal frame as groups of rows. A group opens on its `title count`
 *  line; its table header names where each column starts. A cell wider than
 *  its column wraps onto the next line, whose name cell is blank, so that line
 *  continues the row above rather than starting one. */
function terminalFrame(lines) {
  const groups = []
  let g = null, cols = null
  for (const line of lines.map((l) => l.replace(/[▀▄█▐▌]+$/, '').trimEnd())) {
    const head = line.match(/^(\S+) (\d+)$/)
    if (head) { g = { kind: head[1], count: Number(head[2]), rows: [] }; groups.push(g); cols = null; continue }
    if (!g || isLegend(line)) continue
    if (/^Name\s+State\s+Command\s+Actions$/.test(line)) {
      cols = ['State', 'Command', 'Actions'].map((w) => line.indexOf(w))
      continue
    }
    if (!cols || !line.trim()) continue
    const cells = {
      name:    squash(line.slice(0, cols[0])),
      state:   squash(line.slice(cols[0], cols[1])),
      command: squash(line.slice(cols[1], cols[2])),
      actions: actionsOf(line.slice(cols[2])),
    }
    const last = g.rows.at(-1)
    if (!cells.name && last) for (const f in cells) last[f] = squash(`${last[f]} ${cells[f]}`)
    else g.rows.push(cells)
  }
  return groups
}

// The browser frame, read off the same markup the terminal painted.
const BROWSER_FRAME = `
  const squash = (s) => s.replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('section[data-kind]')].map(s => {
    const bar = s.querySelector('.bar');
    return {
      kind:  squash(bar.querySelector('strong').textContent),
      count: Number(bar.querySelector('span').textContent),
      rows:  [...s.querySelectorAll('tr[data-id]')].map(tr => {
        const td = tr.querySelectorAll('td');
        return {
          name:    squash(td[0].textContent),
          state:   squash(td[1].textContent),
          command: squash(td[2].textContent),
          actions: [...td[3].querySelectorAll('button, a')].map(b => squash(b.textContent)).join(' '),
        };
      }),
    };
  });
`

/** Every line on which the two frames differ, as `kind/row: field a ≠ b`.
 *  A wrap may fall inside a word or at a space, so a cell is compared with
 *  its whitespace taken out. */
const same = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '')
function diff(term, web) {
  const out = []
  const kinds = (gs) => gs.map((g) => `${g.kind} ${g.count}`).join(', ')
  if (kinds(term) !== kinds(web)) out.push(`groups: terminal [${kinds(term)}] ≠ browser [${kinds(web)}]`)
  for (const w of web) {
    const t = term.find((g) => g.kind === w.kind)
    if (!t) continue
    const n = Math.max(t.rows.length, w.rows.length)
    for (let i = 0; i < n; i++) {
      const a = t.rows[i], b = w.rows[i]
      if (!a || !b) { out.push(`${w.kind}/${i}: ${a ? 'only the terminal' : 'only the browser'} has ${JSON.stringify(a ?? b)}`); continue }
      for (const f of ['name', 'state', 'command', 'actions'])
        if (!same(a[f], b[f])) out.push(`${w.kind}/${a.name}: ${f} ${JSON.stringify(a[f])} ≠ ${JSON.stringify(b[f])}`)
    }
  }
  return out
}

// Each pane after `:run`, in strip order, reached by its digit. Read off the
// line that heads the pane's first list.
const firstNumber = (s) => s.match(/\d+/)?.[0] ?? null
const PANES = [
  ['check',  '2', ['findings']],
  ['decide', '3', ['decisions']],
  ['ship',   '4', ['release', 'publish']],
  ['map',    '5', ['issues']],
  ['live',   '6', ['calls', 'jobs']],
  ['call',   '7', ['methods']],
  ['data',   '8', ['models']],
  ['ask',    '9', ['tools']],
]

// The legend is the footer's last line in the terminal and `[data-legend]` in
// the browser, compared as text with a key's bracket and spacing taken out.
const legendOf = (s) => squash(s.replace(/[[\]]/g, ' '))
const isLegend   = (l) => /: go to a pane|^\s*<CR> /.test(l)
const termLegend = () => legendOf(screen(out).filter(isLegend).at(-1) ?? '')
const webLegend  = () => browser.evaluate(`return document.querySelector('[data-legend]')?.textContent ?? ''`).then(legendOf)
async function legendsAgree(label, expect) {
  let t = '', w = ''
  const agree = async () => { t = termLegend(); w = await webLegend(); return same(t, w) && expect.every((e) => w.includes(e)) }
  check(await until(agree, 10000), `${label} — both frames show the same legend`, `terminal ${JSON.stringify(t)}\nbrowser  ${JSON.stringify(w)}`)
}

// A key at both frames: the pty takes bytes, Chrome a real key event.
const BYTES = { Enter: '\r', Escape: '\x1b' }
async function press(k) {
  pty.stdin.write(BYTES[k] ?? k)
  await (k.length === 1 ? browser.type(k) : browser.press(k))
  await sleep(150)
}

// ─── the terminal frame: `fli gui` under a pty ────────────────────────

const pty = spawn('script', ['-qfec', `stty rows ${ROWS} cols ${COLS}; bun ${FLI} gui --port ${PORT} --devtools-port ${DEVTOOLS}`, '/dev/null'], {
  cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TERM: 'xterm-256color', PATH: `${binDir}:${process.env.PATH}` },
})
let out = ''
pty.stdout.on('data', (d) => { out += d })
const exited = new Promise((r) => pty.on('exit', (code) => r(code)))
let browser = null

try {
  check(await until(answers), `fli gui at a terminal starts its server on :${PORT}`, out.slice(-500))
  const { rows: inventory } = await fetch(`${origin}/api/runnables`).then((r) => r.json())
  check(inventory.length > 10, `the workspace has rows to compare (${inventory.length})`)

  const painted = () => terminalFrame(screen(out)).reduce((n, g) => n + g.rows.length, 0) === inventory.length
    && screen(out).some((l) => l.startsWith('What can run here') && l.includes('state at'))
  check(await until(painted), 'the terminal paints every row, with a state read', screen(out).join('\n'))

  // ─── the browser frame: the same process's /console/ ────────────────

  browser = await openChrome({ windowSize: '1400,900' })
  await browser.navigate(`${origin}/console/`,
    `document.querySelectorAll('tr[data-id]').length === ${inventory.length} && document.querySelector('[data-at]')?.textContent.startsWith('state at')`)
  check(true, 'Chrome paints /console/ from the same server, every row and a state read')

  // ─── the two agree ─────────────────────────────────────────────────

  let differences = []
  for (let attempt = 0; attempt < 4; attempt++) {
    const web  = await browser.evaluate(BROWSER_FRAME)
    const term = terminalFrame(screen(out))
    differences = diff(term, web)
    if (!differences.length) {
      const counted = web.every((g) => g.count === g.rows.length) && term.every((g) => g.count === g.rows.length)
      check(counted, 'each group\'s count is the rows under it, in both frames')
      break
    }
    await sleep(3500)
  }
  check(!differences.length, 'the terminal and the browser show the same rows — group, name, state, command, actions',
    differences.slice(0, 20).join('\n') + (differences.length > 20 ? `\n… and ${differences.length - 20} more` : ''))

  // ─── the keys: the legend, then a filter typed into both ───────────

  await legendsAgree(':run', ['1–9 the panes', ': go to a pane', '/ filter', 'r read again'])

  const TERM = 'drive'
  for (const k of ['/', ...TERM, 'Enter']) await press(k)
  const total = (gs) => gs.reduce((n, g) => n + g.rows.length, 0)
  let narrowed = []
  const filtered = async () => {
    const web = await browser.evaluate(BROWSER_FRAME)
    narrowed = diff(terminalFrame(screen(out)), web)
    return total(web) > 0 && total(web) < inventory.length && !narrowed.length
  }
  check(await until(filtered, 10000), `/${TERM} narrows both frames to the same rows`, narrowed.slice(0, 10).join('\n'))
  await legendsAgree('filtered', ['<Esc> clear the filter', `filtered by /${TERM}`])
  await press('Escape')
  check(await until(async () => (await browser.evaluate(BROWSER_FRAME)).reduce((n, g) => n + g.rows.length, 0) === inventory.length
    && total(terminalFrame(screen(out))) === inventory.length, 10000), 'Esc clears the filter in both frames')

  // ─── the other panes: the count each one heads its list with ───────

  for (const [pane, digit, parts] of PANES) {
    await press(digit)
    for (const part of parts) {
      await browser.waitFor(`/\\d/.test(document.querySelector('[data-part="${part}"] .bar span')?.textContent ?? '')`, { ms: 120000 })
      const web = squash(await browser.evaluate(`return document.querySelector('[data-part="${part}"] .bar span').textContent`))
      // No space is promised after the title: the terminal paints no flex gap.
      const line = () => screen(out).find((l) => l.startsWith(part) && /^\s*\d/.test(l.slice(part.length)))
      check(await until(line, 120000), `:${pane} paints its ${part} in the terminal`, screen(out).slice(0, 40).join('\n'))
      const term = squash(line()?.slice(part.length) ?? '')
      check(firstNumber(term) !== null && firstNumber(term) === firstNumber(web), `:${pane} — both frames count the same ${part} (${firstNumber(web)})`, `terminal ${JSON.stringify(term)} ≠ browser ${JSON.stringify(web)}`)
    }
    await legendsAgree(`:${pane}`, ['1–9 the panes', pane === 'check' ? 'r check again' : 'r read again'])
  }

  // ─── :call, as a member and as nobody (Chrome) ────────────────────

  await press('7')
  const field = (label, value) => browser.evaluate(`const i = document.querySelector('input[aria-label="${label}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true`)
  const answer = (kind) => `document.querySelector('[data-answer]')?.dataset.answer === '${kind}' && document.querySelector('[data-answer]')`
  check(await until(() => browser.evaluate(`const b = document.querySelector('[data-method="notes.create"]'); b?.click(); return !!b`), 8000), ':call — notes.create is offered, read off the service')
  check(!(await browser.evaluate(`return !!document.querySelector('[data-method="notes._create"]')`)), ':call — no hook-bypass twin is offered')
  await field('as', 'ann@x.test')
  await field('arguments', '{"body":"from :call"}')
  await browser.evaluate(`document.querySelector('[data-call-go]').click(); return true`)
  check(await until(() => browser.evaluate(`return !!(${answer('ok')})?.textContent?.includes('ann@x.test (User 1)')`), 8000), ':call — a member\'s create answers ok, with the standing it ran as',
    await browser.evaluate(`return document.querySelector('[data-part="answers"]')?.textContent`))
  check(await browser.evaluate(`return !!document.querySelector('[data-result]')?.textContent.includes('from :call')`), ':call — the answer is the row it wrote')
  await field('as', '')
  await browser.evaluate(`document.querySelector('[data-call-go]').click(); return true`)
  check(await until(() => browser.evaluate(`return !!(${answer('refused')})?.textContent?.includes('403')`), 8000), ':call — the same create as nobody is refused, 403',
    await browser.evaluate(`return document.querySelector('[data-part="answers"]')?.textContent`))

  // The call ran in the app, so the feed the app's devtools keeps has it.
  await press('6')
  const fed = `[...document.querySelectorAll('[data-call]')].filter(r => r.textContent.includes('notes.create'))`
  check(await until(() => browser.evaluate(`return ${fed}.some(r => r.dataset.call === 'ok' && r.textContent.includes('internal · 1 '))`), 8000), ':live — the member\'s call is in the feed, as user 1',
    await browser.evaluate(`return ${fed}.map(r => r.textContent).join('\\n')`))
  check(await browser.evaluate(`return ${fed}.some(r => r.dataset.call === 'error' && r.textContent.includes('guest'))`), ':live — the refused call is in the feed, as a guest')
  check(await until(() => browser.evaluate(`return !!document.querySelector('[data-event="notes:created"]')`), 5000), ':live — the create announced notes:created on the bus')

  // ─── :live acts on the queue (Chrome) ─────────────────────────────

  const job   = (status, text = '') => `[...document.querySelectorAll('[data-job]')].find(r => r.querySelector('.badge')?.textContent.trim() === '${status}' && r.textContent.includes('${text}'))`
  const press$ = (row, word) => browser.evaluate(`const b = [...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === '${word}'); b?.click(); return !!b`)
  check(await until(() => browser.evaluate(`return !!${job('dead', 'handler exploded')}`), 10000), ':live — the failed job is a row, dead, with its error')
  await press$(job('dead', 'flaky-job'), 'flaky-job')
  check(await until(() => browser.evaluate(`return !!document.querySelector('[data-payload]')?.textContent.includes('ord_42')`), 5000), ':live — its name opens the payload')
  check(await press$(job('dead', 'flaky-job'), 'retry'), ':live — a dead job offers retry')
  check(await until(() => browser.evaluate(`return !!${job('done', 'flaky-job')}`), 8000), ':live — retry runs the job again, through to done')
  check(await press$(`document.querySelector('[data-handler="nightly-sweep"]')`, 'run now'), ':live — a registered handler offers run now')
  check(await until(() => browser.evaluate(`return [...document.querySelectorAll('[data-job]')].some(r => r.textContent.includes('nightly-sweep'))`), 8000), ':live — running it by hand puts it in the list')
  check(await until(() => browser.evaluate(`return document.querySelector('[data-check="jobs"]')?.textContent.includes('ok')`), 8000), ':live — health names the queue check, ok')
  check(await until(() => browser.evaluate(`return !!document.querySelector('[data-metrics="jobs"]')`), 8000), ":live — the queue's own metrics section is drawn")
  const before = await browser.evaluate(`return document.querySelectorAll('[data-call]').length`)
  await fetch(`http://127.0.0.1:${APP_PORT}/things`)
  check(await until(() => browser.evaluate(`return document.querySelectorAll('[data-call]').length > ${before}`), 5000), ':live — a call made now arrives on the stream')
  const page = await fetch(`http://127.0.0.1:${DEVTOOLS}/`).then((r) => r.status === 404 && r.text())
  check(String(page).includes(':live'), 'devtools serves no page of its own, and says where its console is', String(page))

  // ─── :data, as nobody and as a member (Chrome) ────────────────────
  //
  // Read inside the app, through its own client: the gate refuses a guest
  // outright, and the row policy leaves a guest nothing where a member sees
  // the note `:call` wrote.

  await press('8')
  // A pick reads at once, and the answer names its model and standing, so
  // the wait is for THIS read's answer rather than the one before it.
  const rowsFor = async (model, as) => {
    await field('as', as)
    await browser.evaluate(`document.querySelector('[data-model="${model}"]').click(); return true`)
    const mine = `const s = document.querySelector('[data-part="rows"]'); return s?.querySelector('code')?.textContent === '${model}' && s.querySelector('[data-standing]')?.textContent.includes('${as || 'nobody'}') ? { answer: s.dataset.answer, text: s.textContent, total: s.querySelector('[data-total]')?.dataset.total ?? null } : null`
    await until(() => browser.evaluate(mine), 8000)
    return browser.evaluate(mine)
  }
  check(await until(() => browser.evaluate(`return !!document.querySelector('[data-model="Memo"]')`), 8000), ':data — the models are the schema\'s, Memo among them')
  let seen = await rowsFor('Memo', '')
  check(seen?.answer === 'refused' && seen.text.includes('403') && seen.text.includes('requires level 3') && seen.text.includes('nobody'),
    ':data — a guest reading Memo is refused, 403, by the gate', JSON.stringify(seen))
  seen = await rowsFor('Memo', 'ann@x.test')
  check(seen?.answer === 'ok' && seen.total === '1' && seen.text.includes('for members') && seen.text.includes('ann@x.test (User 1)'),
    ':data — the same read as a member is the row', JSON.stringify(seen))
  seen = await rowsFor('Note', '')
  check(seen?.answer === 'ok' && seen.total === '0', ':data — a guest reading Note is answered and shown no row, by the policy', JSON.stringify(seen))
  seen = await rowsFor('Note', 'ann@x.test')
  check(seen?.answer === 'ok' && seen.text.includes('from :call'), ':data — a member reading Note sees the note :call wrote', JSON.stringify(seen))

  // ─── :ask, as nobody and as a member (Chrome) ─────────────────────
  //
  // The agent is graded at the standing the pane names: a guest is offered
  // fewer tools, is refused a write the policy keeps for a person, and is
  // never offered the gated model's; a member's same write lands.

  await press('9')
  const tools  = () => browser.evaluate(`return [...document.querySelectorAll('[data-tool]')].map(t => t.dataset.tool)`)
  const offeredAs = async (as) => {
    await field('as', as)
    await browser.evaluate(`document.querySelector('[data-ask-fresh]').click(); return true`)
    const label = as ? `as ${as}` : 'as nobody'
    await until(() => browser.evaluate(`return document.querySelector('[data-part="tools"] .bar span')?.textContent.includes('${label}')`), 8000)
    await browser.evaluate(`document.querySelector('[data-tools-all]')?.click(); return true`)
    await until(async () => (await tools()).length === Number(await browser.evaluate(`return document.querySelector('[data-tools]')?.dataset.tools`)), 5000)
    return tools()
  }
  const guest = await offeredAs('')
  const member = await offeredAs('ann@x.test')
  const create = guest.find((t) => t.includes('notes') && t.includes('create'))
  const memos  = member.find((t) => t.includes('memos') && t.includes('find'))
  check(!!create && !!memos && !guest.includes(memos) && member.length > guest.length,
    `:ask — the tools are the standing's: a member is offered ${memos}, a guest is not (${guest.length} < ${member.length})`, JSON.stringify({ guest, member }))
  const asked = async (as, question) => {
    await field('as', as)
    await browser.evaluate(`document.querySelector('[data-ask-fresh]').click(); return true`)
    await field('question', question)
    await browser.evaluate(`document.querySelector('[data-ask-go]').click(); return true`)
    await until(() => browser.evaluate(`return !!document.querySelector('[data-line="result"]')`), 15000)
    return browser.evaluate(`return Object.fromEntries(['you', 'tool', 'refused', 'text', 'error', 'result'].map(k => [k, [...document.querySelectorAll('[data-line="' + k + '"]')].map(l => l.textContent)]))`)
  }
  let talk = await asked('', `call ${create} {"body":"from :ask"}`)
  check(talk.tool.length === 1 && talk.refused.length === 1 && !talk.error.length && !talk.text.some((t) => t.startsWith('argv')),
    ':ask — a guest agent\'s create is made through the app\'s MCP and refused by the app', JSON.stringify(talk))
  talk = await asked('', `call ${memos} {}`)
  check(!talk.tool.length && talk.text.some((t) => t.includes('not offered')), ':ask — a guest agent is not offered the gated model at all', JSON.stringify(talk))
  talk = await asked('ann@x.test', `call ${create} {"body":"from :ask"}`)
  check(talk.tool.length === 1 && !talk.refused.length && talk.text.includes('done'), ':ask — the same create as a member lands', JSON.stringify(talk))
  check(await until(async () => (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/api/data/Note?as=ann%40x.test`)).json()).rows?.some((r) => r.body === 'from :ask'), 5000),
    ':ask — the member agent\'s note is in the app')

  // `:` and a unique prefix, back to the first pane.
  for (const k of [':', 'r', 'u', 'Enter']) await press(k)
  check(await until(painted, 20000), ':ru goes back to :run in the terminal', screen(out).slice(0, 3).join('\n') + `\nlegend: ${termLegend()}`)
  check(await until(async () => await browser.evaluate(`return document.querySelectorAll('tr[data-id]').length`) === inventory.length, 20000),
    ':ru goes back to :run in the browser', await webLegend())
  check(!browser.errors.length, 'the browser page raised no error', browser.errors.join('\n'))
} catch (e) {
  check(false, 'the drive ran to the end', e.stack ?? String(e))
} finally {
  await browser?.close()
  appProc.kill()
}

// ─── Ctrl+C stops both ────────────────────────────────────────────────

pty.stdin.write('\x03')
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
check(!(await answers()), `and :${PORT} is free after it`)
if (code === 'timeout') pty.kill('SIGKILL')

console.log(failed ? `\n${failed} failed` : '\nall green')
process.exit(failed ? 1 : 0)
