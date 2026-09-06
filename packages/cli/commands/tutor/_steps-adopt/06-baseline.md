---
title: 06-baseline
description: The debt you are keeping, written down where it cannot grow
---

## The finding you are not going to fix

Run the architecture rules against the app you just adopted:

```console
fli check
```

One warning, and it is about the third table:

```text
⚠  polymorphic-subject — a polymorphic pair names which models it can point at
     ActivityLog.subject_type names what subject_id points at, and it is a bare
     String — so nothing refuses a value that names nothing, and not a
     migration, a seed or asSystem() either.
```

It is right, and you are still not going to fix it. `subject_type` holds the
name of whatever the row is about, and that set grows every time the app gains a
model — which is the one case the rule names as legitimate. The other case is
the opposite: where the set is known and small, constrain the column
(`@@check("subject_type IN ('Customer', 'Order')")` or a declared value set) and
the finding goes away because the problem did.

So this is debt, deliberately kept, and the question is how to keep it without
it growing. That is what `check-baseline.json` is:

```console
fli check --adopt        # record what is there. The verb for taking debt on
fli check --update       # lock in an improvement. It cannot raise a number
fli check --fix          # apply the mechanical repairs
```

**The file's presence is the declaration** — there is no flag to remember, so
the app's own `bun run check` gets the ratchet for free. What it changes is the
exit code and **nothing else**: the findings still print, every run, forever.
Debt you cannot see is debt nobody pays.

**`--adopt` and `--update` are two verbs because they are two decisions.**
`--update` may only ever lower a number; `--adopt` may raise one. Taking on more
debt is a thing you are allowed to do and it is not a thing that should happen
because somebody typed the convenient flag.

```js
if (!await narrate(context)) return

context.config.__step = 6

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app      = context.config.appDir
const schema   = schemaFile(context)
const baseline = join(app, 'check-baseline.json')

// Run and READ, rather than assert: every question below is about the exit code
// AND the output together, and `probe.command` grades one of them for you.
// Never a bare `fli` — that is whatever global install the machine has.
const check = (args = []) => {
  const r = probe.runArgv(process.execPath, [join(global.fliRoot, 'bin', 'fli.js'), 'check', ...args], { cwd: app })
  return { ...r, out: `${r.stdout}\n${r.stderr}`.trim(), ok: r.code === 0 }
}
const baselineSays = () => (readFileSync(baseline, 'utf8').match(/"polymorphic-subject":\s*(\d+)/) ?? [])[1]

// ─── the finding ──────────────────────────────────────────────────────────
const found = check()
if (!await must(context, {
  ok:    /polymorphic-subject/.test(found.out),
  name:  'the adopted schema carries one finding, and it names the pair',
  asked: 'polymorphic-subject, about ActivityLog.subject_type',
  got:   found.ok ? 'a clean check' : 'something else — the output is below',
}, {
  likely:    'the legacy database did not get its activity_log table — step 2 writes it',
  detail:    found.out.slice(-600),
  reproduce: `cd ${app} && fli check`,
})) return

// ─── taking it on ─────────────────────────────────────────────────────────
if (existsSync(baseline)) rmSync(baseline)
check(['--adopt'])

if (!await must(context, probe.fileContains({
  path:   baseline,
  needle: /"polymorphic-subject":\s*1/,
  name:   'the debt is written down, by rule and by number',
}), {
  likely:    'fli check --adopt wrote nothing — its output is above',
  reproduce: `cd ${app} && fli check --adopt && cat check-baseline.json`,
})) return

// A baseline that SILENCED the finding would be the wrong mechanism: what is
// being asserted is that it still prints, and only the verdict moved.
const within = check()
if (!await must(context, {
  ok:    within.ok && /polymorphic-subject/.test(within.out),
  name:  'the app passes now — and still says what it is carrying',
  asked: 'exit 0, with the finding printed',
  got:   `exit ${within.code}, ${/polymorphic-subject/.test(within.out) ? 'finding printed' : 'nothing printed about it'}`,
}, {
  likely: 'the baseline is being read as a mute button rather than a ceiling',
  detail: within.out.slice(-600),
})) return

// ─── the ceiling ──────────────────────────────────────────────────────────
// A second pair, in a model added by hand. The point is not the model — it is
// that the number moved, which is the only thing the file is for.
const before = readFileSync(schema, 'utf8')
appendFileSync(schema, [
  '',
  'model Attachment {',
  '  id  Int  @id',
  '  owner_type  String',
  '  owner_id  Int',
  '  path  String',
  '  @@noStrict',
  '  @@gate("0.4.4.6")',
  '}',
  '',
].join('\n'), 'utf8')

const risen = check()
if (!await must(context, {
  ok:    !risen.ok && /baseline is 1/.test(risen.out),
  name:  'a second one fails the check, naming the number it was allowed',
  asked: 'a non-zero exit, and "2 finding(s), baseline is 1"',
  got:   `exit ${risen.code}`,
}, {
  likely: 'the ratchet is not being applied — check-baseline.json may not have been read',
  detail: risen.out.slice(-600),
})) return

// The pair that makes the two verbs mean something: --update is offered the
// same rise and refuses it, leaving the file where it was.
const refused = check(['--update'])
if (!await must(context, {
  ok:    !refused.ok && baselineSays() === '1',
  name:  'and --update will not raise it, because raising is a different decision',
  asked: 'a non-zero exit, and the file still saying 1',
  got:   `exit ${refused.code}, file says ${baselineSays()}`,
}, {
  likely: '--update wrote a higher number — that is --adopt’s job and only --adopt’s',
  detail: refused.out.slice(-600),
})) return

// ─── back where it was ────────────────────────────────────────────────────
// The model came out again rather than being constrained, so the app the lesson
// leaves behind still matches the database it adopted — a schema declaring a
// table that is not there is the next person's confusing morning.
writeFileSync(schema, before, 'utf8')

if (!await must(context, {
  ok:    check().ok,
  name:  'with it taken out again the app is green, and the ceiling stands at one',
  asked: 'exit 0',
  got:   'a failure — the output is above',
}, { likely: 'the schema did not come back — compare it against db/imported.lite' })) return

log.info('')
log.info(`  ${baseline}`)
log.info('  one line per rule, and it may never rise without somebody saying so')
log.info('')

remember(context, '06-baseline', { baseline })
```
