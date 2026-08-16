---
title: fli:check
description: Architecture rules — model names, resource files, and the two config lines whose absence is silent
alias: check
examples:
  - fli check
  - fli check --only resource-file-name,vite-strict-port
  - fli check --list
  - fli check --json
flags:
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

const { RULES, runChecks, formatFindings } =
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

const { findings, ran, skipped } = runChecks({ root, only })

if (flag.json) {
  echo(JSON.stringify({ root, ran, skipped, findings }, null, 2))
  if (findings.some(f => f.severity === 'error')) process.exitCode = 1
  return
}

echo('')
echo('  fli check\n')

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

if (!findings.length) log.success(`${ran.length} rule(s) checked, nothing to report`)
else if (!errors)     log.warn(`${ran.length} rule(s) checked · ${warns} warning(s)`)
else                  log.error(`${ran.length} rule(s) checked · ${errors} error(s), ${warns} warning(s)`)

echo('')
if (errors) process.exitCode = 1
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

## The same engine runs against the framework

`scripts/ci.mjs` imports `core/checks.js` by relative path and runs it over this
repo's own apps and packages. That is deliberate: a framework that breaks its own
stated rules is worse than one that never stated them, and the way that happens
is two implementations of one rule where only one of them is ever re-derived.

## An exception is a named entry with a reason

There is no ignore comment. `runChecks({ allow })` takes `'<rule>:<path>'` keyed
to why, and **a stale allowance is reported** — an exception that outlives the
thing it excused is an unenforced rule nobody knows is unenforced.
