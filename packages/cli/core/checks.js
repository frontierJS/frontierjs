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
// So: plain ESM, node or bun, and one package — `@frontierjs/toolbelt`, the
// substrate below the dependency graph, because *what is the singular of this
// service name* (`/inflect`, Invariant 2) and *what does this `---` block say*
// (`/frontmatter`) each have one owner, and a rule answering either again would
// grade an app by rules the app does not run.
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


import { relative, join }              from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { CHECKS as data }              from './checks/data.js'
import { CHECKS as api }               from './checks/api.js'
import { CHECKS as ui }                from './checks/ui.js'
import { CHECKS as app }               from './checks/app.js'
import { CHECKS as repo }              from './checks/repo.js'

// `findApps` lives in `core/runnables.js` with the other tree readers — these rules
// read the runnable list, so it cannot live here without a cycle. Re-exported
// because it is part of this module's surface.
export { findApps } from './runnables.js'

// ─── the rule table ───────────────────────────────────────────────────────────
//
// `scope: 'app'` runs against a client app; `scope: 'repo'` against a package
// tree; `scope: 'both'` in either run. `fli check` runs the app scope, `ci.mjs`
// runs both.

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
  { id: 'route-part-prefix',    scope: 'app',  severity: 'error', invariant: null,
    title: 'a co-located part whose prefix names a folder names ITS folder' },
  { id: 'nav-href-routes',      scope: 'app',  severity: 'warn',  invariant: null,
    title: 'every href and section path in src/lib/nav.js names a route' },
  { id: 'resource-one-per-file', scope: 'app', severity: 'error', invariant: 19,
    title: 'one Resource per file' },
  { id: 'vite-strict-port',     scope: 'app',  severity: 'error', invariant: null,
    title: 'every vite config sets strictPort' },
  { id: 'surface-script',       scope: 'app',  severity: 'error', invariant: null,
    title: 'the api/ and web/ scripts are named api and web' },
  { id: 'drive-opens-chrome',   scope: 'both', severity: 'error', invariant: null,
    title: 'a drive opens Chrome through @frontierjs/mesa/drive' },
  { id: 'test-port-literal',   scope: 'app',  severity: 'error', invariant: null,
    hazard: 'api: A test may not name a port',
    title: 'a test asks for its port with portFor(), never a literal' },
  { id: 'drive-holds',          scope: 'both', severity: 'error', invariant: null,
    title: 'a drive that reaches its checkout\'s ports or dev database declares it in holds' },
  { id: 'test-not-hermetic',    scope: 'both', severity: 'error', invariant: null,
    title: 'a collected test binds no fixed port, opens no Chrome and mocks no module' },
  { id: 'test-timeout-inline',  scope: 'both', severity: 'warn',  invariant: null,
    title: 'a package that sets its test timeout sets it in one place' },
  { id: 'body-tag-in-comment',  scope: 'app',  severity: 'error', invariant: null,
    hazard: 'ui: Vite injects the built',
    title: 'the body tag is never written inside a comment' },
  { id: 'untrusted-upload-root', scope: 'app', severity: 'warn', invariant: null,
    title: 'a static root serving uploads says so' },
  { id: 'file-column-storage', scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a File column has a FileStorage to store it' },
  { id: 'app-layout',           scope: 'app',  severity: 'warn',  invariant: 3,
    title: 'db/ at the app root, each surface a directory beside it, and each file in its kind\'s folder' },
  { id: 'surface-config',       scope: 'app',  severity: 'warn',  invariant: 3,
    hazard: 'api: A missing config DIRECTORY',
    title: 'a surface keeps its configuration in config/' },
  { id: 'mesa-compiles',        scope: 'app',  severity: 'error', invariant: null,
    title: 'every .mesa in a surface compiles' },
  { id: 'surface-src',          scope: 'app',  severity: 'warn',  invariant: 3,
    title: 'a surface keeps its source in src/, and only its entry beside it' },
  { id: 'widget-entry-name',    scope: 'app',  severity: 'error', invariant: 19,
    title: 'a widget is a PascalCase file, or a directory holding index.mesa' },
  { id: 'migration-history',    scope: 'app',  severity: 'error', invariant: null,
    title: 'the migration history builds db/schema.lite' },
  { id: 'raw-route-param',      scope: 'app',  severity: 'error', invariant: null,
    hazard: 'api: Raw routes',
    title: 'a raw route names a capture {id}, never :id' },
  { id: 'ctx-params',           scope: 'app',  severity: 'error', invariant: null,
    hazard: 'api: `ctx.params` does not exist',
    title: 'a service context has no ctx.params and no ctx.client' },
  { id: 'set-auth-discarded',   scope: 'app',  severity: 'error', invariant: null,
    hazard: 'data: `$setAuth(user)` RETURNS',
    title: '$setAuth answers a scoped client rather than mutating one' },
  { id: 'call-header-declared', scope: 'app',  severity: 'error', invariant: null,
    hazard: 'api: A header the caller varies per call',
    title: 'a per-call header is declared in http.callHeaders' },
  { id: 'service-model',        scope: 'app',  severity: 'error', invariant: 2,
    title: 'a service resolves to the model whose @@gate grades it' },
  { id: 'auth-service-collision', scope: 'app', severity: 'warn', invariant: null,
    title: 'no model derives the name of a service @frontierjs/auth registers' },
  { id: 'service-definition',   scope: 'app',  severity: 'error', invariant: null,
    title: 'a service file default-exports a definition, never a factory (FJS-D1079)' },
  { id: 'app-entry',            scope: 'app',  severity: 'error', invariant: null,
    title: 'index.html loads virtual:sierra, and main.js mounts nothing (FJS-D1085)' },
  { id: 'resource-model-miss',  scope: 'app',  severity: 'error', invariant: 2,
    title: 'a resource name resolves to the model it means' },
  { id: 'money-rendered-raw',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a @money column is not printed as the integer it stores' },
  { id: 'table-column-key',     scope: 'app',  severity: 'error', invariant: null,
    title: 'a <Table> column names its field `name`, the way the schema does' },
  { id: 'page-path-retired',    scope: 'app',  severity: 'error', invariant: null,
    title: 'the router speaks `pathname` and `search`, as the browser does' },
  { id: 'import-subpath-exported', scope: 'app', severity: 'error', invariant: null,
    title: 'a @frontierjs import names a subpath its package still exports' },
  { id: 'detail-read-dead',     scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a row a screen KEEPS is watched, not fetched once' },
  { id: 'envelope-hedge',       scope: 'app',  severity: 'warn',  invariant: null,
    hazard: 'ui: `find()` answers the list envelope',
    title: 'a service answer is read in the one shape the server gives it' },
  { id: 'service-module-db',    scope: 'app',  severity: 'error', invariant: null,
    title: 'a service reads the request-scoped client, a job the one ctx.app.withDb hands out, never the module one' },
  { id: 'service-as-system',    scope: 'app',  severity: 'warn',  invariant: 6,
    title: 'asSystem() off the app client crosses tenants; with no row tenancy, any asSystem() in a service crosses users' },
  { id: 'scheduler-dispatch',   scope: 'app',  severity: 'error', invariant: null,
    hazard: 'api: Caravan owns the clock',
    title: 'a timer that dispatches into a queue is the queue\'s schedule' },
  { id: 'battery-raw-secret',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a battery takes its credential by reference, not as a constructor argument' },
  { id: 'queue-operator-verb',  scope: 'app',  severity: 'error', invariant: null,
    title: 'pausing, resuming, draining or purging a queue — or every queue — is an operator\'s act, not a service\'s' },
  { id: 'gate-unreachable',     scope: 'app',  severity: 'warn',  invariant: 6,
    title: 'a declared @@gate level something can actually reach' },
  { id: 'static-publish-db',    scope: 'app',  severity: 'error', invariant: null,
    title: 'a prerendered site wires the client its publish check reads' },
  { id: 'package-model-drift',  scope: 'app',  severity: 'warn',  invariant: null,
    title: "a copied model still agrees with the package that ships it" },
  { id: 'schema-in-memory',     scope: 'app',  severity: 'warn',  invariant: null,
    title: 'every model the app runs is one the committed artefacts describe' },
  { id: 'schema-runs',          scope: 'app',  severity: 'error', invariant: null,
    title: 'a schema litestone can open: the file parses and createClient builds over it' },
  { id: 'transition-methods',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a declared move and the code that makes it still name each other' },
  { id: 'required-system-unfilled', scope: 'app', severity: 'warn', invariant: null,
    hazard: 'ui: `@system` is the column an application writes',
    title: 'a required @system column with no @default is filled by code the service runs' },
  { id: 'commitment-swept',     scope: 'app',  severity: 'warn',  invariant: null,
    hazard: 'data: A row that stops counting at a date',
    title: 'a move a @@commitment owes is made by the commitment, not by a job too' },
  { id: 'capability-ladder',    scope: 'app',  severity: 'warn',  invariant: null,
    hazard: 'data: A CAPABILITY is a grid',
    title: 'a model graded by capability is not also graded by ladder' },
  { id: 'polymorphic-subject',  scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a polymorphic pair names which models it can point at' },
  { id: 'log-db-unbound',       scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a jsonl/trail database the deploy can point at the volume' },
  { id: 'db-path-committed',    scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a database path the schema declares is covered by .gitignore' },
  { id: 'deploy-image-needs',   scope: 'app',  severity: 'warn',  invariant: null,
    title: 'the deploy image carries what the API needs at runtime: a Chrome to print or drive, web/src to render from' },
  { id: 'command-parses',       scope: 'app',  severity: 'error', invariant: 15,
    title: 'every project command compiles, with its namespace module, to JavaScript that parses' },
  { id: 'command-resolves',     scope: 'app',  severity: 'error', invariant: 15,
    title: 'every name a project command uses is declared, imported, or one the shim injects' },
  { id: 'css-token-undefined',  scope: 'app',  severity: 'error', invariant: 13,
    hazard: 'ui: A `var()` naming a token',
    title: 'a styled value names a token the stylesheets define' },
  { id: 'css-raw-literal',      scope: 'app',  severity: 'warn',  invariant: 13,
    title: 'a .mesa <style> holds no raw color, size or spacing value' },
  { id: 'css-raw-utility',      scope: 'app',  severity: 'warn',  invariant: 13,
    title: 'an app\'s markup holds more raw color utilities than semantic classes' },
  { id: 'css-class-collision', scope: 'app',  severity: 'warn',  invariant: 13,
    title: 'a .mesa <style> names no class the kit already owns' },
  { id: 'kit-prop-unknown',    scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a kit component is passed only props it declares or attributes HTML has' },
  { id: 'aria-owed',           scope: 'app',  severity: 'warn',  invariant: null,
    title: 'an element written with a kit term\'s class carries the role and names the kit says it owes' },
  { id: 'preview-ui-only',      scope: 'app',  severity: 'error', invariant: null,
    title: 'a preview branch changes web/ and nothing else' },
  { id: 'plan-size',            scope: 'app',  severity: 'warn',  invariant: null,
    title: 'a PLAN.md stays small enough to read whole: finished phases live in docs/plan-done.md' },
  { id: 'package-root-md',      scope: 'repo', severity: 'warn',  invariant: 17,
    title: 'three markdown files are the standard at a package root' },
  { id: 'test-files-run',       scope: 'repo', severity: 'error', invariant: null,
    title: 'a hand-listed test script names every test file beside it' },
  { id: 'docs-index',           scope: 'repo', severity: 'warn',  invariant: 17,
    title: 'a docs/ index links every page beside it' },
  { id: 'proof-target',         scope: 'repo', severity: 'error', invariant: null,
    title: 'every drive the proof table names still exists, and every row can be hit' },
  { id: 'proof-drive-named',    scope: 'repo', severity: 'warn',  invariant: null,
    title: 'every drive is named by some row of the proof table' },
  { id: 'drive-preamble',       scope: 'repo', severity: 'error', invariant: null,
    title: 'every step a drive says to start first is a script that exists' },
  { id: 'dev-host-unique',      scope: 'repo', severity: 'error', invariant: null,
    title: 'no two surfaces derive the same dev name' },
  { id: 'tutor-order',          scope: 'repo', severity: 'error', invariant: null,
    title: 'the tutorial agrees with itself about what order it is in' },
  { id: 'tutor-lesson-named',   scope: 'repo', severity: 'warn',  invariant: null,
    title: 'every lesson is one the tutorial index lists' },
  { id: 'skill-pointer',        scope: 'repo', severity: 'error', invariant: null,
    title: 'every skill CLAUDE.md names is a SKILL.md whose frontmatter agrees' },
  { id: 'home-path-literal',    scope: 'repo', severity: 'error', invariant: null,
    title: 'no file names the home directory of the machine it was written on' },

  // The notes, graded against the tree — `core/doc-audit.js`. Prose is the one
  // artefact here with no compiler, no test and no snapshot behind it, and it is
  // read first by everyone.
  { id: 'doc-word-unknown',     scope: 'repo', severity: 'warn',  invariant: null,
    title: 'a document uses no schema word the language does not have' },
  { id: 'doc-cites-dead',       scope: 'repo', severity: 'warn',  invariant: null,
    title: 'every path, link and register id a document cites resolves' },
  { id: 'doc-claims-count',     scope: 'repo', severity: 'warn',  invariant: null,
    title: 'a count in prose is the count in the tree' },
  { id: 'doc-invariant-ref',    scope: 'repo', severity: 'error', invariant: null,
    title: 'every cited invariant is one CLAUDE.md declares' },
  { id: 'doc-status-stale',     scope: 'repo', severity: 'warn',  invariant: null,
    title: 'a guiding document does not call open what the register has ruled' },
  { id: 'doc-map-narration',    scope: 'repo', severity: 'warn',  invariant: null,
    title: 'a map states what is true, not what used to be' },
  { id: 'doc-unchecked-count',  scope: 'repo', severity: 'warn',  invariant: null,
    title: 'a number in prose is generated or absent' },
  { id: 'invariant-enforcer',   scope: 'repo', severity: 'error', invariant: null,
    title: 'a declared invariant enforcer resolves to something that exists' },
  { id: 'hazard-enforcer',      scope: 'repo', severity: 'error', invariant: null,
    title: 'a rule\'s hazard key names exactly one bullet of its realm skill' },
  { id: 'seam-owner',           scope: 'repo', severity: 'error', invariant: 4,
    title: 'a seam\'s stated owner exists and is where the name is declared' },
  { id: 'seam-listed',          scope: 'repo', severity: 'error', invariant: 4,
    title: 'every seam the skill explains is named in CLAUDE.md\'s key list' },
  { id: 'threat-row',           scope: 'repo', severity: 'error', invariant: null,
    title: 'every THREATS.md row names a test that is in the tree' },
  { id: 'doc-examples-run',     scope: 'repo', severity: 'warn',  invariant: 16,
    title: 'a package whose docs fence a runnable example has a suite that runs it' },
  { id: 'connector-contract',   scope: 'repo', severity: 'error', invariant: null,
    title: 'every @frontierjs/conduit-* package holds a sink, a drive and a conduit peer' },
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

// A skip is one of two things. Most are *nothing to grade* (no `web/`, no test
// directory). A rule that has something to grade and lacks the tool or input to
// grade it — no parser, a snapshot nobody generated — answers `blind: true`,
// and `blindSkips` lists those that are errors, which is what a runner must not
// let read as a clean pass.
export function blindSkips({ skipped = [] }) {
  const severity = Object.fromEntries(RULES.map(r => [r.id, r.severity]))
  return skipped.filter(s => s.blind && severity[s.rule] === 'error')
    .map(({ rule, why }) => ({ rule, severity: 'error', why }))
}

// `allow` is `{ '<rule>:<path>': 'why' }`, path relative to `root`. An exception
// is a named entry with a reason, never a loosened rule: the rule is what every
// app gets on the next release, and the one place it may not hold is written down
// where the next person can disagree with it.

// A rule answers `{ findings: [...] }` or `{ skipped: 'why' }`, and anything else
// THROWS naming the rule. Read leniently, a rule returning a bare array — which
// is what a body building `findings` reads like — contributed nothing, was
// counted as having run, and had 0 written into the baseline as its ceiling:
// a broken rule and a satisfied one printed the same line (FJS-1049). The shape
// is the same on every tree, so a wrong one fails the rule's first test.
export function verdictOf(rule, out) {
  const plain   = out !== null && typeof out === 'object' && !Array.isArray(out)
  const skip    = plain && typeof out.skipped === 'string' && out.skipped !== ''
  const listed  = plain && Array.isArray(out.findings)
  if (plain && skip !== listed && (skip ? !('findings' in out) : !('skipped' in out))) return out

  const got = Array.isArray(out) ? `an array of ${out.length}`
            : plain              ? `an object with keys [${Object.keys(out).join(', ')}]`
            :                      String(out === null ? null : typeof out)
  throw new Error(
    `fli check: rule \`${rule.id}\` returned ${got}. A rule answers { findings: [...] } or ` +
    `{ skipped: 'why' } — exactly one — and any other shape would be read as a rule that ran ` +
    `and found nothing.`
  )
}

export function runChecks({ root, only = null, scope = 'app', allow = {} } = {}) {
  const inScope = r => scope === 'both' || r.scope === 'both' || r.scope === scope
  const wanted  = RULES.filter(r => inScope(r) && (!only || only.includes(r.id)))

  // An id that matches no rule in this scope would otherwise run nothing and
  // read as a clean pass: a typo, or a repo rule asked for from an app.
  const unknown = (only ?? []).filter(id => !wanted.some(r => r.id === id))
  if (unknown.length) {
    const why = unknown.map(id => {
      const rule = RULES.find(r => r.id === id)
      return rule ? `\`${id}\` is a ${rule.scope}-scope rule, not run in ${scope} scope` : `\`${id}\` names no rule`
    })
    throw new Error(`fli check --only: ${why.join('; ')}. \`fli check --list\` shows the rules.`)
  }

  const findings = []
  const allowed  = []
  const ran      = []
  const skipped  = []

  for (const rule of wanted) {
    const out = verdictOf(rule, CHECKS[rule.id]({ root, rule, rules: RULES }))
    if (out.skipped) skipped.push({ rule: rule.id, why: out.skipped, ...(out.blind && { blind: true }) })
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
  // Only for a rule that RAN: under `--only` an allowance for another rule has
  // nothing to hit, and calling it stale would tell a person to delete a live one.
  const hit   = new Set(allowed.map(a => `${a.rule}:${relative(root, a.file) || '.'}`))
  const stale = Object.keys(allow).filter(k => !hit.has(k) && ran.includes(k.slice(0, k.indexOf(':'))))

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
  try { raw = JSON.parse(read(path, 'utf8')) } catch { return { path, present: false, counts: {}, allow: {}, notes: {} } }

  // `//<rule>` is the reason a rule's ceiling stands; `writeBaseline` carries it.
  const counts = {}, notes = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('//')) {                        // a comment, the way JSON allows one
      if (key.length > 2 && typeof value === 'string') notes[key.slice(2)] = value
      continue
    }
    if (Number.isFinite(value)) counts[key] = value
  }

  // `allow` rides beside the counts (`FJS-D508`): `'<rule>:<path>'` to why. An
  // entry with no reason is not an exception, so it is not read as one.
  const allow = {}
  if (raw.allow && typeof raw.allow === 'object' && !Array.isArray(raw.allow))
    for (const [key, why] of Object.entries(raw.allow))
      if (typeof why === 'string' && why.trim()) allow[key] = why

  return { path, present: true, counts, allow, notes }
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
  // A reason sits directly above its rule and goes when the debt does: a reason
  // for a ceiling that no longer exists would explain nothing.
  const notes = baseline.notes ?? {}
  const sorted = Object.entries(next).sort(([a], [b]) => a.localeCompare(b))
  const counted = Object.fromEntries(sorted)
  const body = Object.fromEntries(sorted
    .flatMap(([id, count]) => notes[id] ? [[`//${id}`, notes[id]], [id, count]] : [[id, count]]))
  // The ratchet rewrites this file, so what it does not own is carried through:
  // an `--adopt` that dropped the allowances would turn each back into a finding.
  const allow = baseline.allow && Object.keys(baseline.allow).length ? { allow: baseline.allow } : {}
  write(join(root, BASELINE_FILE), `${JSON.stringify({ ...header, ...body, ...allow }, null, 2)}\n`)
  return counted
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

// ─── the checks ───────────────────────────────────────────────────────────────
//
// One body per rule id, in `core/checks/` by realm — the split the root
// `CLAUDE.md` § Live hazards makes: `data`, `api`, `ui`, then `app` for an
// app-scope rule belonging to no realm and `repo` for the workspace's own.
// `lib.js` is the readers two slices share. The spread is checked because a rule
// id in two slices would be one body silently shadowing the other, and the
// table above would still count it as run.
const CHECKS = {}
for (const slice of [data, api, ui, app, repo]) {
  for (const [id, body] of Object.entries(slice)) {
    if (id in CHECKS) throw new Error(`fli check: rule \`${id}\` has a body in two slices`)
    CHECKS[id] = body
  }
}

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

// What `api.js` declares and `test/checks.test.js` holds against auth's own list.
export { AUTH_SERVICES } from './checks/api.js'
