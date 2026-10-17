/*
 * wedged — a browser stopped outright fails the one job, and the job behind it
 * prints on a fresh browser (FJS-2230). Every call to a stopped browser goes
 * unanswered, the job's own and any its cleanup sends.
 */
import { spawnSync } from 'node:child_process'
import { createPrinter } from '../../index.js'

export const name = 'a wedged browser'

export async function run(t) {
  const wedged = createPrinter()
  try {
    const known = new Set(spawnSync('pgrep', ['-P', String(process.pid), 'chrome'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean))
    await wedged.pdf('<p>warm</p>')
    // The shared printer's browser is a child of this process too; only the
    // one this printer launched is stopped.
    const chrome = spawnSync('pgrep', ['-P', String(process.pid), 'chrome'], { encoding: 'utf8' }).stdout.trim().split('\n')
      .filter((pid) => pid && !known.has(pid))
    t.ok(chrome.length > 0, 'the printer has a browser to stop')
    for (const pid of chrome) process.kill(Number(pid), 'SIGSTOP')

    const t0 = performance.now()
    const first = wedged.pdf('<p>first</p>').then(() => 'printed', (e) => e.message)
    const next  = wedged.pdf('<p>next</p>').then(() => 'printed', (e) => e.message)
    t.match(await first, /did not answer/, 'fails the one job')
    // Resumed so the discarded browser's own close is quick, not so the next
    // job can use it: the job is already on its way to a fresh one.
    for (const pid of chrome) process.kill(Number(pid), 'SIGCONT')
    t.is(await next, 'printed', 'and the job behind it prints')
    // The call's own 30s and a launch — not a second and third 30s spent
    // asking the wedged browser to close its tab.
    const took = performance.now() - t0
    t.ok(took < 40000, `inside one call's bound and a launch (took ${Math.round(took)}ms)`)
    t.is(wedged.stats().launches, 2, 'on a fresh browser')
  } finally { await wedged.close() }
}
