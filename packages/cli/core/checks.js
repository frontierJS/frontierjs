// ─── checks.js — architecture rules, enforced as assertions ──────────────────
//
// The rules an FJS app has to follow that no compiler catches: what a model may
// be called, what may live in `src/resources/`, what a resource file is named,
// and the two configuration lines whose absence is silent and expensive.
//
// It exists because half of those rules are greppable and were being enforced by
// code review, which is the enforcement mechanism that stops working the week
// everyone is busy. Pest's architecture testing is the proven form.
//
// ── One engine, two callers ──────────────────────────────────────────────────
//
// `fli check` runs this over a client app. `scripts/ci.mjs` runs the same
// functions over this repo's own apps. They must not be two implementations: a
// framework that breaks its own stated rules is worse than one that never stated
// them, and the way that happens is a second copy nobody re-derives.
//
// So: zero dependencies, plain ESM, node or bun. `ci.mjs` imports it by relative
// path, which is what keeps it honest — a rule loosened for the repo is loosened
// for every app on the next release.
//
// ── What belongs here ────────────────────────────────────────────────────────
//
// A rule earns a place by being (a) decidable from the file tree and (b) silent
// when broken. `strictPort` is the model: vite hops to the next free port
// without a word, so a second app's test drive exercises the first app's app and
// everything passes. A rule whose violation is already a loud error belongs in
// the thing that raises it, not here.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, relative, basename, extname }               from 'path'

// ─── the rule table ───────────────────────────────────────────────────────────
//
// `scope: 'app'` runs against a client app; `scope: 'repo'` against a package
// tree. `fli check` runs the app scope, `ci.mjs` runs both.

export const RULES = [
  { id: 'model-name-case',      scope: 'app',  severity: 'error', invariant: 2,
    title: 'a model name is PascalCase' },
  { id: 'model-name-plural',    scope: 'app',  severity: 'warn',  invariant: 2,
    title: 'a model name is singular' },
  { id: 'resource-dir-mesa',    scope: 'app',  severity: 'error', invariant: 18,
    title: 'src/resources/ holds only .mesa files' },
  { id: 'resource-script',      scope: 'app',  severity: 'error', invariant: 18,
    title: 'a resource is a <script module> and no markup' },
  { id: 'resource-file-name',   scope: 'app',  severity: 'error', invariant: 19,
    title: 'a resource file is named for its model' },
  { id: 'resource-one-per-file', scope: 'app', severity: 'error', invariant: 19,
    title: 'one Resource per file' },
  { id: 'vite-strict-port',     scope: 'app',  severity: 'error', invariant: null,
    title: 'every vite config sets strictPort' },
  { id: 'body-tag-in-comment',  scope: 'app',  severity: 'error', invariant: null,
    title: 'the body tag is never written inside a comment' },
  { id: 'app-layout',           scope: 'app',  severity: 'warn',  invariant: 3,
    title: 'db/ at the app root, and each surface a directory beside it' },
  { id: 'widget-entry-name',    scope: 'app',  severity: 'error', invariant: 19,
    title: 'a widget is a PascalCase file, or a directory holding index.mesa' },
  { id: 'package-root-md',      scope: 'repo', severity: 'warn',  invariant: 17,
    title: 'four markdown files are the standard at a package root' },
]

const BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]))

// ─── runChecks ────────────────────────────────────────────────────────────────
//
//   runChecks({ root: '/path/to/app' })            → every app rule
//   runChecks({ root, only: ['vite-strict-port'] })
//   runChecks({ root, scope: 'repo' })
//
// Returns `{ findings, ran, skipped }`. **`skipped` is not decoration**: a rule
// that found nothing because it found nothing to look at is not a rule that
// passed, and reporting the two as one number is how a check quietly stops
// covering the thing it was written for.

// `allow` is `{ '<rule>:<path>': 'why' }`, path relative to `root`. An exception
// is a named entry with a reason, never a loosened rule: the rule is what every
// app gets on the next release, and the one place it may not hold is written down
// where the next person can disagree with it.

export function runChecks({ root, only = null, scope = 'app', allow = {} } = {}) {
  const wanted = RULES.filter(r =>
    (scope === 'both' || r.scope === scope) && (!only || only.includes(r.id)))

  const findings = []
  const allowed  = []
  const ran      = []
  const skipped  = []

  for (const rule of wanted) {
    const out = CHECKS[rule.id]({ root, rule })
    if (out.skipped) skipped.push({ rule: rule.id, why: out.skipped })
    else             ran.push(rule.id)
    for (const f of out.findings ?? []) {
      const found = { rule: rule.id, severity: rule.severity, invariant: rule.invariant, ...f }
      const key   = `${rule.id}:${relative(root, f.file) || '.'}`
      if (key in allow) allowed.push({ ...found, why: allow[key] })
      else              findings.push(found)
    }
  }

  // A stale allowance is reported, not ignored — an exception that outlives the
  // thing it excused is an unenforced rule nobody knows is unenforced.
  const hit   = new Set(allowed.map(a => `${a.rule}:${relative(root, a.file) || '.'}`))
  const stale = Object.keys(allow).filter(k => !hit.has(k))

  return { findings, allowed, stale, ran, skipped }
}

/** Every directory under `root` that looks like an FJS app — one `db/schema.lite`. */
export function findApps(root) {
  const out = []
  walk(root, 4, dir => {
    if (existsSync(join(dir, 'db', 'schema.lite'))) out.push(dir)
  })
  return out
}

// ─── the checks ───────────────────────────────────────────────────────────────

const CHECKS = {

  // Invariant 2. Three resolvers agree that `model Lead` is `db.lead` and the
  // service `leads`; a name that is not PascalCase singular disagrees with one of
  // them, and which one it disagrees with is not stated anywhere.
  'model-name-case': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    return { findings: models(schema).filter(m => !/^[A-Z][A-Za-z0-9]*$/.test(m.name)).map(m => ({
      file: schema.path, line: m.line,
      message: `model ${m.name} — a model name is PascalCase. \`db.<accessor>\`, the service name and the ` +
               `JSON Schema \`$defs\` key are all derived from it, and they do not all derive the same way.`,
    })) }
  },

  // A warning, not an error, because English is not decidable. The plural
  // endings below are the ones that are; a false positive is answered by
  // renaming or by ignoring one line, and the alternative — saying nothing — is
  // how `model Servers` reaches the point where renaming it moves a migration.
  'model-name-plural': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    return { findings: models(schema).filter(m => looksPlural(m.name)).map(m => ({
      file: schema.path, line: m.line,
      message: `model ${m.name} — a model name is singular (\`model Lead\` → \`db.lead\` → service \`leads\`). ` +
               `If this really is singular, this line is a false positive; if not, rename it now, because ` +
               `later it moves a migration too.`,
    })) }
  },

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

  // Invariant 18, second half: no markup, everything in `<script module>`. A
  // plain `<script>` is instance scope — it would run per component rather than
  // once per module, and a resource has no instance.
  'resource-script': ({ root }) => {
    const files = resourceFiles(root)
    if (!files.length) return { skipped: 'no .mesa files in web/src/resources/' }
    const findings = []
    for (const path of files) {
      const src = readFileSync(path, 'utf8')
      if (!/<script\s+module[\s>]/.test(src)) findings.push({
        file: path,
        message: `a resource's code goes in <script module>. A plain <script> is instance scope — it runs ` +
                 `once per component, and a Resource has no instances.`,
      })
      const rest = src
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim()
      if (rest) findings.push({
        file: path,
        message: `a resource file has no markup, and this one has ${rest.length} character(s) of it: ` +
                 `${JSON.stringify(rest.slice(0, 60))}. A Resource is data, not a component.`,
      })
    }
    return { findings }
  },

  // Invariant 19. **The schema decides**, rather than a pluralisation rule this
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
    const findings = []

    for (const path of files) {
      const name = basename(path, '.mesa')
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || looksPlural(name)) {
        findings.push({
          file: path,
          message: `a resource file is named for its noun — PascalCase, singular. ` +
                   `${name}.mesa should be ${singular(name)}.mesa.`,
        })
        continue
      }
      if (!known) continue

      const src    = readFileSync(path, 'utf8')
      const stated = src.match(/\bmodel:\s*['"]([A-Za-z0-9_]+)['"]/)
      if (stated) {
        if (stated[1] !== name) findings.push({
          file: path,
          message: `states model: '${stated[1]}' but is named ${name}.mesa. Where a model exists the ` +
                   `filename IS the model name — that is what makes an irregular visible in the tree.`,
        })
        continue
      }
      if (known.has(name)) continue

      // A Resource over no model takes its SERVICE noun, singularised — which is
      // `Hub.mesa` for `createResource('hub')`, and correct. Judging it against
      // the schema alone would refuse every cross-cutting resource an app has.
      const service = src.match(/createResource\(\s*['"]([A-Za-z0-9_-]+)['"]/)?.[1]
      if (service && singular(service) === name) continue

      findings.push({
        file: path,
        message: `no model named ${name} in db/schema.lite${service ? `, and the service is '${service}'` : ''}. ` +
                 `Either the file is misnamed, or this is a Resource over no model and should take its ` +
                 `service noun singularised — and if the service does not pluralise regularly from the ` +
                 `model, say so with model:.`,
      })
    }
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

  // Not an invariant — a live hazard, which is worse. Vite hops to the next free
  // port in silence, so the second app to start binds the first app's neighbour
  // and a test drive exercises the wrong app with everything green.
  'vite-strict-port': ({ root }) => {
    const configs = []
    walk(root, 4, dir => {
      for (const name of readdirSync(dir)) {
        if (/^vite\.config\.[cm]?[jt]s$/.test(name)) configs.push(join(dir, name))
      }
    })
    if (!configs.length) return { skipped: 'no vite config' }
    return { findings: configs.filter(p => !/strictPort/.test(readFileSync(p, 'utf8'))).map(p => ({
      file: p,
      message: `no strictPort. Vite hops to the next free port without a word, so this app can end up ` +
               `serving on the port another app's test drive is pointed at — and every assertion passes ` +
               `against the wrong app.`,
    })) }
  },

  // Vite injects the built <script> at the first TEXTUAL match for the body tag
  // and does not skip comments. Mention it in one and the build succeeds,
  // dist/index.html looks right, and the page loads no JavaScript.
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
      for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) {
        if (!/<\s*body/i.test(m[0])) continue
        findings.push({
          file: path, line: lineOf(src, m.index),
          message: `the body tag appears inside a comment. Vite injects the built <script> at the first ` +
                   `textual match and does not skip comments — the build succeeds, the file looks right, ` +
                   `and the page loads no JavaScript.`,
        })
      }
    }
    return { findings }
  },

  // Invariant 3. A SURFACE is a directory at the app root — `api/`, `web/`,
  // `widgets/` — with the schema beside them and owned by none of them. Which
  // surfaces an app has is the app's business: api-only, web-only and
  // widgets-only are all whole projects, and a rule that demands all of them
  // gets disabled rather than obeyed.
  //
  // What is decidable, and silent when wrong, is a surface in the WRONG PLACE:
  // widgets living inside web/ share that surface's config, its port and its
  // release, and the first thing anyone notices is a widget shipping when the
  // SPA does.
  'app-layout': ({ root }) => {
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'not an app root' }

    const has = (...p) => existsSync(join(root, ...p))
    const surfaces = ['api', 'web', 'widgets', 'extension'].filter(d => has(d))

    // A schema with no surface beside it is a single-realm fixture, not an app
    // that got the layout wrong. Asked before judging, because a check that
    // scolds every fixture in a repo is a check people turn off.
    if (!surfaces.length)
      return { skipped: 'a schema with no api/, web/, widgets/ or extension/ beside it — a fixture, not an app' }

    const findings = []

    // A surface's contents at the app root: `src/` beside `db/` means the
    // realms were never separated in the first place.
    if (has('src') && !has('web') && !has('widgets')) findings.push({
      file: join(root, 'src'),
      message: `src/ at the app root with no surface owning it. Each realm is a directory — api/, ` +
               `web/, widgets/ — and every generator, drive and doc resolves paths against one of ` +
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
    }

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

  // Invariant 17. Repo scope: an app root is the developer's own, but a package
  // published from this tree keeps four files at its root and puts the rest in
  // docs/.
  //
  // **A warning, not an error.** The four are the standard and a fifth file is
  // worth a conversation, not a refused build — the rule cannot know whether the
  // new file is a stray design note or the next thing everyone needs at the root.
  // So it names what it found and leaves the decision to a person; an allowance
  // under "structure" in scripts/ci-allowances.json is where that decision gets
  // written down once it is made.
  'package-root-md': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const allowed = new Set(['README.md', 'CLAUDE.md', 'PROJECT_STATE.md', 'CHANGES.md'])

    // A `*.snapshot.md` is generated and gated, not documentation — nobody is
    // asked to hold it in their head, and it cannot move: CI reruns each
    // snapshot's generator from the file's own directory, and an app is built
    // with the cwd its own scripts use. `packages/basecamp` is a package and an
    // app at once, which is the only reason this crosses the rule at all.
    const generated = (name) => /\.snapshot\.md$/.test(name)

    const findings = []
    for (const dir of pkgs) {
      const extra = safeRead(dir).filter(n => n.endsWith('.md') && !allowed.has(n) && !generated(n))
      if (extra.length) findings.push({
        file: dir,
        message: `${extra.length} markdown file(s) beyond the four at the package root — ${extra.join(', ')}. ` +
                 `README/CLAUDE/PROJECT_STATE/CHANGES is the standard, because the root is the index and ` +
                 `an index nobody can hold in their head is a directory listing. Does this one belong at ` +
                 `the root, or in docs/? Record the answer as an allowance either way.`,
      })
    }
    return { findings }
  },
}

// ─── reading the tree ─────────────────────────────────────────────────────────

/** `web/src/resources/` and `src/resources/` under it — a Sierra app's shape. */
function resourceDirs(root) {
  return [join(root, 'web', 'src', 'resources'), join(root, 'src', 'resources')]
    .filter(d => existsSync(d) && statSync(d).isDirectory())
}

function resourceFiles(root) {
  return resourceDirs(root).flatMap(dir =>
    readdirSync(dir).filter(n => extname(n) === '.mesa').map(n => join(dir, n)))
}

function schemaFile(root) {
  const path = join(root, 'db', 'schema.lite')
  return existsSync(path) ? { path, text: readFileSync(path, 'utf8') } : null
}

// A line scan, not the parser. `fli check` must answer without a database, a
// migration or an installed litestone, and a rule about a NAME does not need the
// AST. `@@external` is exempt from invariant 2, so it is skipped here too.
function models({ text }) {
  const out   = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (!m) continue
    if (bodyOf(lines, i).includes('@@external')) continue
    out.push({ name: m[1], line: i + 1 })
  }
  return out
}

/** The text from a model's opening line to its closing brace. */
function bodyOf(lines, start) {
  const out = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += (lines[i].match(/{/g) ?? []).length
    depth -= (lines[i].match(/}/g) ?? []).length
    if (i > start && depth <= 0) break
  }
  return out.join('\n')
}

// ─── English, as far as it is decidable ───────────────────────────────────────
//
// Deliberately narrow. `Status`, `Address`, `Progress` and every other singular
// ending in `s` are why the `ss` and `us` cases are excluded rather than
// allow-listed — an allow-list is a thing to maintain, and the words it would
// hold are exactly the ones a schema uses.

function looksPlural(name) {
  if (/(ss|us|is)$/.test(name)) return false     // Address, Status, Analysis
  return /(ies|ses|xes|ches|shes)$/.test(name) || /[a-z]s$/.test(name)
}

function singular(name) {
  const pascal = name[0].toUpperCase() + name.slice(1)
  if (/ies$/.test(pascal))  return pascal.slice(0, -3) + 'y'
  if (/(ses|xes|ches|shes)$/.test(pascal)) return pascal.slice(0, -2)
  if (/[a-z]s$/.test(pascal)) return pascal.slice(0, -1)
  return pascal
}

// ─── walking ──────────────────────────────────────────────────────────────────

const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output', '.vite'])

function walk(dir, depth, fn) {
  if (depth < 0 || !existsSync(dir)) return
  try { fn(dir) } catch { /* an unreadable directory is not a finding */ }
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(dir, name)
    try { if (statSync(child).isDirectory()) walk(child, depth - 1, fn) } catch { /* dangling link */ }
  }
}

function safeRead(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

// ─── reporting ────────────────────────────────────────────────────────────────

/** Findings as lines a terminal can print. `root` shortens the paths. */
export function formatFindings(findings, root) {
  const byRule = {}
  for (const f of findings) (byRule[f.rule] ??= []).push(f)

  const out = []
  for (const [id, list] of Object.entries(byRule)) {
    const rule = BY_ID[id]
    const tag  = rule.invariant ? ` (invariant ${rule.invariant})` : ''
    out.push(`  ${rule.severity === 'error' ? '✗' : '⚠'}  ${id}${tag} — ${rule.title}`)
    for (const f of list) {
      const where = relative(root, f.file) || '.'
      out.push(`       ${where}${f.line ? `:${f.line}` : ''}`)
      out.push(`         ${f.message}`)
    }
  }
  return out
}
