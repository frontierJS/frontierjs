// ─── checks/app.js — the app as a whole ───────────────────────────────────────
//
// App-scope rules that belong to no realm: the layout (Invariant 3), what a
// surface's scripts are named, what a test or drive may bind, a command file in
// the app's `cli/`, a preview branch, a plan's size. One slice of the rule bodies
// `core/checks.js` runs; the table, the runner and the baseline stay there.
// Plain ESM on node, `@frontierjs/toolbelt` and this package only.

import { join, resolve, relative, dirname, extname, basename }     from 'path'
import { existsSync, readFileSync, readdirSync, statSync }         from 'fs'
import { previewScope }                                            from '../preview.js'
import { findApps, driveRows, driveScripts, declaredHolds, HOLDS } from '../runnables.js'
import { readConfig }                                              from '../config.js'
import { parseCommands, resolveCommands }                          from '../command-parse.js'
import { typeScriptIn }                                            from '../scope.js'
import {
  lineOf, readCode, isAppRoot, SURFACES, sources, SCRIPT_EXT, stripComments,
  scripts, stem, staticSurfaces,
} from './lib.js'
import { safeRead, SKIP, rel }                                     from '../fs.js'

export const CHECKS = {

  // Not an invariant — a live hazard, which is worse. Vite hops to the next free
  // port in silence, so the second app to start binds the first app's neighbor
  // and a test drive exercises the wrong app with everything green.
  // A preview serves this branch's web/ against production's API, so anything
  // else the branch changed is previewed against a schema production does not
  // have — and Submit would put it in the pull request. `core/preview.js` says
  // which worktrees are previews and what the diff is graded from.
  'preview-ui-only': ({ root }) => {
    const p = previewScope(root, join(root, 'web'))
    if (!p.preview) return { skipped: p.why }
    if (p.why) return { findings: [{ file: root, message: p.why }] }
    return { findings: p.outside.map(f => ({
      file: resolve(p.top, f),
      message: `changed against ${p.into}, outside web/. A preview runs against production's API, so this ` +
               `branch can be neither previewed nor submitted until the change is taken off it.`,
    })) }
  },

  // A session opens by reading PLAN.md and every later turn re-reads it, so a
  // plan that keeps each finished phase inline costs its whole length on every
  // turn: measured at 31-155 KB, 1.4M characters of Read output in one audit
  // window (FJS-1562). The limit is the smallest plan that audit found grown.
  'plan-size': ({ root }) => {
    const file = join(root, 'PLAN.md')
    if (!existsSync(file)) return { findings: [] }
    const text  = readFileSync(file, 'utf8')
    const bytes = Buffer.byteLength(text)
    if (bytes <= PLAN_LIMIT) return { findings: [] }

    const lines = text.split('\n')
    const heads = []
    let fence = false
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return }
      const m = !fence && line.match(/^(#{1,6})\s+(.*)$/)
      if (m) heads.push({ at: i, level: m[1].length, title: m[2].trim() })
    })
    const finished = []
    heads.forEach((h, k) => {
      if (!/^Phase\s+\d/i.test(h.title)) return
      const next = heads.slice(k + 1).find(n => n.level <= h.level)
      const body = lines.slice(h.at, next ? next.at : lines.length)
      const boxes = body.filter(l => /^- \[[ x~]\]\s/.test(l))
      if (!boxes.length || boxes.some(l => l.startsWith('- [ ]'))) return
      finished.push({ title: h.title, size: Buffer.byteLength(body.join('\n')) })
    })
    finished.sort((a, b) => b.size - a.size)

    const kb = n => `${Math.round(n / 1024)} KB`
    const held = finished.length
      ? ` Finished phases still inline: ${finished.slice(0, 5).map(p => `${p.title} (${kb(p.size)})`).join(', ')}` +
        `${finished.length > 5 ? `, and ${finished.length - 5} more` : ''}.`
      : ''
    return { findings: [{
      file,
      message: `${kb(bytes)}, past the ${kb(PLAN_LIMIT)} a session can afford to read on every turn.${held} ` +
               `Move finished phases, answered questions and the finding record verbatim to docs/plan-done.md, ` +
               `leave a one-line stub under each heading so Q and step numbers still resolve, and read one ` +
               `section at a time with fli outline PLAN.md '<heading>'.`,
    }] }
  },

  // FJS-D1083. `fli dev:api`, `fli dev`'s port check and every drive's *Start
  // first* find a surface's script by its directory name, so a `dev:api` with
  // no `api` beside it is a script `fli dev` skips the port check for and
  // `fli dev:api` refuses to start.
  'surface-script': ({ root }) => {
    let pkg
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { return { skipped: 'no package.json' } }
    const scripts  = pkg.scripts ?? {}
    const findings = []
    for (const dir of ['api', 'web']) {
      if (!existsSync(join(root, dir)) || existsSync(join(root, dir, 'package.json'))) continue
      if (typeof scripts[`dev:${dir}`] !== 'string' || typeof scripts[dir] === 'string') continue
      findings.push({
        file: join(root, 'package.json'),
        message: `\`dev:${dir}\` starts ${dir}/ and no \`${dir}\` script does. Rename it \`${dir}\`: ` +
                 `\`fli dev:${dir}\` refuses to start a surface whose script it cannot find, and \`fli dev\` ` +
                 `skips that surface's port check.`,
      })
    }
    return { findings }
  },

  // A drive that launches Chrome itself has to learn, one at a time, what the
  // driver already knows. A FIXED debugging port binds only the first browser,
  // so a second drive attached to somebody else's session and graded their
  // screen — *a signed-out visitor is refused* read FALSE against a browser
  // signed in as an administrator (`FJS-1265`). A launcher with no sweep left
  // its Chrome running after a throw, and nineteen were found alive on one
  // machine (`FJS-361`). About twenty-five copies carried some of those lessons
  // and not others (`FJS-1588`); `openChrome()` carries all of them, so the
  // debugging port is its flag and nobody else's.
  //
  // Scope `both`, and one rule for either run: a root checks the drives under
  // it and leaves a nested app to that app's own run, which is how ci already
  // splits the workspace — so nothing is reported twice. A drive is any file
  // under a `test/`, `tests/` or `bench/` directory. `--dump-dom` is not here:
  // a page that computes its own answer and is read back from the dump has no
  // port to pin, and css's harness is that shape on purpose.
  'drive-opens-chrome': ({ root }) => {
    const files = driveFiles(root, /^(tests?|bench)$/)
    if (!files.length) return { skipped: 'no test directory' }
    const findings = []
    for (const path of files) {
      let text
      try { text = readFileSync(path, 'utf8') } catch { continue }
      const m = /--remote-debugging-port\b/.exec(text)
      if (!m) continue
      findings.push({
        file: path,
        line: lineOf(text, m.index),
        message: 'this drive launches Chrome itself. Use `openChrome()` from @frontierjs/mesa/drive: it ' +
                 'lets Chrome pick the port, gives the run a profile of its own, and kills the browser ' +
                 'on a throw or a signal — a launcher written here has to relearn each of those, and a ' +
                 'fixed port attaches to whichever browser bound it first.',
      })
    }
    return { findings }
  },

  // `FJS-D841`'s branch offset moves a port read from `FRONTIER_PORT_*` or an env
  // var and nothing else. A test that names 8110 reaches the PARENT checkout's
  // server from a branch, or fails to bind the port the parent's run holds —
  // and the first of those passes against the wrong app, so nothing goes red
  // (`FJS-2277`). `portFor()` in `@frontierjs/cli/core/ports.js` is the way to
  // ask (`FJS-D857`).
  //
  // The pattern is text: a number in 7000–8999
  // on a line that says `localhost`, `listen` or `port`. A fixture such as
  // `memory: 8192` says none of those, which the rule's own test holds.
  // `port` is a word and not a substring: `export` and `import` hold it, and a
  // UUID group such as `-8000-` is no port either, so a number joined to a
  // hyphen or a word character is not read as one.
  'test-port-literal': ({ root }) => {
    const files = driveFiles(root, /^tests?$/)
    if (!files.length) return { skipped: 'no test directory' }
    const findings = []
    for (const path of files) {
      readCode(path).split('\n').forEach((line, i) => {
        if (!/localhost|127\.0\.0\.1|listen/i.test(line) && !/(?<![a-z])port|Port|(?<![A-Z])PORT/.test(line)) return
        for (const m of line.matchAll(/(?<![\w-])[78]\d{3}(?![\w-])/g)) {
          const n = Number(m[0])
          if (n < 7000) continue
          findings.push({
            file: path,
            line: i + 1,
            message: `this test names port ${n} as a literal. A second checkout of the app (a Workbench ` +
                     'branch) takes an offset on every port, and a literal ignores it: the test reaches ' +
                     "the parent's server or fails to bind the parent's port. Ask for it with `portFor()` " +
                     'from @frontierjs/cli/core/ports.js.',
          })
          break
        }
      })
    }
    return { findings }
  },

  // `fli prove` queues two proves in one tree on what each drive declares it
  // holds, so a drive that binds the checkout's port block or opens its dev
  // database without saying so runs beside the other and collides — the
  // `env: port` and `env: shared db` rows. Read as text, one hop deep: the
  // drive and each module it imports by relative path, because the example
  // drives reach their ports through `lib/preflight.mjs`. `ports` is read off
  // `portFor(` or `FRONTIER_PORT_`, `db` off a path literal under `db/` naming a
  // `.db` file. A drive reaching the dev database only through the API it
  // drives is held by `ports` already.
  //
  // Scope `both`, and a nested app's drives are left to that app's own run,
  // as `drive-opens-chrome` does.
  'drive-holds': ({ root }) => {
    const apps = findApps(root).filter(a => a !== root)
    const rows = driveRows(root).filter(d => {
      const dir = join(root, d.where)
      return !apps.some(a => !relative(a, dir).startsWith('..'))
    })
    if (!rows.length) return { skipped: 'no verify script' }
    const findings = []
    for (const d of rows) {
      const scripts = driveScripts(root, d).filter(existsSync)
      if (!scripts.length) continue
      const held = new Set()
      for (const path of scripts) {
        const src  = readFileSync(path, 'utf8')
        const decl = declaredHolds(src)
        for (const name of decl?.names ?? []) {
          held.add(name)
          if (HOLDS.includes(name)) continue
          findings.push({
            file: path,
            line: lineOf(src, decl.index),
            message: `\`${d.script}\` declares it holds "${name}", which is not one of ${HOLDS.join(', ')}. ` +
                     '`fli prove` fails the drive on it rather than holding nothing.',
          })
        }
      }
      const binds = {}
      for (const path of scripts) {
        const code = readCode(path)
        const read = [[path, code]]
        for (const m of code.matchAll(/\bimport\s+(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
          const dep = resolve(dirname(path), m[1])
          if (existsSync(dep)) read.push([dep, readCode(dep)])
        }
        for (const [file, text] of read) {
          for (const [name, re] of [['ports', DRIVE_BINDS_PORTS], ['db', DRIVE_BINDS_DB]]) {
            const m = re.exec(text)
            if (m && !binds[name]) binds[name] = { file, line: lineOf(text, m.index) }
          }
        }
      }
      for (const [name, at] of Object.entries(binds)) {
        if (held.has(name)) continue
        const where = at.file === scripts[0] ? `line ${at.line}` : `${relative(root, at.file)}:${at.line}`
        findings.push({
          file: scripts[0],
          line: at.file === scripts[0] ? at.line : 1,
          message: `\`${d.script}\` ${name === 'ports' ? "reaches this checkout's port block" : 'opens a database under db/'} ` +
                   `(${where}) and does not declare it, so a second \`fli prove\` in this tree runs beside it ` +
                   `and collides. Add \`export const holds = [${[...held, name].filter(n => HOLDS.includes(n)).map(n => `'${n}'`).join(', ')}]\`.`,
        })
      }
    }
    return { findings }
  },

  // A collected test runs in every package suite, beside every other suite on
  // the machine, so one that binds a fixed port collides with whichever run
  // holds it and fails as environment: basecamp's edge.test.ts asked for this
  // checkout's block slot 7, which `verify:provision` binds too. A test that
  // launches Chrome depends on a browser being installed, idle and quick. Both
  // are driven tests wearing a collected name; the way out is `port: 0`, or a
  // `specs/` file under the `run.mjs` beside it. A server on `port: 0` and a
  // `new Request('http://localhost/x')` handed to a handler are hermetic and not
  // read.
  //
  // Read as code with strings blanked, so a fixture naming `portFor(` is not a
  // call. `portFor(import.meta…)` is this checkout's block; a `portFor` given a
  // scratch root is the port table under test. `FRONTIER_PORT_` is not read: in a
  // collected test it is an env var set and restored around the code under
  // test, never a port reached.
  'test-not-hermetic': ({ root }) => {
    const files = collectedTests(root)
    if (!files.length) return { skipped: 'no collected test' }
    const findings = []
    for (const path of files) {
      const code = readCode(path, { strings: true })
      for (const [re, says] of TEST_NOT_HERMETIC) {
        const m = re.exec(code)
        if (!m) continue
        findings.push({
          file: path,
          line: lineOf(code, m.index),
          message: `this collected test ${says}, so it fails whenever the machine is not as it expects and ` +
                   'the row gets filed as environment. Bind `port: 0` and read the port back, or move the ' +
                   'case to a `specs/` file the `run.mjs` beside it drives. A module mock is replaced by ' +
                   'injecting the transport, or by the real implementation.',
        })
        break
      }
    }
    return { findings }
  },

  // A package that states its test timeout once and then overrides it in a
  // test has two answers to how long a test may take, and the next timing row
  // gets fixed by a third. Graded only where the package states one: an inline
  // timeout with no package timeout is a known-slow test, the ecosystem's
  // ordinary shape. Bun reads no timeout from `bunfig.toml` (1.4.2), so a bun
  // package states it as `--timeout` in its `test` script.
  'test-timeout-inline': ({ root }) => {
    const files = collectedTests(root)
    if (!files.length) return { skipped: 'no collected test' }
    const owners = new Map()
    const findings = []
    let graded = 0
    for (const path of files) {
      const dir = packageDirOf(path, root)
      if (!owners.has(dir)) owners.set(dir, timeoutOwner(dir))
      const owner = owners.get(dir)
      if (!owner) continue
      graded++
      const code = readCode(path, { strings: true })
      for (const { index, timeout } of inlineTimeouts(code)) {
        findings.push({
          file: path,
          line: lineOf(code, index),
          message: `this test sets its own timeout (${timeout}), and ${owner} already sets the package's. ` +
                   'Raise the package timeout, or keep this one and say in an allowance why the test is slower.',
        })
      }
    }
    if (!graded) return { skipped: 'no package sets a test timeout' }
    return { findings }
  },

  // A command compiles when it is run, so one nobody has run is broken with
  // nothing saying so — and `fli check` is the one thing an agent runs after
  // editing a `.md`. Findings name the `.md` line, the command's or its module's.
  'command-parses': ({ root }) => {
    const { routesDir } = readConfig(root)
    const dir = join(root, routesDir)
    if (!existsSync(dir)) return { skipped: `no ${routesDir}/` }
    const { checked, problems } = parseCommands(dir)
    if (!checked) return { skipped: `no command files under ${routesDir}/` }
    return { findings: problems }
  },

  // A parse is not a run: a free identifier parses clean and throws on the
  // first call, in whichever branch nothing has run (FJS-730). Graded over the
  // unit the runtime loads, module script included, with the project's own
  // TypeScript as the parser; no parser is a skip that says so.
  'command-resolves': ({ root }) => {
    const { routesDir } = readConfig(root)
    const dir = join(root, routesDir)
    if (!existsSync(dir)) return { skipped: `no ${routesDir}/` }
    const ts = typeScriptIn(root)
    if (!ts) return { skipped: 'no typescript in node_modules — the parser this rule reads with', blind: true }
    const { checked, problems } = resolveCommands(dir, ts)
    if (!checked) return { skipped: `no command files under ${routesDir}/` }
    return { findings: problems }
  },

  // Invariant 3. A SURFACE is a directory at the app root — `api/`, `web/`,
  // `widgets/`, `site/` — with the schema beside them and owned by none of
  // them. Which surfaces an app has is the app's business: api-only, web-only,
  // widgets-only and site-only are all whole projects, and a rule that demands
  // all of them gets disabled rather than obeyed.
  //
  // What is decidable, and silent when wrong, is a surface in the WRONG PLACE:
  // widgets living inside web/ share that surface's config, its port and its
  // release, and the first thing anyone notices is a widget shipping when the
  // SPA does.
  'app-layout': ({ root }) => {
    if (!isAppRoot(root)) return { skipped: 'not an app root' }

    const has = (...p) => existsSync(join(root, ...p))
    const surfaces = SURFACES.filter(d => has(d))

    // A schema with no surface beside it is a single-realm fixture, not an app
    // that got the layout wrong. Asked before judging, because a check that
    // scolds every fixture in a repo is a check people turn off.
    if (!surfaces.length)
      return { skipped: `a schema with no ${SURFACES.map(s => s + '/').join(', ')} beside it — a fixture, not an app` }

    const findings = []

    // A surface's contents at the app root: `src/` beside `db/` means the
    // realms were never separated in the first place.
    if (has('src') && !has('web') && !has('widgets') && !has('site')) findings.push({
      file: join(root, 'src'),
      message: `src/ at the app root with no surface owning it. Each realm is a directory — api/, ` +
               `web/, widgets/, site/ — and every generator, drive and doc resolves paths against one of ` +
               `them, not against the root.`,
    })

    // Another surface's contents inside one. Each is its own sub-project — its
    // own config, its own test shape, its own release — and folded into another
    // it inherits that one's build and ships when it ships.
    for (const inside of ['web', 'api']) {
      if (has(inside, 'src', 'Embeds')) findings.push({
        file: join(root, inside, 'src', 'Embeds'),
        message: `widgets inside ${inside}/. A widget surface is a peer of ${inside}/, not a folder in ` +
                 `it — widgets/src/Embeds/ — because its config, its host pages and its release are ` +
                 `its own. Here it inherits ${inside}/'s build and ships when ${inside}/ ships.`,
      })
      // `src/harbor/` is jetty's service-worker entry and belongs to nothing
      // else, so it is the one unambiguous marker for an extension.
      if (has(inside, 'src', 'harbor')) findings.push({
        file: join(root, inside, 'src', 'harbor'),
        message: `a browser extension inside ${inside}/. It is a peer of ${inside}/ — extension/ — ` +
                 `because its config emits a MANIFEST rather than a page, it is loaded unpacked ` +
                 `instead of served, and it ships to two web stores under a review nothing else here ` +
                 `waits for.`,
      })

      // A SECOND Sierra config inside a surface, declaring `target: 'static'`.
      // That is a public prerendered site wearing the SPA's clothes, and it is
      // the one surface folded into another that reads as reasonable while it
      // is being written: a second config beside the first looks like two
      // targets of one app rather than two apps.
      //
      // It is decidable from the config's own text, which is why this rule can
      // see it at all. Four answers differ from the SPA's — the build is
      // prerendered, the tests run against FILES rather than a running app, the
      // release is a bucket with no server behind it, and the OUTPUT collides:
      // one Vite root means the site's dist/ sits inside the SPA's, and Vite
      // empties outDir by default, so building the SPA deletes the site with
      // nothing said. That last one is why this is an error rather than taste.
      const cfgDir = join(root, inside, 'config')
      if (existsSync(cfgDir)) {
        for (const entry of readdirSync(cfgDir)) {
          if (!/\.(js|mjs|ts)$/.test(entry) || !/sierra/.test(entry)) continue
          let text = ''
          try { text = readFileSync(join(cfgDir, entry), 'utf8') } catch { continue }
          if (!/target\s*:\s*['"`]static['"`]/.test(text)) continue
          findings.push({
            file: join(cfgDir, entry),
            message: `a prerendered site inside ${inside}/. \`target: 'static'\` is its own surface — ` +
                     `site/ — because it is built into files, proved against those files rather than a ` +
                     `running app, and released to a static host with no server behind it. Sharing ` +
                     `${inside}/'s Vite root also shares its dist/, and \`vite build\` empties outDir: ` +
                     `building ${inside}/ deletes the site and says nothing. \`fli make:site\` writes the ` +
                     `surface.`,
          })
        }
      }
    }

    findings.push(...srcLayoutFindings(root))

    return { findings }
  },

  // A subpath is renamed in one change with no alias left behind (the root
  // CLAUDE.md § Evolution policy), so an app on the old spelling is broken from
  // that commit on. The build says so only for a file the build reaches: a test,
  // an `api/` script or a surface nobody built stays broken unseen, which is how
  // nine sibling apps sat on `@frontierjs/sierra/junction` after it became
  // `./resource`. The authority is the INSTALLED package's own `exports` map, so
  // the rule carries no list of retired names to keep current.
  //
  // Only `@frontierjs/*`: a third-party package keeps its old subpaths working
  // across a rename and this framework does not.
  'import-subpath-exported': ({ root }) => {
    const files = sources(root, ['.mesa', '.css', ...SCRIPT_EXT], ...SURFACES, 'tests', 'db')
    if (!files.length) return { skipped: 'no source under a surface' }

    const findings = []
    let graded = 0
    for (const path of files) {
      const code = readCode(path)

      for (const m of code.matchAll(FJS_IMPORT_RE)) {
        const [, , pkg, tail = ''] = m
        const manifest = installedManifest(dirname(path), pkg)
        if (!manifest) continue
        graded++
        const subpath = '.' + tail
        const exported = exportedSubpaths(manifest.exports)
        if (!exported) continue
        if (subpathExported(manifest.exports, subpath)) {
          const targets = patternTargets(manifest.exports, subpath, manifestDir.get(manifest))
          if (!targets?.length || targets.some(existsSync)) continue
          findings.push({
            file: path, line: lineOf(code, m.index),
            message: `\`${pkg}${tail}\` matches an export pattern of ${pkg}, but the file it ` +
                     `resolves to is not there (${relative(manifestDir.get(manifest), targets[0])}), ` +
                     'so the import fails to resolve wherever it is built or run. The pattern adds ' +
                     'the extension itself — import the subpath without it — and a removed ' +
                     'component or store is gone from the package.',
          })
          continue
        }
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `\`${pkg}${tail}\` is not a subpath ${pkg} exports, so the import fails wherever ` +
                   'it is built or run. A renamed subpath keeps no alias, so the import moves to the ' +
                   `new name. ${pkg} exports: ${exported.join(', ')}.`,
        })
      }

      for (const m of code.matchAll(DEEP_IMPORT_RE)) {
        const target = resolve(dirname(path), m[2])
        if (['', ...SCRIPT_EXT].some(ext => existsSync(target + ext))) { graded++; continue }
        const pkg = m[2].match(/node_modules\/(@frontierjs\/[^/]+)/)[1]
        if (!installedManifest(dirname(path), pkg)) continue
        graded++
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `\`${m[2]}\` reaches into ${pkg}'s files past its \`exports\` map, and the file ` +
                   'is not there any more. Import an exported subpath instead; a file behind one ' +
                   'moves without notice.',
        })
      }
    }

    if (!graded) return { skipped: 'no @frontierjs import resolves to an installed package' }
    return { findings }
  },
}

// ─── a @frontierjs specifier against its package's exports ────────────────────

// `from '…'`, `import '…'`, `import('…')`, `require('…')` and a CSS `@import`.
// A Vite query (`?inline`, `?raw`) is not part of the subpath.
const FJS_IMPORT_RE  = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])(@frontierjs\/[a-z0-9][a-z0-9._-]*)(\/[^'"`\n?]*)?(?:\?[^'"`\n]*)?\1/g

const DEEP_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])(\.{1,2}\/[^'"`\n]*node_modules\/@frontierjs\/[^'"`\n]+)\1/g

/**
 * The manifest of `pkg` as node would find it from `dir` — the nearest
 * `node_modules/<pkg>` walking up. A surface may hold its own install, so the
 * walk starts at the importing file rather than the app root. Never
 * `require.resolve`, which bun answers from its global cache (`FJS-666`).
 */
const manifestCache = new Map()

const manifestDir   = new WeakMap()

function installedManifest(dir, pkg) {
  const key = `${dir}\0${pkg}`
  if (manifestCache.has(key)) return manifestCache.get(key)
  let found = null
  for (let here = dir; ; here = dirname(here)) {
    const file = join(here, 'node_modules', pkg, 'package.json')
    if (existsSync(file)) {
      try {
        found = JSON.parse(readFileSync(file, 'utf8'))
        if (found && typeof found === 'object') manifestDir.set(found, dirname(file))
      } catch { found = null }
      break
    }
    if (dirname(here) === here) break
  }
  manifestCache.set(key, found)
  return found
}

/** The subpath keys of an `exports` field, or null when there is none to grade. */
function exportedSubpaths(exports) {
  if (exports == null) return null
  if (typeof exports === 'string' || Array.isArray(exports)) return ['.']
  const keys = Object.keys(exports)
  // A conditions object (`{ import, require }`) exports the root alone.
  if (!keys.some(k => k.startsWith('.'))) return ['.']
  return keys.filter(k => exports[k] !== null)
}

/**
 * Node's subpath matching: an exact key, a one-`*` pattern, or a legacy `./dir/`
 * prefix. `{ key, rest }` is the key that wins and what its `*` (or prefix)
 * captured; null when no key matches or a `null` carve-out wins.
 */
function matchSubpath(exports, subpath) {
  const isMap = typeof exports === 'object' && !Array.isArray(exports) &&
                Object.keys(exports).some(k => k.startsWith('.'))
  if (!isMap) return subpath === '.' ? { key: '.', rest: null } : null
  if (Object.hasOwn(exports, subpath)) return exports[subpath] !== null ? { key: subpath, rest: null } : null
  let hit = null
  for (const key of Object.keys(exports)) {
    const star = key.indexOf('*')
    const match = star === -1
      ? key.endsWith('/') && subpath.startsWith(key)
      : subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1)) &&
        subpath.length >= key.length - 1
    // The longest matching key wins, which is how a `null` carve-out beats `./*`.
    if (match && (hit === null || key.length > hit.length)) hit = key
  }
  if (hit === null || exports[hit] === null) return null
  const star = hit.indexOf('*')
  const rest = star === -1 ? subpath.slice(hit.length)
    : subpath.slice(star, subpath.length - (hit.length - star - 1))
  return { key: hit, rest }
}

const subpathExported = (exports, subpath) => matchSubpath(exports, subpath) !== null

/**
 * The files a pattern or `./dir/` match resolves to, one per condition, as paths
 * inside the package; null for an exact key, which is not graded (a built
 * package's `dist/` is absent from a source tree). Node substitutes `*` into the
 * target textually, so `./stores/*` → `./src/stores/*.js` turns an import that
 * already says `.js` into `toast.js.js`.
 */
function patternTargets(exports, subpath, pkgDir) {
  const hit = matchSubpath(exports, subpath)
  if (!hit || hit.rest === null) return null
  const leaves = []
  const walk = t => {
    if (typeof t === 'string') leaves.push(t)
    else if (Array.isArray(t)) t.forEach(walk)
    else if (t && typeof t === 'object') Object.values(t).forEach(walk)
  }
  walk(exports[hit.key])
  return leaves.filter(t => t.startsWith('./'))
    .map(t => join(pkgDir, hit.key.includes('*') ? t.replaceAll('*', hit.rest) : t + hit.rest))
}

// ─── the src/ layout (FJS-D625, FJS-D626, FJS-D627) ───────────────────────────

// Sierra loads these by path; everything else `fli new` writes goes in lib/.
const WEB_SRC_LOOSE_OK = new Set(['main.js', 'main.ts'])

export const WEB_SRC_KINDS = new Set(['routes', 'resources', 'components'])

// README § Project Structure names each of these; a cli test fails when it drops one.
export const API_SRC_KINDS = new Set(['core', 'services', 'routes', 'plugins', 'jobs', 'notifications', 'providers', 'domain', 'components'])

// A surface folded into web/ is reported once already, by name, above.
const WEB_SRC_REPORTED = new Set(['Embeds', 'harbor'])

const LOADED_SUFFIX    = { services: /\.service\.(ts|js|mjs)$/, jobs: /\.job\.(ts|js|mjs)$/, notifications: /\.notification\.(ts|js|mjs)$/ }

const IMPORT_RE        = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`](\.{1,2}\/[^'"`\n]*)['"`]/g

/** The paths a file's relative imports resolve to, each with its stem. */
function relativeImports(file) {
  let text = ''
  try { text = stripComments(readFileSync(file, 'utf8')) } catch { return [] }
  return [...text.matchAll(IMPORT_RE)].map(m => resolve(dirname(file), m[1]))
}

/**
 * Where `src/` puts things, graded as a warning. Kind first, area second
 * (`FJS-D625`): a file goes in the folder named for its kind, so these are the
 * ways a file is in the wrong one. Every check is a path or an import; none
 * reads what the code means, which is why a file can still be moved by a person
 * who disagrees, and why a baseline allowance (`FJS-D508`) is the answer rather
 * than a pragma.
 */
function srcLayoutFindings(root) {
  const findings = []
  const warn = (file, message) => findings.push({ file: join(root, file), message })

  // web/src: loose modules and misplaced .mesa files.
  const webSrc = join(root, 'web', 'src')
  for (const name of safeRead(webSrc)) {
    const full = join(webSrc, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (!st.isFile() || WEB_SRC_LOOSE_OK.has(name)) continue
    if (name === 'App.mesa' || extname(name) === '.mesa' || !SCRIPT_EXT.has(extname(name))) continue
    warn(rel(root, full), `a module loose in web/src/. Every JavaScript module that is not a route, resource or ` +
      `component goes in web/src/lib/<area>/ (state only the browser has: web/src/stores/). main.js and ` +
      `App.mesa are the files \`fli new\` writes here, and the rest are found by kind, not by being beside them (FJS-D625).`)
  }
  for (const file of sources(root, ['.mesa'], 'web/src')) {
    const parts = relative(webSrc, file).split(/[\\/]/)
    if (parts.length === 1 && parts[0] === 'App.mesa') continue
    if (parts.length > 1 && (WEB_SRC_KINDS.has(parts[0]) || WEB_SRC_REPORTED.has(parts[0]))) continue
    warn(rel(root, file), `a .mesa file outside routes/, resources/ and components/. Every .mesa file that is ` +
      `not a route or a resource goes in web/src/components/<area>/ (FJS-D625, FJS-D382).`)
  }

  const apiSrc  = join(root, 'api', 'src')
  const apiJs   = scripts(root, 'api/src')
  const inside  = (dir, file) => !relative(dir, file).startsWith('..')

  // A raw route belongs where its path is its URL (FJS-D626).
  const routesDir = join(apiSrc, 'routes')
  for (const file of apiJs) {
    if (inside(routesDir, file)) continue
    let text = ''
    try { text = stripComments(readFileSync(file, 'utf8')) } catch { continue }
    if (!/\bapp\.(get|post)\s*\(\s*['"`]\//.test(text)) continue
    warn(rel(root, file), `a raw route outside api/src/routes/. \`app.get\` and \`app.post\` live in ` +
      `api/src/routes/, where a file's path is the URL it answers and an outsider can read a webhook's ` +
      `address off the tree (FJS-D626).`)
  }

  // A loader globs its own folder, so a loaded segment anywhere else registers nothing
  // and nothing says so (FJS-D708).
  for (const file of apiJs) {
    for (const [kind, loaded] of Object.entries(LOADED_SUFFIX)) {
      if (!loaded.test(file) || inside(join(apiSrc, kind), file)) continue
      warn(rel(root, file), `a ${kind.replace(/s$/, '')} file outside api/src/${kind}/. The loader reads only ` +
        `${kind}/, so this file is never loaded; move it there, or drop the .${kind.replace(/s$/, '')} segment ` +
        `if it is not one (FJS-D708).`)
    }
  }

  // A helper in a loader's folder is private to the files beside it (FJS-D625).
  const imported = new Map()
  for (const file of apiJs) for (const target of relativeImports(file)) {
    if (!imported.has(target)) imported.set(target, [])
    imported.get(target).push(file)
  }
  for (const [kind, loaded] of Object.entries(LOADED_SUFFIX)) {
    for (const file of apiJs) {
      if (!inside(join(apiSrc, kind), file) || loaded.test(file)) continue
      const base = stem(file)
      const importers = [...imported].filter(([target]) => stem(target) === base || (basename(base) === 'index' && target === dirname(file)))
        .flatMap(([, from]) => from).filter(from => dirname(from) !== dirname(file))
      if (!importers.length) continue
      warn(rel(root, file), `a helper in ${kind}/ imported from another folder (${rel(root, importers[0])}). A file ` +
        `without the loaded suffix is private to the files beside it; once another folder imports it, it is ` +
        `domain logic and moves to api/src/domain/<area>/ (FJS-D625).`)
    }
  }

  // core/ sets up what the framework ships; a plugin the app wrote is not that.
  for (const file of apiJs) {
    if (!inside(join(apiSrc, 'core'), file)) continue
    let text = ''
    try { text = stripComments(readFileSync(file, 'utf8')) } catch { continue }
    const typed = /import\s*(type\s*)?\{[^}]*\bPlugin(Fn|Input)?\b[^}]*\}\s*from\s*['"]@frontierjs\/junction/.test(text)
    // `app` alone: app.configure(fn) calls it with nothing else, so a helper taking more
    // (joinChannels(app, session, conn), configureTexting(app, opts)) is called by app.ts.
    // A plugin returns nothing, so `channelManager(app): Manager | undefined` is a getter.
    const shaped = /export\s+(async\s+)?(const|function)\s+\w+\s*(=\s*(async\s*)?)?\(\s*app\s*:\s*App\b(<[^>]*>)?\s*,?\s*\)\s*(:\s*(Promise<\s*void\s*>|void)\s*)?(=>|\{)/.test(text)
    if (!/\bexport\b/.test(text) || !(typed || shaped)) continue
    warn(rel(root, file), `a core/ file that exports a plugin. core/ sets up what the framework ships; a plugin ` +
      `the app wrote goes in api/src/plugins/, which app.ts installs one by one because order matters (FJS-D625).`)
  }

  // core/ is what app.ts is built from. A file app.ts never reaches, directly or through
  // another core/ file, is imported only by services, jobs or a script, and no other rule
  // looks inside core/ for it. Domain logic app.ts does import passes: telling that apart
  // from setup reads what the code means.
  const appFile = ['app.ts', 'app.js'].map(name => join(apiSrc, name)).find(existsSync)
  const coreJs  = apiJs.filter(file => inside(join(apiSrc, 'core'), file) && !file.endsWith('.d.ts'))
  if (appFile && coreJs.length) {
    const byStem  = new Map(coreJs.map(file => [stem(file), file]))
    const reached = new Set()
    for (const queue = [appFile]; queue.length;) {
      for (const target of relativeImports(queue.shift())) {
        const file = byStem.get(stem(target)) ?? byStem.get(join(target, 'index'))
        if (!file || reached.has(file)) continue
        reached.add(file)
        queue.push(file)
      }
    }
    // An app.ts reaching none is assembled some way this does not follow, and every file would fire.
    for (const file of reached.size ? coreJs : []) {
      if (reached.has(file)) continue
      warn(rel(root, file), `a core/ file app.ts never reaches. core/ sets up what the framework ships and app.ts ` +
        `assembles it; a module only services, jobs or a script import is domain logic and moves to ` +
        `api/src/domain/<area>/, or beside its one importer when that is a loader's folder (FJS-D625).`)
    }
  }

  // An area at the top of api/src/ is a feature folder: no check that finds files by kind looks in it.
  for (const name of safeRead(apiSrc)) {
    if (API_SRC_KINDS.has(name)) continue
    try { if (!statSync(join(apiSrc, name)).isDirectory()) continue } catch { continue }
    warn(`api/src/${name}`, `a folder at the top of api/src/ that is not a kind. An area is a subfolder of its ` +
      `kind: logic in api/src/domain/${name}/, a .mesa file another imports in api/src/components/${name}/ ` +
      `(FJS-D625, FJS-D1516).`)
  }

  // A .mesa that code renders sits in the area of what renders it; one only another .mesa
  // imports sits in components/ (FJS-D1520).
  const apiMesa    = sources(root, ['.mesa'], 'api/src')
  const mesaImport = new Set(apiMesa.flatMap(relativeImports))
  for (const file of apiMesa) {
    const kind = relative(apiSrc, file).split(/[\\/]/)[0]
    if (kind === 'components' || (kind === 'domain' && !mesaImport.has(file))) continue
    warn(rel(root, file), kind === 'domain'
      ? `a .mesa file in domain/ that another .mesa file imports. A part goes in api/src/components/<area>/, ` +
        `or at the components/ root when two areas use it (FJS-D1520).`
      : `a .mesa file outside domain/ and components/. A .mesa file code renders goes in the ` +
        `api/src/domain/<area>/ of what renders it; one another .mesa file imports goes in components/ (FJS-D1520).`)
  }

  // A surface never imports another by relative path (FJS-D627). The one exception is a
  // prerendered route's .meta.js reading the client its static config's `db:` names: the
  // build cannot fetch the API, and the publish check only taps that client.
  const staticDb = new Map()
  for (const s of staticSurfaces(root)) {
    const db = s.config.match(/\bdb\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
    if (db) staticDb.set(s.surface, stem(resolve(s.surface, db)))
  }
  for (const surface of SURFACES) {
    const dbModule = staticDb.get(join(root, surface))
    for (const file of sources(root, [...SCRIPT_EXT, '.mesa'], `${surface}/src`)) {
      const companion = /\.meta\.[jt]s$/.test(basename(file))
      if (relativeImports(file).some(t => inside(join(root, 'db'), t)))
        warn(rel(root, file), `${surface}/ imports db/ by relative path. Import it as #db/<file>, the alias ` +
          `the app's package.json "imports" names, so no surface depends on where db/ sits (FJS-D1320).`)
      for (const target of relativeImports(file)) {
        if (companion && dbModule && stem(target) === dbModule) continue
        const other = SURFACES.find(s => s !== surface && inside(join(root, s), target))
        if (!other) continue
        warn(rel(root, file), `${surface}/ imports ${other}/ by relative path. Surfaces are peers: ` +
          `the side that runs the file owns it, and the other surface gets its output through a service (FJS-D627).`)
        break
      }
    }
  }

  findings.push(...sharedFindings(root, inside))
  return findings
}

const SHARED_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"`]#shared\/([^'"`\n]+)['"`]/g
const SERVER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"`]@frontierjs\/(?:junction|litestone)\b/

/**
 * shared/ is the one app root that is not a surface (FJS-D1320): pure code two
 * surfaces run, imported as `#shared/<file>`. A shared file that reaches into a
 * surface, db/ or a server package drags that side into the other's bundle; one
 * a single surface imports is that surface's file in the wrong place, and the
 * folder becomes where anything goes.
 */
function sharedFindings(root, inside) {
  const dir   = join(root, 'shared')
  const files = sources(root, SCRIPT_EXT, 'shared')
  if (!files.length) return []

  const findings = []
  const warn = (file, message) => findings.push({ file, message })

  for (const file of files) {
    let text = ''
    try { text = stripComments(readFileSync(file, 'utf8')) } catch { continue }
    const out = relativeImports(file).find(t => !inside(dir, t))
    if (out || SERVER_RE.test(text))
      warn(file, `a shared/ file imports ${out ? rel(root, out) : 'a server package'}. shared/ holds pure code ` +
        `both surfaces run, so it imports nothing from a surface, db/ or the server; db/ may import shared/, ` +
        `never the reverse (FJS-D1320).`)
  }

  // Who reaches each shared file: a surface directly, or a shared file it imports.
  const reach = new Map(files.map(f => [stem(f), new Set()]))
  const via   = new Map(files.map(f => [stem(f), relativeImports(f).filter(t => inside(dir, t)).map(stem)]))
  for (const surface of SURFACES) {
    for (const file of sources(root, [...SCRIPT_EXT, '.mesa'], `${surface}/src`)) {
      let text = ''
      try { text = stripComments(readFileSync(file, 'utf8')) } catch { continue }
      for (const m of text.matchAll(SHARED_RE)) reach.get(stem(join(dir, m[1])))?.add(surface)
      if (relativeImports(file).some(t => inside(dir, t)))
        warn(file, `${surface}/ imports shared/ by relative path. Import it as #shared/<file>, the alias ` +
          `the app's package.json "imports" names, so no surface depends on where another sits (FJS-D1320).`)
    }
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [from, targets] of via) for (const t of targets) for (const s of reach.get(from) ?? []) {
      const set = reach.get(t)
      if (set && !set.has(s)) { set.add(s); changed = true }
    }
  }

  for (const file of files) {
    const n = reach.get(stem(file))?.size ?? 0
    if (n < 2) warn(file, n
      ? `a shared/ file only ${[...reach.get(stem(file))][0]}/ imports. shared/ is for code two surfaces run; ` +
        `one surface's file goes in that surface (FJS-D1320).`
      : `a shared/ file no surface imports (FJS-D1320).`)
  }
  return findings
}

const PLAN_LIMIT = 32 * 1024

// What `drive-holds` reads as binding a resource: the port block is asked for,
// the database is a path literal with no space in it, so a sentence naming
// `db/app.db` in an assertion message is not one.
const DRIVE_BINDS_PORTS = /\bportFor\s*\(|\bFRONTIER_PORT_/

const DRIVE_BINDS_DB    = /(['"`])[^'"`\s]*\bdb\/[^'"`\s]*\.db\b[^'"`\s]*\1/

// What `test-not-hermetic` reads, over code with its strings blanked. A
// `findChrome` given an argument is the probe under test against a fake host,
// and an `openChrome` handed straight to `expect(` is a refusal that launches
// nothing.
const TEST_NOT_HERMETIC = [
  [/\bportFor\s*\(\s*import\.meta\b/,                         "asks for this checkout's port block"],
  [/\bBun\.serve\s*\(\s*\{[^}]*?\bport\s*:\s*[1-9]/,          'binds a literal port'],
  [/\.listen\s*\(\s*[1-9]/,                                   'binds a literal port'],
  [/(?<!\bexpect\(\s*)\bopenChrome\s*\(|\bfindChrome\s*\(\s*\)/, 'launches Chrome'],
  // `mock.module()` replaces the module for every file in the bun process
  // (`FJS-D443`), so the test that calls it changes what its neighbors import.
  [/\bmock\.module\s*\(/,                                     'mocks a module for the whole bun process'],
]

// The calls a timeout rides on, and where it sits: a third argument to a test,
// a second to a hook, or an options object after the name. A `.each(table)` or
// `.skipIf(cond)` chain is read through. The argument must read as arithmetic,
// because `readCode` does not track regex literals and a `(` inside one
// unbalances the call.
const TEST_CALL = /(?<![\w.$])(test|it|describe|beforeAll|beforeEach|afterAll|afterEach)((?:\.\w+(?:\([^()]*\))?)*)\s*\(/g

const TIMEOUT_ARG = /^[\w.\s*+]+$/

const TIMEOUT_OPTION = /^\s*\{[^{}]*\btimeout\s*:\s*([^,}]+)/

function inlineTimeouts(code) {
  const out = []
  for (const m of code.matchAll(TEST_CALL)) {
    const args = []
    let depth = 1, start = m.index + m[0].length
    for (let i = start; i < code.length && depth; i++) {
      const c = code[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') { if (!--depth) args.push(code.slice(start, i)) }
      else if (c === ',' && depth === 1) { args.push(code.slice(start, i)); start = i + 1 }
    }
    const option = args.slice(1).map(a => TIMEOUT_OPTION.exec(a)).find(Boolean)
    const at = (/^(before|after)/.test(m[1]) ? args[1] : args[2])?.trim()
    const timeout = option ? option[1].trim() : at && TIMEOUT_ARG.test(at) ? at : null
    if (timeout) out.push({ index: m.index, timeout: timeout.replace(/\s+/g, ' ') })
  }
  return out
}

// The nearest directory at or above `path` holding a package.json, `root` the
// last one asked.
function packageDirOf(path, root) {
  let dir = dirname(path)
  while (dir !== root && dir.startsWith(root) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return dir.startsWith(root) ? dir : root
}

// Where a package states its test timeout, or null: `--timeout` in its `test`
// script for bun, `testTimeout`/`hookTimeout` in its vitest config.
function timeoutOwner(dir) {
  let script = ''
  try { script = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.test ?? '' } catch {}
  if (/--timeout[= ]\d/.test(script)) return '`--timeout` in its `test` script'
  for (const name of safeRead(dir)) {
    if (!/^vite(st)?\.config\.[mc]?[jt]s$/.test(name)) continue
    if (/\b(test|hook)Timeout\s*:/.test(readCode(join(dir, name)))) return `\`testTimeout\` in ${name}`
  }
  return null
}

// Every `*.test.*` file under `root` — the files `bun test` and vitest collect —
// with fixtures and a nested app left out, the second to that app's own run.
function collectedTests(root) {
  const apps  = new Set(findApps(root).filter(a => a !== root))
  const files = []
  const visit = (dir, depth) => {
    if (depth < 0) return
    for (const name of safeRead(dir)) {
      if (SKIP.has(name) || name.startsWith('.') || name === 'fixtures') continue
      const child = join(dir, name)
      let st
      try { st = statSync(child) } catch { continue }
      if (st.isDirectory()) { if (!apps.has(child)) visit(child, depth - 1) }
      else if (/\.test\.[mc]?[jt]sx?$/.test(name)) files.push(child)
    }
  }
  visit(root, 8)
  return files.sort()
}

// Every script under a directory whose name `dirs` matches, a nested app left
// to that app's own run.
function driveFiles(root, dirs) {
  const apps  = new Set(findApps(root).filter(a => a !== root))
  const files = []
  const visit = (dir, depth, inTests) => {
    if (depth < 0) return
    for (const name of safeRead(dir)) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const child = join(dir, name)
      let st
      try { st = statSync(child) } catch { continue }
      if (st.isDirectory()) {
        if (!apps.has(child)) visit(child, depth - 1, inTests || dirs.test(name))
      } else if (inTests && /\.(mjs|js|ts)$/.test(name)) files.push(child)
    }
  }
  visit(root, 8, false)
  return files
}
