/*
 * emit-types.spec.js
 *
 * scripts/emit-types.mjs writes the .d.ts an installed app reads in place of
 * this kit's JS. A linked app read the JS itself, where tsc takes an untyped
 * function to accept any number of arguments; a declaration requiring every
 * parameter made the same call TS2554 once installed (FJS-4330). A fixture
 * package is emitted and an app typechecked against it, the way an install
 * reads it.
 */

import { spawnSync }                                         from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join }                                     from 'node:path'
import { fileURLToPath }                                     from 'node:url'

import { findTsc }                                           from '../../../cli/core/typecheck.js'

const here   = dirname(fileURLToPath(import.meta.url))
const script = join(here, '../../../../scripts/emit-types.mjs')

const KIT = `
export function untyped(a, b) { return a }
/** @returns {number} */
export function onlyReturns(a) { return 1 }
export const arrow = (a) => a
export class Store {
  constructor(config) {}
  put(key, value) {}
}
/** @param {string} name */
export function typed(name) { return name }
`

const APP = `
import { untyped, onlyReturns, arrow, Store, typed } from './kit/kit.js'
untyped()
untyped(1)
onlyReturns()
arrow()
new Store().put('k')
// @ts-expect-error -- a documented parameter stays required
typed()
`

function emitAndCheck() {
  // Inside the node_modules tsc lives in: the script finds tsc by walking up.
  const tsc = findTsc(here)
  const tmp = mkdtempSync(join(dirname(dirname(tsc)), '.emit-types-spec-'))
  try {
    const kit = join(tmp, 'kit')
    mkdirSync(kit)
    writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: 'kit', type: 'module', exports: { '.': './kit.js' } }))
    writeFileSync(join(kit, 'kit.js'), KIT)
    const emit = spawnSync(process.execPath, [script], { cwd: kit, encoding: 'utf8' })
    if (emit.status !== 0) throw new Error(`emit failed: ${emit.stdout}${emit.stderr}`)

    writeFileSync(join(tmp, 'app.ts'), APP)
    const run = spawnSync(tsc, [
      '--noEmit', '--strict', '--module', 'preserve', '--moduleResolution', 'bundler', '--skipLibCheck', 'app.ts',
    ], { cwd: tmp, encoding: 'utf8' })
    return { status: run.status, out: run.stdout + run.stderr, dts: readFileSync(join(kit, 'kit.d.ts'), 'utf8') }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('an untyped JS parameter declares optional, as tsc reads the JS', () => {
  const { status, out, dts } = emitAndCheck()
  assert.equal(out.trim(), '', `the app typechecks against\n${dts}`)
  assert.equal(status, 0)
})
