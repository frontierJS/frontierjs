// The generated package.json and config files ARE the framework's opinion about
// tooling, and far more people will read them than will ever read this repo.
// Every one of these defaults is nearly impossible to change afterwards, so
// they are asserted rather than left to whoever last edited a 1400-line command.

import { test, expect, describe } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath }          from 'node:url'

import {
  EDITORCONFIG, APP_DEV_DEPS, appTsconfig, appBiomeJson, appCheckScripts, appWorkflow,
} from '../core/app-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI  = resolve(HERE, '..')

describe('the config is a dependency, not a copy', () => {
  test('tsconfig is one line of extends plus the app layout', () => {
    // A copied config is frozen at the moment it was written. A dependency can
    // be corrected for every app that already exists.
    const ts = JSON.parse(appTsconfig({ useWeb: true }))
    expect(ts.extends).toBe('@frontierjs/config/tsconfig')
    expect(ts.compilerOptions.paths['@/*']).toEqual(['./web/src/*'])
    expect(ts.include).toEqual(['api/**/*', 'web/**/*'])
    // Everything about HOW it is checked lives in the dependency.
    expect(ts.compilerOptions.strict).toBeUndefined()
    expect(ts.compilerOptions.target).toBeUndefined()
  })

  test('an api-only app gets no web paths it does not have', () => {
    const ts = JSON.parse(appTsconfig({ useWeb: false }))
    expect(ts.include).toEqual(['api/**/*'])
    expect(ts.compilerOptions).toBeUndefined()
  })

  test('biome.json is extends and nothing else', () => {
    const biome = JSON.parse(appBiomeJson())
    expect(biome).toEqual({ extends: ['@frontierjs/config/biome'] })
  })

  test('the app is given the config package to extend', () => {
    expect(APP_DEV_DEPS['@frontierjs/config']).toBeTruthy()
    expect(APP_DEV_DEPS['@biomejs/biome']).toBeTruthy()
  })
})

describe('the check gate', () => {
  const scripts = appCheckScripts()

  test('fli check runs first', () => {
    // It is the half a linter cannot reach: biome reads neither .mesa nor
    // .lite, which is where an FJS app's real mistakes live. Running it after
    // the linter means a model-name violation waits behind a missing radix.
    expect(scripts.check.indexOf('fli check')).toBe(0)
    expect(scripts.check).toContain('bun run lint')
    expect(scripts.check).toContain('bun run typecheck')
  })

  test('a warning fails the lint', () => {
    // A warning nobody fails on is a warning nobody reads.
    expect(scripts.lint).toContain('--error-on-warnings')
  })

  test('typecheck is not a bare tsc', () => {
    // Every @frontierjs package ships TypeScript source, so tsc follows those
    // imports and checks the framework as part of the app's own program: a
    // freshly scaffolded app gets several hundred diagnostics from inside
    // node_modules and none of its own. `skipLibCheck` covers .d.ts only.
    expect(scripts.typecheck).toBe('fli typecheck')
  })

  test('fli is a dependency, so the gate runs on a fresh clone', () => {
    // Three of the four scripts call `fli`. Assuming a global one means the
    // workflow fails, and a global one of a different vintage generating files
    // for this app's framework version is the drift the pin removes.
    expect(APP_DEV_DEPS['@frontierjs/cli']).toBeTruthy()
  })
})

describe('the workflow', () => {
  const yml = appWorkflow({ name: 'demo' })

  test('it calls the same command a person runs', () => {
    // The gate this repo holds itself to, one level down: .github/workflows
    // calls one script and nothing else, so it runs identically on a laptop.
    expect(yml).toContain('bun run check')
    expect(yml).not.toContain('biome')
    expect(yml).not.toContain('tsc')
  })

  test('it installs from the lockfile', () => {
    expect(yml).toContain('--frozen-lockfile')
  })
})

describe('.editorconfig', () => {
  test('it is byte-identical to the one @frontierjs/config ships', () => {
    // The one file that cannot be a dependency — EditorConfig has no extends
    // mechanism. Two texts, one test.
    const original = readFileSync(resolve(CLI, '..', 'config', 'editorconfig'), 'utf8')
    expect(EDITORCONFIG).toBe(original)
  })

  test('it declares only what EditorConfig can actually enforce', () => {
    // Alignment is the rule that refuses a formatter and it is not expressible
    // here — the comment says so, and no directive pretends otherwise. An
    // invented key is silently ignored by every editor, which reads as enforced.
    const KNOWN = new Set([
      'root', 'charset', 'end_of_line', 'insert_final_newline',
      'trim_trailing_whitespace', 'indent_style', 'indent_size', 'max_line_length',
    ])
    const keys = EDITORCONFIG.split('\n')
      .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
      .map(l => l.split('=')[0].trim())

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(KNOWN).toContain(key)
  })
})

describe('what fli new actually writes', () => {
  const source = readFileSync(join(CLI, 'commands', 'project', 'new.md'), 'utf8')

  test('every file this module owns is in the write list', () => {
    for (const file of ['tsconfig.json', 'biome.json', '.editorconfig', '.github/workflows/ci.yml']) {
      expect(source).toContain(`'${file}'`)
    }
  })

  test('it holds no second copy of a config this module owns', () => {
    // The shapes moved here so they could be asserted; a literal left behind in
    // the command is a second answer that no test would contradict.
    expect(source).not.toContain('function makeTsconfig')
    expect(source).not.toContain('moduleResolution')
  })
})
