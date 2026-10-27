// ─── checks/ui.js — the UI realm's rules ──────────────────────────────────────
//
// A resource, a route, a `.mesa` screen, a style and the kit — what mesa and
// sierra compile clean and render wrong. One slice of the rule bodies
// `core/checks.js` runs; the table, the runner and the baseline stay there.
// Plain ESM on node, `@frontierjs/toolbelt` and this package only.

import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, extname, basename, relative, dirname }      from 'path'
import { spawnSync }                                       from 'child_process'
import { modelName }                                       from '@frontierjs/toolbelt/inflect'
import { ARIA, RELATIONSHIPS }                             from '@frontierjs/toolbelt/aria'
import { appSchemaViews }                                  from '../app-schema.js'
import {
  schemaFile, models, looksPlural, stripComments, walk, safeRead, readCode,
  lineOf, isAppRoot, SURFACES, sources, SCRIPT_EXT, CLIENT_SURFACES,
  modelResolver, spanFrom, closingParen, staticSurfaces, scripts,
  servingServices, withoutComments, bodyOf,
} from './lib.js'

export const CHECKS = {

  // Invariant 18. A Resource is a UI-realm noun and is written in the UI-realm
  // language. A `.js` here compiles and runs, which is why nothing else objects.
  'resource-dir-mesa': ({ root }) => {
    const dirs = resourceDirs(root)
    if (!dirs.length) return { skipped: 'no web/src/resources/' }
    const findings = []
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (statSync(join(dir, name)).isDirectory()) continue
        if (extname(name) === '.mesa') continue
        findings.push({
          file: join(dir, name),
          message: `src/resources/ holds Resources, and a Resource is a .mesa file. ` +
                   `Move ${name} to src/lib/ if it is support code.`,
        })
      }
    }
    return { findings }
  },

  // Invariant 18, second half: the DATA half is `<script module>`, which runs
  // once at import and is what every other module imports. Markup is not
  // checked — a resource carries its model's default form, so a plain
  // `<script>` beside it is that form's instance scope (`FJS-D112`). What is
  // still refused is a file with no module scope at all: a resource whose
  // `createResource` ran per instance would give every page its own store, and
  // the import that another module writes would resolve to nothing.
  'resource-script': ({ root }) => {
    const files = resourceFiles(root)
    if (!files.length) return { skipped: 'no .mesa files in web/src/resources/' }
    const findings = []
    for (const path of files) {
      const src = readFileSync(path, 'utf8')
      if (!/<script\s+module[\s>]/.test(src)) findings.push({
        file: path,
        message: `a resource's data layer goes in <script module> — it runs once at import and its named ` +
                 `exports are what another module imports. Markup and a plain <script> are the model's ` +
                 `default form and belong here too; a file with only a plain <script> is a component.`,
      })
    }
    return { findings }
  },

  // Invariant 19. **The schema decides**, rather than a pluralization rule this
  // file would have to keep in step with sierra's: the filename must name a
  // model, or the resource must state the `model:` it means. That is the same
  // conclusion `modelNameFor()` reaches when it misses — except it warns into a
  // browser console at run time and degrades to a bare `make()`, so validation,
  // labels and field rules all stop being schema-derived without anything failing.

  'resource-file-name': ({ root }) => {
    const files = resourceFiles(root)
    if (!files.length) return { skipped: 'no .mesa files in web/src/resources/' }
    const schema = schemaFile(root)
    const known  = schema ? new Set(models(schema).map(m => m.name)) : null
    const viewNames = schema ? new Set(appSchemaViews(root).map(v => v.name)) : null
    const findings = []

    for (const path of files) {
      const name = basename(path, '.mesa')
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || looksPlural(name)) {
        findings.push({
          file: path,
          message: `a resource file is named for its noun — PascalCase, singular. ` +
                   `${name}.mesa should be ${modelName(name)}.mesa.`,
        })
        continue
      }
      if (!known) continue

      // Comments stripped BEFORE anything is matched. A resource file explains
      // itself, and one explaining why it names a model quotes the option:
      // `createResource('lenses', { model: 'Lens' })` inside a doc comment was
      // read as this file's declaration, and the rule reported a file named for
      // its own prose.
      const src    = stripComments(readFileSync(path, 'utf8'))
      const stated = src.match(/\bmodel:\s*['"]([A-Za-z0-9_]+)['"]/)
      if (stated) {
        // A resource over a VIEW is the second half of Invariant 19 with a
        // declaration behind it: a projection is named like an accessor
        // (`revenueByStatus`), so no PascalCase filename can BE its name, and
        // the file takes its service noun the way a resource over nothing does.
        // The stated name still has to exist — a typo is not a view.
        if (viewNames?.has(stated[1])) {
          const svc = src.match(/createResource\(\s*['"]([A-Za-z0-9_-]+)['"]/)?.[1]
          if (!svc || modelName(svc) === name) continue
          findings.push({
            file: path,
            message: `states model: '${stated[1]}', a view, and is named ${name}.mesa while the service is ` +
                     `'${svc}'. A Resource over a view takes its SERVICE noun singularized — ` +
                     `${modelName(svc)}.mesa — because a projection is named like an accessor and has no ` +
                     `PascalCase name for the tree to carry.`,
          })
          continue
        }
        if (stated[1] !== name) findings.push({
          file: path,
          message: `states model: '${stated[1]}' but is named ${name}.mesa. Where a model exists the ` +
                   `filename IS the model name — that is what makes an irregular visible in the tree.`,
        })
        continue
      }
      if (known.has(name)) continue

      // A Resource over no model takes its SERVICE noun, singularized — which is
      // `Hub.mesa` for `createResource('hub')`, and correct. Judging it against
      // the schema alone would refuse every cross-cutting resource an app has.
      const service = src.match(/createResource\(\s*['"]([A-Za-z0-9_-]+)['"]/)?.[1]
      if (service && modelName(service) === name) continue

      findings.push({
        file: path,
        message: `no model named ${name} in db/schema.lite${service ? `, and the service is '${service}'` : ''}. ` +
                 `Either the file is misnamed, or this is a Resource over no model and should take its ` +
                 `service noun singularized — and if the service does not pluralize regularly from the ` +
                 `model, say so with model:.`,
      })
    }
    return { findings }
  },

  // Sierra rules the ROLES of a route file and says nothing about what a
  // co-located component is CALLED, and this rule does not either (`FJS-D250`).
  // What it grades is a name that already made a claim: `_orders.Row.mesa`
  // says it belongs to `routes/orders/`, and the way that becomes false is a
  // FORK — a folder copied wholesale keeps the source folder's prefix, so the
  // one thing the name was for is the one thing it is now lying about. An app
  // that writes no dotted prefix never sees this rule.
  'route-part-prefix': ({ root }) => {
    const findings = []
    let looked = 0

    for (const routes of routeDirs(root)) {
      walk(routes, 6, dir => {
        // The route SEGMENT, which is the folder the prefix is a claim about.
        // A dynamic segment (`[id]`) is a name no prefix can match, so a part
        // inside one is graded against nothing rather than against brackets.
        const folder = basename(dir)
        if (folder.startsWith('[')) return

        for (const name of safeRead(dir)) {
          if (extname(name) !== '.mesa') continue
          const base = basename(name, '.mesa')
          // `_module` is the layout and is reserved; `_Plural.mesa` and a bare
          // `Row.mesa` claim no folder. Only a dotted lowercase prefix does.
          const prefix = base.match(/^_([a-z][a-z0-9-]*)\./)?.[1]
          if (!prefix) continue
          looked++
          if (prefix === folder) continue
          findings.push({
            file: join(dir, name),
            message: `is named _${prefix}.* but sits in ${folder}/. A dotted prefix is a claim about the ` +
                     `folder that owns the part — rename it _${folder}.${base.slice(prefix.length + 2)}.mesa, ` +
                     `or drop the prefix if the part is not this route's.`,
          })
        }
      })
    }
    if (!looked && !findings.length) return { skipped: 'no _prefix.Part.mesa files' }
    return { findings }
  },

  // A nav link restates a URL the route tree already decided, and the two drift
  // in silence: a renamed folder moves the page, the link keeps the old URL, and
  // the click is a 404 no build reports. The authority is the surface's
  // committed `routes.snapshot.md`, not a walk of src/routes — it carries the
  // routes a `*.mount.js` brings in from another package, and the `snapshots`
  // phase fails it when stale. A warning, because a dead link loses no data.
  'nav-href-routes': ({ root }) => {
    const findings = []
    const unread   = []
    let graded = 0

    for (const name of safeRead(root)) {
      const nav = join(root, name, 'src', 'lib', 'nav.js')
      if (!existsSync(nav)) continue
      const routes = committedRoutes(join(root, name))
      if (!routes.length) { unread.push(`${name}/`); continue }
      graded++

      const code = readCode(nav)
      for (const m of code.matchAll(NAV_TARGET)) {
        const [, key, , value] = m
        // A template with a hole names a URL only at runtime.
        if (value.includes('${') || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue
        const line = lineOf(code, m.index)
        if (!value.startsWith('/')) {
          findings.push({ file: nav, line,
            message: `\`${key}: '${value}'\` is relative, so it resolves against whichever page is ` +
                     'showing. A nav link and a section path start with `/`.' })
          continue
        }
        const segs = value.replace(/[?#].*$/, '').split('/').filter(Boolean)
        // A section claims every page beneath its path, so it needs a route at
        // or under it; `/` matches only `/`, as `sectionFor` reads it.
        const beneath = key === 'path' && segs.length > 0
        if (routes.some(r => routeAnswers(r, segs, beneath))) continue
        findings.push({ file: nav, line,
          message: key === 'path'
            ? `section path \`${value}\` has no route at or beneath it in ${name}/routes.snapshot.md, ` +
              'so its tabs can never be current. Fix the path, or run `sierra routes` if the pages are new.'
            : `\`${value}\` names no route in ${name}/routes.snapshot.md, so the link opens a 404. ` +
              'Fix the href, or run `sierra routes` if the page is new.' })
      }
    }

    if (!graded && unread.length) return { skipped: `src/lib/nav.js in ${unread.join(', ')} with no ` +
      'routes.snapshot.md beside it — `sierra routes` writes one', blind: true }
    if (!graded) return { skipped: 'no src/lib/nav.js' }
    return { findings }
  },

  // Invariant 19, the other half. Two resources in one file is the same problem
  // as an irregular that does not say so: the tree stops being the index.
  'resource-one-per-file': ({ root }) => {
    const files = resourceFiles(root)
    if (!files.length) return { skipped: 'no .mesa files in web/src/resources/' }
    const findings = []
    for (const path of files) {
      const src   = readFileSync(path, 'utf8')
      const names = [...src.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*createResource\b/g)]
        .map(m => m[1])
      if (names.length > 1) findings.push({
        file: path,
        message: `${names.length} Resources in one file — ${names.join(', ')}. One per file, named for its ` +
                 `noun: a picker's lookup resource belongs in its own file, not folded into the one that ` +
                 `happens to need it first.`,
      })
    }
    return { findings }
  },

  'vite-strict-port': ({ root }) => {
    const configs = []
    walk(root, 4, dir => {
      for (const name of readdirSync(dir)) {
        if (/^vite\.config\.[cm]?[jt]s$/.test(name)) configs.push(join(dir, name))
      }
    })
    if (!configs.length) return { skipped: 'no vite config' }
    // The flag lives in what the config returns, which a config delegating to a
    // factory never spells; the text is the grade only for one that will not load.
    let loaded = {}
    const run = spawnSync(process.versions.bun ? process.execPath : 'bun', ['-e', VITE_PORT_SCRIPT], {
      cwd: root, input: JSON.stringify(configs), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, BUN_BE_BUN: '1' },
    })
    try { if (run.status === 0) loaded = JSON.parse(run.stdout.trim().split('\n').pop()) } catch {}
    const sets = p => loaded[p] ?? /strictPort/.test(readFileSync(p, 'utf8'))
    return { findings: configs.filter(p => !sets(p)).map(p => ({
      file: p,
      message: `no strictPort. Vite hops to the next free port without a word, so this app can end up ` +
               `serving on the port another app's test drive is pointed at — and every assertion passes ` +
               `against the wrong app.`,
    })) }
  },

  'body-tag-in-comment': ({ root }) => {
    const pages = []
    walk(root, 4, dir => {
      for (const name of readdirSync(dir)) {
        if (name === 'index.html') pages.push(join(dir, name))
      }
    })
    if (!pages.length) return { skipped: 'no index.html' }

    const findings = []
    for (const path of pages) {
      const src = readFileSync(path, 'utf8')

      // `</body>` does not match: the injection point is the OPENING tag.
      const first = src.search(/<\s*body/i)
      if (first === -1) continue

      // Inside a comment, and first, means Vite injects into the comment. A file
      // with no real tag at all lands here too, which is the same failure.
      const inComment = [...src.matchAll(/<!--[\s\S]*?-->/g)]
        .some(m => first >= m.index && first < m.index + m[0].length)
      if (!inComment) continue

      findings.push({
        file: path, line: lineOf(src, first),
        message: `the FIRST body tag in this file is inside a comment. Vite injects the built <script> ` +
                 `at the first textual match and does not skip comments — the build succeeds, the file ` +
                 `looks right, and the page loads no JavaScript.`,
      })
    }
    return { findings }
  },

  // The UI realm's only grader short of `vite build`. Lint cannot read a
  // `.mesa` and tsc is told not to, so an unclosed `{#if}` or a RULE 7 watch
  // passed the whole `bun run check` a scaffold's CI runs (`FJS-1228`).
  //
  // Sierra owns what a build does to a file before Mesa sees it, so the
  // compile is `@frontierjs/sierra/check`, resolved from the SURFACE — the
  // copy that surface builds with. The compiler is async and this runner is
  // not, hence the child process. A surface that cannot resolve sierra is
  // skipped rather than failed: it is not a Sierra surface, or not installed.
  'mesa-compiles': ({ root }) => {
    if (!isAppRoot(root)) return { skipped: 'not an app root' }
    const findings = []
    let looked = 0
    for (const surface of safeRead(root)) {
      const dir = join(root, surface)
      const files  = filesUnder(join(dir, 'src'), '.mesa')
      // A package's routes are compiled in this surface's build and sit in no
      // src/ here, so a mount is followed to the directory it names (`FJS-3352`).
      const mounts = filesUnder(join(dir, 'src'), '.mount.js')
      if (!files.length && !mounts.length) continue
      const run = spawnSync(process.versions.bun ? process.execPath : 'bun', ['-e', MESA_CHECK_SCRIPT], {
        cwd: dir, input: JSON.stringify({ files, mounts }), encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, BUN_BE_BUN: '1' },
      })
      const out = run.stdout?.trim().split('\n').pop()
      if (run.status !== 0 || !out) continue
      const verdict = JSON.parse(out)
      if (verdict.unresolved) continue
      looked += files.length
      for (const { file, errors } of verdict.failed) {
        findings.push({
          file,
          message: `does not compile clean — ${errors.length} Mesa error(s) or reactivity hint(s), ` +
                   `which \`vite build\` stops on or \`bun run dev\` prints:\n` + errors.map(e => `    ${e}`).join('\n'),
        })
      }
    }
    if (!looked) return { skipped: 'no .mesa files in a Sierra surface' }
    return { findings }
  },

  // Invariant 3's third question, and the one no rule was asking. `app-layout`
  // asks whether the surfaces sit beside `db/`; `surface-config` asks whether
  // each keeps its configuration in `config/`. Neither asks what is INSIDE a
  // surface, so an `api/` with every file at its root — no `src/`, no entry —
  // passed both for as long as `example` was written that way.
  //
  // The shape is the one the root README calls canonical and `fli new` writes:
  // the ENTRY sits at the surface root, because that is the path a runner is
  // pointed at (`bun run api/index.ts`) and it is a deployment fact rather than
  // application code; everything it pulls in sits under `src/`. `web/` makes
  // the same split with `index.html`.
  //
  // What the split buys is not tidiness. An entry that STARTS the app and a
  // module that ASSEMBLES it are two files, so the assembling one can be
  // imported without binding a port — which is what `junction app --app`
  // and `junction jobs --app` need, and what an `import.meta.main` guard is
  // standing in for wherever the two are one file.
  //
  // Two findings and not three. A surface with `src/` whose entry is INSIDE it
  // is not reported: `web/`, `widgets/` and `site/` are entered through
  // `index.html` and have no root script at all, so "no entry beside src/"
  // cannot be told from the normal case for three of the five surfaces, and a
  // rule that fires on the normal case is a rule people turn off.
  //
  // Judged per surface; a surface with nothing in it is skipped rather than
  // scolded, for `surface-config`'s reason. Configuration filenames are
  // excluded because that rule already owns them, and two rules pointing at one
  // file teaches the reader to skip both.
  'surface-src': ({ root }) => {
    if (!isAppRoot(root)) return { skipped: 'not an app root' }

    const SCRIPT = new Set(['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts'])
    // `index`, whatever the extension. Named rather than derived from a
    // manifest: a surface may be started by a runner this cannot see, and the
    // question here is where the file sits, not whether something runs it.
    const isEntry = f => basename(f, extname(f)) === 'index'
    // surface-config's own list, restated only to be EXCLUDED.
    const CONFIG  = /^(junction|sierra|vite|jetty|desktop)\.config\.[cm]?[jt]s$/
    // Directories a loader reads by NAME from `app.root` (`FJS-D1080`). Named and
    // not every directory: a surface root legitimately holds `deploy/`, `public/`,
    // `shell/`, so only a directory a loader owns is known to be source.
    const LOADED_DIRS = ['services', 'jobs', 'notifications']

    const findings = []
    let looked = 0

    for (const surface of SURFACES) {
      const dir = join(root, surface)
      if (!existsSync(dir)) continue

      const rootScripts = readdirSync(dir).filter(f =>
        SCRIPT.has(extname(f)) && !CONFIG.test(f) && statSync(join(dir, f)).isFile())
      const strayDirs = LOADED_DIRS.filter(d => existsSync(join(dir, d)) && statSync(join(dir, d)).isDirectory())
      const hasSrc = existsSync(join(dir, 'src'))
      // A directory somebody made is not a surface yet.
      if (!hasSrc && !rootScripts.length && !strayDirs.length) continue
      looked++

      // The whole surface is flat. The sharper of the two: nothing in it sits
      // where a generator, a doc or a drive resolves a path to.
      if (!hasSrc) {
        const named = [...rootScripts, ...strayDirs.map(d => `${d}/`)]
        const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? ', …' : '')
        findings.push({
          file: dir,
          message: `${surface}/ has no src/ — its source is at the surface root (${shown}). The ` +
                   `layout is ${surface}/index.ts beside ${surface}/config/ and ${surface}/src/, ` +
                   `which is what fli new writes and what every generator resolves against, so a ` +
                   `scaffolded file lands in a directory this surface does not have. The entry is ` +
                   `the one script that belongs at the root: it starts the app, and the module it ` +
                   `imports assembles one without starting it.`,
        })
        continue
      }

      for (const f of rootScripts.filter(f => !isEntry(f))) findings.push({
        file: join(dir, f),
        message: `${surface}/${f} sits at the surface root beside ${surface}/src/. Only the entry ` +
                 `belongs there — the file a runner is pointed at, which starts the app and ` +
                 `assembles nothing. Everything it imports lives under src/.`,
      })

      for (const d of strayDirs) findings.push({
        file: join(dir, d),
        message: `${surface}/${d}/ sits at the surface root beside ${surface}/src/. A loader reads ` +
                 `${d}/ from the directory the app is created in, which is src/ — so it belongs ` +
                 `at ${surface}/src/${d}/, where the app that declares it keeps it.`,
      })
    }

    if (!looked) return { skipped: 'no surface with source in it' }
    return { findings }
  },

  // Invariant 19, for the surface next door. A widget's name is a component
  // name AND the custom element a stranger's page writes, so `booking.mesa`
  // reaches HTML as `<booking>` — not a legal custom element name, which means
  // the widget never upgrades and the host page shows nothing.
  //
  // The second half is the silent one: discovery is per directory, so a folder
  // in `src/Embeds/` with no `index.mesa` is simply not a widget. That is
  // correct for a widget's own parts and wrong for a widget somebody is midway
  // through writing, and neither says anything at build time.
  'widget-entry-name': ({ root }) => {
    // The surface root, or the surface itself — `fli check` is run from an app
    // root and from inside a sub-project alike.
    const dir = [join(root, 'widgets', 'src', 'Embeds'), join(root, 'src', 'Embeds')]
      .find(d => existsSync(d) && statSync(d).isDirectory())
    if (!dir) return { skipped: 'no widgets/src/Embeds/' }

    const findings = []
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || name.startsWith('_')) continue
      const full = join(dir, name)
      const isDir = statSync(full).isDirectory()
      const base  = isDir ? name : basename(name, extname(name))

      if (isDir) {
        const index = ['index.mesa', 'index.js'].some(f => existsSync(join(full, f)))
        if (!index) {
          // Not an error — this is exactly where a widget's shared parts live —
          // but it is built as nothing, and saying so beats an empty dist.
          const parts = readdirSync(full).filter(f => extname(f) === '.mesa')
          if (parts.length) findings.push({
            file: full,
            message: `no index.mesa, so nothing here is built — the ${parts.length} component(s) inside ` +
                     `are treated as another widget's parts. A widget with parts is a directory whose ` +
                     `index.mesa IS the widget.`,
          })
          continue
        }
      } else if (extname(name) !== '.mesa' && extname(name) !== '.js') {
        findings.push({
          file: full,
          message: `not a widget and not built. src/Embeds/ holds one component per embeddable script — ` +
                   `a .mesa file, or a directory holding index.mesa. Stylesheets and helpers belong ` +
                   `beside the widget that imports them.`,
        })
        continue
      }

      if (!/^[A-Z][A-Za-z0-9]*$/.test(base)) findings.push({
        file: full,
        message: `"${base}" is not a widget name. PascalCase, singular (Invariant 19) — it is also the ` +
                 `custom element a host page writes, and a name with no word boundary reaches HTML as a ` +
                 `tag with no dash, which no browser will upgrade.`,
      })
    }
    return { findings }
  },

  // Invariant 2 again, for the same miss one realm over. `resource-file-name`
  // judges the FILE; this judges the NAME passed to createResource, which is
  // what actually resolves — so `ProductVariant.mesa` calling
  // `createResource('product-variants')` passes that rule and still degrades.
  //
  // A miss is silent by design: `modelNameFor` warns into a browser console and
  // falls back to a bare `make()`, so validation, labels, field rules, the
  // generated form and every constraint stop being schema-derived with the
  // screen still rendering.
  //
  // Reported only where a model plausibly EXISTS under the name — a resource
  // over no model is a whole kind of resource (`createResource('hub')`), and a
  // rule that scolded those would be answered by turning it off.
  'resource-model-miss': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const { resolves, modelNamed } = modelResolver(schema, root)
    const findings = []

    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bcreateResource\s*\(\s*(['"`])([A-Za-z0-9_-]+)\1/g)) {
        const service = m[2]
        // The whole call, so a `model:` stated in the options is seen.
        const call = spanFrom(code, code.indexOf('(', m.index))
        if (/\bmodel\s*:\s*['"`]/.test(call)) continue
        if (resolves(service)) continue

        const meant = modelNamed(modelName(service))
        if (!meant) continue

        // Two shapes: an options object to add the key to, or no second
        // argument at all, where the whole option goes in before the `)`.
        const paren = code.indexOf('(', m.index)
        const close = closingParen(code, paren)
        const brace = code.indexOf('{', m.index + m[0].length)
        const edit  = close === -1 ? null
          : (brace !== -1 && brace < close)
            ? optionsInsert(code, brace, `model: '${meant}'`)
            : { start: close, end: close, was: '', replacement: `, { model: '${meant}' }` }

        findings.push({
          file: path, line: lineOf(code, m.index),
          ...(edit ? { edit } : {}),
          message: `createResource('${service}') resolves to no model, and ${meant} is the one it means. ` +
                   `The miss warns into the browser console and falls back to a bare make(), so the form ` +
                   `is generated from nothing: no validation, no labels, no field rules, and a screen that ` +
                   `still renders. Say it — createResource('${service}', { model: '${meant}' }).`,
        })
      }
    }
    return { findings }
  },

  // A service holding the MODULE client has no principal. Per-request scoping
  // puts the caller's client on `$.db`, resolved off the call in progress —
  // and the module one is the root: `auth()` is null, so every row
  // policy compares against nothing and matches nothing, and a write belongs to
  // nobody in the audit trail. A read answers an empty list with a 200.
  //
  // `db.asSystem()` and `db.$setAuth(…)` are deliberate and do not match: the
  // pattern is the module binding followed by an ACCESSOR, which is the shape
  // that means *I forgot which client I am holding*.

  // ── A row a screen keeps ────────────────────────────────────────────────────
  //
  // `service.get(id)` answers a plain object. It is the raw proxy by design —
  // the same escape hatch `service.find()` is — and nothing can reach a plain
  // object: not a WS push, not a write from another tab, not a job. So a screen
  // that assigns one to state it KEEPS is stale from the moment somebody else
  // writes that row, and it looks right the whole time, because the screen
  // usually re-reads after its own actions and never after anyone else's.
  //
  // Every detail screen in this repo was that, and none of them looked broken
  // (`FJS-518`). `resource.record(id)` is a view of the row's node — same path
  // a list takes, filtered to one — so a push moves the screen (`FJS-D138`).
  //
  // **Bare assignment only, and that is the whole of the heuristic.** `order =
  // await …` in a Mesa script is an outer `let`: state the component keeps.
  // `const row = await …` is a local, which is a genuinely one-shot read — a
  // label, a check, something handed straight to another call — and flagging
  // those would be answered by turning the rule off.
  //
  // `X.service.get(…)` is the whole test for *is this a resource*: `.service`
  // exists on nothing else, and every resource has `record()`. No binding to
  // trace, so a resource imported from `src/resources/` is judged the same as
  // one made in the file.
  //
  // A WARNING, and it fails open. A screen may legitimately keep a row nothing
  // will ever write again — an archived order, a row read to seed a form that
  // then owns it — and a rule that cannot tell those apart must not be the
  // thing that fails a build. No `--fix` either: the change is a subscribe, a
  // release and a lifetime, and a half-applied one is a green check over a leak.
  // A `@money` column holds MINOR units, so printing it is a price a hundred
  // times too big — and there is no error, no warning and no wrong-looking
  // output, which is what `FJS-D242` was ruled about. The authority is the
  // SCHEMA: the app declared the column, so *this number is cents* is a fact in
  // the tree rather than a claim a paragraph makes.
  //
  // It has been written wrong at every tier. Five copies of `£${n.toFixed(2)}`
  // across this repo's own example app; the kit's own `<Cell>` handed the stored
  // integer to `formatMoney`, which takes MAJOR units (`FJS-1051`); and the
  // generated list page before it printed the raw integer.
  'money-rendered-raw': ({ root }) => {
    // ── which column names ARE money, and which are ambiguous ───────────────
    //
    // A `.mesa` says `{order.total}` and nothing in it says what `order` holds,
    // so this is name-based and has to be narrowed by the schema rather than by
    // a guess: a name declared `@money` on one model and as a plain column on
    // another cannot be judged from the interpolation, and is DROPPED. Being
    // silent about an ambiguous name is the cost; reporting one is advice that
    // is wrong, which is worse than none.
    const money  = new Set()
    const plain  = new Set()
    let declared = 0

    // The app's whole seed — `schema.lite` and the siblings an `import` in it
    // reaches, which is the layout `fli auth:install` writes.
    for (const file of sources(root, ['.lite'], 'db')) {
      // A `view` column carries no attributes at all — a projection is a SELECT
      // and there is nowhere on it to write `@money` — so its plainness is not
      // evidence of anything, and counting it drops the name for every model
      // that DID declare it. `revenueByStatus.total` is that exact case here:
      // it sums a `@money` column and is therefore cents, declared `Int`
      // because a view has no other spelling.
      let inView = false
      let depth  = 0
      for (const raw of readCode(file).split('\n')) {
        const line = raw.replace(/\/\/.*$/, '')
        if (/^\s*view\s+[A-Za-z_$][\w$]*/.test(line)) { inView = true; depth = 0 }
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        const col = line.match(/^\s*([A-Za-z_$][\w$]*)\s+[A-Za-z]/)?.[1]
        if (col) {
          if (/@money\b/.test(line)) { money.add(col); declared++ }
          else if (!inView) plain.add(col)
        }
        if (inView && depth <= 0 && /\}/.test(line)) inView = false
      }
    }
    if (!declared) return { skipped: 'no @money column in this seed' }

    for (const name of plain) money.delete(name)
    if (!money.size) return { skipped: 'every @money column shares its name with a plain one' }

    const files = sources(root, ['.mesa'], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const findings = []
    const cols = [...money].join('|')
    // A WHOLE interpolation that is just `thing.col` — so `{money(o.total)}` and
    // `{fromMinor(o.total, c)}` do not match, which is the point: what is being
    // reported is the absence of anything between the column and the screen.
    const bare = new RegExp(`\\{\\s*([A-Za-z_$][\\w$]*)\\.(${cols})\\s*\\}`, 'g')

    for (const path of files) {
      const lines = readCode(path).split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(bare)) {
          // TEXT position only. An ATTRIBUTE — `value={row.total}` — is handing
          // the raw column to something whose job is to render it, which is
          // exactly what `<Cell value={row.total} column={c} />` is, and
          // flagging that would report the fix as the bug.
          if (lines[i][m.index - 1] === '=') continue
          findings.push({
            file: path, line: i + 1,
            message: `\`${m[1]}.${m[2]}\` is a \`@money\` column and this prints it. The column stores ` +
                     `MINOR units, so the screen shows a number a hundred times too big — or a yen amount ` +
                     `a hundred times too small, since the scale is the CURRENCY's and not a constant. ` +
                     `Nothing refuses it and nothing looks wrong, which is the only way a number goes ` +
                     `wrong quietly (\`FJS-D242\`). ` +
                     `Render it with \`<Cell value={${m[1]}.${m[2]}} column={c} />\` where the column entry ` +
                     `comes from \`resource.columns()\`, which reads the declaration; or, outside a table, ` +
                     `with \`formatMoney(fromMinor(v, code), code)\` from \`@frontierjs/toolbelt/units\` — ` +
                     `never a hand-rolled division, which is right for the dollar and wrong for the yen. ` +
                     `An integer somebody genuinely wants raw is a fair exception; baseline it with a reason.`,
          })
        }
      }
    }

    return { findings }
  },

  'table-column-key': ({ root }) => {
    // A column identifies a FIELD, and `name` is what the field is called
    // everywhere else it is named — `resource.columns()` emits it, `<FilterBar>`
    // reads it off the same list, the schema declares it. `<Table>` alone said
    // `key`, so every caller carried a `.map` to translate between two spellings
    // of one thing and the translation had no owner (`FJS-1081`).
    //
    // It is an ERROR rather than a warning because of what a miss looks like:
    // `col.name` is `undefined`, the header still renders its label, the rows
    // still render, and only the sort is dead — `aria-sort` stuck at `none` and
    // a header that never reverses. Nothing throws and nothing looks wrong,
    // which is the failure class the rule exists for.
    const files = sources(root, ['.mesa'], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    // Only a file that actually renders one. `key:` is an ordinary property
    // name — a keyed `{#each}`, a KeyboardEvent, a lookup table — so judging a
    // file that never imports the component is advice that is wrong.
    const users = files.filter(p => /display\/Table\.mesa/.test(readCode(p)))
    if (!users.length) return { skipped: 'no screen renders a <Table>' }

    // The column shape, and only it: a `key` whose sibling is a `label`. The
    // word boundary is load-bearing — `provider_key:` and `ssh_key:` are
    // ordinary object keys in this repo's own screens.
    const DECLARED = /\bkey(\s*:\s*['"][A-Za-z_$][\w$]*['"]\s*,\s*label\s*:)/g
    // The translation itself, which is the thing the rename exists to delete.
    const MAPPED   = /\bkey\s*:\s*([A-Za-z_$][\w$]*)\.name\b/g

    const findings = []
    for (const path of users) {
      const code  = readCode(path)
      const spans = tableColumnSpans(code)
      const inColumns = i => spans.some(([a, b]) => i >= a && i < b)

      for (const m of code.matchAll(DECLARED)) {
        if (!inColumns(m.index)) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          // A whole fix: the property is renamed and nothing else moves, which
          // is what `--fix` may touch.
          edit: { start: m.index, end: m.index + 3, was: 'key', replacement: 'name' },
          message: 'a `<Table>` column names its field `name`, not `key` — the spelling the schema, ' +
                   '`resource.columns()` and `<FilterBar>` all already use. With `key` the component ' +
                   'reads `undefined`: the header still draws its label and the rows still render, and ' +
                   'only the sort is dead — `aria-sort` stuck at `none` and a header that never ' +
                   'reverses. Nothing throws (`FJS-1081`).',
        })
      }

      for (const m of code.matchAll(MAPPED)) {
        if (!inColumns(m.index)) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          // Deliberately no `edit`: collapsing `cols.map(c => ({…}))` to a
          // spread is a change to the expression around this, and a partial fix
          // here would leave a map that no longer maps anything.
          message: `\`${m[1]}.name\` is being copied onto \`key\` — \`<Table>\` reads \`name\` directly ` +
                   'now, so the whole `.map` is `...cols`. A column carries its alignment and its ' +
                   'display beside its name, and a map that lists three properties drops the rest ' +
                   'silently (`FJS-1081`).',
        })
      }
    }

    return { findings }
  },

  'page-path-retired': ({ root }) => {
    // `page.path` was `pathname + search` — a value `window.location` has no
    // word for, wearing a name that reads like `pathname`. It is retired in
    // favour of the browser's own two, and this is the rule that makes the
    // retirement safe to have made: the field is simply absent now, so a page
    // still reading it gets `undefined` and `goto(undefined, q)` navigates
    // somewhere wrong rather than throwing. Nothing in the build objects and
    // nothing on the screen says why (`FJS-1083`).
    //
    // `to.path` is the same field on the navigation context and is retired with
    // it, which is where the live defect was: an exact `publicRoutes` rule was
    // compared against a path that carried the query, so `/login/` stopped
    // matching `/login/?returnTo=…`.
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    // A member access on `page` or on a navigation target, and nothing else:
    // `node.path`, `route.path` and `join(a.path)` are all ordinary and common.
    const RETIRED = /\b(page|to|from)\.path\b(?!name)/g

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(RETIRED)) {
        const whole = m[1] === 'page'
        findings.push({
          file: path, line: lineOf(code, m.index),
          // No `edit`: which of the two replacements is right depends on what
          // the caller wanted, and that is the whole reason the field was split.
          // `goto(page.path.split('?')[0], q)` wants `pathname`; an OAuth
          // `returnTo` wants both halves. A fix that guessed would be a green
          // check over a wrong navigation.
          message: `\`${m[1]}.path\` is retired — the router speaks \`pathname\` (the path with no ` +
                   'query) and `search` (the raw query string, leading `?`), which are ' +
                   '`window.location`\'s own words. It reads `undefined` now, so a `goto` built on it ' +
                   'navigates somewhere wrong rather than throwing. Want the path alone? ' +
                   `\`${m[1]}.pathname\`. Want what the address bar shows` +
                   (whole ? ' — an OAuth `returnTo`, a saved return path' : '') +
                   `? \`${m[1]}.pathname + ${m[1]}.search\` (\`FJS-1083\`).`,
        })
      }
    }

    return { findings }
  },

  'detail-read-dead': ({ root }) => {
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const findings = []
    let looked = 0

    for (const path of files) {
      const lines = readCode(path).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const at   = line.indexOf('.service.get(')
        if (at < 0) continue
        looked++

        // What is being read, and what it is being kept in. The resource name
        // is the identifier immediately left of `.service`.
        const left = line.slice(0, at)
        const res  = left.match(/([A-Za-z_$][\w$]*)$/)?.[1]
        if (!res) continue

        // `NAME =` and nothing else before it. A declaration keyword means a
        // local; anything else (a property, an argument, a comparison) is not
        // an assignment to kept state.
        //
        // The assignment is often a line UP — `customer = cond ? await … : null`
        // wraps — so a continuation is followed back. Only one line, and only
        // over an operator that cannot end a statement, because the alternative
        // is pairing an assignment with a call that has nothing to do with it.
        // `NAME = ` at the start of a statement, and nothing that merely looks
        // like one: `==`, `!=`, `<=`, `>=` and `=>` are all rejected by the
        // character on either side of the `=`, and a declaration keyword means
        // a local rather than kept state.
        const named = (text) => {
          const m = text.match(/^\s*([A-Za-z_$][\w$]*)\s*([=!<>+\-*/%&|^]?)=(=?)/)
          if (!m || m[2] || m[3]) return null
          return m[1]
        }

        let kept = /^\s*(?:const|let|var)\b/.test(line) ? null : named(left)
        // A continuation — this line, or the one it hangs off, opens with an
        // operator that cannot begin a statement. Walked back at most three,
        // which covers the wrapped ternary every one of these screens writes
        // (`x = cond ? await …get(id) : null`) and stops well short of pairing
        // an assignment with a call that has nothing to do with it.
        for (let back = i - 1; !kept && back >= 0 && i - back <= 3; back--) {
          const hangs = /^\s*[?:&|+]/.test(lines[back + 1]) || /[=?:,(&|+]\s*$/.test(lines[back])
          if (!hangs) break
          if (/^\s*(?:const|let|var)\b/.test(lines[back])) break
          kept = named(lines[back])
        }
        // The other spelling, and the one a GENERATOR reaches for: the call is
        // a statement and the assignment is inside the callback that resolves
        // it.
        //
        //   orders.service.get(id)
        //     .then(row => { record = row })
        //
        // The walk above cannot see it — it goes backward, looking for the
        // wrapped ternary a person writes, and this assignment is forward. So
        // `fli check` was silent on the shape `fli admin:generate` emits, once
        // per model, which is the worst place for a blind spot: a hand-written
        // screen is one screen and a generated one is every screen.
        //
        // Bounded the same way and for the same reason — three lines, and only
        // while the chain is still open, so an assignment further down the file
        // is not paired with a call it has nothing to do with.
        // Only a `.then` handler receives the row: `.catch` and `.finally`
        // assign the error and a flag, so reading them named `error` as the
        // variable holding the row (`FJS-2741`). A chain on one line is read
        // from the call onward, and each handler runs to the next one.
        const keptIn = (text) => {
          for (const part of text.split(/(?=\.(?:then|catch|finally)\s*\()/)) {
            if (!/^\.then\s*\(/.test(part)) continue
            const inner = part.match(/=>\s*{?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/)
            if (inner) return inner[1]
          }
          return null
        }
        if (!kept) kept = keptIn(line.slice(at))
        for (let fwd = i + 1; !kept && fwd < lines.length && fwd - i <= 3; fwd++) {
          // The line must CONTINUE this call — a leading `.then` and nothing
          // else. Accepting any line holding an arrow was the loose version and
          // it reported `total` for `lines.forEach(x => { total = … })` three
          // lines under an unrelated one-shot read.
          if (!/^\s*\.(?:then|catch|finally)\b/.test(lines[fwd])) break
          kept = keptIn(lines[fwd].trim())
        }

        if (!kept) continue
        const assign = [null, kept]

        findings.push({
          file: path, line: i + 1,
          message: `\`${assign[1]}\` keeps a row that nothing can update. \`service.get()\` is the raw ` +
                   `proxy and answers a plain object, so a write from another tab, a job or a webhook ` +
                   `reaches the store and never this variable — the screen is stale with nothing said. ` +
                   `Watch it instead: \`const row = ${res}.record(id)\`, \`row.subscribe(v => ${assign[1]} = v)\`, ` +
                   `and release it when the screen goes. ` +
                   `**Where this service's \`get()\` answers MORE than the row** — an \`include:\`, a ` +
                   `\`withWidgets()\`, a count assembled per call — declare it: \`${res}.record(id, ` +
                   `{ composed: true })\`. A node holds one shape and a push carries the row alone, so a ` +
                   `plain watch drops the children at the first announcement, silently; declaring it makes ` +
                   `the node the trigger and re-runs this read instead (\`FJS-533\`). ` +
                   `What is left is a read with nothing to subscribe to — a row nothing will write again, ` +
                   `or an answer that is not a row at all — and that is a fair exception. Baseline it ` +
                   `with a reason.`,
        })
      }
    }

    return looked ? { findings } : { skipped: 'no service.get() on a client surface' }
  },

  // `find` answers the list envelope and `invoke` answers what the method
  // returned (`FJS-D76`, `FJS-D937`), so a client reading an answer two ways
  // is guessing at a shape the server already fixed. The guess was harmless
  // while both halves were right; it stops being harmless the day the method
  // changes, because nothing then says which half the screen relied on.
  //
  // Only the two spellings that name ONE value both ways are graded. A bare
  // `x?.data ?? []` is also how a screen guards a call it caught to `null`, and
  // text cannot tell that from a guess.
  'envelope-hedge': ({ root }) => {
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const ID     = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
    const HEDGES = [
      new RegExp(`(?<![\\w$.])(${ID})\\?\\.data\\s*\\?\\?\\s*\\1(?![\\w$.?\\[])`, 'g'),
      new RegExp(`Array\\.isArray\\(\\s*(${ID})\\s*\\)\\s*\\?\\s*\\1\\s*:\\s*\\(?\\s*\\1\\??\\.data\\b`, 'g'),
    ]

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const re of HEDGES) {
        for (const m of code.matchAll(re)) {
          findings.push({
            file: path, line: lineOf(code, m.index),
            message: `\`${m[0]}\` reads one answer as two shapes. \`find\` always answers the list ` +
                     'envelope, so read `.data` (or call `findData()`); `invoke` answers what the method ' +
                     'returned, an array as the array and an object as the object (`FJS-D937`). Pick the ' +
                     'one the server gives: against an array, the `?.data ?? []` half of a hedge is an ' +
                     'empty screen and no error.',
          })
        }
      }
    }

    return { findings }
  },

  // ─── the build-time half, as far as text can reach it ────────────────────────
  //
  // A prerendered page is public: whatever is in it is served to anyone, CDN
  // cached and indexed, and cannot be recalled. Sierra proves each one at BUILD
  // time — reads are tapped around the route's companion and graded against
  // `@@gate`, fail-closed — and no text rule can replace that, because the
  // question is what a `load()` actually read.
  //
  // What text CAN see is whether that proof is switched on, and the rule below
  // is the way it silently is not.

  // The tap needs a Litestone client, which the app hands the build as `db` in
  // its Sierra config. Without one, every route with a companion is refused
  // whatever its `publishes:` says, and the build cannot be made green except
  // by wiring the client or deleting the companion.
  //
  // Only for a surface whose routes actually READ: a site with no companion
  // pulls no data, so there is nothing to observe and no client to want.
  'static-publish-db': ({ root }) => {
    if (!schemaFile(root)) return { skipped: 'no db/schema.lite — no gates to prove' }
    const surfaces = staticSurfaces(root)
    if (!surfaces.length) return { skipped: 'no target: static surface' }

    const findings = []
    for (const s of surfaces) {
      if (/^\s*db\s*:/m.test(s.config)) continue
      const companions = sources(root, ['.js', '.ts'], relative(root, s.routes))
        .filter(f => /\.meta\.[jt]s$/.test(basename(f)))
      if (!companions.length) continue

      findings.push({
        file: s.path,
        message: `target: 'static' with no db:, and ${companions.length} route(s) here load data. The ` +
                 `publish check taps that client to see what a load() read; with none it can observe ` +
                 `nothing, so every route with a companion is refused, and no publishes: declaration ` +
                 `changes that. Point db: at the app's own client (db: '../api/src/core/db.ts').`,
      })
    }
    return { findings }
  },

  // ─── required-system-unfilled ───────────────────────────────────────────
  //
  // `@system` is out of create-mode `required`, so a generated form never asks
  // for the column and a page that sends it anyway is refused by name. A
  // required one with no `@default` therefore has exactly one filler — the
  // application — and where the application never names it, every create is
  // refused at the Data boundary: *apiToken is @system and was not supplied*.
  // Its first sighting was a schema-first build where that model was the root
  // of every other row, so nobody could create anything (`FJS-1825`).
  //
  // Litestone's `advise` carries the schema half under the same id; it cannot
  // read code, so it reports every such column whether or not something fills
  // it. This is the half that can.
  //
  // ── Filled means any of three spellings, in a file that is not a test ──
  //
  // `system: ['col']` on a litestone call, `ctx.system.add('col')` in a hook
  // (junction passes the set on as `system:`), and an `asSystem()` create of
  // the model naming the column. Matched loosely — the column's literal in a
  // file that names `system:` at all — because a list built in a constant is a
  // legal spelling, and this rule misses rather than misfires. A test seeding a
  // row through `asSystem()` is not the application filling it.
  //
  // ── Graded only once a service serves create ──
  //
  // The schema is written first and the service after it (`transition-methods`,
  // `FJS-1778`), so a model with no service, or one whose `methods:` leaves
  // `create` out, has no create for the gap to break yet.
  'required-system-unfilled': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const columns = requiredSystemColumns(schema)
    if (!columns.length) return { skipped: 'no required @system column without a @default in db/schema.lite' }

    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source — no service serves a create' }

    const code     = files.map(p => readCode(p))
    const served   = servingServices(root, files, code, schema)
    const isTest   = (p) => /(^|[/\\])tests?[/\\]/.test(relative(root, p)) || /\.(test|spec)\.[cm]?[jt]s$/.test(p)
    const app      = code.filter((_, i) => !isTest(files[i]))
    const findings = []

    const fills = (src, model, field) => {
      const quoted = new RegExp(`['"\`]${field}['"\`]`)
      if (quoted.test(src) && /\bsystem\s*:|\.system\s*\.\s*add\s*\(/.test(src)) return true
      const accessor = model[0].toLowerCase() + model.slice(1)
      return /\basSystem\s*\(/.test(src) &&
        new RegExp(`\\.${accessor}\\s*\\.\\s*(create|createMany|upsert|upsertMany)\\b`).test(src) &&
        new RegExp(`\\b${field}\\b`).test(src)
    }

    for (const c of columns) {
      const over = (served.get(c.model) ?? []).filter(svc => svc.servesCreate)
      if (!over.length) continue
      if (app.some(src => fills(src, c.model, c.field))) continue
      findings.push({
        file: schema.path, line: c.line,
        message: `${c.model}.${c.field} is required and @system with no @default, ` +
                 `${over.map(svc => basename(svc.path)).join(', ')} serves create, and nothing under api/ ` +
                 `supplies it — no system: ['${c.field}'] on a write, no ctx.system.add('${c.field}') in a ` +
                 `hook, no asSystem() create naming it. So every create is refused at the Data boundary ` +
                 `("${c.field} is @system and was not supplied"), and a page cannot fill it: @system ` +
                 `refuses a caller's payload naming the column. Fill it in a before.create hook ` +
                 `(ctx.data.${c.field} = …; ctx.system.add('${c.field}')), give it a @default, or make it optional.`,
      })
    }

    return { findings }
  },

  'css-token-undefined': ({ root }) => {
    const defined = shippedTokens(root)
    if (!defined.size) return { skipped: 'no dependency ships CSS' }
    // The app's own stylesheets define tokens too: a theme that sets `--brand`
    // once for every component reading it. Counted after the skip, so an app
    // whose dependencies ship no CSS is still skipped rather than graded on its
    // own sheets alone (FJS-1532).
    for (const token of appTokens(root)) defined.add(token)

    const findings = []
    for (const surface of CLIENT_SURFACES) {
      walk(join(root, surface), 6, (dir) => {
        for (const name of safeRead(dir)) {
          if (!name.endsWith('.mesa') && !name.endsWith('.css')) continue
          const file = join(dir, name)
          let text
          try { text = readFileSync(file, 'utf8') } catch { continue }

          // Declared anywhere in this file counts. A Mesa style block is scoped
          // to the file, so file scope is the smallest honest unit — narrower
          // than that reports a knob set in one block and read in the next.
          const local = new Set([...text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(m => m[1]))

          const seen = new Set()
          for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
            const token = m[1]
            if (defined.has(token) || local.has(token) || seen.has(token)) continue
            seen.add(token)
            findings.push({
              file,
              line: lineOf(text, m.index),
              message: `var(${token}) — nothing defines this token, so every declaration reading it is ` +
                       `dropped whole. Name the one you meant, or give it a fallback if it is a knob a ` +
                       `caller may set.`,
            })
          }
        }
      })
    }
    return { findings }
  },

  'css-raw-literal': ({ root }) => {
    if (!shippedTokens(root).size) return { skipped: 'no dependency ships CSS' }

    // A color is never a hairline; 1px is, and 0 is no value. 1rem is 16px.
    const RAW = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|(?<![\w.-])(?:(?:\d*\.\d+|[2-9]|\d{2,})(?:\.\d+)?(?:px|rem|em)|1(?:rem|em))\b/g
    // A keyword is a color too, and only a value holds one — .blue in a selector is a class.
    const NAMED = new RegExp(`(?<![\\w.#-])(?:${CSS_NAMED_COLORS.join('|')})(?![\\w-])`, 'gi')
    const findings = []
    for (const surface of CLIENT_SURFACES) {
      walk(join(root, surface), 6, (dir) => {
        for (const name of safeRead(dir)) {
          if (!name.endsWith('.mesa')) continue
          const file = join(dir, name)
          let text
          try { text = readFileSync(file, 'utf8') } catch { continue }
          // A comment that says "the <style> block below" otherwise opens a
          // block there, and every `&#123;` in the markup after it reads as a color.
          const scan = text.replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '))

          for (const block of scan.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
            const start = block.index + block[0].indexOf('>') + 1
            // Blanked rather than cut, so every index still maps to its line.
            const css = block[1]
              .replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' '))
              // A color that is the data (a levels ramp, a hue swatch) is declared in --data-* (FJS-D1001).
              .replace(/--data-[A-Za-z0-9_-]+\s*:[^;}]*/g, s => s.replace(/[^\n]/g, ' '))
              // A var() fallback names the token first.
              .replace(/var\([^)]*\)/g, s => s.replace(/[^\n]/g, ' '))
              // A condition cannot read var(), so a breakpoint has no token spelling to offer.
              .replace(/@(?:media|container|supports)\b[^{;]*/g, s => s.replace(/[^\n]/g, ' '))
            // Declaring a size token is where a literal belongs; a color in one is graded.
            const tokens = [...css.matchAll(/--[A-Za-z0-9_-]+\s*:[^;}]*/g)].map(t => [t.index, t.index + t[0].length])
            const inToken = (i) => tokens.some(([a, b]) => i >= a && i < b)
            const hits = [...css.matchAll(RAW)].filter(m => !inToken(m.index) || !/^[\d.]/.test(m[0]))
            for (const d of css.matchAll(/:([^;{}]*)/g)) {
              for (const m of d[1].matchAll(NAMED)) hits.push({ 0: m[0], index: d.index + 1 + m.index })
            }
            hits.sort((a, b) => a.index - b.index)
            for (const m of hits) {
              const token = inToken(m.index)
              findings.push({
                file,
                line: lineOf(text, start + m.index),
                message: `${m[0].replace(/\($/, '(…)')} in a <style> — ` + (token
                  ? `a raw color in a custom property is themed by nothing. A color that is the data goes in a ` +
                    `--data-* property; any other color is a tone and a treatment, or a token from @frontierjs/css.`
                  : `a raw color, size or spacing value is the one thing @frontierjs/css rules out, since a theme ` +
                    `switch and a density change cannot reach it. Say what the thing is and what is true of it — ` +
                    `a tone and a treatment on the element — or read a token with var(--…), or --data-* for a ` +
                    `color that is the data.`),
              })
            }
          }
        }
      })
    }
    return { findings }
  },

  'css-raw-utility': ({ root }) => {
    let doc
    try { doc = JSON.parse(readFileSync(join(root, 'node_modules/@frontierjs/css/vocabulary.json'), 'utf8')) }
    catch { return { skipped: '@frontierjs/css is not installed' } }

    // What the vocabulary names: a term's class, a tone, a treatment, a density.
    const semantic = new Set([
      ...(doc.terms ?? []).map(t => t.class ?? (t.class === undefined ? t.term?.toLowerCase() : null)),
      ...['tone', 'treatment', 'density'].flatMap(axis => doc.notATerm?.[axis] ?? []),
    ].filter(Boolean))

    // A palette-scale or white/black utility on a color property. A layout or
    // type utility (`gap-2`, `text-sm`) is none, and `text-primary` is a name.
    const RAW = /^-?(?:text|bg|border(?:-[trblxy])?|ring|fill|stroke|divide|outline|from|via|to|decoration|accent|caret|shadow|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)(?:\/\d+)?$/

    let raw = 0, sem = 0
    const perFile = new Map()
    for (const surface of CLIENT_SURFACES) {
      walk(join(root, surface), 6, (dir) => {
        for (const name of safeRead(dir)) {
          if (!name.endsWith('.mesa')) continue
          const file = join(dir, name)
          let text
          try { text = readFileSync(file, 'utf8') } catch { continue }
          for (const attr of text.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
            for (const token of (attr[1] ?? attr[2] ?? attr[3]).split(/[\s'"`]+/)) {
              // `hover:` and `md:` are variants of the utility, not part of its name.
              const bare = token.slice(token.lastIndexOf(':') + 1)
              if (RAW.test(bare)) {
                raw++
                perFile.set(file, (perFile.get(file) ?? 0) + 1)
              } else if (semantic.has(bare)) sem++
            }
          }
        }
      })
    }
    if (raw <= sem) return { findings: [] }

    // A count and a ratio, not a refusal: an app may run UnoCSS beside
    // @frontierjs/css, and the rule cannot tell a stray from the next necessary one.
    const worst = [...perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    return {
      findings: [{
        file: worst[0][0],
        line: 1,
        message: `${raw} raw color utilities against ${sem} semantic classes — a theme switch cannot reach ` +
                 `\`text-gray-500\` or \`bg-red-600\`. Name what the thing is and what is true of it — a tone ` +
                 `(\`danger\`) and a treatment (\`outlined\`) — and let the theme choose the color. Most: ` +
                 `${worst.map(([f, n]) => `${relative(root, f)} (${n})`).join(', ')}.`,
      }],
    }
  },

  'css-class-collision': ({ root }) => {
    let doc
    try { doc = JSON.parse(readFileSync(join(root, 'node_modules/@frontierjs/css/vocabulary.json'), 'utf8')) }
    catch { return { skipped: '@frontierjs/css is not installed' } }

    // class → term. A component's `.item` is scoped by a hash class, which
    // narrows its own rule and leaves the kit's `.item { display: flex }`
    // applying to the same element all the same (FJS-2512).
    const owned = new Map((doc.terms ?? []).filter(t => t.class).map(t => [t.class, t.term]))
    const findings = []
    for (const surface of CLIENT_SURFACES) {
      walk(join(root, surface), 6, (dir) => {
        for (const name of safeRead(dir)) {
          if (!name.endsWith('.mesa')) continue
          const file = join(dir, name)
          let text
          try { text = readFileSync(file, 'utf8') } catch { continue }
          const scan = text.replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '))

          const seen = new Set()
          for (const block of scan.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
            const start = block.index + block[0].indexOf('>') + 1
            const css = block[1].replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' '))
            // A selector is what precedes a `{`; a declaration value never does.
            for (const rule of css.matchAll(/([^{};]+)\{/g)) {
              if (rule[1].trimStart().startsWith('@')) continue
              // `:global(.item)` reaches the kit's rule on purpose.
              const selector = rule[1].replace(/:global\([^)]*\)/g, s => ' '.repeat(s.length))
              for (const m of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
                const term = owned.get(m[1])
                if (!term || seen.has(m[1])) continue
                seen.add(m[1])
                findings.push({
                  file,
                  line: lineOf(text, start + rule.index + m.index),
                  message: `.${m[1]} in a <style> — @frontierjs/css's ${term} owns that class, so this element ` +
                           `takes the kit's rules as well as this one. Rename the component's own class, or use ` +
                           `the ${term} as the kit ships it.`,
                })
              }
            }
          }
        }
      })
    }
    return { findings }
  },

  'kit-prop-unknown': ({ root }) => {
    // A prop the component does not declare is not an error to Mesa: it is the
    // component's `$attributes`, spread onto its root element. So a prop
    // misremembered from a sibling (`<EmptyState sub="…">` after `<StatCard
    // sub>`) renders as `sub="…"` on a div and the sentence never appears.
    // Nothing throws and a drive asserting the title passes (FJS-1648).
    const files = sources(root, ['.mesa'], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const findings = []
    let importers = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('@frontierjs/ui/')) continue
      importers++
      for (const use of kitUnknownProps(text, dirname(file))) {
        findings.push({
          file, line: lineOf(text, use.index),
          message: `<${use.tag} ${use.name}> — ${use.tag} declares ${use.declared.length ? use.declared.join(', ') : 'no props'}, ` +
                   `and ${use.name} is not an HTML attribute either, so it lands on the root element as ` +
                   `${use.name}="…" and renders nothing. A misremembered prop name; the text of a component ` +
                   `that takes none is its children (FJS-1648).`,
        })
      }
    }
    if (!importers) return { skipped: 'no screen imports a kit component' }
    return { findings }
  },

  'aria-owed': ({ root }) => {
    // `vocabulary.js` writes `<div role="toolbar">` and a screen writes
    // `<div class="toolbar">`: the class takes the kit's rules, the role stays
    // behind, and a strip meant as one tab stop is read as a div. The page
    // renders and a drive asserting its text passes. What a term owes is
    // `@frontierjs/toolbelt/aria` (FJS-D837); a class is read where it is a
    // literal, and one built at runtime is the page audit's to grade.
    let doc
    try { doc = JSON.parse(readFileSync(join(root, 'node_modules/@frontierjs/css/vocabulary.json'), 'utf8')) }
    catch { return { skipped: '@frontierjs/css is not installed' } }
    const files = sources(root, ['.mesa'], ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no client surface' }

    const owed = ariaByClass(doc)
    const findings = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const f of ariaOwed(markupOnly(text), owed)) {
        findings.push({ file, line: lineOf(text, f.index), message: f.message })
      }
    }
    return { findings }
  },
}

// The CSS named colors; transparent and currentColor are not, since no theme owns them.
const CSS_NAMED_COLORS = (
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
  'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
  'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
  'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
  'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
  'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
  'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
  'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
  'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
  'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
  'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
  'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
  'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
  'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
).split(' ').sort((a, b) => b.length - a.length)

// ─── reading markup ───────────────────────────────────────────────────────────

// The array literals a `<Table>` is handed as `columns` — `columns={X}`, the
// `{columns}` shorthand, or an inline `columns={[…]}` — as [start, end) offsets.
// A `{ key, label }` lookup table beside a Table (a status legend, a filter
// chip list) is not a column list, and renaming its `key` breaks every
// `s.key` that reads it.
function tableColumnSpans(code) {
  const names  = new Set()
  const starts = []
  for (const m of code.matchAll(/<Table\b(?:[^>]|=>)*?(?:\{\s*columns\s*\}|\bcolumns\s*=\s*\{\s*(\[|[A-Za-z_$][\w$]*))/g)) {
    if (m[1] === '[') starts.push(m.index + m[0].length - 1)
    else names.add(m[1] ?? 'columns')
  }
  for (const name of names) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*\\[`, 'g')
    for (const m of code.matchAll(decl)) starts.push(m.index + m[0].length - 1)
  }
  return starts.map(start => [start, closingBracket(code, start)])
}

// The offset just past the `]` matching the `[` at `start`, skipping string
// and template contents. Unbalanced runs to the end of the text.
function closingBracket(code, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i + 1
  }
  return code.length
}

// ─── kit-prop-unknown ──────────────────────────────────────────────────────

// Names HTML itself gives an element, so a component that spreads `$attributes`
// is rightly handed them. Lowercase only: a camelCase name is a prop's spelling.
const HTML_ATTRS = new Set((
  'accept action allow alt async autocapitalize autocomplete autofocus autoplay capture checked cite class cols colspan ' +
  'content contenteditable controls coords crossorigin datetime decoding default defer dir dirname disabled download ' +
  'draggable enctype enterkeyhint for form formaction formenctype formmethod formnovalidate formtarget headers height ' +
  'hidden high href hreflang id inert inputmode integrity is itemid itemprop itemref itemscope itemtype kind label lang ' +
  'list loading loop low max maxlength media method min minlength multiple muted name nonce novalidate open optimum ' +
  'pattern ping placeholder playsinline popover poster preload readonly referrerpolicy rel required reversed role rows ' +
  'rowspan sandbox scope selected shape size sizes slot span spellcheck src srcdoc srclang srcset start step style ' +
  'tabindex target title translate type usemap value width wrap key part exportparts'
).split(' '))

/** The text with comments, `<script>` and `<style>` blanked to spaces, offsets intact. */
function markupOnly(text) {
  const blank = s => s.replace(/[^\n]/g, ' ')
  return text.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>/g, blank)
}

/** Where `@frontierjs/ui` is installed as seen from `dir`, or null. */
function installedKit(dir) {
  for (let here = dir; ; here = dirname(here)) {
    const kit = join(here, 'node_modules', '@frontierjs', 'ui')
    if (existsSync(join(kit, 'package.json'))) return kit
    if (dirname(here) === here) return null
  }
}

/**
 * Every attribute written on a kit component that the component does not
 * declare and HTML does not name, as `{ tag, name, index, declared }`.
 * Judged only where the component's `export let` list is readable: one that
 * reads `$$props` consumes undeclared names itself, and a file that is not
 * found is not a component this rule can speak for.
 */
function kitUnknownProps(text, dir) {
  const imports = new Map()
  for (const m of text.matchAll(/\bimport\s+([A-Z]\w*)\s+from\s+['"]@frontierjs\/ui\/(components\/[^'"]+?)(\.mesa)?['"]/g)) {
    imports.set(m[1], m[2])
  }
  if (!imports.size) return []
  const kit = installedKit(dir)
  if (!kit) return []

  const declaredBy = new Map()
  for (const [tag, rel] of imports) {
    const file = join(kit, `${rel}.mesa`)
    if (!existsSync(file)) continue
    const code = readCode(file)
    if (/\$\$props\b/.test(code)) continue
    declaredBy.set(tag, [...code.matchAll(/\bexport\s+(?:let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]))
  }

  const markup = markupOnly(text)
  const found = []
  for (const open of markup.matchAll(/<([A-Z]\w*)(?=[\s/>])/g)) {
    const declared = declaredBy.get(open[1])
    if (!declared) continue
    for (const { name, index } of readAttributes(markup, open.index + open[0].length).attrs) {
      // Only a plain lowercase word: `data-*`, `aria-*`, `bind:`, `on:` and
      // `onclick` are the transport's, and a camelCase name is a prop's.
      if (!/^[a-z]+$/.test(name) || name.startsWith('on')) continue
      if (declared.includes(name) || HTML_ATTRS.has(name)) continue
      found.push({ tag: open[1], name, index, declared })
    }
  }
  return found
}

/**
 * The attributes of the tag whose name ends at `i`, each `{ name, index,
 * literal }` — `literal` is a quoted value's text, `null` for a bare attribute,
 * and `undefined` where the value is an expression. A `{...rest}` sets `spread`
 * and names nothing, since what it carries is decided at runtime.
 */
function readAttributes(markup, i) {
  const attrs = []
  let spread = false
  while (i < markup.length) {
    while (/\s/.test(markup[i] ?? '')) i++
    const c = markup[i]
    if (c === undefined || c === '>' || (c === '/' && markup[i + 1] === '>')) break
    if (c === '{') {
      if (markup.startsWith('{...', i)) spread = true
      i = skipBraces(markup, i)
      continue
    }
    const start = i
    while (i < markup.length && !/[\s=/>{]/.test(markup[i])) i++
    const name = markup.slice(start, i)
    if (!name) { i++; continue }
    while (/\s/.test(markup[i] ?? '')) i++
    let literal = null
    if (markup[i] === '=') {
      i++
      while (/\s/.test(markup[i] ?? '')) i++
      const q = markup[i]
      if (q === '"' || q === "'") {
        const close = markup.indexOf(q, i + 1)
        literal = markup.slice(i + 1, close === -1 ? markup.length : close)
        i = close === -1 ? markup.length : close + 1
      } else if (q === '{') {
        literal = undefined
        i = skipBraces(markup, i)
      } else {
        const from = i
        while (i < markup.length && !/[\s>]/.test(markup[i])) i++
        literal = markup.slice(from, i)
      }
    }
    attrs.push({ name, index: start, literal })
  }
  return { attrs, spread, end: i }
}

/**
 * The aria kit keyed by the class a screen writes: a term's own row under the
 * class the vocabulary gives it, each part under the anatomy class that names
 * it. A term the installed vocabulary does not hold is left out with its parts,
 * so the rule grades only what the app's css can style.
 */
function ariaByClass(doc) {
  const classOf = new Map((doc.terms ?? []).filter(t => t.class).map(t => [t.term, t.class]))
  const out = new Map()
  for (const [term, entry] of Object.entries(ARIA)) {
    const cls = classOf.get(term)
    if (!cls) continue
    if (entry.role || entry.requires) out.set(cls, { term, part: null, role: entry.role ?? null, requires: entry.requires ?? [] })
    for (const [part, sub] of Object.entries(entry.parts ?? {})) {
      if (!sub.role && !sub.requires) continue
      out.set(part, { term, part, role: sub.role ?? null, requires: sub.requires ?? [] })
    }
  }
  return out
}

/**
 * Every element whose literal `class` names a kit row and whose attributes do
 * not satisfy it, as `{ index, message }`. A role written as an expression is
 * taken as the kit's; a `{...rest}` on the element is left alone, since the
 * spread may carry what the row asks for.
 */
function ariaOwed(markup, owed) {
  const found = []
  for (const open of markup.matchAll(/<([a-z][\w-]*)(?=[\s/>])/g)) {
    const { attrs, spread } = readAttributes(markup, open.index + open[0].length)
    if (spread) continue
    const cls = attrs.find(a => a.name === 'class')
    if (!cls || typeof cls.literal !== 'string') continue
    const has = name => attrs.some(a => a.name === name)
    for (const token of cls.literal.split(/\s+/)) {
      const row = token.includes('{') ? null : owed.get(token)
      if (!row) continue
      const who  = row.part ? `${row.term}'s .${row.part}` : `a ${row.term}`
      const self = `<${open[1]} class="${token}">`
      if (row.role) {
        const role = attrs.find(a => a.name === 'role')
        if (!role) {
          found.push({ index: open.index, message: `${self} — ${who} is role="${row.role}" (@frontierjs/toolbelt/aria) and this element writes none. ` +
                                                   `Write the role and own what it promises, or use a class the kit does not read as one.` })
        } else if (typeof role.literal === 'string' && role.literal !== row.role) {
          found.push({ index: role.index, message: `${self} — ${who} is role="${row.role}" (@frontierjs/toolbelt/aria) and this element writes role="${role.literal}".` })
        }
      }
      for (const rel of row.requires) {
        if (RELATIONSHIPS[rel].some(has)) continue
        const want = rel === 'label' ? `an accessible name (${RELATIONSHIPS[rel].join(' or ')})` : RELATIONSHIPS[rel].join(' or ')
        found.push({ index: open.index, message: `${self} — ${who} owes ${want} (@frontierjs/toolbelt/aria) and this element carries none.` })
      }
    }
  }
  return found
}

/** The index just past the `}` closing the `{` at `i`; strings and templates are skipped whole. */
function skipBraces(text, i) {
  let depth = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * The edit that adds one entry to an options object literal, written the way
 * the object already is.
 *
 * Three shapes and they are the three an app writes: `{}` takes the entry and
 * no comma, `{ a: 1 }` takes it first with one, and an object opened on its own
 * line takes a line of its own indented like its neighbor. The alternative —
 * one canonical form — reformats somebody's file to fix a missing key, which is
 * how a `--fix` gets a reputation.
 */
function optionsInsert(text, brace, entry) {
  const after = text.slice(brace + 1)
  const empty = /^\s*\}/.test(after)
  const block = /^[ \t]*\r?\n/.test(after)

  let replacement
  if (empty)      replacement = `{ ${entry} `
  else if (block) {
    const indent = after.match(/\r?\n([ \t]*)\S/)?.[1] ?? '  '
    replacement  = `{\n${indent}${entry},`
  }
  else replacement = `{ ${entry},`

  return { start: brace, end: brace + 1, was: '{', replacement }
}

// ─── reading the tree ─────────────────────────────────────────────────────────

/** `web/src/resources/` and `src/resources/` under it — a Sierra app's shape. */
function resourceDirs(root) {
  return [join(root, 'web', 'src', 'resources'), join(root, 'src', 'resources')]
    .filter(d => existsSync(d) && statSync(d).isDirectory())
}

// Every surface's route tree. A surface is a directory beside `db/`
// (Invariant 3) and `src/routes` is the default sierra reads; a surface that
// moved it says so in its own config, which `staticSurfaces` already parses for
// the static ones. Probed rather than derived from where a vite config sits.
function routeDirs(root) {
  const out = []
  for (const name of safeRead(root)) {
    const dir = join(root, name, 'src', 'routes')
    try { if (statSync(dir).isDirectory()) out.push(dir) } catch { /* not a surface */ }
  }
  for (const s of staticSurfaces(root)) if (!out.includes(s.routes)) {
    try { if (statSync(s.routes).isDirectory()) out.push(s.routes) } catch { /* declared, not written */ }
  }
  return out
}

// `href: '/x/'` and `path: '/x/'` in a nav table — a quoted literal only. A
// `match` predicate's `path` parameter is never followed by a colon.
const NAV_TARGET = /\b(href|path)\s*:\s*(['"`])([^'"`\n]*)\2/g

// The URL patterns a surface's committed route tables list, as segments — every
// `routes*.snapshot.md` beside it, since a second target writes a second file.
// The rows are read from § Routes alone; the sections around it hold other paths.
function committedRoutes(surface) {
  const out = []
  for (const name of safeRead(surface)) {
    if (!/^routes(\.[\w-]+)?\.snapshot\.md$/.test(name)) continue
    let text = ''
    try { text = readFileSync(join(surface, name), 'utf8') } catch { continue }
    const section = text.split(/^## /m).find(s => s.startsWith('Routes\n')) ?? ''
    for (const m of section.matchAll(/^\| `(\/[^`]*)` \|/gm)) out.push(m[1].split('/').filter(Boolean))
  }
  return out
}

// Does a route pattern answer these path segments — or, with `beneath`, any URL
// under them? `:param` takes one segment and a spread (`*`) the rest. A ROOT
// spread is the app's catch-all 404, which answers every URL and so vouches for
// none of them.
function routeAnswers(pattern, segs, beneath) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') return i > 0
    if (i >= segs.length) return beneath
    if (pattern[i][0] !== ':' && pattern[i] !== segs[i]) return false
  }
  return pattern.length === segs.length
}

function resourceFiles(root) {
  return resourceDirs(root).flatMap(dir =>
    readdirSync(dir).filter(n => extname(n) === '.mesa').map(n => join(dir, n)))
}

// ─── the CSS a dependency ships ───────────────────────────────────────────────

// Every custom property the CSS this app INSTALLS declares.
//
// Read off the dependencies for `package-model-drift`'s reason: the answer is a
// property of what is installed, and a list written here goes stale the first
// time a package adds a rung. A package is included when its `exports` names a
// `.css` file; the whole of its shipped CSS is then read, because a bundle and
// the sources it was built from declare the same tokens and either may be the
// one an app links.
/**
 * Every custom property an app's own stylesheets declare — `.css` and `.scss`
 * under each client surface, `content/` included, with `dist/` and
 * `node_modules/` skipped by `walk`. A declaration anywhere counts, as it does
 * for a dependency's: which selector it sits under is the cascade's business.
 */
function appTokens(root) {
  const out = new Set()
  for (const surface of CLIENT_SURFACES) {
    walk(join(root, surface), 6, (dir) => {
      for (const file of safeRead(dir)) {
        if (!file.endsWith('.css') && !file.endsWith('.scss')) continue
        try {
          for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/(--[A-Za-z0-9_-]+)\s*:/g))
            out.add(m[1])
        } catch { /* unreadable is not a definition */ }
      }
    })
  }
  return out
}

function shippedTokens(root) {
  const out = new Set()
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { return out }

  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const dir = join(root, 'node_modules', name)
    let manifest
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }

    const shipsCss = Object.values(manifest.exports ?? {})
      .some(t => typeof t === 'string' && t.endsWith('.css'))
    if (!shipsCss) continue

    // `exports` targets may be patterns (`./foundation/*.css`), so the files are
    // walked rather than resolved one by one — a pattern names a directory, and
    // globbing it here would be a second implementation of `files:`.
    walk(dir, 4, (sub) => {
      for (const file of safeRead(sub)) {
        if (!file.endsWith('.css')) continue
        try {
          for (const m of readFileSync(join(sub, file), 'utf8').matchAll(/(--[A-Za-z0-9_-]+)\s*:/g))
            out.add(m[1])
        } catch { /* unreadable is not a definition */ }
      }
    })
  }
  return out
}

/**
 * Every column a create cannot leave out and no caller may supply — required,
 * `@system`, and nothing at the Data boundary that fills it. `{ model, field,
 * line }`, a line scan for `declaredTransitions`' reason.
 *
 * A scalar list is not one: its column is `NOT NULL DEFAULT '[]'`, so a create
 * that never names it succeeds (`FJS-2044`). `@updatedAt` stamps the create too.
 * Only depth-one lines of a model are fields, which keeps a `@system` move
 * inside `@@transitions( … )` out.
 */
function requiredSystemColumns({ text }) {
  const out   = []
  const lines = text.split('\n')
  let model   = null, depth = 0, inBlock = false

  for (let i = 0; i < lines.length; i++) {
    const [line, still] = withoutComments(lines[i], inBlock)
    inBlock = still
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/)
    if (m && depth === 0) {
      depth = (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length
      model = depth > 0 && !bodyOf(lines, i).includes('@@external') ? m[1] : null
      if (depth < 0) depth = 0
      continue
    }
    const atDepth = depth
    for (const c of line) {
      if (c === '{' || c === '(') depth++
      if (c === '}' || c === ')') depth--
    }
    if (depth <= 0) { depth = 0; model = null; continue }
    if (!model || atDepth !== 1) continue

    const f = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?(.*)$/)
    if (!f || f[3] || f[4]) continue
    const attrs = f[5]
    if (!/@system\b/.test(attrs)) continue
    if (/@(default|generated|sequence|updatedAt|computed|derived|from)\b/.test(attrs)) continue
    out.push({ model, field: f[1], line: i + 1 })
  }
  return out
}

function filesUnder(dir, suffix) {
  const out = []
  for (const name of safeRead(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) out.push(...filesUnder(full, suffix))
    else if (name.endsWith(suffix)) out.push(full)
  }
  return out
}

// Run in the surface's directory, so sierra resolves as that surface builds it.
const MESA_CHECK_SCRIPT = `
let checkMesaFiles
try { ({ checkMesaFiles } = await import(Bun.resolveSync('@frontierjs/sierra/check', process.cwd() + '/'))) }
catch { console.log(JSON.stringify({ unresolved: true })); process.exit(0) }
const { files, mounts } = JSON.parse(await Bun.stdin.text())
// Resolved as sierra's scanner resolves one. A mount that will not import is
// left to the scanner, which refuses it by name at the first build or dev boot.
const { fileURLToPath } = await import('node:url')
for (const mount of mounts) {
  let dir
  try { dir = (await import(mount)).default } catch { continue }
  if (dir instanceof URL || String(dir).startsWith('file:')) dir = fileURLToPath(dir)
  if (typeof dir !== 'string') continue
  files.push(...new Bun.Glob('**/*.mesa').scanSync({ cwd: dir, absolute: true }))
}
console.log(JSON.stringify({ failed: await checkMesaFiles(files, { root: process.cwd() }) }))
`

// Reads the flag off the config a surface RETURNS. `null` is a config that would
// not load, left to the caller's text grade.
const VITE_PORT_SCRIPT = `
import { pathToFileURL } from 'node:url'
const out = {}
for (const file of JSON.parse(await Bun.stdin.text())) {
  try {
    let config = (await import(pathToFileURL(file).href)).default
    if (typeof config === 'function') config = await config({ command: 'serve', mode: 'development' })
    out[file] = config?.server?.strictPort === true
  } catch { out[file] = null }
}
console.log(JSON.stringify(out))
`
