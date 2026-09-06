---
title: 04-fixedpoint
description: Build a database from the reading, read it again, and compare
---

## The property that makes it trustworthy

A converter is easy to test badly. Assert that the output contains
`model Customer` and you have graded a substring; the things that actually go
wrong are quieter — a default emitted as a string literal whose quotes double on
every pass, a predicate that nests one level deeper each time, a relation field
that takes a real column's name and deletes it.

There is one property that catches all of them, and this step runs it:

> Build a database from the schema. Read **that** database. You must get the
> same schema back.

Not *similar*. The same text. Anything the reading gets wrong in a way that
compounds shows up on the second pass, and anything it silently drops is missing
from a file you can diff.

It is the property litestone's own suite holds over seven corpus schemas and a
188-model fixture, and it is worth running against **your** database before you
trust the output — which is what this step does.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir', 'imported'], { from: '03-introspect' })) return

const app  = context.config.appDir
const lite = join(app, 'node_modules', '.bin', 'litestone')

// The imported schema declares no `database` block — it describes tables, not
// where they live — so one is put in front of it to build from.
const round = join(app, 'roundtrip.lite')
const rtDb  = join(app, 'roundtrip.db')

if (existsSync(rtDb)) rmSync(rtDb, { force: true })
writeFileSync(round,
  'database main { path "./roundtrip.db" }\n\n'
  + readFileSync(context.config.imported, 'utf8')
      .split('\n').filter(l => !l.startsWith('///')).join('\n'),
  'utf8')

const built = probe.command({
  bin:  lite,
  args: ['db', 'push', '--schema', 'roundtrip.lite'],
  cwd:  app,
  name: 'a database is built from the reading',
})
if (!await must(context, built, {
  likely:    'the schema it wrote does not build — which is the strongest thing this step can find',
  reproduce: `cd ${app} && bunx litestone db push --schema roundtrip.lite`,
})) return

const again = probe.command({
  bin:  lite,
  args: ['introspect', 'roundtrip.db', '--no-camel', '--out', 'roundtrip.out.lite'],
  cwd:  app,
  name: 'and read back again',
})
if (!await must(context, again, { likely: 'the rebuilt database could not be read' })) return

// The comparison, on the MODELS. The header names the file it came from, which
// is a different file on the second pass and is the one line that is allowed to
// differ.
const models = (p) => readFileSync(p, 'utf8')
  .split('\n').filter(l => !l.startsWith('///')).join('\n').trim()

const before = models(context.config.imported)
const after  = models(join(app, 'roundtrip.out.lite'))

const firstDiff = (() => {
  const a = before.split('\n'), b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `line ${i + 1}\n      was  ${a[i] ?? '(nothing)'}\n      now  ${b[i] ?? '(nothing)'}`
  return null
})()

if (!await must(context, {
  ok:    before === after,
  name:  'the reading is a fixed point — the same text, twice',
  asked: 'introspect(build(introspect(db))) === introspect(db)',
  got:   firstDiff ?? 'identical',
}, {
  likely:    'something in the reading compounds or is dropped — the first differing line is above',
  reproduce: `diff ${context.config.imported} ${join(app, 'roundtrip.out.lite')}`,
})) return

log.info('')
log.info('  the same text, twice — nothing compounded and nothing fell out')
log.info('')

remember(context, '04-fixedpoint', { roundtrip: round })
```
