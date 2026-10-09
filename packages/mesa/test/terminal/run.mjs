/*
 * run.mjs — the terminal drive.
 *
 *   bun test/terminal/run.mjs               every spec
 *   bun test/terminal/run.mjs counter       specs whose filename matches
 *   bun test/terminal/run.mjs --verbose     print the passing rows too
 *
 * Bun only: `@opentui/core` is a Zig renderer over Bun FFI whose Node build
 * wants a newer Node than this machine has, which is also why nothing here is
 * a vitest `*.test.js` — vitest.config.js excludes `test/terminal/**`.
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * A `.mesa` component on a terminal, run rather than described: the frame a
 * person would see, captured from the headless renderer
 * (`@opentui/core/testing`) after real key input through the engine's own
 * parser. No Chrome, no TTY. Every `specs/*.spec.mjs` exports `run(t)`; this
 * file is the only thing that imports them, prints pass/fail per spec and
 * exits 1 on any failure. A failed `expectFrame` prints the whole frame, since
 * the frame is the evidence.
 *
 * Traps:
 * - Mesa flushes on a microtask, so every key helper waits a tick and renders
 *   once before returning; a spec that reads the frame straight after a
 *   mockInput call of its own sees the previous state.
 * - A fixture is compiled with its imports by `scripts/terminal-tree.js`,
 *   which `bun run tui` shares; its header carries the module traps.
 */
import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTestRenderer } from '@opentui/core/testing'
import * as runtime from '../../src/runtime.js'
import * as tui from '../../src/runtime-terminal.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red   = (s) => `\x1b[31m${s}\x1b[0m`
const dim   = (s) => `\x1b[2m${s}\x1b[0m`

const argv    = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const filters = argv.filter((a) => !a.startsWith('--'))

const WIDTH = 40, HEIGHT = 12

const tick = () => new Promise((r) => setTimeout(r))

// ─── the spec API ─────────────────────────────────────────────────────

function makeT(rows, tmp) {
  let current = null   // { setup, handle } for the mount in progress
  const need = () => {
    if (!current) throw new Error('t.mount() first')
    return current
  }
  const settle = async () => {
    await tick()
    runtime.flushSync()
    await need().setup.renderOnce()
  }
  const t = {
    tui, runtime,
    WIDTH, HEIGHT,

    /** Compile `fixtures/<name>.mesa` for the terminal and import the module. */
    compile: async (name) => {
      // Loaded here rather than at the top: a compiler that fails to import
      // fails the spec that asked for it, not the drive and every spec in it.
      const { compileTree } = await import('../../scripts/terminal-tree.js')
      const mod = await import(await compileTree(join(HERE, 'fixtures', `${name}.mesa`), tmp))
      return mod.default
    },

    /** A fresh headless renderer, 40x12 unless sized, and a mount of `Component` into its root. */
    mount: async (Component, props = {}, { width = WIDTH, height = HEIGHT } = {}) => {
      if (current) await t.unmount()
      const setup = await createTestRenderer({ width, height })
      const handle = tui.mount(Component, { renderer: setup.renderer, props })
      current = { setup, handle }
      await setup.renderOnce()
      return handle
    },
    unmount: async () => {
      if (!current) return
      const { setup, handle } = current
      current = null
      handle.dispose()
      setup.renderer.destroy()
    },

    frame: async () => {
      const { setup } = need()
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
    press: async (key, modifiers) => { need().setup.mockInput.pressKey(key, modifiers); await settle() },
    type:  async (text) => { await need().setup.mockInput.typeText(text); await settle() },
    tab:   async (modifiers) => { need().setup.mockInput.pressTab(modifiers); await settle() },
    enter: async () => { need().setup.mockInput.pressEnter(); await settle() },
    /** Flush Mesa and paint, for a state change made without a key. */
    settle,

    ok: (v, label) => rows.push({ name: label, ok: !!v, detail: `got ${show(v)}` }),
    is: (actual, expected, label) => rows.push({
      name: label, ok: Object.is(actual, expected),
      detail: `expected ${show(expected)}, got ${show(actual)}`,
    }),
    /** Every string in `lines` appears in `frame`, in that order. */
    expectFrame: (frame, lines, label = lines.join(' · ')) => {
      let from = 0, missing = null
      for (const line of lines) {
        const at = frame.indexOf(line, from)
        if (at < 0) { missing = line; break }
        from = at + line.length
      }
      rows.push({
        name: label, ok: missing === null,
        detail: missing === null ? '' : `${JSON.stringify(missing)} not found in order\n${boxed(frame)}`,
      })
    },
    /** Polls `fn` for a truthy value up to ~500 ms. */
    eventually: async (fn, label, ms = 500) => {
      const t0 = Date.now()
      let v
      for (;;) {
        v = await fn()
        if (v || Date.now() - t0 > ms) break
        await new Promise((r) => setTimeout(r, 10))
      }
      rows.push({ name: label, ok: !!v, detail: `got ${show(v)}` })
    },
  }
  return t
}

/** A renderable in a failure detail is its class and id, not a walk of the
 *  engine's graph, which `JSON.stringify` cannot do and throws on. */
function show(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.constructor !== Object)
    return `<${v.constructor?.name ?? 'object'}${v.id ? ' ' + v.id : ''}>`
  try { return JSON.stringify(v) } catch { return String(v) }
}

function boxed(frame) {
  const lines = frame.split('\n')
  const w = Math.max(...lines.map((l) => l.length))
  const rule = '+' + '-'.repeat(w) + '+'
  return [rule, ...lines.map((l) => '|' + l.padEnd(w) + '|'), rule].join('\n')
}

// ─── the run ──────────────────────────────────────────────────────────

const specDir = join(HERE, 'specs')
let specFiles = existsSync(specDir)
  ? readdirSync(specDir).filter((f) => f.endsWith('.spec.mjs')).sort()
  : []
if (filters.length) specFiles = specFiles.filter((f) => filters.some((x) => f.includes(x)))
if (!specFiles.length) {
  console.error(filters.length ? `No spec matches: ${filters.join(', ')}` : 'No specs found.')
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'mesa-terminal-'))
let failures = 0
let total = 0

for (const file of specFiles) {
  const mod = await import(pathToFileURL(join(specDir, file)).href)
  const name = mod.name ?? basename(file, '.spec.mjs')
  const rows = []
  const t = makeT(rows, tmp)
  try {
    await mod.run(t)
  } catch (e) {
    rows.push({ name: 'spec threw', ok: false, detail: e?.stack ?? String(e) })
  } finally {
    await t.unmount().catch((e) => rows.push({ name: 'teardown', ok: false, detail: String(e) }))
  }
  const failed = rows.filter((r) => !r.ok)
  total += rows.length
  failures += failed.length
  console.log(`${failed.length ? red('✗') : green('✓')} ${name} ${dim(`${rows.length - failed.length}/${rows.length}`)}`)
  for (const r of rows) {
    if (r.ok && !verbose) continue
    console.log(`  ${r.ok ? green('ok') : red('FAIL')} ${r.name}`)
    if (!r.ok && r.detail) console.log(r.detail.split('\n').map((l) => '       ' + l).join('\n'))
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures ? red(`${failures} of ${total} assertions failed`) : green(`${total} assertions, all green`))
process.exit(failures ? 1 : 0)
