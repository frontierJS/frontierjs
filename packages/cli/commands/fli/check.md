---
title: fli:check
description: Architecture rules — model names, resource files, and the two config lines whose absence is silent
alias: check
examples:
  - fli check
  - fli check --fix
  - fli check --adopt
  - fli check --update
  - fli check --only resource-file-name,vite-strict-port
  - fli check --list
  - fli check --json
flags:
  fix:
    char: f
    type: boolean
    description: Apply the mechanical repairs, then re-check
    defaultValue: false
  update:
    char: u
    type: boolean
    description: Lock an improvement into check-baseline.json — it cannot raise a number
    defaultValue: false
  adopt:
    type: boolean
    description: Record what is there as the baseline, raising included. The verb for taking debt on
    defaultValue: false
  only:
    char: o
    type: string
    description: Run only these rules (comma-separated ids)
    defaultValue: ''
  list:
    char: l
    type: boolean
    description: Print the rule table and exit
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit findings as JSON
    defaultValue: false
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
//
// `resolve` is imported here rather than assumed: there is no `fli/_module.md`
// to supply it, and the parse sweep compiles a command WITHOUT its namespace
// module, so a free identifier parses clean and throws on the first run.
const { resolve } = await import('node:path')

const { RULES, runChecks, formatFindings, applyFixes,
        BASELINE_FILE, readBaseline, gradeBaseline, writeBaseline } =
  await import(resolve(global.fliRoot, 'core/checks.js'))

if (flag.list) {
  echo('')
  for (const r of RULES) {
    const inv = r.invariant ? `invariant ${r.invariant}` : 'live hazard'
    echo(`  ${r.severity === 'error' ? '✗' : '⚠'}  ${r.id.padEnd(22)} ${r.title}`)
    echo(`     ${''.padEnd(22)} ${inv}`)
  }
  echo('')
  return
}

const root = context.paths.root
const only = flag.only ? flag.only.split(',').map(s => s.trim()).filter(Boolean) : null

let { findings, ran, skipped } = runChecks({ root, only })

// `fli check` with no flags is the plan and `--fix` applies it, which is the
// order Terraform got right: nothing is written by the command a person runs to
// find out what is wrong. What gets applied is re-checked from disk rather than
// subtracted from the list in memory — a fix that did not take is the one thing
// this must not report as done.
let fixed = []
if (flag.fix) {
  const result = applyFixes(findings)
  fixed = result.fixed

  if (fixed.length) ({ findings, ran, skipped } = runChecks({ root, only }))

  for (const f of result.failed) {
    log.warn(`could not fix ${f.rule} at ${f.file}: ${f.why}`)
  }
}

// The ratchet. The FILE's presence is the declaration — no flag to remember, so
// an app's own `bun run check` gets it — and what it changes is the exit code
// and nothing else: the findings still print. Debt you cannot see is debt
// nobody pays.
let baseline = readBaseline(root)
let grade    = baseline.present || flag.adopt
  ? gradeBaseline({ findings, ran, skipped }, baseline)
  : null

// Writing happens before the verdict, and the verdict is then re-read FROM THE
// FILE — the same rule `--fix` follows. A run that records a baseline and then
// fails against the numbers it just wrote is reporting a state that no longer
// exists.
let written = null
if (grade && (flag.adopt || (flag.update && grade.improvements.length))) {
  written  = writeBaseline(root, {
    counts: grade.counts, ran, baseline, mode: flag.adopt ? 'adopt' : 'lower',
  })
  const before = grade
  baseline = readBaseline(root)
  grade    = { ...gradeBaseline({ findings, ran, skipped }, baseline), improvements: before.improvements }
}

if (flag.json) {
  echo(JSON.stringify({
    root, ran, skipped, findings,
    ...(flag.fix ? { fixed } : {}),
    ...(grade ? { baseline: { file: BASELINE_FILE, ...grade } } : {}),
  }, null, 2))
  process.exitCode = grade
    ? (grade.ok ? 0 : 1)
    : (findings.some(f => f.severity === 'error') ? 1 : 0)
  return
}

echo('')
echo(`  fli check${flag.fix ? ' --fix' : ''}\n`)

if (fixed.length) {
  echo(`  ${fixed.length} fix(es) applied:`)
  for (const f of fixed) {
    const where = f.file.startsWith(root) ? f.file.slice(root.length + 1) : f.file
    echo(`     ${where}:${f.line}  ${f.edit.was || '(nothing)'} → ${f.edit.replacement.trim()}`)
  }
  echo('')
}

if (findings.length) {
  for (const line of formatFindings(findings, root)) echo(line)
  echo('')
}

// A rule that found nothing because it found nothing to LOOK at is not a rule
// that passed. Reporting the two as one number is how a check quietly stops
// covering the thing it was written for — see every green suite in this repo's
// issue history.
if (skipped.length) {
  echo(`  ${skipped.length} rule(s) had nothing to check:`)
  for (const s of skipped) echo(`     ${s.id ?? s.rule} — ${s.why}`)
  echo('')
}

const errors = findings.filter(f => f.severity === 'error').length
const warns  = findings.length - errors

const remain = flag.fix ? ' remaining' : ''

if (grade) {
  for (const u of grade.unknown)
    log.warn(`${BASELINE_FILE} carries ${u.rule}, which is not a rule — remove the line`)
  // A rule with nothing to look at reports 0 findings, which is what a fixed one
  // reports. Its ceiling stands rather than ratcheting to nothing.
  for (const h of grade.held)
    echo(`  ·  ${h.rule} did not run — its baseline of ${h.ceiling} stands, ungraded`)

  if (written) {
    const total = Object.values(written).reduce((a, b) => a + b, 0)
    log.success(flag.adopt
      ? `${BASELINE_FILE} written — ${total} finding(s) across ${Object.keys(written).length} rule(s). ` +
        `The number may never rise.`
      : `${BASELINE_FILE} lowered — ${grade.improvements.map(i => `${i.rule} ${i.ceiling}→${i.count}`).join(', ')}`)
  } else if (grade.improvements.length) {
    log.info(`below the baseline on ${grade.improvements.length} rule(s) — ` +
             `run with --update to lock it in`)
  }

  for (const r of grade.regressions)
    log.error(`${r.rule}: ${r.count} finding(s), baseline is ${r.ceiling}`)
}

if (!findings.length)      log.success(`${ran.length} rule(s) checked, nothing to report`)
else if (grade?.ok)        log.warn(`${ran.length} rule(s) checked · ${findings.length} finding(s), all within ${BASELINE_FILE}`)
else if (!errors)          log.warn(`${ran.length} rule(s) checked · ${warns} warning(s)${remain}`)
else                       log.error(`${ran.length} rule(s) checked · ${errors} error(s), ${warns} warning(s)${remain}`)

echo('')
if (grade ? !grade.ok : errors) process.exitCode = 1
```

## What it checks

Rules that are decidable from the file tree and **silent when broken** — which is
the whole membership test. A rule whose violation already raises an error belongs
in the thing that raises it.

```
fli check --list        the rule table, with the invariant each one comes from
```

Half of them are FrontierJS invariants: a model name is PascalCase singular
(three resolvers agree on that and none of them says so), `src/resources/` holds
`.mesa` files, a resource file is named for its model, one Resource per file.

The other half are hazards with no invariant and a long memory:

- **`strictPort`** — vite hops to the next free port without a word, so the
  second app to start serves on the port the first app's test drive is pointed
  at, and every assertion passes against the wrong app.
- **the body tag inside a comment** — vite injects the built `<script>` at the
  first *textual* match and does not skip comments. The build succeeds,
  `dist/index.html` looks right, and the page loads no JavaScript. This one was
  found in FrontierJS's own Sierra example by the first run of this command.

## The other half reads a line of your own JavaScript

The rules above are about where a file sits. Five are about what one says, and
they are here for the same membership test — each is silent when broken, and each
is silent for one reason: **the wrong spelling is a legal spelling of something
else**, so nothing downstream has anything to object to.

- **`:id` in a raw route** — registers as a literal segment, so the route answers
  the path exactly as typed and 404s on every real request. Forever.
- **`ctx.params`** — does not exist in Junction. It reads `undefined`, so a role
  check written against it passes for every caller.
- **a discarded `$setAuth`** — it ANSWERS a scoped client and mutates nothing, so
  a bare `db.$setAuth(user)` leaves the writes after it anonymous and every row
  policy comparing against a null principal.
- **a per-call header the API never declared** — over HTTP it is an ordinary
  header and works; a WebSocket frame carries none of its own, so the value is
  dropped the moment the socket connects. Cross-surface, which is why nothing
  else can see it: both halves are correct in the file they are written in.
- **a service that resolves to no model** — the lookup misses rather than throws,
  and the two things that grade a caller fail OPEN: no `@@gate` is found, so a
  gated model is served to anyone, and no schema is found, so `autoValidate`
  validates nothing.

Four more read across the realms, where the seed decides:

- **a resource that resolves to no model** — `createResource('product-variants')`
  falls back to a bare `make()`, so the form is generated from nothing and the
  screen still renders. The same question as the service one, asked from the UI
  realm; both rules share one resolver.
- **the module client inside a service** — it carries no principal, so `auth()`
  is null, every row policy matches nothing and a write belongs to nobody.
  `db.asSystem()` says which client it means and is not reported.
- **a timer that dispatches into the queue** — `app.scheduler` has no
  persistence, no retry and no principal, and it runs in every replica, so two
  processes queue the same work twice. `app.jobs.schedule()` is the same line
  with caravan's clock under it.
- **a `@@gate` level nothing can reach** — the shipped resolver grades standing
  from `isAdmin`/`isOwner`/`isSystemAdmin` and never interprets a role STRING,
  so ADMINISTRATOR(5) with none of those columns and no `getLevel` of your own
  is an operation nobody but `asSystem()` can perform. A warning, because the
  app is more closed than it meant to be rather than open. `8` and `9` are
  deliberate and are not reported.

Text, never an AST: `fli check` runs on node with no build, and a parser here
would be a second one to keep in step with the compiler this repo ships. Comments
are blanked before anything is matched — most of these hazards are DESCRIBED in a
comment somewhere, in the words the rule looks for, and a check that fires on the
paragraph explaining the hazard is one people turn off.

Most of them cannot be answered from one file, which is what makes them this
command's rather than a linter's: a header is declared in `api/` and set in
`web/`, a resource name is graded against `db/schema.lite`, and a gate level is
a fact about the schema and the API at once.

## The same engine runs against the framework

`scripts/ci.mjs` imports `core/checks.js` by relative path and runs it over this
repo's own apps and packages. That is deliberate: a framework that breaks its own
stated rules is worse than one that never stated them, and the way that happens
is two implementations of one rule where only one of them is ever re-derived.

## `--fix` applies the ones that are a whole fix

```
fli check          the plan — nothing is written
fli check --fix    apply, then re-check from disk
```

Three rules carry one: `:id` → `{id}` is a spelling, and the two model rules
have already worked out the exact name the call is missing, so the edit is
`model: 'ProductVariant'` written into the options object the way that object is
already written — `{}` gets no comma, one opened on its own line gets a line
indented like its neighbor.

**The others deliberately have none, and `set-auth-discarded` is the argument.**
Wrapping the call in `const scoped =` would silence the rule and leave every
write below it going through the unscoped client — the bug, with a green check
over it. A fix that makes a check pass without fixing the failure is worse than
no fix.

What was applied is **re-checked from disk**, not subtracted from the list in
memory: a fix that did not take is the one thing this must not report as done.
Each finding names the byte span it would change and the text it expects to find
there, so a file that has moved since the check is refused by name rather than
edited at a stale offset.

## A baseline is for adopting the rules; an allowance is for excusing one

```
fli check --adopt     record what is there — the verb for taking debt on
fli check             the same output, and the exit code the baseline decides
fli check --update    lock in an improvement. It cannot raise a number
```

`check-baseline.json` at the app root, one number per rule id, absent = 0 =
clean. Invariant 14's ratchet applied to a second kind of count, and
`scripts/typecheck-baselines.json` is the precedent — deliberately identical,
down to `--update` being unable to raise. Two verbs, because one flag that both
locks in a fix and records a regression is how a ceiling goes up without anyone
deciding to raise it.

**It grandfathers nothing.** The findings still print; what the file changes is
the exit code. Debt you cannot see is debt nobody pays, and a rule set that goes
red the day it is installed gets removed rather than obeyed.

**A rule that did not RUN is not a rule that improved.** A rule with nothing to
look at reports 0 findings, which is exactly what a fixed one reports — so a
skipped rule's ceiling is carried forward and said out loud instead of being
ratcheted down to nothing. Otherwise deleting a surface for an afternoon locks
in a baseline no later run can meet. It is the same doctrine as `skipped` in the
summary, one layer along.

A ceiling for a rule that no longer exists is reported, the way a stale
allowance is.

## An exception is a named entry with a reason

There is no ignore comment. `runChecks({ allow })` takes `'<rule>:<path>'` keyed
to why, and **a stale allowance is reported** — an exception that outlives the
thing it excused is an unenforced rule nobody knows is unenforced.
