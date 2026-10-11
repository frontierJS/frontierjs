// The SQLITE_BUSY retry in `applyWal` sleeps between attempts, and a browser
// worker that is not cross-origin isolated has no SharedArrayBuffer to sleep on.
// FJS-2320: the first busy error on a device database was a ReferenceError
// naming SharedArrayBuffer instead of a retry. Run under `node --conditions=browser`
// with the global removed, which is the host the retry has to survive.

import { test, expect } from 'bun:test'
import { join } from 'path'

const PRAGMAS = join(import.meta.dir, '../src/core/pragmas.js')

test('applyWal retries a busy switch where SharedArrayBuffer does not exist', () => {
  const script = `
    delete globalThis.SharedArrayBuffer
    const { applyWal } = await import(${JSON.stringify(PRAGMAS)})
    let busy = 3
    const db = { run(sql) {
      if (sql.includes('journal_mode') && busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    } }
    try { applyWal(db, 1000); console.log('ok ' + busy) } catch (e) { console.log(e.name + ': ' + e.message) }
  `
  const run = Bun.spawnSync(['node', '--conditions=browser', '--no-warnings', '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  expect(run.stdout.toString().trim()).toBe('ok -1')
})
