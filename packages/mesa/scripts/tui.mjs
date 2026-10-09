/*
 * tui.mjs — run one `.mesa` file live in this terminal, `target: 'terminal'`.
 *
 *   bun run tui <file.mesa>                   Tab moves focus, Enter or a click presses, Ctrl+C quits
 *   bun run tui <file.mesa> --frame           print one 60x20 frame and exit, no TTY needed
 *   bun run tui <file.mesa> --props='{"label":"Revenue"}'
 *                                             props for the root component, as JSON
 *
 * A path is relative to the process's directory, which `bun run` sets to
 * `packages/mesa` (and `$PWD` with it); from anywhere else, call the file:
 * `bun packages/mesa/scripts/tui.mjs packages/ui/components/display/Stat.mesa`.
 * A file that does not lower
 * prints the compiler's refusal, which is the answer to "how far is this from
 * the terminal"; `bun run corpus -- --portability terminal` asks it of every
 * file at once.
 *
 * Traps:
 * - The engine is imported from this file, so it resolves from
 *   `packages/mesa` wherever the command is typed. A script living elsewhere
 *   importing `@opentui/core` gets a second copy, and two copies fail
 *   `instanceof` inside the engine.
 * - A component with no props is often an empty frame: most of the kit
 *   renders nothing until it is given a label or a value.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCliRenderer } from '@opentui/core'
import { compileTree } from './terminal-tree.js'
import * as tui from '../src/runtime-terminal.js'

const argv  = process.argv.slice(2)
const file  = argv.find((a) => !a.startsWith('--'))
const frame = argv.includes('--frame')
const props = JSON.parse(argv.find((a) => a.startsWith('--props='))?.slice('--props='.length) ?? '{}')
if (!file) {
  console.error('usage: bun run tui <file.mesa> [--frame] [--props=JSON]')
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'mesa-tui-'))
const clean = () => rmSync(tmp, { recursive: true, force: true })

let Component
try {
  Component = (await import(await compileTree(resolve(file), tmp))).default
} catch (e) {
  clean()
  console.error(`does not lower: ${e.message}`)
  process.exit(1)
}

if (frame) {
  const { createTestRenderer } = await import('@opentui/core/testing')
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 20 })
  tui.mount(Component, { renderer, props })
  await new Promise((r) => setTimeout(r))
  await renderOnce()
  console.log(captureCharFrame().replace(/\s+$/, ''))
  renderer.destroy()
  clean()
  process.exit(0)
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: clean })
tui.mount(Component, { renderer, props })
tui.focusNext()
