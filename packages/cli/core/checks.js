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
// So: plain ESM, node or bun, and one import — `@frontierjs/toolbelt/inflect`,
// the substrate package below the dependency graph, because *what is the
// singular of this service name* has one owner (Invariant 2) and a rule that
// answered it a sixth time would grade an app by rules the app does not run.
// `ci.mjs` imports this file by relative path, which is what keeps it honest —
// a rule loosened for the repo is loosened for every app on the next release.
//
// ── What belongs here ────────────────────────────────────────────────────────
//
// A rule earns a place by being (a) decidable from the file tree and (b) silent
// when broken. `strictPort` is the model: vite hops to the next free port
// without a word, so a second app's test drive exercises the first app's app and
// everything passes. A rule whose violation is already a loud error belongs in
// the thing that raises it, not here.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, relative, basename, extname }               from 'path'

import { singularize } from '@frontierjs/toolbelt/inflect'

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
    title: 'a resource has a <script module>' },
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
  { id: 'surface-config',       scope: 'app',  severity: 'warn',  invariant: 3,
    title: 'a surface keeps its configuration in config/' },
  { id: 'surface-src',          scope: 'app',  severity: 'warn',  invariant: 3,
    title: 'a surface keeps its source in src/, and only its entry beside it' },
  { id: 'widget-entry-name',    scope: 'app',  severity: 'error', invariant: 19,
    title: 'a widget is a PascalCase file, or a directory holding index.mesa' },
  { id: 'migration-history',    scope: 'app',  severity: 'error', invariant: null,
    title: 'an app whose container migrates on boot has a migration history to replay' },
  { id: 'raw-route-param',      scope: 'app',  severity: 'error', invariant: null,
    title: 'a raw route names a capture {id}, never :id' },
  { id: 'ctx-params',           scope: 'app',  severity: 'error', invariant: null,
    title: 'a service context has no ctx.params' },
  { id: 'set-auth-discarded',   scope: 'app',  severity: 'error', invariant: null,
    title: '$setAuth answers a scoped client rather than mutating one' },
  { id: 'call-header-declared', scope: 'app',  severity: 'error', invariant: null,
    title: 'a per-call header is declared in http.callHeaders' },
  { id: 'service-model',        scope: 'app',  severity: 'error', invariant: 2,
    title: 'a service resolves to the model whose @@gate grades it' },
  { id: 'resource-model-miss',  scope: 'app',  severity: 'error', invariant: 2,
    title: 'a resource name resolves to the model it means' },
  { id: 'detail-read-dead',     scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a row a screen KEEPS is watched, not fetched once' },
  { id: 'service-module-db',    scope: 'app',  severity: 'error', invariant: null,
    title: 'a service reads the request-scoped client, not the module one' },
  { id: 'service-as-system',    scope: 'app',  severity: 'warn',  invariant: null,
    title: 'asSystem() off the app client crosses tenants; off the request client it does not' },
  { id: 'scheduler-dispatch',   scope: 'app',  severity: 'error', invariant: null,
    title: 'a timer that dispatches into a queue is the queue\'s schedule' },
  { id: 'gate-unreachable',     scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a declared @@gate level something can actually reach' },
  { id: 'static-publish-db',    scope: 'app',  severity: 'error', invariant: null,
    title: 'a prerendered site wires the client its publish check reads' },
  { id: 'static-publishes-0',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'publishes: 0 silences the proof rather than raising a bar' },
  { id: 'package-model-drift',  scope: 'app',  severity: 'warn',  invariant: null,
    title: "a copied model still agrees with the package that ships it" },
  { id: 'transition-methods',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a declared move and the code that makes it still name each other' },
  { id: 'capability-ladder',    scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a model graded by capability is not also graded by ladder' },
  { id: 'css-token-undefined',  scope: 'app',  severity: 'error', invariant: 13,
    title: 'a styled value names a token the stylesheets define' },
  { id: 'package-root-md',      scope: 'repo', severity: 'warn',  invariant: 17,
    title: 'four markdown files are the standard at a package root' },
  { id: 'test-files-run',       scope: 'repo', severity: 'error', invariant: null,
    title: 'a hand-listed test script names every test file beside it' },
]

const BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]))

// Migration files, one directory deep — a schema declaring `database` blocks
// keeps them under db/migrations/<name>/.
function walkSql(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walkSql(join(dir, e.name)))
    else if (e.name.endsWith('.sql') || e.name.endsWith('.js')) out.push(e.name)
  }
  return out
}

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

// ─── the baseline ─────────────────────────────────────────────────────────────
//
// `check-baseline.json` at the app root, one number per rule id. Absent means 0
// means clean, and a number may only ever fall — Invariant 14's ratchet, applied
// to a second kind of count. `scripts/typecheck-baselines.json` is the
// precedent and the semantics are deliberately identical, down to `--update`
// being unable to raise.
//
// ── Why it is not the allowance mechanism ────────────────────────────────────
//
// `allow` says *this one is fine, and here is why*: keyed by rule AND path,
// carrying a reason, and a stale one is reported. A baseline says something
// weaker and more useful for adoption — *there are this many and there will
// never be more*. It grandfathers nothing: the findings still PRINT. What the
// file changes is the exit code, because debt you cannot see is debt nobody
// pays, and a rule set that goes red on the day it is installed gets removed
// rather than obeyed.
//
// ── A rule that did not RUN is not a rule that improved ──────────────────────
//
// This is the one place the shape had to differ from typecheck's, and it comes
// from the same doctrine as `skipped`: a rule with nothing to look at reports 0
// findings, which is indistinguishable from a fixed one by count alone. So a
// skipped rule's ceiling is carried forward untouched and reported, rather than
// ratcheted down to 0 — otherwise deleting the `web/` surface for an afternoon
// locks in a baseline that no later run can meet.

export const BASELINE_FILE = 'check-baseline.json'

export function readBaseline(root, { read = readFileSync } = {}) {
  const path = join(root, BASELINE_FILE)
  let raw
  try { raw = JSON.parse(read(path, 'utf8')) } catch { return { path, present: false, counts: {} } }

  const counts = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('//')) continue                 // a comment, the way JSON allows one
    if (Number.isFinite(value)) counts[key] = value
  }
  return { path, present: true, counts }
}

/**
 * Grade a run against a baseline.
 *
 *   regressions  — a rule above its ceiling. The gate.
 *   improvements — below it, and `--update` locks those in.
 *   held         — a rule that did not run; its ceiling stands, ungraded.
 *   unknown      — a ceiling for a rule id that no longer exists.
 */
export function gradeBaseline({ findings, ran, skipped }, baseline) {
  const counts = {}
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1

  const didRun  = new Set(ran)
  const skipped_ = new Set((skipped ?? []).map(s => s.rule ?? s.id))
  const ceiling = (id) => baseline.counts[id] ?? 0

  const regressions = [], improvements = [], held = [], unknown = []

  for (const rule of RULES) {
    if (!didRun.has(rule.id)) {
      if (ceiling(rule.id) > 0 && skipped_.has(rule.id))
        held.push({ rule: rule.id, ceiling: ceiling(rule.id) })
      continue
    }
    const count = counts[rule.id] ?? 0
    if (count > ceiling(rule.id)) regressions.push({ rule: rule.id, count, ceiling: ceiling(rule.id) })
    else if (count < ceiling(rule.id)) improvements.push({ rule: rule.id, count, ceiling: ceiling(rule.id) })
  }

  const ids = new Set(RULES.map(r => r.id))
  for (const id of Object.keys(baseline.counts)) if (!ids.has(id)) unknown.push({ rule: id, ceiling: baseline.counts[id] })

  return { counts, regressions, improvements, held, unknown, ok: regressions.length === 0 }
}

/**
 * Write the file back.
 *
 * `mode: 'lower'` is the ratchet — it takes improvements and refuses to raise,
 * so the flag a person runs after fixing something cannot record the thing they
 * broke. `mode: 'adopt'` writes what is actually there, raising included, and is
 * its own verb for that reason: recording new debt is a decision, and it should
 * read like one in the diff.
 *
 * A rule that did not run keeps the number it had under both.
 */
export function writeBaseline(root, { counts, ran, baseline, mode = 'lower', write = writeFileSync }) {
  const next = { ...baseline.counts }

  // Only a rule that RAN may move its own number. Everything else keeps what it
  // had, including a rule that skipped — see `gradeBaseline`.
  for (const id of ran) {
    const count   = counts[id] ?? 0
    const ceiling = next[id] ?? 0
    if (mode !== 'adopt' && count > ceiling) continue
    if (count === 0) delete next[id]
    else next[id] = count
  }

  // A zero says exactly what an absent key says, so it is not written. The file
  // is the list of rules with debt on them and nothing else.
  for (const [id, count] of Object.entries(next)) if (!count) delete next[id]

  const header = {
    '//': 'One number per fli check rule id — the count that may never rise. Absent = 0 = clean. ' +
          '`fli check --update` locks in an improvement and cannot raise; `fli check --adopt` records ' +
          'what is there, which is the verb for taking debt on. The findings still print either way.',
  }
  const body = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
  write(join(root, BASELINE_FILE), `${JSON.stringify({ ...header, ...body }, null, 2)}\n`)
  return body
}

// ─── applyFixes ───────────────────────────────────────────────────────────────
//
//   const { fixed, failed } = applyFixes(runChecks({ root }).findings)
//
// A finding MAY carry `edit: { start, end, was, replacement }` — byte offsets
// into the file it names. The rule computes the span because only the rule knows
// it; this writes, because *how a file gets changed on disk* is one answer and
// not one per rule.
//
// **The offsets are into the real source even though rules read `readCode`**,
// and that is the whole reason comments are blanked to spaces rather than
// deleted: every position survives, so a span found in the blanked text names
// the same bytes in the file.
//
// ── What may carry a fix ─────────────────────────────────────────────────────
//
// Only a rewrite that is the WHOLE fix. Three rules qualify: `:id` → `{id}` is
// a spelling, and the two model rules already computed the exact name the call
// is missing. The others deliberately have none, and `set-auth-discarded` is
// the argument — wrapping the call in `const scoped =` would silence the rule
// and leave every write below it going through the unscoped client, which is
// the bug. **A fix that makes the check pass without fixing the failure is
// worse than no fix**, because the next person reads a green check.
//
// `was` is re-verified before the write. A finding computed against a file that
// has since changed is refused by name rather than applied at a stale offset.

export function applyFixes(findings, { read = readFileSync, write = writeFileSync } = {}) {
  const byFile = new Map()
  for (const f of findings) {
    if (!f.edit) continue
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }

  const fixed  = []
  const failed = []

  for (const [file, list] of byFile) {
    let text = ''
    try { text = read(file, 'utf8') } catch { 
      for (const f of list) failed.push({ ...f, why: 'the file could not be read' })
      continue
    }

    // Back to front, so an earlier edit's offsets are still true. Overlapping
    // spans are refused rather than resolved: two rules wanting the same bytes
    // is a question for a person.
    const sorted = [...list].sort((a, b) => b.edit.start - a.edit.start)
    const applied = []
    let last = Infinity

    for (const f of sorted) {
      const { start, end, was, replacement } = f.edit
      if (end > last)                     { failed.push({ ...f, why: 'it overlaps another fix' }); continue }
      if (text.slice(start, end) !== was) { failed.push({ ...f, why: 'the file has changed since it was checked' }); continue }
      text = text.slice(0, start) + replacement + text.slice(end)
      last = start
      applied.push(f)
    }

    if (!applied.length) continue
    try { write(file, text) } catch {
      for (const f of applied) failed.push({ ...f, why: 'the file could not be written' })
      continue
    }
    fixed.push(...applied)
  }

  return { fixed, failed }
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
  // and does not skip comments. Mention it in one ABOVE the real tag and the
  // build succeeds, dist/index.html looks right, and the page loads no
  // JavaScript.
  //
  // FIRST is the whole rule (`FJS-329`). A mention below the real <body> is
  // harmless — Vite has already matched — and flagging it made this rule fire on
  // a file that documents its own markup, which is `packages/css/guide`. A check
  // that cries wolf is the failure this engine exists to prevent, and it is
  // worse in a rule an app runs than in one only this repo does.
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
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'not an app root' }

    const has = (...p) => existsSync(join(root, ...p))
    const surfaces = ['api', 'web', 'widgets', 'site', 'extension'].filter(d => has(d))

    // A schema with no surface beside it is a single-realm fixture, not an app
    // that got the layout wrong. Asked before judging, because a check that
    // scolds every fixture in a repo is a check people turn off.
    if (!surfaces.length)
      return { skipped: 'a schema with no api/, web/, widgets/, site/ or extension/ beside it — a fixture, not an app' }

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

    return { findings }
  },

  // Invariant 3's second half: configuration lives in `config/`.
  //
  // This is the silent-when-broken class those rules exist for. Nothing fails
  // when the directory is missing — a loader treats an absent config file as an
  // optional miss, which is right — so an app boots on framework defaults
  // looking configured. `basecamp` read `api/config` for its whole life without
  // that directory existing, and its CORS was `*` for everyone as a result
  // (`FJS-415`).
  //
  // Judged per SURFACE, and a surface with no source in it is skipped rather
  // than scolded — a directory somebody made is not a surface yet, and a rule
  // that scolds every fixture in a repo is a rule people turn off. `db/` is
  // exempt by name (Invariant 3 says so) and is not in the list.
  //
  // Three findings, in descending sharpness: a config file BESIDE a config/,
  // where one of the two is read and nobody can tell which; a config file at
  // the surface root with no config/ at all, which is read by nothing; and the
  // bare absence, which is basecamp's case and the one worth arguing about.
  //
  // The absence IS a finding, rather than "this surface declares nothing on
  // purpose", because the framework resolves that path whether or not the app
  // meant it to: junction's default configPath is `api/config` unconditionally.
  // An app that genuinely wants the defaults writes a config file saying so in
  // one line, which costs nothing and is the difference between a decision and
  // an accident.
  // An app whose entrypoint replays migrations must have some to replay.
  //
  // `fli db:push` writes tables and no file; the container runs `migrate
  // apply`, which runs files. An app that has only ever pushed therefore
  // deploys, starts, answers /health and 500s on the first write — measured on
  // this repo's own `example`, which had no `db/migrations/` at all
  // (`FJS-345`, `FJS-388`).
  //
  // This is the STRUCTURAL half and deliberately only that: whether the history
  // actually BUILDS the declared schema is a semantic question that needs
  // litestone to run, and `fli` is on node where `bun:sqlite` cannot be
  // imported. `litestone migrate check` answers it, and three things call it —
  // `fli deploy:doctor` before the image is built, `migrate apply` at container
  // start, and CI's deploy phase. A rule here that shelled out would be a
  // fourth implementation of a question that already has one owner
  // (`FJS-D123`).
  //
  // Only for an app that migrates on BOOT. basecamp runs its migrations inside
  // app.ts and has no `db:migrate` script, on purpose (`FJS-417`), and an app
  // with no Dockerfile is not deploying this way at all.
  'migration-history': ({ root }) => {
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'not an app root' }

    const dockerfile = ['Dockerfile', join('deploy', 'Dockerfile')]
      .map(p => join(root, p)).find(p => existsSync(p))
    if (!dockerfile) return { skipped: 'no Dockerfile — not deployed this way' }
    if (!/\bbun\s+run\s+db:migrate\b/.test(readFileSync(dockerfile, 'utf8')))
      return { skipped: 'the entrypoint does not replay migrations' }

    const dir = join(root, 'db', 'migrations')
    const files = existsSync(dir) ? walkSql(dir) : []
    if (files.length) return { findings: [] }

    return { findings: [{
      file: 'db/migrations/',
      message: 'the container runs `bun run db:migrate` and there is no migration to replay, so it will '
             + 'start over an empty database and fail on the first write. Write one: `fli db:migrate`',
    }] }
  },

  'surface-config': ({ root }) => {
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'not an app root' }

    const CONFIGS = {
      api:       ['junction.config.js', 'junction.config.ts'],
      web:       ['sierra.config.js', 'vite.config.js', 'sierra.config.ts', 'vite.config.ts'],
      widgets:   ['sierra.config.js', 'vite.config.js'],
      site:      ['sierra.config.js', 'vite.config.js'],
      extension: ['jetty.config.js', 'vite.config.js'],
    }

    const findings = []
    let looked = 0

    for (const [surface, names] of Object.entries(CONFIGS)) {
      const dir = join(root, surface)
      if (!existsSync(dir)) continue
      // A surface with no source is a directory somebody made, not a surface.
      const hasSource = existsSync(join(dir, 'src')) ||
        readdirSync(dir).some(f => extname(f) === '.ts' || extname(f) === '.js')
      if (!hasSource) continue
      looked++

      const stray = names.filter(n => existsSync(join(dir, n)))

      if (existsSync(join(dir, 'config'))) {
        // The directory is there AND a config file sits beside it. Whichever
        // one the loader resolves, the other is read by nobody.
        if (stray.length) findings.push({
          file: join(dir, stray[0]),
          message: `${surface}/${stray[0]} sits beside ${surface}/config/. One of the two is read ` +
                   `and the other is not, and which depends on the loader — move it in.`,
        })
        continue
      }

      findings.push({
        file: stray.length ? join(dir, stray[0]) : dir,
        message: stray.length
          ? `${surface}/${stray[0]} sits at the surface root; configuration lives in ` +
            `${surface}/config/. Loaders resolve the DIRECTORY, so a config file here is read by ` +
            `nothing and the surface boots on defaults looking configured.`
          : `${surface}/ has no config/. Configuration lives there (Invariant 3) and the ` +
            `framework looks there unprompted — junction's default is ${surface}/config/ — so an ` +
            `absent directory is not "this surface declares nothing", it is a path the loader ` +
            `resolves to nowhere. Nothing fails when it is missing, which is why this is a rule: ` +
            `basecamp read api/config for its whole life without that directory existing, and its ` +
            `CORS was '*' for everyone as a result.`,
      })
    }

    if (!looked) return { skipped: 'no surface with source in it' }
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
  // imported without binding a port — which is what `junction surface --app`
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
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'not an app root' }

    const SCRIPT = new Set(['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts'])
    // `index`, whatever the extension. Named rather than derived from a
    // manifest: a surface may be started by a runner this cannot see, and the
    // question here is where the file sits, not whether something runs it.
    const isEntry = f => basename(f, extname(f)) === 'index'
    // surface-config's own list, restated only to be EXCLUDED.
    const CONFIG  = /^(junction|sierra|vite|jetty)\.config\.[cm]?[jt]s$/

    const findings = []
    let looked = 0

    for (const surface of ['api', 'web', 'widgets', 'site', 'extension']) {
      const dir = join(root, surface)
      if (!existsSync(dir)) continue

      const rootScripts = readdirSync(dir).filter(f =>
        SCRIPT.has(extname(f)) && !CONFIG.test(f) && statSync(join(dir, f)).isFile())
      const hasSrc = existsSync(join(dir, 'src'))
      // A directory somebody made is not a surface yet.
      if (!hasSrc && !rootScripts.length) continue
      looked++

      // The whole surface is flat. The sharper of the two: nothing in it sits
      // where a generator, a doc or a drive resolves a path to.
      if (!hasSrc) {
        const shown = rootScripts.slice(0, 3).join(', ') + (rootScripts.length > 3 ? ', …' : '')
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

  // ─── the source hazards ──────────────────────────────────────────────────────
  //
  // The five below read a line of an app's own JavaScript rather than its place
  // in the tree. Same membership test, and each of them is silent for one
  // reason: the wrong spelling is a LEGAL spelling of something else, so nothing
  // downstream has anything to object to. Text, never an AST — `fli check` runs
  // on node with no build, and a parser here would be a second one to keep in
  // step with the compiler this repo already ships.

  // `:id` registers as a LITERAL segment. The route then matches the path
  // `/orders/:id` as typed and nothing else, so every real request 404s forever
  // and no line of code is wrong enough to raise anything. Express and Feathers
  // both spell it this way, which is where it arrives from.
  'raw-route-param': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const ROUTE = /\bapp(?:\.http\.router)?\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`\n]*)\2/g
    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(ROUTE)) {
        if (!/(^|\/):[A-Za-z_]/.test(m[3])) continue
        // The path literal alone — the quotes stay, so a template literal or a
        // double-quoted path is rewritten in the spelling it was written in.
        const start = m.index + m[0].length - 1 - m[3].length
        findings.push({
          file: path, line: lineOf(code, m.index),
          edit: { start, end: start + m[3].length, was: m[3],
                  replacement: m[3].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}') },
          message: `${m[1].toUpperCase()} ${m[3]} — a raw route's capture is written {id}: ` +
                   `'${m[3].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}'. A :name segment is matched ` +
                   `literally, so this route answers the path exactly as typed and 404s on every real ` +
                   `request. Nothing objects at registration or at match time.`,
        })
      }
    }
    return { findings }
  },

  // There is no `ctx.params` in Junction. A ServiceContext splits into `auth`
  // (the principal), `client`, `route` (path captures) and `locals` (per-call
  // scratch) — so `ctx.params.user` is undefined and a role check written
  // against it admits everyone. The name is Feathers's and survives in older
  // notes, which is exactly how it gets written a second time.
  'ctx-params': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bctx\.params\b/g)) findings.push({
        file: path, line: lineOf(code, m.index),
        message: `ctx.params does not exist. A ServiceContext is auth (the principal — frozen, and it ` +
                 `propagates), client (ip, userAgent, headers), route (path captures alone) and locals ` +
                 `(per-call scratch, where the scoped db is). This reads undefined, so a check written ` +
                 `on it passes for every caller.`,
      })
    }
    return { findings }
  },

  // `$setAuth(user)` ANSWERS a scoped client; it does not mutate the one it was
  // called on. Called as a statement it scopes nothing, the next write goes
  // through the root client as anonymous, and every row policy compares against
  // a null principal — a read that matches nothing and a write that belongs to
  // nobody, neither of which raises.
  //
  // Only a whole statement is judged. `const scoped = db.$setAuth(u)` and
  // `db.$setAuth(u).order.create(…)` both keep the answer, and a call spanning
  // two lines is left alone rather than guessed at.
  'set-auth-discarded': ({ root }) => {
    const files = scripts(root, 'api', 'db', 'web', 'widgets', 'site', 'extension')
    if (!files.length) return { skipped: 'no source' }

    const findings = []
    for (const path of files) {
      const lines = readCode(path).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const at   = line.indexOf('.$setAuth(')
        if (at < 0) continue

        let depth = 0, end = -1
        for (let j = at; j < line.length; j++) {
          if (line[j] === '(') depth++
          else if (line[j] === ')' && --depth === 0) { end = j; break }
        }
        if (end < 0) continue                                        // spans lines — not judged
        if (line.slice(end + 1).replace(/[;\s]/g, '')) continue       // the answer is used

        const before = line.slice(0, at).trim().replace(/^await\s+/, '')
        if (!/^[A-Za-z_$][\w$.\[\]'"]*$/.test(before)) continue       // an argument, not a statement

        findings.push({
          file: path, line: i + 1,
          message: `the scoped client is discarded. $setAuth ANSWERS a client and mutates nothing, so ` +
                   `the writes after this line go through the unscoped one as anonymous: every row ` +
                   `policy compares against a null principal, which matches no rows and raises nothing. ` +
                   `const scoped = ${before}.$setAuth(…)`,
        })
      }
    }
    return { findings }
  },

  // A header the caller varies per call must be declared, or it works until the
  // socket connects. Over HTTP it is an ordinary header; a WebSocket frame has
  // no headers of its own, so the value rides meta.headers and the server merges
  // only the names the app DECLARED — undeclared, it is simply absent, and
  // whatever reads it sees nothing: an empty list with a 200, or a 404 on every
  // call. The same declaration is what gets it past a cross-origin preflight.
  //
  // Cross-surface, which is why nothing else can see it: both halves are correct
  // in the file they are written in.
  'call-header-declared': ({ root }) => {
    if (!existsSync(join(root, 'api'))) return { skipped: 'no api/ surface — the server is elsewhere' }
    const client = scripts(root, 'web', 'widgets', 'site', 'extension')
    if (!client.length) return { skipped: 'no client surface' }
    const api = scripts(root, 'api')

    // Neither half is written as a literal in a real app — both sides name a
    // shared constant — so a rule reading literals alone reads nothing. A name
    // holding two different values in one app resolves to nothing: a wrong
    // answer here is worse than no answer.
    const consts = new Map()
    for (const path of [...api, ...client]) {
      for (const m of readCode(path).matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g)) {
        if (consts.has(m[1]) && consts.get(m[1]) !== m[3]) consts.set(m[1], null)
        else if (!consts.has(m[1]))                        consts.set(m[1], m[3])
      }
    }
    const valueOf = (token) => {
      const t   = token.trim()
      const lit = t.match(/^(['"`])([^'"`]*)\1$/)
      return lit ? lit[2] : (consts.get(t) ?? null)
    }

    const declared = new Set()
    let opaque = null
    for (const path of api) {
      for (const m of readCode(path).matchAll(/callHeaders\s*:\s*\[([^\]]*)\]/g)) {
        for (const token of m[1].split(',').map(t => t.trim()).filter(Boolean)) {
          const value = valueOf(token)
          if (value === null) opaque ??= token
          else declared.add(value.toLowerCase())
        }
      }
    }
    // A declaration this rule cannot read is not an absent declaration.
    if (opaque) return { skipped: `http.callHeaders names ${opaque}, which this rule cannot resolve to a string` }

    const findings = []
    for (const path of client) {
      const code = readCode(path)
      for (const m of code.matchAll(/\.setCallHeader\s*\(\s*([^,)]+)/g)) {
        const name = valueOf(m[1])
        if (name === null || declared.has(name.toLowerCase())) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `'${name}' is set per call and is not in the API's http.callHeaders. Over HTTP it is ` +
                   `an ordinary header and this works; a WebSocket frame carries none of its own, so the ` +
                   `server merges only declared names and the header is absent the moment the socket ` +
                   `connects — an empty list with a 200, or a 404, depending on what reads it. Declare ` +
                   `it: http: { callHeaders: ['${name}'] }.`,
        })
      }
    }
    return { findings }
  },

  // Invariant 2, at the seam it was written for. A service resolves its model by
  // NAME — the literal spelling, then the singular of it — and a miss is not an
  // error: getTable throws, but the two that grade the caller fail OPEN. No
  // @@gate is found, so a gated model is served to anyone; no schema is found,
  // so autoValidate validates nothing.
  //
  // The derivation is `singularize` from @frontierjs/toolbelt/inflect, the same
  // module litestone derives a table name with, run the other way — so an
  // irregular resolves and a HYPHENATED name never can: db.<accessor> is the
  // model name with a lower first letter, and 'product-variant' is not
  // 'productVariant'. Such a service states its model, and this rule is how it
  // finds out it has to.
  //
  // A service with no `model:` and no CRUD base is judged on nothing: a service
  // over no model is a whole kind of service — a hub, a webhook receiver — and
  // not a fault.
  'service-model': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    const files = scripts(root, 'api').filter(p => /\.service\.[cm]?[jt]s$/.test(basename(p)))
    if (!files.length) return { skipped: 'no *.service.* under api/' }

    const { resolves, pascalOf, modelNamed } = modelResolver(schema)

    const findings = []
    for (const path of files) {
      const code    = readCode(path)
      const service = basename(path).replace(/\.service\.[cm]?[jt]s$/, '')
      const stated  = code.match(/\bmodel\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/)

      if (stated) {
        if (resolves(stated[1])) continue
        findings.push({
          file: path, line: lineOf(code, stated.index),
          message: `model: '${stated[1]}' names no model in db/schema.lite. The lookup misses rather ` +
                   `than throws and the two things that grade a caller fail open: no @@gate is found, ` +
                   `so a gated model is served to anyone, and no schema is found, so autoValidate ` +
                   `validates nothing.`,
        })
        continue
      }

      if (!/\bcreateBaseService\b/.test(code)) continue
      if (resolves(service)) continue

      // Name the model if the schema has one under that spelling — a rule that
      // says which line to write beats one that says the line is missing.
      const meant = modelNamed(pascalOf(service))

      // The CALL, which is not the first mention: `import { createBaseService }`
      // is one, and searching forward from it lands on the `(` of the arrow
      // function beside it — so the options object came out after the paren
      // that had already closed, and there was no fix and a line number
      // pointing at the import.
      const call  = code.match(/\bcreateBaseService\s*\(/)
      const paren = call ? call.index + call[0].length - 1 : -1
      const close = paren === -1 ? -1 : closingParen(code, paren)
      const brace = paren === -1 ? -1 : code.indexOf('{', paren)
      const edit  = meant && brace !== -1 && close !== -1 && brace < close
        ? optionsInsert(code, brace, `model: '${meant}'`)
        : null

      findings.push({
        file: path, line: lineOf(code, call ? call.index : 0),
        ...(edit ? { edit } : {}),
        message: `createBaseService with no model:, and '${service}' resolves to none — it singularises ` +
                 `to '${singularize(service)}', while db.<accessor> is the model name with a lower first ` +
                 `letter, so a hyphenated name never meets it. The miss is silent and fails open: the ` +
                 `@@gate is not found and the model is served to anyone. State it — ` +
                 (meant ? `model: '${meant}'.` : `model: '<Model>', naming one in db/schema.lite.`),
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
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], 'web', 'widgets', 'site', 'extension')
    if (!files.length) return { skipped: 'no client surface' }

    const { resolves, pascalOf, modelNamed } = modelResolver(schema)
    const findings = []

    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bcreateResource\s*\(\s*(['"`])([A-Za-z0-9_-]+)\1/g)) {
        const service = m[2]
        // The whole call, so a `model:` stated in the options is seen.
        const call = spanFrom(code, code.indexOf('(', m.index))
        if (/\bmodel\s*:\s*['"`]/.test(call)) continue
        if (resolves(service)) continue

        const meant = modelNamed(pascalOf(service))
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
  // assigns `ctx.locals.db` — `$.db` is the same client, resolved off the call
  // in progress — and the module one is the root: `auth()` is null, so every row
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
  'detail-read-dead': ({ root }) => {
    const files = sources(root, ['.mesa', ...SCRIPT_EXT], 'web', 'widgets', 'site', 'extension')
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
        if (!kept) continue
        const assign = [null, kept]

        findings.push({
          file: path, line: i + 1,
          message: `\`${assign[1]}\` keeps a row that nothing can update. \`service.get()\` is the raw ` +
                   `proxy and answers a plain object, so a write from another tab, a job or a webhook ` +
                   `reaches the store and never this variable — the screen is stale with nothing said. ` +
                   `Watch it instead: \`const row = ${res}.record(id)\`, \`row.subscribe(v => ${assign[1]} = v)\`, ` +
                   `and release it when the screen goes. ` +
                   `**Only where the detail row IS the row.** A store node holds one shape and a push ` +
                   `REPLACES it, so if this service's \`get()\` composes children the list read does not ` +
                   `carry — \`include:\`, a \`withWidgets()\`, an adapter ping — watching it drops them at ` +
                   `the first announcement, silently. Four of basecamp's five composed reads did exactly ` +
                   `that when this was adopted. There the reload-on-push those screens already hand-roll ` +
                   `is the correct answer, and it is a fair exception; so is a row nothing will write ` +
                   `again. Record either as one.`,
        })
      }
    }

    return looked ? { findings } : { findings, skipped: 'no service.get() on a client surface' }
  },

  'service-module-db': ({ root }) => {
    const files = scripts(root, 'api').filter(p => /\.service\.[cm]?[jt]s$/.test(basename(p)))
    if (!files.length) return { skipped: 'no *.service.* under api/' }

    // Only where `db` is an IMPORT. `const db = ctx.locals.db` is the correct
    // shape and cannot coexist with an imported binding of that name — that is
    // a duplicate declaration — so the import is the whole test.
    const IMPORTS_DB = /import\s+(?:db\s+,?\s*(?:{[^}]*})?\s+from|{[^}]*?(?<![\w])db\s*(?:,[^}]*)?}\s*from)/
    const USES_DB    = /(?<![\w.$])db\.[a-z][A-Za-z0-9_]*\./g

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      if (!IMPORTS_DB.test(code)) continue
      if (/\bdb\s+as\s+\w/.test(code)) continue          // renamed on import — not this binding

      const seen = new Set()
      for (const m of code.matchAll(USES_DB)) {
        const line = lineOf(code, m.index)
        if (seen.has(line)) continue
        seen.add(line)
        findings.push({
          file: path, line,
          message: `${m[0]}… reads the module client, which carries no principal. The request-scoped one ` +
                   `is ${'`$.db`'} (or ctx.locals.db): through this one auth() is null, so every row policy ` +
                   `matches nothing — an empty list with a 200 — and a write belongs to nobody in the ` +
                   `audit trail. asSystem() is the deliberate bypass and is not this.`,
        })
      }
    }
    return { findings }
  },

  // `FJS-519`: `asSystem()` means no PERMISSION rules. It does not mean no
  // scope — it keeps row tenancy — but it can only keep a tenant that is in
  // scope, and the claim comes from the principal. So which client you elevate
  // decides whether the result is scoped at all:
  //
  //   ctx.locals.db.asSystem()   the caller's tenant, gate and policies crossed
  //   app.data.asSystem()        no principal, no claim, every tenant
  //
  // The app-level client cannot be named positively — it is `app.claim(<any
  // name>, db)`, and basecamp calls it `app.data` — so the test runs the other
  // way: a receiver that is not the request's client. That is also where the
  // fix is.
  //
  // A WARNING and not an error, because the unscoped client is exactly right
  // for a cross-tenant admin tier. What is wrong is reaching for it by habit
  // inside a request, where the symptom is silent: rows from every tenant with
  // a 200.
  'service-as-system': ({ root }) => {
    // Only under `strategy row`. With no tenancy block there is no claim to
    // lose, and under `strategy database` one client IS one file, so a system
    // context physically cannot reach a second tenant — the hazard does not
    // exist and every finding would be noise. `example` is that case.
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    // Comments blanked first. basecamp's own schema explains the feature in a
    // doc comment — *declared once in the `tenancy { }` block below* — and a
    // raw match reads that empty pair as the declaration and skips the app.
    const block = readCode(schema.path).match(/\btenancy\s*\{[^}]*\}/s)
    if (!block)                            return { skipped: 'no tenancy block — nothing to scope' }
    if (!/\bstrategy\s+row\b/.test(block[0])) return { skipped: 'strategy database — one client is one tenant' }

    // Everything under `services/`, not just `*.service.*`. A helper module
    // beside a service runs in the same call scope and carries the identical
    // hazard — basecamp's `api-keys/scopes.ts` reaches for the app client from
    // inside a hook — so a filename filter made two real sites invisible. The
    // directory is the principled boundary: a job handler lives in `jobs/`,
    // is NOT inside a call, and is where the app client is the right reach.
    const files = scripts(root, 'api').filter(p => /[/\\]services[/\\]/.test(p))
    if (!files.length) return { skipped: 'no api/**/services/** source' }

    const REQUEST = /^(?:ctx\.locals\.db|\$\.db)$/
    const BOUND   = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ctx\.locals\.db|\$\.db)\b/g

    // The receiver of a `.asSystem()`, read backwards so a cast survives:
    // `(app.data as any).asSystem()` is the spelling three of basecamp's use.
    const receiverAt = (code, dot) => {
      let i = dot - 1
      while (i >= 0 && /\s/.test(code[i])) i--
      if (code[i] === ')') {
        let depth = 1
        i--
        while (i >= 0 && depth) {
          if (code[i] === ')') depth++
          else if (code[i] === '(') depth--
          i--
        }
        return code.slice(i + 2, dot).replace(/\)\s*$/, '').replace(/\s+as\s+[\w<>\[\]|]+\s*$/, '').trim()
      }
      let j = i
      while (j >= 0 && /[\w$.]/.test(code[j])) j--
      return code.slice(j + 1, dot).trim()
    }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      if (!code.includes('.asSystem')) continue

      // Names this file binds to the request's client — `const db = ctx.locals.db`.
      const local = new Set()
      for (const m of code.matchAll(BOUND)) local.add(m[1])

      const seen = new Set()
      for (const m of code.matchAll(/\.asSystem\s*\(/g)) {
        const recv = receiverAt(code, m.index)
        if (!recv) continue
        if (REQUEST.test(recv) || local.has(recv)) continue

        const line = lineOf(code, m.index)
        if (seen.has(line)) continue
        seen.add(line)
        findings.push({
          file: path, line,
          message: `${recv}.asSystem() elevates a client that carries no principal, so it carries no ` +
                   `tenant claim either — under row tenancy it reads and writes EVERY tenant, with a 200. ` +
                   `The request's own client is the one to elevate: ctx.locals.db.asSystem() (or $.db), ` +
                   `which crosses the gate and every policy and stays in the caller's tenant. If crossing ` +
                   `tenants is what you mean — a hub or admin tier — this is correct and this warning is ` +
                   `the place to say so.`,
        })
      }
    }
    return { findings }
  },

  // `FJS-D36`: caravan owns the clock. `app.scheduler` is a bare in-process
  // timer — no persistence, no retry, no principal, gone with the process — so
  // firing a queue dispatch from one buys the clock with none of the queue's
  // durability while looking like it has it, and it runs in EVERY replica, so
  // two processes do the work twice. `app.jobs.schedule(name, expr, fn)` is the
  // same line with caravan's clock under it: a cron fire is dispatched under
  // `cron:<job>:<minute>`, so the second replica's fire is a no-op.
  'scheduler-dispatch': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bapp\.scheduler\.([A-Za-z]+)\s*\(/g)) {
        const call = spanFrom(code, m.index + m[0].length - 1)
        const hit  = call.match(/\bdispatch\s*\(/)
        if (!hit) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `app.scheduler.${m[1]}() dispatches into the queue. That is the queue's schedule and ` +
                   `belongs to it — app.jobs.schedule(name, expr, fn) — because this timer has no ` +
                   `persistence, no retry and no principal, and it runs in every replica, so two ` +
                   `processes queue the same work twice. Caravan's clock fires under ` +
                   `cron:<job>:<minute>, where the second fire is a no-op.`,
        })
      }
    }
    return { findings }
  },

  // A level nothing in this app can reach. The shipped resolver grades standing
  // from `isAdmin` / `isOwner` / `isSystemAdmin` and **never interprets a role
  // string** — 'admin' means whatever an app decides it means, and guessing
  // would hand out level 5 on a string match — so a schema declaring
  // ADMINISTRATOR(5) or above, with none of those columns and no getLevel of its
  // own, has declared an operation nobody but asSystem() can perform.
  //
  // It is not a fail-open, which is why it is a warning: the app is more closed
  // than it meant to be, and the symptom is a 403 that reads as *this caller is
  // not an admin yet* rather than as *no caller ever will be*.
  //
  // 8 and 9 are excluded by name. `8` means nothing outside asSystem() has
  // anything to say to this model and `9` is locked; both are deliberate, and
  // the identity models ship that way.
  // A model that declares the grid AND grades writes by ladder. The two are
  // ANDed with the gate as the floor (`FJS-D146`), which is what keeps standing
  // that crosses tenants available — but a write level ABOVE the read level is
  // the ladder answering the question the grid was declared to answer, and both
  // have to pass, so the ladder silently narrows every grant.
  //
  // The shape it catches is a model moved onto capabilities with its old gate
  // left in place: a billing clerk holding `Invoice.create` is refused because
  // the clerk grades USER(4) and creates want ADMINISTRATOR(5) — a 403 that
  // reads as *not senior enough* about a person who was deliberately granted the
  // capability. `@@gate("2")` flat at the read floor is the usual answer.
  //
  // A warning rather than an error: two authorities in front of one operation is
  // legitimate where the ladder is guarding something the grid does not model,
  // and this cannot tell that from a leftover.
  'capability-ladder': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const models = capabilityModels(schema)
    if (!models.length) return { skipped: 'no model declares @@capabilities' }

    const findings = []
    for (const m of models) {
      if (!m.gate) continue
      const above = ['create', 'update', 'delete'].filter(op => m.gate[op] > m.gate.read)
      if (!above.length) continue
      findings.push({
        file: schema.path, line: m.gateLine,
        message: `${m.name} declares @@capabilities and @@gate("${m.gateSource}") — ` +
                 `${above.join(', ')} need${above.length > 1 ? '' : 's'} level ` +
                 `${above.map(o => m.gate[o]).join('/')} where read needs ${m.gate.read}. The grid and ` +
                 `the ladder are ANDed, so a caller granted a capability on this model is still refused ` +
                 `unless they also climb — which is the ladder answering what the grid was declared to ` +
                 `answer. A model graded by capability usually wants its gate flat at the read floor.`,
      })
    }
    return { findings }
  },

  'gate-unreachable': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const gates = declaredGates(schema).filter(g => g.level >= 5 && g.level <= 7)
    if (!gates.length) return { skipped: 'no @@gate above USER(4)' }

    // A resolver of the app's own answers everything below.
    const api = scripts(root, 'api')
    if (api.some(p => /\bgetLevel\b/.test(readCode(p)))) return { findings: [] }
    if (!api.length) return { skipped: 'no api/ source — the resolver is elsewhere' }

    // The three columns the shipped resolver reads. Declared anywhere in the
    // seed is enough: this rule cannot see which model the session is built
    // from, and reporting an app that has them would be the wolf-crying case.
    if (/^\s*(isAdmin|isOwner|isSystemAdmin)\s+Boolean/m.test(schema.text)) return { findings: [] }

    const worst = gates.reduce((a, b) => (a.level >= b.level ? a : b))
    return { findings: [{
      file: schema.path, line: worst.line,
      message: `${worst.what} requires level ${worst.level}, and nothing in this app can grade a caller ` +
               `above 4. The shipped resolver reads isAdmin / isOwner / isSystemAdmin — none of which this ` +
               `schema declares — and it never interprets a role STRING, because 'admin' means whatever an ` +
               `app decides it means. ${gates.length > 1 ? `${gates.length} declarations are above 4. ` : ''}` +
               `Either add the column, or install your own: ` +
               `GatePlugin({ getLevel: (u) => u?.role === 'admin' ? 5 : sessionGateLevel(u) }).`,
    }] }
  },

  // ─── the build-time half, as far as text can reach it ────────────────────────
  //
  // A prerendered page is public: whatever is in it is served to anyone, CDN
  // cached and indexed, and cannot be recalled. Sierra proves each one at BUILD
  // time — reads are tapped around the route's companion and graded against
  // `@@gate`, fail-closed — and no text rule can replace that, because the
  // question is what a `load()` actually read.
  //
  // What text CAN see is whether that proof is switched on, and the two rules
  // below are the two ways it silently is not. Both were measured by running
  // `checkRoute` rather than read off the source.

  // The tap needs a Litestone client, which the app hands the build as `db` in
  // its Sierra config. Without one, every route with a companion is refused
  // until it declares `publishes:` — and the message the build prints tells the
  // author to write `publishes: 0`. Do that per route and the build goes green
  // having proved nothing at all, permanently, with no line anywhere saying so.
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
                 `nothing, so every route with a companion is refused until it declares publishes: — and ` +
                 `a page that declares it is a page the check has stopped proving. Point db: at the app's ` +
                 `own client (db: '../api/src/core/db.ts').`,
      })
    }
    return { findings }
  },

  // `publishes: N` is the level a page says it may publish at, and the default
  // is 0. So declaring 0 raises nothing — measured by running `checkRoute` both
  // ways, it changes exactly two outcomes, and both are refusals becoming
  // passes: a route the build could not OBSERVE, and a route that read a name
  // the schema does not describe. Those are the two fail-closed branches.
  //
  // A warning rather than an error, and not because it is minor: the line may
  // be exactly what its author meant. It is here because it is the one
  // declaration that reads like a bar and works like an off switch, and the
  // build's own message recommends writing it.
  'static-publishes-0': ({ root }) => {
    const surfaces = staticSurfaces(root)
    if (!surfaces.length) return { skipped: 'no target: static surface' }

    // A page's OWN frontmatter and nowhere else — that is where the build reads
    // it (`r.meta.publishes`), so a `publishes` exported from a companion is a
    // variable named after a key nothing consults, and reporting it would be
    // this rule inventing a mechanism.
    const findings = []
    for (const s of surfaces) {
      for (const file of sources(root, ['.mesa'], relative(root, s.routes))) {
        const fm = frontmatter(file)
        if (!fm.block) continue
        const m = fm.block.match(/(^|\n)\s*publishes\s*:\s*['"]?0['"]?\s*(#.*)?(\n|$)/)
        if (!m) continue
        // The keyword, not the newline the match opens on, or the line reported
        // is the one above it.
        const at = fm.start + m.index + m[0].indexOf('publishes')
        findings.push({
          file, line: lineOf(fm.text, at),
          message: `publishes: 0 is the default bar, so this line raises nothing — what it does is turn ` +
                   `off the two refusals that fail closed: a route the build could not observe, and a ` +
                   `read of a name the schema does not describe. If this page is genuinely public, ` +
                   `deleting the line says so and keeps the proof; if it is here to get a build green, ` +
                   `the build was telling you it could not see what this page reads.`,
        })
      }
    }
    return { findings }
  },

  // A test file no script names is a test that never runs, and it is silent in
  // the worst way: the suite is green, the count goes up as files are added, and
  // the one file nobody listed is the one written last — which is the one
  // written for the defect just fixed. Measured here first: `packages/cli`'s own
  // `tests/pipe.test.js` pins `FJS-379` and had never been run by `bun run test`.
  //
  // Only where the script HAND-LISTS files. `bun test` and `vitest run` discover
  // their own, and a package that lets its runner walk the directory cannot have
  // this problem — which is the argument for the shape, not for the rule.
  //
  // Every `test*` script counts, not just `test`: a file run by `test:browser`
  // is a file something runs, and grading against one script would report it as
  // orphaned. And only `*.test.*` — a harness beside the tests (a stub, a
  // client) is support code and is named by whatever imports it.
  'test-files-run': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const findings = []
    let looked = 0

    for (const dir of pkgs) {
      let pkg
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }

      // `:watch` is a dev affordance rather than the suite, and it is invariably
      // the bare runner — reading it would make every package look discovering.
      const bodies = Object.entries(pkg.scripts ?? {})
        .filter(([name]) => /^test(:|$)/.test(name) && !name.endsWith(':watch'))
        .map(([, body]) => body)

      // A runner walking a directory cannot forget a file, so the package has
      // nothing this rule can say. `bun test` counts as walking unless the
      // command names a file — `bun test test/` is a directory.
      const DISCOVERS = [/\bvitest\b/, /\bjest\b/, /\bnode\s+--test\b/]
      const segments  = bodies.join(' && ').split(/&&|;/)
      const walking   = segments.some(seg =>
        DISCOVERS.some(re => re.test(seg)) ||
        (/\bbun\s+test\b/.test(seg) && !/[\w.-]+\.[cm]?[jt]s\b/.test(seg)))
      if (walking) continue

      const listed = new Set([...bodies.join(' ').matchAll(/(?:\.\/)?(tests?)\/([\w.-]+\.[cm]?[jt]sx?)\b/g)]
        .map(m => `${m[1]}/${m[2]}`))
      // Fewer than two named files is a script this rule has no business reading.
      if (listed.size < 2) continue
      looked++

      const dirs = [...new Set([...listed].map(f => f.split('/')[0]))]
      // Two shapes of unrun file, and the second one needed a second signal.
      //
      // A `*.test.*` the script does not name is an unrun test, full stop.
      //
      // Anything ELSE in that directory is usually support code, and the thing
      // that tells support code apart from a dead harness is not its extension
      // — it is that support code is IMPORTED. jetty's HMR coverage was two
      // `.mjs` harnesses in `test/` that no script ran, that nothing imported,
      // and that could not have run at all: they resolved mesa by an absolute
      // path from another machine. They were the only cover for the seam
      // `FJS-481` broke, and ~450 green tests said nothing. Requiring BOTH — no
      // runner and no importer — is what separates them from a stub a test
      // pulls in.
      const RUNNABLE = /\.[cm]?[jt]sx?$/
      const bodiesOf = (d) => {
        const out = new Map()
        for (const name of safeRead(join(dir, d))) {
          if (!RUNNABLE.test(name)) continue
          try { out.set(name, readFileSync(join(dir, d, name), 'utf8')) } catch {}
        }
        return out
      }
      const orphans = []
      for (const d of dirs) {
        const files = bodiesOf(d)
        for (const [name] of files) {
          if (listed.has(`${d}/${name}`)) continue
          const isTest = /\.test\.[cm]?[jt]sx?$/.test(name)
          if (!isTest) {
            const stem = name.replace(RUNNABLE, '')
            // Imported by anything else in the directory → support code.
            const imported = [...files].some(([other, body]) =>
              other !== name && new RegExp(String.raw`['"\./]${stem}(\.[cm]?[jt]sx?)?['"]`).test(body))
            if (imported) continue
          }
          orphans.push(`${d}/${name}`)
        }
      }
      if (!orphans.length) continue

      findings.push({
        file: join(dir, 'package.json'),
        message: `${orphans.length} test file(s) that no script runs — ${orphans.join(', ')}. The script ` +
                 `names its files one at a time, so a file added later is simply never run: the suite is ` +
                 `green, the count rises, and the file nobody listed is the one written last — which is ` +
                 `the one written for the defect just fixed. Add them, or let the runner walk the ` +
                 `directory.`,
      })
    }

    if (!looked) return { skipped: 'no package hand-lists its test files' }
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
  //
  // The rule reports the CEILING and the FLOOR, and only the ceiling needs that
  // judgement. A file that is missing needs none: the four are named in the
  // invariant, so an absent one is decidable from the listing. Reporting only
  // what was NOT in `allowed` could catch a fifth file and could never catch a
  // missing fourth, which left seven packages short a standard file with the
  // check green over all of them.
  // A model a package SHIPS, declared here as well.
  //
  // Two ways a package's `.lite` reaches an app and they are not the same: some
  // files are IMPORTED, and some are appended into the app's own schema to be
  // extended — `@frontierjs/auth` ships one of each, because `User` is the model
  // an app grows columns on and `Credential` is not. So the presence of a copy
  // decides nothing, and a rule keyed on it would fire on every correct install.
  //
  // What is decidable is a column THE PACKAGE DECLARES that this copy declares
  // differently. Adding a column is what an app is for; adding `@@tenant(none)`
  // or a policy is the app's business too. Changing the package's own column is
  // the class that costs something, and it is silent by construction: the
  // package's code goes on writing to a column whose declaration it no longer
  // recognises, and nothing anywhere compares a copy to its original.
  //
  // Measured: basecamp's copy of `Credential` had `@guarded(all)` where auth
  // writes `@secret` on the two OAuth token columns, so turning OAuth on there
  // would have stored every provider access and refresh token unencrypted. Its
  // 137 tests were green either side of the divergence (`FJS-483`).
  //
  // A WARNING, because a deviation can be right: basecamp declares `accountId`
  // as `String?` against auth's `Int?` and has to, since its `Account.id` is a
  // uuid. So both declarations are printed and the reader judges — the same
  // reasoning `model-name-plural` is a warning for. `check-baseline.json` is how
  // an app accepts the ones it has argued for.
  //
  // No parser and no installed litestone: a line scan over a file in
  // node_modules, like every other rule here.
  // ─── transition-methods ─────────────────────────────────────────────────
  //
  // A named move is written in two places that never meet: `@@transitions` in
  // the seed, and the code that makes the move. Both directions fail quietly.
  //
  // **A move nothing can reach** is the silent one. It is not an error — the
  // machine is still enforced — it is a declaration nobody drives, which reads
  // exactly like a feature somebody has not got round to. Its first run found
  // three: basecamp's `Deployment` declares `push -> pushing`,
  // `release -> deploying` and `rollback -> rolled_back @gate(5)`, and the
  // pipeline goes pending → building → success. All three states appear in the
  // UI's tone maps, so three screens render a colour for a state that cannot
  // occur, and one of them carries an authority level for a move nothing makes.
  //
  // **A move that is not declared** throws `TransitionNotFoundError` (400) the
  // first time a caller asks for it — a named error, found by a user rather
  // than by a build.
  //
  // ── Reachable means EITHER spelling, and that is the whole of the accuracy ──
  //
  // `db.order.transition(id, 'cancel')` names the move; `update({ data: {
  // status: 'cancelled' } })` makes the same move by naming its target, and
  // litestone enforces the machine on both. A rule asking only for the move
  // name reports eleven of basecamp's nineteen and is wrong about all but three
  // — measured, which is why it asks for either.
  //
  // The whole of `api/` is searched rather than the model's own service: a job
  // driving a pipeline is the ordinary case, and `deploy-run.job.ts` is where
  // `Deployment`'s machine actually moves. Comments are blanked first, so a
  // move named only in a comment about it does not count as driving it.
  'transition-methods': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const moves = declaredMoves(schema)
    if (!moves.length) return { skipped: 'no @@transitions in db/schema.lite' }

    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source — the machine is driven elsewhere' }

    const code     = files.map(p => readCode(p))
    const all      = code.join('\n')
    const literal  = (word) => new RegExp(`['"\`]${word}['"\`]`).test(all)
    const findings = []

    for (const m of moves) {
      if (literal(m.move) || literal(m.to)) continue
      const gate = m.gate ? ` @gate(${m.gate})` : ''
      findings.push({
        file: schema.path, line: m.line,
        message: `${m.model}.${m.move} -> ${m.to}${gate} is declared and nothing under api/ names either ` +
                 `the move or the state it moves to, so no caller can reach it. A declared move nobody ` +
                 `drives is not an error — the machine is still enforced — it reads as a feature nobody ` +
                 `got round to, and a screen rendering '${m.to}' is rendering a state that cannot occur.`,
      })
    }

    // The other direction: a literal handed to transition() that the seed does
    // not declare. Matched on the CALL rather than on any string, because a
    // service naming its methods after its moves would otherwise report every
    // one of them.
    const declared = new Set(moves.map(m => m.move))
    for (let i = 0; i < files.length; i++) {
      for (const call of code[i].matchAll(/\.transition\s*\(\s*[^,()]+,\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
        if (declared.has(call[1])) continue
        findings.push({
          file: files[i], line: lineOf(code[i], call.index),
          message: `transition(…, '${call[1]}') names no move any model declares in db/schema.lite. ` +
                   `Litestone resolves the name against @@transitions and throws TransitionNotFoundError ` +
                   `(400) — so this is a call that has never worked, found by whoever asks for it first. ` +
                   `Declared moves: ${[...declared].join(', ') || 'none'}.`,
        })
      }
    }

    return { findings }
  },

  'package-model-drift': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const shipped = shippedSchemas(root)
    if (!shipped.length) return { skipped: 'no dependency ships a .lite file' }

    const mine     = declaredColumns(schema.text)
    const findings = []

    for (const dep of shipped) {
      for (const [name, theirs] of declaredColumns(dep.text)) {
        const ours = mine.get(name)
        if (!ours) continue          // imported, or this app does not use it

        for (const [column, declared] of theirs.columns) {
          const here = ours.columns.get(column)
          if (here === declared) continue

          findings.push({
            file: schema.path,
            line: ours.columnLines.get(column) ?? ours.line,
            message: here === undefined
              ? `model ${name} is a copy of ${dep.pkg}'s and is missing its column '${column}' ` +
                `(${declared}). That package's own code still writes to it. Import the model ` +
                `instead and add what is yours with \`extend model\`.`
              : `model ${name} is a copy of ${dep.pkg}'s and declares '${column}' differently — ` +
                `the package says \`${declared}\`, this says \`${here}\`. If the deviation is ` +
                `deliberate, say so here and baseline this rule; if it is drift, it is silent ` +
                `until that package's code meets the column.`,
          })
        }
      }
    }

    return { findings }
  },

  // Invariant 13. A `var(--x)` naming a token nothing defines is invalid at
  // computed-value time, so the WHOLE declaration is dropped — not the value,
  // the line. `gap: var(--space-4)` on a design system whose ladder is
  // `--space-2xl` is no gap at all, and there is no console message, no build
  // warning and no failing selector: the stylesheet is in the bundle and is
  // being ignored one declaration at a time. It cost this repo's own storefront
  // every border, gap and radius on the page while `verify:site` stayed green,
  // because a drive asserts what a page SAYS and none of this changes that.
  //
  // A `var()` carrying a FALLBACK is not a finding and that is the whole of
  // where the line sits: a fallback is an author saying the token may be absent,
  // and it is also what a component's own knob looks like from outside
  // (`var(--cp-accent, var(--color-primary))`). Only the bare form drops.
  //
  // The token table is read from the DEPENDENCIES rather than listed here —
  // whatever CSS this app installs is the answer, so an app on a design system
  // this file has never heard of is graded against its own.
  'css-token-undefined': ({ root }) => {
    const defined = shippedTokens(root)
    if (!defined.size) return { skipped: 'no dependency ships CSS' }

    const findings = []
    for (const surface of ['web', 'site', 'widgets', 'extension']) {
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

  'package-root-md': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const STANDARD = ['README.md', 'CLAUDE.md', 'PROJECT_STATE.md', 'CHANGES.md']
    const allowed  = new Set(STANDARD)

    // A `*.snapshot.md` is generated and gated, not documentation — nobody is
    // asked to hold it in their head, and it cannot move: CI reruns each
    // snapshot's generator from the file's own directory, and an app is built
    // with the cwd its own scripts use. `packages/basecamp` is a package and an
    // app at once, which is the only reason this crosses the rule at all.
    const generated = (name) => /\.snapshot\.md$/.test(name)

    const findings = []
    for (const dir of pkgs) {
      const entries = safeRead(dir)

      const extra = entries.filter(n => n.endsWith('.md') && !allowed.has(n) && !generated(n))
      if (extra.length) findings.push({
        file: dir,
        message: `${extra.length} markdown file(s) beyond the four at the package root — ${extra.join(', ')}. ` +
                 `README/CLAUDE/PROJECT_STATE/CHANGES is the standard, because the root is the index and ` +
                 `an index nobody can hold in their head is a directory listing. Does this one belong at ` +
                 `the root, or in docs/? Record the answer as an allowance either way.`,
      })

      // One finding per absent file, and the finding points AT that file rather
      // than at the directory: an allowance is keyed by path, so a package
      // excused for a fifth file at its root would otherwise be excused for
      // every missing one too.
      for (const name of STANDARD.filter(n => !entries.includes(n))) findings.push({
        file: join(dir, name),
        message: `${name} is missing from the package root. The four are what somebody picking this ` +
                 `package up cold reads in order — what it is (README), how to work in it (CLAUDE), ` +
                 `where it stands (PROJECT_STATE), what changed (CHANGES) — so an absent one is a ` +
                 `question with no answer rather than a shorter index. A package deliberately without ` +
                 `it is an allowance under "structure", same as a fifth file.`,
      })
    }
    return { findings }
  },
}

// ─── reading source ───────────────────────────────────────────────────────────

const SCRIPT_EXT = new Set(['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts'])

/** Every file of the given extensions under the named directories, in tree order. */
function sources(root, exts, ...dirs) {
  const want = exts instanceof Set ? exts : new Set(exts)
  const out  = []
  for (const dir of dirs) {
    walk(join(root, dir), 6, here => {
      for (const name of safeRead(here)) {
        if (!want.has(extname(name))) continue
        const full = join(here, name)
        try { if (statSync(full).isFile()) out.push(full) } catch { /* dangling link */ }
      }
    })
  }
  return out
}

/** Every script under the named directories of an app. */
function scripts(root, ...dirs) { return sources(root, SCRIPT_EXT, ...dirs) }

/**
 * The text from an opening paren to the one that closes it.
 *
 * Rules that ask *what is inside this call* need the whole call rather than the
 * line it started on: an options object, a scheduler's callback and a
 * createResource's `model:` are all routinely three lines below the name. An
 * unbalanced call answers what is left of the file rather than nothing, which
 * over-reports rather than under-reports — the safer direction for a rule whose
 * other answer is silence.
 */
function spanFrom(text, open) {
  const close = closingParen(text, open)
  return close === -1 ? '' : text.slice(open + 1, close)
}

/** The index of the `)` closing the `(` at `open`, or -1 — including unbalanced. */
function closingParen(text, open) {
  if (text[open] !== '(') return -1
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * The edit that adds one entry to an options object literal, written the way
 * the object already is.
 *
 * Three shapes and they are the three an app writes: `{}` takes the entry and
 * no comma, `{ a: 1 }` takes it first with one, and an object opened on its own
 * line takes a line of its own indented like its neighbour. The alternative —
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

/**
 * A file's source with its comments blanked — spaces, not deletions, so every
 * offset and line number stays where it was.
 *
 * Blanked rather than kept because most of what these rules look for is
 * DESCRIBED in a comment somewhere in this repo's own apps, in exactly the
 * words the rule matches. A check that fires on the paragraph explaining the
 * hazard is one people turn off.
 *
 * **Quote-aware, and that is not fussiness.** A regex sweep blanks from the
 * `//` in `'http://localhost:8010'` to the end of the line, so a `callHeaders:`
 * sitting after a CORS origin on one line disappears — and the rule that reads
 * it then reports a correctly-declared header as undeclared. Blanking too much
 * is how a source rule cries wolf, which costs more than the rule is worth.
 *
 * A scanner rather than a parser: it knows strings, template literals and the
 * two comment forms, and nothing else. Regex literals are not tracked — a `//`
 * cannot appear inside one (that is an empty regex, which no engine accepts) —
 * and an escaped quote is honoured, which is the only escape that matters here.
 */
function readCode(path) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return '' }

  const out = [...text]
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === c) { i++; break }
        i++
      }
      continue
    }

    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      blank(i, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const to  = end === -1 ? text.length : end + 2
      blank(i, to)
      i = to
      continue
    }

    i++
  }
  return out.join('')
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

// ─── a dependency's own schema ────────────────────────────────────────────────
//
// Which `.lite` files a package ships is asked of its `exports` map and of
// nothing else — never a guess at a path inside a package, which is the rule the
// litestone parser's own resolver follows. A package that exports none ships
// none as far as anything here is concerned.
// Every custom property the CSS this app INSTALLS declares.
//
// Read off the dependencies for `package-model-drift`'s reason: the answer is a
// property of what is installed, and a list written here goes stale the first
// time a package adds a rung. A package is included when its `exports` names a
// `.css` file; the whole of its shipped CSS is then read, because a bundle and
// the sources it was built from declare the same tokens and either may be the
// one an app links.
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

function shippedSchemas(root) {
  const out = []
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { return out }

  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  for (const name of deps) {
    const dir = join(root, 'node_modules', name)
    let manifest
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }

    for (const target of Object.values(manifest.exports ?? {})) {
      // Only the plain-string form. A conditional export ({ import, require })
      // is how JavaScript is published and is not how a schema fragment is.
      if (typeof target !== 'string' || !target.endsWith('.lite')) continue
      const file = join(dir, target)
      if (!existsSync(file)) continue
      out.push({ pkg: name, file, text: readFileSync(file, 'utf8') })
    }
  }
  return out
}

// model name → { line, columns: Map<name, everything after it>, columnLines }
//
// A line scan for the same reason `models()` is one. What a column's
// DECLARATION is, for comparison, is everything after the field name with runs
// of whitespace collapsed — so realigning a column of attributes is not a
// finding and adding one is. A `//` comment is cut, because a comment is not
// part of what the column means.
function declaredColumns(text) {
  const lines  = text.split('\n')
  const models = new Map()
  let current  = null
  let depth    = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    const open = raw.match(/^\s*model\s+([A-Za-z_]\w*)/)
    if (open && depth === 0) {
      current = { name: open[1], line: i + 1, columns: new Map(), columnLines: new Map() }
      models.set(open[1], current)
    }

    depth += (raw.match(/{/g) ?? []).length
    depth -= (raw.match(/}/g) ?? []).length
    if (!current) continue
    if (depth <= 0) { current = null; continue }

    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue

    // A field line is `name Type …`. A relation field is one too and is compared
    // like any other — a package that declares one means it.
    const field = trimmed.match(/^([a-zA-Z_]\w*)\s+(\S.*)$/)
    if (!field) continue

    const declaration = field[2].replace(/\s*\/\/.*$/, '').replace(/\s+/g, ' ').trim()
    current.columns.set(field[1], declaration)
    current.columnLines.set(field[1], i + 1)
  }

  return models
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

/**
 * Every `target: 'static'` surface in an app — its config, its routes directory.
 *
 * The surface is the config's grandparent (Invariant 3 puts configuration in
 * `config/`), falling back to its parent for an app that keeps it at the
 * surface root — which `surface-config` reports separately rather than this
 * rule failing to see the surface at all.
 */
function staticSurfaces(root) {
  const out = []
  walk(root, 4, dir => {
    for (const name of safeRead(dir)) {
      if (!/^sierra.*\.config\.[cm]?[jt]s$/.test(name)) continue
      const path   = join(dir, name)
      const config = readCode(path)
      if (!/target\s*:\s*['"`]static['"`]/.test(config)) continue

      const surface   = basename(dir) === 'config' ? join(dir, '..') : dir
      const routesDir = config.match(/routesDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? 'src/routes'
      out.push({ path, config, surface, routes: join(surface, routesDir) })
    }
  })
  return out
}

/**
 * A `.mesa` route's frontmatter block, with the whole file beside it.
 *
 * Both, because a finding needs a line number in the FILE and matching the file
 * would find the word in the markup below. `start` is where the block begins,
 * so an offset inside it can be reported against the file it came from.
 */
function frontmatter(path) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return { text: '', block: '', start: 0 } }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return { text, block: m ? m[1] : '', start: m ? m[0].indexOf(m[1]) : 0 }
}

// ─── the schema, as far as three rules need it ────────────────────────────────

/**
 * The one answer to *does this name reach a model*, shared by `service-model`
 * and `resource-model-miss` — the same question asked from the API realm and
 * from the UI realm, and two answers to it is how one of them starts grading an
 * app by a rule the app does not run.
 *
 * `db.<accessor>` is the model name with a lower first letter, so the singular
 * has to arrive in that spelling: `productVariants` reaches `ProductVariant`
 * and `product-variants` never can, which is exactly the case that has to be
 * stated rather than derived.
 */
function modelResolver(schema) {
  const known = new Map(models(schema).map(m => [m.name.toLowerCase(), m.name]))

  const resolves = (name) => {
    const clean = name.replace(/Service$/i, '')
    for (const candidate of [clean, singularize(clean.charAt(0).toLowerCase() + clean.slice(1))]) {
      const hit = known.get(candidate.toLowerCase())
      if (hit) return hit
    }
    return null
  }

  /** `product-variants` → `ProductVariant`: the model this name plainly MEANT. */
  const pascalOf = (name) => singularize(name).split(/[-_]/)
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join('')

  const modelNamed = (pascal) => known.get(pascal.toLowerCase()) ?? null

  return { resolves, pascalOf, modelNamed }
}

// The level scale, as the @@gate grammar spells it. Litestone owns the numbers;
// this is the reading of a declaration, not a second definition of the scale.
const GATE_LEVELS = {
  STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3, USER: 4,
  ADMINISTRATOR: 5, OWNER: 6, SYSADMIN: 7, SYSTEM: 8, LOCKED: 9,
}

/**
 * Every level a schema requires, in both spellings the grammar accepts —
 * `@@gate("0.4.4.5")` and `@@gate(read: READER, write: USER)` — plus the
 * `@gate(N)` a `@@transitions` clause hangs on one move.
 *
 * A line scan like `models()`, for its reason: this must answer with no
 * database, no migration and no installed litestone.
 */
// Models declaring `@@capabilities`, with the gate each one carries. A text scan
// like declaredGates beside it — `fli check` runs on an app's tree with no client
// built, so the schema is read as text rather than parsed.
function capabilityModels({ text }) {
  const out   = []
  const lines = text.split('\n')
  let current = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('//')) continue
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { current = { name: m[1], gate: null, gateSource: null, gateLine: 0, grid: false }; out.push(current); continue }
    if (!current) continue

    if (/@@capabilities\b/.test(line)) current.grid = true

    // BOTH spellings. Reading only the compact one would make this rule silent on
    // every schema that writes its gate by name — which is the shape `example`
    // and `basecamp` use, so the rule would have been dead where it matters most.
    const compact = line.match(/@@gate\s*\(\s*['"`]([\d.]+)['"`]\s*\)/)
    const named   = compact ? null : line.match(/@@gate\s*\(([^)]*[A-Za-z][^)]*)\)/)

    if (compact) {
      // "R.C.U.D" with inheritance: a position not stated takes the one before it.
      const [r = 0, c = r, u = c, d = u] = compact[1].split('.').map(Number)
      current.gate       = { read: r, create: c, update: u, delete: d }
      current.gateSource = compact[1]
      current.gateLine   = i + 1
    } else if (named) {
      const lvl = (t) => /^\d$/.test(t) ? Number(t) : (GATE_LEVELS[t.toUpperCase()] ?? null)
      const kv  = {}
      for (const m2 of named[1].matchAll(/\b(read|create|update|delete|write|all)\s*:\s*([A-Za-z0-9_]+)/g))
        kv[m2[1]] = lvl(m2[2])
      if (Object.values(kv).some(v => v != null)) {
        // `write:` is create+update+delete, `all:` is every position — the same
        // widening the parser gives them.
        const pick = (op) => kv[op] ?? (op === 'read' ? kv.all : (kv.write ?? kv.all)) ?? kv.all ?? 0
        current.gate       = { read: pick('read'), create: pick('create'), update: pick('update'), delete: pick('delete') }
        current.gateSource = named[1].trim()
        current.gateLine   = i + 1
      }
    }
  }
  return out.filter(m => m.grid)
}

function declaredGates({ text }) {
  const out   = []
  const lines = text.split('\n')
  let model   = null

  const level = (token) => {
    const t = token.trim().replace(/^['"`]|['"`]$/g, '')
    if (/^\d$/.test(t)) return Number(t)
    return GATE_LEVELS[t.toUpperCase()] ?? null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('//')) continue          // `///` is a doc comment and starts with it
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { model = m[1]; continue }

    const where = model ? `model ${model}'s` : 'a'

    for (const g of line.matchAll(/@@gate\s*\(([^)]*)\)/g)) {
      const body    = g[1]
      const compact = body.match(/^\s*['"`]([\d.]+)['"`]\s*$/)
      const levels  = compact
        ? compact[1].split('.').map(Number)
        : [...body.matchAll(/\b(?:read|create|update|delete|write)\s*:\s*([A-Za-z0-9_]+)/g)].map(k => level(k[1]))
      for (const n of levels)
        if (n != null && !Number.isNaN(n)) out.push({ level: n, line: i + 1, what: `${where} @@gate` })
    }

    // Single `@` — a transition's own gate, which is the only place a level
    // above the model's own appears in most schemas.
    for (const g of line.matchAll(/(?<!@)@gate\s*\(\s*(['"`]?[A-Za-z0-9_]+['"`]?)\s*\)/g)) {
      const n = level(g[1])
      if (n != null) out.push({ level: n, line: i + 1, what: `${where} transition @gate` })
    }
  }
  return out
}

/**
 * Every named move a schema declares — `{ model, move, to, gate, line }`.
 *
 * A line scan like `models()` and `declaredGates()`, for their reason: this must
 * answer with no database, no migration and no installed litestone.
 *
 * Two things about the grammar cost more than they look. **The clause list is
 * split on TOP-LEVEL commas**, because a from-list is itself comma-separated —
 * `cancel: [pending, paid] -> cancelled` is one clause, and splitting naively
 * loses the name and reports the target instead. And **the name is optional**:
 * `pending -> paid` names itself after the target state, which is the spelling
 * `db.<model>.transition(id, 'paid')` then has to use.
 *
 * The enum's own `transitions { }` block is NOT read. It desugars onto every
 * model using that enum, so resolving it means resolving field types — and no
 * schema in this repo uses it. A model whose machine arrives that way is
 * invisible here, which is a rule that misses rather than one that misfires.
 */
function declaredMoves({ text }) {
  const out   = []
  const lines = text.split('\n')
  let model   = null

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { model = m[1]; continue }

    const at = lines[i].indexOf('@@transitions')
    if (at === -1 || lines[i].trim().startsWith('//')) continue

    // To the balanced close — the block spans as many lines as it likes.
    let depth = 0, body = '', open = false, j = i
    scan: for (; j < lines.length; j++) {
      for (const c of (j === i ? lines[j].slice(at) : lines[j])) {
        if (c === '(') { depth++; open = true }
        if (open) body += c
        if (c === ')' && --depth === 0) break scan
      }
      body += '\n'
    }

    const parts = []
    let cur = '', bracket = 0
    for (const c of body.slice(1, -1)) {
      if (c === '[') bracket++
      if (c === ']') bracket--
      if (c === ',' && bracket === 0) { parts.push(cur); cur = '' } else cur += c
    }
    parts.push(cur)

    // parts[0] is the FIELD the machine is on, not a clause.
    for (const clause of parts.slice(1)) {
      if (!clause.includes('->')) continue
      const to = clause.match(/->\s*([A-Za-z_][A-Za-z0-9_]*)/)
      if (!to) continue
      const named = clause.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)
      const gate  = clause.match(/@gate\s*\(\s*['"`]?([A-Za-z0-9_]+)['"`]?\s*\)/)
      out.push({ model, move: named ? named[1] : to[1], to: to[1], gate: gate ? gate[1] : null, line: i + 1 })
    }
    i = j
  }
  return out
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
    // A finding a person has to fix and one a flag can fix read identically
    // otherwise, and the second is the one nobody should be typing out.
    const fix  = list.every(f => f.edit) ? '  ·  fli check --fix'
               : list.some(f => f.edit)  ? `  ·  ${list.filter(f => f.edit).length} fixable with --fix`
               : ''
    out.push(`  ${rule.severity === 'error' ? '✗' : '⚠'}  ${id}${tag} — ${rule.title}${fix}`)
    for (const f of list) {
      const where = relative(root, f.file) || '.'
      out.push(`       ${where}${f.line ? `:${f.line}` : ''}`)
      out.push(`         ${f.message}`)
    }
  }
  return out
}
