/**
 * tests/verify-ask.mjs — shift+alt-click an element, ask Claude to change it.
 *
 * The plugin's suite (`packages/cli/test/vite-ask.test.js`) pins the argv and
 * the undo against files. What only a page can show is the crossing: the
 * inspector hands the pick to the panel, the panel streams the reply, the edit
 * reaches the page through the dev server's own watcher, and the undo puts the
 * file back BYTE FOR BYTE. Any one of those broken leaves the others green.
 *
 * The site is a scratch one under tests/tmp/, served by the same `siteKit()`
 * config `bun run dev` uses, so nothing in site/ is touched. Sierra turns the
 * panel on (`src/build/ask-plugin.js`) and this config is not changed at all:
 * the fake is reached the way the real one is, as `claude` on PATH.
 *
 *   bun tests/verify-ask.mjs           a fake `claude` that makes the edit itself
 *   bun tests/verify-ask.mjs --real    the real CLI — spends up to $2 a run
 *
 * Needs Chrome on PATH or $FJS_CHROME. Refuses port 7690 if it answers.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openChrome } from '../../packages/mesa/src/drive.js'
import { siteKit } from '../packages/site-kit/config/vite.js'

const REAL   = process.argv.includes('--real')
const HERE   = dirname(fileURLToPath(import.meta.url))
// Under the tree, not the OS temp dir: the route imports resolve from here.
const ROOT   = join(HERE, 'tmp', `ask-${process.pid}`)
const ROUTE  = join(ROOT, 'content', 'routes', 'index.mesa')
const NOTE   = join(ROOT, 'content', 'sections', 'Note.mesa')
// A second file on the page, so one ask can be shown changing two.
const LEDE   = join(ROOT, 'content', 'parts', 'Lede.mesa')
const LEDE_BEFORE = 'A lede in a second file'
const LEDE_AFTER  = 'Lede changed by ask'
// test / site / project 9 (`website`) — the dev server's slot one tier down.
const PORT   = Number(process.env.ASK_PORT ?? 7690)
const ORIGIN = `http://localhost:${PORT}`
const BEFORE = 'Hello from the drive'
const AFTER  = 'Changed by ask'

const answers = await fetch(ORIGIN).then(() => true, () => false)
if (answers) {
  console.error(`${ORIGIN} already answers — stop whatever holds it; a drive against it would test that process`)
  process.exit(1)
}

// No content/settings/site.js: a site is content/ and nothing else (FJS-1709).
mkdirSync(dirname(ROUTE), { recursive: true })
mkdirSync(dirname(LEDE), { recursive: true })
// Frontmatter is stripped before Mesa sees the file, which moved every loc up
// three lines until Sierra mapped them back; the loc check below fails without it.
const SOURCE = `---\ntitle: Ask drive\n---\n<script>\n  import Lede from '../parts/Lede.mesa'\n  const subtitle = 'Made by a variable'\n</script>\n\n<section>\n  <h1 id="title">${BEFORE}</h1>\n  <h3 id="sub">{subtitle}</h3>\n  <Lede />\n  <p>A paragraph the change must leave alone.</p>\n  <ul id="items"><li>Item</li><li>Item</li></ul>\n</section>\n`
const LEDE_SOURCE = `<h2 id="lede">${LEDE_BEFORE}</h2>\n`
writeFileSync(ROUTE, SOURCE)
writeFileSync(LEDE, LEDE_SOURCE)

// The fake does what the real CLI does in the order the CLI is held to — a
// Read, a turn, then the change — and says so in stream-json. Which change
// is picked from the instruction.
const FAKE = join(ROOT, 'bin', 'claude')
mkdirSync(dirname(FAKE))
writeFileSync(FAKE, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const route = ${JSON.stringify(ROUTE)}
const note  = ${JSON.stringify(NOTE)}
const lede  = ${JSON.stringify(LEDE)}
let prompt = '', n = 0
// Started the way a person starts it, from the command the panel copies: where
// it was started and what it was handed is all a drive can ask of it.
if (!process.argv.includes('-p')) {
  writeFileSync(${JSON.stringify(join(ROOT, 'bin', 'terminal.json'))}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))
  process.exit(0)
}
// Every spawn is counted, so a drive can say a change ran no model.
const calls = ${JSON.stringify(join(ROOT, 'bin', 'calls'))}
writeFileSync(calls, (() => { try { return readFileSync(calls, 'utf8') } catch { return '' } })() + 'x')
const say   = e => process.stdout.write(JSON.stringify(e) + '\\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const call  = (name, input) => { const id = 't' + ++n; say({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }); return id }
const done  = (id, content = 'ok') => say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
async function read(file) { done(call('Read', { file_path: file })); await sleep(150) }
async function edit(file, old_string, new_string, replace_all = false) {
  await read(file)
  const id = call('Edit', { file_path: file, old_string, new_string, replace_all })
  const src = readFileSync(file, 'utf8')
  writeFileSync(file, replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, new_string))
  done(id)
}
// No Read and no pause: the write races the plugin's look, as it may for real.
function create(file, content) {
  const id = call('Write', { file_path: file, content })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  done(id, 'File created successfully at: ' + file)
}
process.stdin.on('data', d => prompt += d)
process.stdin.on('end', async () => {
  say({ type: 'system', subtype: 'init', session_id: '5acea7bb-3850-44cf-81dc-97688510acda' })
  if (!prompt.includes('content/routes/index.mesa')) {
    say({ type: 'result', subtype: 'error_during_execution', is_error: true })
    return
  }
  const change = (prompt.match(/^Change: (.*)$/m) || [])[1] || ''
  if (/every item/.test(change)) await edit(route, 'Item', 'Thing', true)
  else if (/note/.test(change)) {
    create(note, '<p id="note">A new note</p>\\n')
    await edit(route, '<script>\\n', "<script>\\n  import Note from '../sections/Note.mesa'\\n")
    await edit(route, '<section>\\n', '<section>\\n  <Note />\\n')
  }
  else if (/^Change the text "Made by a variable" to exactly: /.test(change)) {
    await edit(route, "'Made by a variable'", JSON.stringify(change.replace(/^.*exactly: /, '')).replace(/"/g, "'"))
  }
  else if (/both headings/.test(change)) {
    // Both picks must have reached the prompt, or there is nothing to change.
    if (!/Element 2 of 2:\\n- source: content\\/parts\\/Lede\\.mesa:/.test(prompt)) {
      say({ type: 'result', subtype: 'error_during_execution', is_error: true })
      return
    }
    await edit(route, ${JSON.stringify(BEFORE)}, ${JSON.stringify(AFTER)})
    await edit(lede, ${JSON.stringify(LEDE_BEFORE)}, ${JSON.stringify(LEDE_AFTER)})
  }
  else await edit(route, ${JSON.stringify(BEFORE)}, ${JSON.stringify(AFTER)})
  // The reply is a turn of its own. Without it the undo landed ~20ms after the
  // edit, the dev server's watcher reported only the first write, and the page
  // kept the edit over a file already put back.
  await sleep(300)
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Changed content/routes/index.mesa.' }] } })
  say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 2 })
})
`)
chmodSync(FAKE, 0o755)
// The dev server runs in this process, so the session it spawns inherits this.
if (!REAL) process.env.PATH = `${dirname(FAKE)}:${process.env.PATH}`

const config = await siteKit({ root: ROOT, port: PORT })
config.logLevel = 'warn'
const failures = []
const check = (name, ok, value) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${value === undefined ? '' : ` — ${JSON.stringify(value)}`}`)
  if (!ok) failures.push(name)
}
check('the dev config carries the ask plugin', config.plugins.some(p => p?.name === 'sierra:ask'))

const server = await createServer(config)
await server.listen()
const browser = await openChrome()
const { cmd, evaluate, navigate, type, press, errors } = browser
const spawns = () => { try { return readFileSync(join(ROOT, 'bin', 'calls'), 'utf8').length } catch { return 0 } }

const until = async (expr, ms, what) => {
  const t0 = Date.now()
  for (;;) {
    if (await evaluate(`return !!(${expr})`).catch(() => false)) return true
    if (Date.now() - t0 > ms) { check(`${what} (waited ${ms}ms)`, false); return false }
    await new Promise(r => setTimeout(r, 100))
  }
}
const panelText = `[...document.querySelectorAll('body > div')].map(d => d.innerText).join('\\n')`

const count = (re) => evaluate(`return (${panelText}.match(${re}) || []).length`)
const button = (label) => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)} && b.style.display !== 'none')`
// Every run that changed a file ends in a row carrying its own Undo.
const undoOf = (run) => run == null
  ? `[...document.querySelectorAll('[data-run] button')].filter(b => !b.disabled).at(-1)`
  : `document.querySelector('[data-run="${run}"] button:not(:disabled)')`
const lastRun = () => evaluate(`return [...document.querySelectorAll('[data-run]')].at(-1)?.dataset.run ?? null`)
const file = () => readFileSync(ROUTE, 'utf8')
const rows = () => evaluate(`return [...document.querySelectorAll('[data-pick]')].map(r => r.innerText)`)

// Real input: the inspector arms on a mousemove holding alt and picks on a
// click holding shift too. Modifiers: alt 1, shift 8.
async function pickAt(selector) {
  const box = await evaluate(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }`)
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, modifiers: 9 })
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 9 })
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 9 })
}

// One question through the panel, waited out by the "done" line it ends with.
async function ask(instruction) {
  const before = await count('/^done\\b/gm')
  await evaluate(`document.querySelector('textarea[placeholder^="What should change"]').focus(); return true`)
  await type(instruction)
  await evaluate(`${button('Send')}.click(); return true`)
  return until(`(${panelText}.match(/^done\\b/gm) || []).length > ${before} && ${undoOf()}`,
    REAL ? 180_000 : 10_000, `the run ended with an undo offered: ${instruction}`)
}

async function undo(run = null) {
  const before = await count('/^(not )?undone: /gm')
  await evaluate(`${undoOf(run)}.click(); return true`)
  return until(`(${panelText}.match(/^(not )?undone: /gm) || []).length > ${before}`, 5_000, 'the undo answered')
}

try {
  await navigate(ORIGIN + '/')
  // Two scripts and either may be the one missing, so each is waited for by name.
  if (!await until(`window.__fjsInspect && document.querySelector('#title')`, 10_000, 'the page rendered with the inspector')) throw new Error('stop')
  if (!await until(`window.__fjsAsk`, 5_000, 'the ask client loaded')) throw new Error('stop')
  check('a site with no settings file renders, inspector and ask client loaded', true)
  const titleLine = SOURCE.split('\n').findIndex(l => l.includes('<h1 id="title">')) + 1
  check('the heading carries its source location, on the line it is written',
    (await evaluate(`return document.querySelector('#title').getAttribute('data-fjs-loc')`)) === `content/routes/index.mesa:${titleLine}:3`,
    await evaluate(`return document.querySelector('#title').getAttribute('data-fjs-loc')`))

  await pickAt('#title')
  if (!await until(`document.querySelector('textarea[placeholder^="What should change"]')`, 3000, 'shift+alt-click opened the panel')) throw new Error('stop')

  const panel = await evaluate(`return ${panelText}`)
  check('the panel names the picked source', panel.includes('content/routes/index.mesa:'))
  check('the panel tells the two clicks apart', panel.includes('alt-click opens the source in your editor') && panel.includes('shift+alt-click asks here'))
  // Caught before it leaves the page: the drive must not launch an editor.
  const opened = await evaluate(`
    const asked = [], real = window.fetch
    window.fetch = (url, ...rest) => String(url).includes('__open-in-editor') ? (asked.push(String(url)), Promise.resolve(new Response(''))) : real(url, ...rest);
    ${button('Open source')}.click()
    window.fetch = real
    return asked`)
  check('"Open source" asks the editor for the picked line', opened.length === 1 && /index\.mesa%3A\d+%3A\d+$/.test(opened[0]), opened)

  // ── an edit, undone whole ────────────────────────────────────────────────
  if (await ask(`Change this heading's text to exactly: ${AFTER}`)) {
    if (await until(`document.querySelector('#title')?.textContent.trim() === ${JSON.stringify(AFTER)}`, 10_000, 'the page shows the new heading'))
      check('the page shows the new heading', true)
    check('the paragraph beside it is untouched', file().includes('A paragraph the change must leave alone.'))
    const log = await evaluate(`return ${panelText}`)
    check('the panel reported the edit and the end of the run', /Edit .*index\.mesa/.test(log) && /^done\b/m.test(log), log.split('\n').slice(-4))
    check('the panel shows the diff, removed then added', /^- .*Hello from the drive.*\n\+ .*Changed by ask/m.test(log))
    check('a session id is kept for a follow-up', /^[0-9a-f-]{36}$/.test(await evaluate(`return sessionStorage.getItem('fli:ask:session') ?? ''`)))
    await undo()
    if (await until(`document.querySelector('#title')?.textContent.trim() === ${JSON.stringify(BEFORE)}`, 10_000, 'the undo reached the page'))
      check('the undo reached the page', true)
    check('the undo put the file back byte for byte', file() === SOURCE)
    check('the panel reported what it undid', (await evaluate(`return ${panelText}`)).includes('undone: content/routes/index.mesa'))

    // ── the conversation, handed to a terminal ─────────────────────────────
    // The clipboard is stubbed: a headless page has no one to grant it.
    const copy = async () => {
      await evaluate(`window.__copied = null
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied = t } } })
        ;${button('Continue in terminal')}.click(); return true`)
      return await until('window.__copied', 3000, '"Continue in terminal" copied something') ? evaluate('return window.__copied') : ''
    }
    const session = await evaluate(`return sessionStorage.getItem('fli:ask:session')`)
    const command = await copy()
    check('"Continue in terminal" copies cd to the app root and a resume of this conversation',
      command === `cd ${ROOT} && claude --resume ${session}`, command)
    check('the panel shows the command too', (await evaluate(`return ${panelText}`)).includes(command))
    if (!REAL && command) {
      const ran = spawnSync('sh', ['-c', command], { encoding: 'utf8', input: '' })
      let seen = null
      try { seen = JSON.parse(readFileSync(join(ROOT, 'bin', 'terminal.json'), 'utf8')) } catch {}
      check('the copied command, run in a shell, starts claude in the root resuming that session',
        ran.status === 0 && seen?.cwd === realpathSync(ROOT) && JSON.stringify(seen?.argv) === JSON.stringify(['--resume', session]), seen ?? ran.stderr)
    }

    // Before a conversation: what a first ask would send, for any agent.
    await evaluate(`${button('New chat')}.click(); document.querySelector('textarea[placeholder^="What should change"]').focus(); return true`)
    await type('Make it bigger')
    const block = await copy()
    check('with no conversation it copies the unsent instruction, the absolute source and the HTML',
      block.includes('Change: Make it bigger') && block.includes(`- source: ${join(ROOT, 'content/routes/index.mesa')}:${titleLine}:3`) && block.includes('<h1 id="title"'),
      block.slice(0, 200))
    check('and none of the rules a model run is held to', !block.includes('Another session may be editing'))
    await evaluate(`document.querySelector('textarea[placeholder^="What should change"]').value = ''; return true`)
  }

  // The real CLI chooses how to make a change; the cases below pin how the
  // plugin undoes one particular shape, so they are asked of the fake only.
  if (!REAL) {
    // ── a replace-all: no single hunk to reverse ──────────────────────────
    if (await ask('Rename every item to Thing')) {
      await until(`[...document.querySelectorAll('#items li')].every(li => li.textContent === 'Thing')`, 10_000, 'the page shows both items renamed')
      check('the replace-all changed both items', (file().match(/Thing/g) || []).length === 2)
      await undo()
      check('the replace-all undo put the file back byte for byte', file() === SOURCE)
    }

    // ── a new file, and the edit that uses it ─────────────────────────────
    if (await ask('Add a note above the heading')) {
      if (await until(`document.querySelector('#note')?.textContent === 'A new note'`, 10_000, 'the page shows the new section'))
        check('the page shows the new section', true)
      check('the panel shows the new file all added', /content\/sections\/Note\.mesa\s+\(new file\)\n\+ <p id="note">/.test(await evaluate(`return ${panelText}`)))
      await undo()
      check('the undo removed the new file and the folder it made', !existsSync(dirname(NOTE)))
      check('the undo put the route back byte for byte', file() === SOURCE)
      await until(`!document.querySelector('#note') && document.querySelector('#title')`, 10_000, 'the page lost the section again')
    }

    // ── another writer in the file since: their line stays ────────────────
    if (await ask(`Change this heading's text to exactly: ${AFTER}`)) {
      const theirs = file().replace('A paragraph the change must leave alone.', 'A paragraph another session rewrote.')
      writeFileSync(ROUTE, theirs)
      await undo()
      check('the undo reversed only its own hunk and kept the other writer\'s line',
        file() === SOURCE.replace('A paragraph the change must leave alone.', 'A paragraph another session rewrote.'))
    }

    // ── two picks in two files, one instruction, one undo ─────────────────
    // The last ask was sent, so this first pick starts a new list.
    const routeNow = file()
    await pickAt('#title')
    await pickAt('#lede')
    await pickAt('section > p')
    check('each shift+alt-click before a send adds to the list', (await rows()).length === 3, await rows())
    await evaluate(`[...document.querySelectorAll('[data-pick]')].find(r => r.innerText.includes('<p>')).querySelector('button[title^="Leave"]').click(); return true`)
    const picked = await rows()
    check('a pick can be left out again', picked.length === 2 && picked[0].includes('content/routes/index.mesa:') && picked[1].includes('content/parts/Lede.mesa:'), picked)
    check('the panel counts what it will change', (await evaluate(`return ${panelText}`)).includes('Ask Claude to change these 2'))
    if (await ask('Change both headings')) {
      if (await until(`document.querySelector('#title')?.textContent.trim() === ${JSON.stringify(AFTER)} && document.querySelector('#lede')?.textContent.trim() === ${JSON.stringify(LEDE_AFTER)}`, 10_000, 'the page shows both headings changed'))
        check('one instruction changed both files', true)
      const log = await evaluate(`return ${panelText}`)
      check('the panel shows a diff for each file', log.includes('content/routes/index.mesa\n') && log.includes('content/parts/Lede.mesa\n'))
      await undo()
      check('one undo put the route back byte for byte', file() === routeNow)
      check('the same undo put the second file back byte for byte', readFileSync(LEDE, 'utf8') === LEDE_SOURCE)
      await until(`document.querySelector('#lede')?.textContent.trim() === ${JSON.stringify(LEDE_BEFORE)}`, 10_000, 'the undo reached the second file on the page')
    }
    await pickAt('#title')
    check('the first pick after a send starts a new list', (await rows()).length === 1, await rows())

    // ── a text edit with no model, and one that has to ask ────────────────
    // Typed into an input laid over the element, committed with Enter.
    async function editText(selector, next) {
      await pickAt(selector)
      const row = `[...document.querySelectorAll('[data-pick]')].at(-1)`
      await evaluate(`${row}.querySelector('button[title^="Change the words"]').click(); return true`)
      if (!await until(`document.activeElement?.matches('textarea[data-fjs-text-edit]')`, 3000, 'Edit text opened an input over the element')) return false
      await type(next)
      const before = await count('/^done\\b/gm')
      await press('Enter')
      return until(`(${panelText}.match(/^done\\b/gm) || []).length > ${before} && ${undoOf()}`, 10_000, `the text edit ended with an undo offered: ${next}`)
    }

    const plain = file(), spawned = spawns()
    if (await editText('#title', 'Typed in place')) {
      check('a static heading was edited with no Claude run', spawns() === spawned)
      if (await until(`document.querySelector('#title')?.textContent.trim() === 'Typed in place'`, 10_000, 'the page shows the typed heading'))
        check('the page shows the typed heading', true)
      const was = plain.split('\n'), now = file().split('\n')
      const changed = now.map((l, i) => l !== was[i] ? i : -1).filter(i => i !== -1)
      check('the file changed by that one line', was.length === now.length && changed.length === 1 && now[changed[0]].includes('<h1 id="title">Typed in place</h1>'), changed.map(i => now[i]))
      const log = await evaluate(`return ${panelText}`)
      check('the panel says no model ran, and shows the diff', /edited directly, no Claude run/.test(log) && /^- .*Hello from the drive.*\n\+ .*Typed in place/m.test(log))
      check('the element itself was never made editable', await evaluate(`return !document.querySelector('[contenteditable]') && !document.querySelector('textarea[data-fjs-text-edit]')`))
      await undo()
      check('the text edit undo put the file back byte for byte', file() === plain)
      await until(`document.querySelector('#title')?.textContent.trim() === ${JSON.stringify(BEFORE)}`, 10_000, 'the text edit undo reached the page')
    }

    if (await editText('#sub', 'Made by Claude')) {
      check('interpolated text fell back to a Claude run', spawns() === spawned + 1)
      check('the panel says which path ran', /not a plain text edit \(the text is not written in the source/.test(await evaluate(`return ${panelText}`)))
      check('the fallback made the change', file().includes("const subtitle = 'Made by Claude'"))
      if (await until(`document.querySelector('#sub')?.textContent.trim() === 'Made by Claude'`, 10_000, 'the page shows the fallback\'s change'))
        check('the page shows the fallback\'s change', true)
      await undo()
      check('the fallback undo put the file back byte for byte', file() === plain)
    }

    // ── an older run undone after a newer one in the same file ────────────
    const para = await evaluate(`return document.querySelector('section > p').textContent.trim()`)
    if (await editText('#title', 'First edit')) {
      const first = await lastRun()
      if (await editText('section > p', 'Second edit')) {
        const second = await lastRun()
        check('each run ends in a row with its own Undo', first && second && first !== second
          && await evaluate(`return document.querySelectorAll('[data-run] button:not(:disabled)').length`) >= 2)
        await undo(first)
        check('undoing the older run put its line back and kept the newer run\'s', file() === plain.replace(para, 'Second edit'))
        check('the older run\'s Undo is spent', await evaluate(`return document.querySelector('[data-run="${first}"] button').disabled`))
        await undo(second)
        check('then the newer run\'s Undo put the file back byte for byte', file() === plain)
        await until(`document.querySelector('section > p')?.textContent.trim() === ${JSON.stringify(para)}`, 10_000, 'both undos reached the page')
      }
    }

    // ── a reload keeps the log, and the Undo in it still undoes ────────────
    if (await editText('#title', 'Before the reload')) {
      const run = await lastRun()
      await navigate(ORIGIN + '/')
      if (await until(`window.__fjsAsk && document.querySelector('[data-run="${run}"] button:not(:disabled)')`, 10_000, 'the panel came back after a reload with the run\'s Undo')) {
        check('the panel came back after a reload with the run\'s Undo', true)
        check('and with the diff it showed', /^\+ .*Before the reload/m.test(await evaluate(`return ${panelText}`)))
        await undo(run)
        check('the Undo from before the reload put the file back byte for byte', file() === plain)
        await until(`document.querySelector('#title')?.textContent.trim() === ${JSON.stringify(BEFORE)}`, 10_000, 'the undo after a reload reached the page')
      }
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.title.startsWith('Close'))?.click(); return true`)
      await navigate(ORIGIN + '/')
      await until('window.__fjsAsk && document.querySelector("#title")', 10_000, 'the page loaded again')
      check('a panel closed before the reload stays closed', !await evaluate(`return !!document.querySelector('[data-run]')?.offsetParent`))
    }
  }

  check('the page threw nothing', errors.length === 0, errors.slice(0, 3))
} catch (err) {
  if (err.message !== 'stop') throw err
} finally {
  await browser.close()
  await server.close()
  rmSync(ROOT, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n${failures.map(f => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log(`\nask drive passed${REAL ? ' against the real CLI' : ''}`)
process.exit(0)
