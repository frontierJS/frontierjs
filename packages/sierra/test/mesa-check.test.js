// @vitest-environment node
/**
 * test/mesa-check.test.js — the gate `fli check`'s mesa-compiles runs
 *
 * A compile with no errors can still emit a module that does not parse
 * (Invariant 15): `{@const t = { w, h }}` built nowhere while this gate passed
 * it (`FJS-2489`). The compiler here is a stub, so the test holds whatever
 * the real compiler's next such bug turns out to be.
 */

import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { checkMesaFiles } from '../src/build/mesa-check.js'
import { findMesaFile } from '../src/build/mesa-plugin.js'

const acornDir = () => {
  const entry = createRequire(findMesaFile('compiler.js', process.cwd())).resolve('acorn')
  return dirname(dirname(entry))
}

const appWithCompiler = (emitted) => {
  const root = mkdtempSync(join(tmpdir(), 'sierra-mesa-check-'))
  const mesa = join(root, 'node_modules', '@frontierjs', 'mesa')
  mkdirSync(mesa, { recursive: true })
  symlinkSync(acornDir(), join(root, 'node_modules', 'acorn'))
  writeFileSync(join(root, 'package.json'), '{ "name": "app" }\n')
  writeFileSync(join(mesa, 'package.json'), '{ "name": "@frontierjs/mesa" }\n')
  writeFileSync(join(mesa, 'compiler.js'),
    `export const compileSource = async () => ({ analysis: { errors: [] }, result: ${JSON.stringify(emitted)} })\n`)
  const file = join(root, 'T.mesa')
  writeFileSync(file, '<p>x</p>\n')
  return { root, file }
}

describe('checkMesaFiles', () => {
  test('a clean compile whose output does not parse is a failure', async () => {
    const { root, file } = appWithCompiler('const m = createMemo(() => { w: 1, h: 2 })\n')
    const failed = await checkMesaFiles([file], { root })
    expect(failed).toHaveLength(1)
    expect(failed[0].file).toBe(file)
    expect(failed[0].errors[0]).toMatch(/does not parse/)
  })

  test('a clean compile whose output parses passes', async () => {
    const { root, file } = appWithCompiler("import { x } from 'y'\nexport default function T() { return x }\n")
    expect(await checkMesaFiles([file], { root })).toEqual([])
  })
})
