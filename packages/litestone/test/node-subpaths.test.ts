// The schema-only subpaths load under Node.
//
// Sierra's schema plugin runs wherever Vite runs, which is Node, and imports
// `./parser`, `./jsonschema` and `./device-schema` by hand for that reason: the
// package root reaches bun:sqlite. A schema file that comes to import anything
// driver-side throws there, the plugin answers "could not be loaded" and ships
// the browser no schema, and every generated form is empty and every can()
// answers yes. Nothing under `bun test` notices, because Bun loads `bun:` fine.
// It happened once: plugins/gate.js began importing core/include.js for
// FJS-1646, and jsonschema.js imports plugins/gate.js (found by the transit
// stressor's browser drive, 2026-10-03).

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root     = join(import.meta.dir, '..')
const exports_ = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports
const node     = Bun.spawnSync(['node', '--version']).exitCode === 0

describe('the subpaths a Node build tool imports', () => {
  for (const sub of ['./parser', './jsonschema', './device-schema']) {
    it.skipIf(!node)(`${sub} imports under Node`, () => {
      const file = join(root, exports_[sub].import)
      const run  = Bun.spawnSync(['node', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(file)})`])
      expect(run.stderr.toString()).toBe('')
      expect(run.exitCode).toBe(0)
    })
  }
})
