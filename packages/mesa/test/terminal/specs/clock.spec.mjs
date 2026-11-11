/*
 * clock — the terminal runtime's timers never hold a process open
 * (IDEAS/mesa-clock.md 5.0).
 *
 * A TUI exits when its last handle goes; haven's `Study.mesa` unrefs its
 * intervals by hand for that. A green run pins: importing the terminal runtime
 * installs its source, and a child process that arms a long `every` and a long
 * `after` on Mesa's clock — nothing else alive — exits at once.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'clock — a declared timer never holds the TUI open'

const TERMINAL = fileURLToPath(new URL('../../../src/runtime-terminal.js', import.meta.url))
const CLOCK = fileURLToPath(new URL('../../../src/clock.js', import.meta.url))

export async function run(t) {
  const { clock } = t.runtime
  const prev = clock.use(null)
  clock.use(prev)
  t.is(prev, t.tui.terminalSource, 'the terminal runtime installs its own clock source')

  const script = `
    await import(${JSON.stringify(TERMINAL)})
    const { clock } = await import(${JSON.stringify(CLOCK)})
    clock.every(60000, () => {}, '$.every')
    clock.after(60000, () => {}, '$.after')
    clock.frame(() => {})
  `
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 10000, encoding: 'utf8' })
  t.is(r.status, 0, `the child exited cleanly${r.stderr ? ` — ${r.stderr.trim().split('\n').at(-1)}` : ''}`)
  t.ok(Date.now() - t0 < 5000, `with a 60 s every and after armed, it exited in ${Date.now() - t0} ms`)
}
