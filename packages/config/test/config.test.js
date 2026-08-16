// What this package ships is three files and a claim about each of them. The
// files have no code to run, so the tests are about the claims: that a caller
// extending them gets what the README says, and that the one file which HAS to
// be copied has not drifted from its copy.

import { test, expect, describe } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { dirname, resolve }       from 'node:path'
import { fileURLToPath }          from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = resolve(HERE, '..')

const read = (rel) => readFileSync(resolve(PKG, rel), 'utf8')

// tsconfig.json is jsonc — TypeScript reads comments and the file has them.
const stripComments = (text) => text
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('the package surface', () => {
  test('every exports target exists and is listed in files', () => {
    const pkg = JSON.parse(read('package.json'))
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const rel = target.replace('./', '')
      expect(() => read(rel)).not.toThrow(`${subpath} → ${target}`)
      expect(pkg.files).toContain(rel)
    }
  })

  test('it declares no dependency of its own', () => {
    const pkg = JSON.parse(read('package.json'))
    // A config package that drags a runtime in is a config package nobody can
    // add to an app they have already tuned. Biome and TypeScript are peers and
    // both optional: an app that deletes biome.json should still install.
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.peerDependenciesMeta['@biomejs/biome'].optional).toBe(true)
    expect(pkg.peerDependenciesMeta.typescript.optional).toBe(true)
  })
})

describe('tsconfig', () => {
  const ts = JSON.parse(stripComments(read('tsconfig.json')))

  test('an app extending it can still import .ts from the framework', () => {
    // Every @frontierjs exports map points at a .ts, so this is not a
    // preference — without it a scaffolded app does not resolve at all.
    expect(ts.compilerOptions.allowImportingTsExtensions).toBe(true)
    expect(ts.compilerOptions.noEmit).toBe(true)
  })

  test('it is strict, and says nothing about the app layout', () => {
    expect(ts.compilerOptions.strict).toBe(true)
    // paths and include belong to the app: they are the only part of a tsconfig
    // that is about where the files are rather than how they are checked.
    expect(ts.compilerOptions.paths).toBeUndefined()
    expect(ts.include).toBeUndefined()
  })

  test('DOM.Iterable is present', () => {
    // Without it headers.entries() is a type error against working code.
    expect(ts.compilerOptions.lib).toContain('DOM.Iterable')
  })
})

describe('biome', () => {
  const biome = JSON.parse(read('biome.json'))

  test('the formatter is off, and so is the assist that reorders imports', () => {
    // This house aligns columns and no formatter can express that. Biome's
    // import sorting is a format change wearing a lint rule's clothes, so it
    // goes with it — see this package's README.
    expect(biome.formatter.enabled).toBe(false)
    expect(biome.assist.enabled).toBe(false)
  })

  test('the linter carries no style opinions', () => {
    // With the formatter refused, a linter that argues about style is a
    // formatter that cannot fix anything.
    expect(biome.linter.rules.recommended).toBe(false)
    expect(biome.linter.rules.style.recommended).toBe(false)
    expect(biome.linter.rules.complexity.recommended).toBe(false)
    expect(biome.linter.rules.performance.recommended).toBe(false)
  })

  test('it keeps the groups that catch bugs', () => {
    expect(biome.linter.rules.correctness.recommended).toBe(true)
    expect(biome.linter.rules.security.recommended).toBe(true)
    expect(biome.linter.rules.suspicious.recommended).toBe(true)
  })

  test('node_modules is excluded, so a nested config is never discovered', () => {
    // Biome treats any biome.json it finds while scanning as a competing root
    // config and refuses to run. This package ships one, so an app that scanned
    // its own node_modules would fail on its own dependency.
    expect(biome.files.includes).toContain('!**/node_modules/**')
  })

  test('it is plain JSON — biome.json is not jsonc', () => {
    expect(() => JSON.parse(read('biome.json'))).not.toThrow()
  })
})

describe('editorconfig', () => {
  test('it is byte-identical to the copy fli scaffolds', async () => {
    // EditorConfig has no extends mechanism, so this is the one file an app
    // gets as a copy rather than a dependency. Two texts, one test — the same
    // shape as every other hand copy in this repo.
    const { EDITORCONFIG } = await import('../../cli/core/app-config.js')
    expect(EDITORCONFIG).toBe(read('editorconfig'))
  })

  test('it declares itself the root', () => {
    expect(read('editorconfig')).toMatch(/^root = true$/m)
  })
})
