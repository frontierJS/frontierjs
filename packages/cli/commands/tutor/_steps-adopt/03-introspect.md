---
title: 03-introspect
description: The database read into a schema, and the list of what did not survive
---

## Reading it

```console
litestone introspect shop.db --no-camel --out imported.lite --report gaps.json
```

Two tables become two models. `customers` becomes **`model Customer`** — the
framework's naming rule applied backwards, PascalCase and singular (Invariant 2)
— and because the derivation does not come back to `customers`, the model
carries **`@@map("customers")`**, which is what points it at the table that is
really there. A foreign key becomes a `@relation`. The database is not touched.

**The two readings are a real choice, and neither is a workaround.** By default
the reading camelCases every column and records the original with
`@map("full_name")` — so your code says `fullName`, the database keeps
`full_name`, and nothing is migrated. `--no-camel` keeps the source spelling in
the schema too, which is what you want when the rest of the team already reads
SQL in that shape.

Both are graded clean, and this step checks the default one is: a reading that
renamed a column and did not RECORD the rename would be a schema naming columns
that are not there, which is the failure the grading exists to catch.

What the output says is only half of it. Read `gaps.json` beside it, and note
what is **noted** rather than lost:

- `application-attributes` — a SQLite file holds no access rules. There is no
  `@@gate`, no `@@allow`, no `@guarded` and no validator in a database, so none
  can be reverse-engineered. **That is step 5.**
- `datetime-as-text` — a `TEXT` column defaulting to a clock is *probably* a
  timestamp, and only you know. It is emitted as what it is.

And one that is **lost**: the `CHECK (total_cents >= 0)` is carried where it can
be and reported where it cannot. A converter that prints only its output has
quietly decided what to lose.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir', 'legacyDb'], { from: { appDir: '01-app', legacyDb: '02-database' } })) return

const app    = context.config.appDir
const schema = join(app, 'imported.lite')
const report = join(app, 'gaps.json')

// Run from the APP, so the litestone doing the reading is the one the app will
// run — a bare `bunx litestone` in a directory with no node_modules goes to the
// registry and reads the database with a different build of the tool.
const run = probe.command({
  bin:  join(app, 'node_modules', '.bin', 'litestone'),
  args: ['introspect', context.config.legacyDb, '--no-camel', '--out', 'imported.lite', '--report', 'gaps.json'],
  cwd:  app,
  name: 'the database is read into a schema',
})

if (!await must(context, run, {
  likely:    'litestone could not read that file — its output is above',
  reproduce: `cd ${app} && bunx litestone introspect ${context.config.legacyDb} --no-camel`,
})) return

for (const [needle, what] of [
  [/^model Customer \{/m,     'customers became model Customer — PascalCase, singular'],
  [/^model Order \{/m,        'orders became model Order'],
  [/@@map\("customers"\)/,    'and it says which table that really is'],
  [/@relation\(/,             'the foreign key became a relation'],
  [/email\s+String\s+@unique/, 'the column UNIQUE was carried'],
]) {
  if (!await must(context, probe.fileContains({ path: schema, needle, name: what }), {
    likely:    'this litestone reads the database differently — the schema it wrote is above',
    reproduce: `cat ${schema}`,
  })) return
}

// The report is the half a converter can quietly skip. Asserted as a PAIR: the
// CHECK it could not rewrite is named, AND the two decisions only a person can
// make are filed as decisions rather than as failures.
const gaps = (() => {
  try { return JSON.parse(readFileSync(report, 'utf8')) } catch { return null }
})()

if (!await must(context, {
  ok:    Array.isArray(gaps) && gaps.some(g => g.kind === 'application-attributes' && g.tier === 'noted'),
  name:  'the access rules are a NOTE, not a failure',
  asked: 'a noted application-attributes in gaps.json',
  got:   Array.isArray(gaps) ? gaps.map(g => `${g.kind}(${g.tier})`).join(', ') : 'gaps.json is not readable',
}, {
  likely:    'the tier table moved — a decision only you can make is noted, never lost',
  reproduce: `cat ${report}`,
})) return

// The other reading — the DEFAULT one — asked the same way. Two things have to
// be true together and either alone is satisfiable by a reading that is wrong:
// it passes `--strict` (nothing it emits says more than the source does), AND
// it RECORDS the rename it made. A reading that camelCased a column and forgot
// to say so would also exit 0, and would name a column that is not there.
const camel = probe.command({
  bin:      join(app, 'node_modules', '.bin', 'litestone'),
  args:     ['introspect', context.config.legacyDb, '--strict', '--stdout'],
  cwd:      app,
  needle:   /fullName\s+String\?\s+@map\("full_name"\)/,
  describe: 'exit 0, and the rename recorded as @map',
  name:     'the default reading renames and says so',
})

if (!await must(context, camel, {
  likely: 'a camelCased column with no @map beside it is a schema that cannot read its own source',
})) return

log.info('')
for (const g of gaps) log.info(`  ${g.tier.padEnd(8)} ${g.kind}${g.model ? `  ${g.model}` : ''}`)
log.info('')

remember(context, '03-introspect', { imported: schema })
```
