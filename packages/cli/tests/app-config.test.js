// The generated package.json and config files ARE the framework's opinion about
// tooling, and far more people will read them than will ever read this repo.
// Every one of these defaults is nearly impossible to change afterwards, so
// they are asserted rather than left to whoever last edited a 1400-line command.

import { test, expect, describe } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath }          from 'node:url'

import {
  EDITORCONFIG, APP_DEV_DEPS, FJS_PACKAGES,
  appTsconfig, appBiomeJson, appCheckScripts, appWorkflow,
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

  // `@` is the surface's own src/, so an app with more than one UI surface has
  // more than one answer. tsc has one program, so `paths` lists them all and
  // the first that exists wins — exact for one surface, a guess for two, and
  // free either way because checkJs is off. Vite is the resolver that matters
  // and it is per-root.
  test('every UI surface the app has is in paths, in a fixed order', () => {
    const ts = JSON.parse(appTsconfig({
      useWeb: true, useSite: true, useWidgets: true, useExtension: true,
    }))
    expect(ts.compilerOptions.paths['@/*'])
      .toEqual(['./web/src/*', './site/src/*', './widgets/src/*', './extension/src/*'])
    expect(ts.include)
      .toEqual(['api/**/*', 'web/**/*', 'site/**/*', 'widgets/**/*', 'extension/**/*'])
  })

  test('a site-only app maps @ to site/, never to a web/ it does not have', () => {
    const ts = JSON.parse(appTsconfig({ useWeb: false, useSite: true }))
    expect(ts.compilerOptions.paths['@/*']).toEqual(['./site/src/*'])
    expect(ts.include).toEqual(['api/**/*', 'site/**/*'])
  })

  test('a widgets-only app with no api includes only widgets', () => {
    const ts = JSON.parse(appTsconfig({ useWeb: false, useWidgets: true, useApi: false }))
    expect(ts.compilerOptions.paths['@/*']).toEqual(['./widgets/src/*'])
    expect(ts.include).toEqual(['widgets/**/*'])
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

// ─── a package a GENERATOR imports is not a product decision (FJS-1045) ──────
//
// `FJS_PACKAGES` is what an app is OFFERED, and that half genuinely is a
// product call — `testing` and `email-kit` are absent on purpose. But a package
// the generated FILES import is not a choice at all: a scaffolded app that does
// not declare it cannot resolve its own pages, and `bun run build` exits 1 on
// the front door.
//
// It shipped that way. Every generated CRUD list page imports
// `encodeQueryString` and `directiveParams`, and `toolbelt` sat on the absent
// list while the comment beside it argued the case for `ui` in exactly these
// words. **Nothing in the repo could see it**: the `scaffold` CI phase packs
// seventeen tarballs and swaps nine dependencies to the working tree, so a
// transitive copy is resolvable however the app declares it — only the `tutor`
// phase walks the registry path a real `fli new` walks, and it walks it once
// per full run.
//
// This is the cheap half of that guard: no scaffold, no install, no network —
// read what the templates import and hold it against what the manifest gets.

describe('every framework package a generator imports is one a scaffold declares', () => {
  const TEMPLATE_MODULES = ['core/crud-templates.js', 'core/app-schema.js', 'core/widget-surface.js']

  /** `@frontierjs/toolbelt/query` → `@frontierjs/toolbelt`. A subpath is not a
   *  package: what an app installs is the name before the second slash. */
  const packageOf = (spec) => spec.split('/').slice(0, 2).join('/')

  function importedByTemplates() {
    const found = new Map()
    for (const rel of TEMPLATE_MODULES) {
      let src
      try { src = readFileSync(join(CLI, rel), 'utf8') } catch { continue }
      for (const m of src.matchAll(/from '(@frontierjs\/[^']+)'/g)) {
        const pkg = packageOf(m[1])
        if (!found.has(pkg)) found.set(pkg, [])
        found.get(pkg).push(`${rel} → ${m[1]}`)
      }
    }
    return found
  }

  test('the templates import nothing the app is not given', () => {
    // Every `@frontierjs/…` in these modules is counted, without trying to
    // separate text written INTO an app from an import the module performs for
    // its own use. That distinction is not cheaply decidable — `widget-surface`
    // writes `import … from '@frontierjs/sierra/build'` at column 0 inside a
    // template literal, so it is indistinguishable from a real one by any
    // line-shaped test, and a heuristic here would read as working precisely
    // because there is currently nothing for it to skip.
    //
    // Counting both is sound rather than lazy: a package the cli imports for
    // its own job is one this repo depends on, and every framework package in
    // that set is already offered to an app. The one shape it would over-report
    // is the cli importing something an app is deliberately never given —
    // `testing`, `email-kit` — which is worth a look rather than a false alarm.
    const imported = importedByTemplates()

    // The control, and it is the assertion that keeps the row below honest: a
    // scan that matched nothing passes vacuously, which is exactly what a
    // tripwire reading the wrong file looks like.
    expect(imported.size).toBeGreaterThan(0)
    expect([...imported.keys()]).toContain('@frontierjs/toolbelt')

    const undeclared = [...imported.entries()]
      .filter(([pkg]) => !(pkg in FJS_PACKAGES))
      .map(([pkg, where]) => `${pkg} (${where.join(', ')})`)
    expect(undeclared).toEqual([])
  })

  test('a UI app is given every package its generated pages import', () => {
    // `FJS_PACKAGES` is the catalog; this is the SUBSET a scaffold actually
    // writes, which is the half that decides whether the build works. Read off
    // the command rather than restated — the two drifted apart once already.
    const src  = readFileSync(join(CLI, 'commands', 'project', 'new.md'), 'utf8')
    const uiBlock = src.slice(src.indexOf('if (useUI) {'), src.indexOf('if (useExtension) {'))
    expect(uiBlock.length).toBeGreaterThan(0)

    for (const pkg of importedByTemplates().keys())
      expect(uiBlock).toContain(`deps['${pkg}']`)
  })
})
