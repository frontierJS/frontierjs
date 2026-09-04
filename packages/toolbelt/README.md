# @frontierjs/toolbelt

Pure functions, shared across every FrontierJS package and app, so the same string/date/object logic is not written a fourth time.

**One package, one kit per subpath.** Each kit stands on its own — import `@frontierjs/toolbelt/glow` and nothing else comes with it — and they ship together because a project that wants one usually ends up wanting two.

```js
import { glow } from '@frontierjs/toolbelt/glow'
```

| Subpath | Kit | State |
| --- | --- | --- |
| `/glow` | source code → highlighted HTML | shipping |
| `/inflect` | English singular ⇄ plural | shipping |
| `/directives` | the `$` convention — filters vs directives | shipping |
| `/history` | the key naming one occurrence of change | shipping |
| `/hooks` | the four-phase resource pipeline | shipping |
| `/json` | reading and editing a JSON document nothing describes | shipping |
| `/jsonschema` | follow a `$ref`; what a blank record looks like | shipping |
| `/match` | does this record belong in that query's results | shipping |
| `/query` | what a query string MEANS — types, structure, both directions | shipping |
| `/search` | ranking a corpus nobody indexed | shipping |
| `/signature` | what a signed machine-to-machine request is | shipping |
| `/units` | a magnitude with a unit, as a person reads it | shipping |
| `/datetime` | date, time and timezone formatting | [`docs/datetime.md`](docs/datetime.md) is the intent; the prototype is parked in `mockup/datetime/` |

The whole package holds to one rule:

> **Every export is a pure function.** Same input, same output. No I/O, no clock, no filesystem, no network, no globals, no framework imports, no mutation of its arguments.

That rule is not a style preference — it is what buys the package its standing (below). A helper that needs the current time, an env var, or a Junction `ctx` does not go in a new subpath here; it goes in the package that needs it, until something rules otherwise.

---

## Realm

Cross-cutting. Not a realm noun — toolbelt introduces no Model, Service, or Resource.

---

## Dependency direction

**Zero dependencies, ever** — workspace or otherwise. Toolbelt is *substrate*: it sits below the dependency graph rather than being a member of it, so importing it can never create a cycle or route a package around `Litestone ← Junction ← Sierra`. Any package may import it, including litestone and mesa.

Ruled `FJS-D26`, `DECISIONS.md` § Dependencies & the ecosystem. The purity rule above is what the ruling rests on: a single `Date.now()` in `src/` costs the exemption, not just the style.

---

## `query` — what a query string means

```js
import { parseQueryString, encodeQueryString } from '@frontierjs/toolbelt/query'

parseQueryString('?qty=5&live=true&sku=007&id[in][]=1&id[in][]=2')
// { qty: 5, live: true, sku: '007', id: { in: [1, 2] } }
```

A URL carries text, so something has to decide whether `?qty=5` is a number.
Three boundaries decide it — Junction's transport, Junction's client writing one,
Sierra's router — and they used to give three answers (`FJS-D125`).

**A string is a number only if it round-trips**: `String(Number(v)) === v`. One
test, and the traps of the usual `parseFloat` version fall out of it — `'007'`
stays a SKU, `'+1'` stays a phone number, `'1.50'` keeps its cents, and
`'9007199254740993'` stays a string because the round trip loses its last digit.

`true`, `false` and `null` are themselves. Structure is bracket notation, never a
sigil. A repeated key is an array. `?code="5"` is the one escape, for text that
would otherwise read back as something else — and it is exactly what
`encodeQueryString` emits for such a string, which is what makes the two halves
inverses rather than approximately so.

**It is not validation and not schema coercion.** It answers *what did the caller
type*, with no model in the room. Where a model exists it has the last word:
`id String` filtered by `?id=5` reads 5 here and Litestone converts it back.

## `units` — a magnitude with a unit

```js
import { formatBytes } from '@frontierjs/toolbelt/units'

formatBytes(5 * 1024 ** 2)              // '5.0 MB'
formatBytes(45 * 1024 ** 2)             // '45 MB'
formatBytes(500 * 1024 ** 3)            // '500 GB'
formatBytes(45 * 1024 ** 2, { decimals: 2 })   // '45.00 MB'
formatBytes(undefined)                  // ''  — absent is not zero
```

Binary steps with the familiar labels: 1024 to the step, and the step is called
MB rather than MiB, which is what almost every tool a reader has used shows them.
Precision is adaptive — one decimal below ten of a unit, none above, and never on
bytes — because a long list is scanned for magnitudes, and `503.2 GB` carries a
digit nobody is reading. `decimals` fixes it for a column that must not jitter.

`''` for `undefined`, `null`, `NaN` and a non-numeric string: answering `0 B` for
a missing size is how *we do not know* reads as *an empty file*.

Four copies of this function existed before it did, and two of them disagreed —
`@frontierjs/ui` said `5.0 MB` where three basecamp screens said `5 MB`, so one
application showed one disk two ways (`FJS-408`).

## `inflect` — English singular ⇄ plural

```js
import { pluralize, singularize } from '@frontierjs/toolbelt/inflect'

pluralize('category')    // 'categories'
pluralize('person')      // 'people'
singularize('statuses')  // 'status'
```

**One definition, five callers.** FrontierJS names one thing three ways —
`model Post` in the schema, `posts` for the service and the URL, `db.post` for
the accessor — and a table name and the model name derived back from it have to
be the same rules run twice. They were five copies that disagreed: two knew
twenty irregulars, one knew none but had the guards that stop `status` becoming
`statu`, and one was `endsWith('s')`.

English's regular rules plus a fixed irregular table (`person`/`people`,
`index`/`indices`, `datum`/`data`, 21 in all). **Not a dictionary, and it cannot
become one** — the gaps are structural: `bases` is `basis` and never `base`,
`houses` singularises to `hous`, `lens` to `len`, because `pens` is a real
plural with the same ending. A word the rules cannot reach is said by hand:
`@@map` in the Data realm, `createResource('lenses', { model: 'Lens' })` in the
UI.

---

## `directives` — the `$` convention

```js
import { splitParams, RESERVED_PARAMS } from '@frontierjs/toolbelt/directives'

splitParams({ status: 'active', $limit: '20', $orderBy: '-createdAt' })
// { query:      { status: 'active' },
//   directives: { limit: 20, orderBy: '-createdAt' } }
```

FrontierJS carries two different kinds of thing in one bag of parameters: the
**filters** (`status=active` — columns, values, a WHERE) and the **directives**
(`$limit=20` — how much, in what order, which fields). The `$` is what tells
them apart, and it is transport syntax: nothing past the boundary that reads it
should ever see one.

**Two boundaries read it, not one** — Junction's bridge, off an HTTP query
string or a WebSocket frame, and Sierra's router, off a URL's search string.
Same grammar, two realms, which is why the table is here rather than in either.
A directive one of them does not name does not fail: it falls through as a
filter, and the Data boundary reports a column nobody declared, three layers
from the cause.

The read direction only. Junction's browser client writes `$` names on the way
out from a typed `QueryDirectives`, through one table, on two paths that share nothing —
its own suite asserts every name it emits is one this table strips, which is the
property that matters and is not the same as sharing a function.

Value shapes are deliberately not fixed: over HTTP everything is a string, and a
caller that has already parsed a URL passes numbers and booleans. Both are read,
and absent stays absent — *nothing was asked* is not *the defaults*.

---

## `glow` — source code to highlighted HTML

```js
import { glow } from '@frontierjs/toolbelt/glow'

glow('.btn { color: red }', { language: 'css', prefix: false })
// → <code language="css">…</code>
```

| Option | Default | What it does |
| --- | --- | --- |
| `language` | inferred from the first character | `css`, `html`, `js`, `bash`, `md`, `json`, `yaml`, … |
| `prefix` | `true` | Treat a leading `+`, `-` or `>` as a line marker. **See the trap below.** |
| `mark` | `true` | Treat `•text•` as a highlight and `••text••` as an error |
| `numbered` | `false` | Wrap each line in a `<span>` so a CSS counter can number it |

**The output carries no CSS classes.** A token is marked with the HTML element that already means it, so the theme is element selectors and one attribute:

| Element | Marks |
| --- | --- |
| `<sup>` | comment |
| `<i>` | punctuation |
| `<b>` | identifier — property, function, key |
| `<em>` | value — string, number, CSS custom property |
| `<strong>` | keyword, tag name, hex color |
| `<label>` | `@rule`, decorator, `!important` |
| `<ins>` `<del>` `<dfn>` | a whole line: added, removed, noted |
| `<mark>` `<u>` | an author's highlight, an author's error |

[`@frontierjs/css`](../css/) ships that theme in `components/code.css` and needs nothing from this package at runtime to do it.

### The line-prefix trap

With `prefix` on, a line beginning `+`, `-` or `>` is a marker and **the character is removed from the output**. In CSS all three are legal first characters — `--custom-prop`, `> .child`, `+ .sibling` — so highlighting a stylesheet with prefixes on silently eats one character per line.

`--` is handled for you: two dashes are never a diff marker. The combinators are not, and cannot be — `+ .sibling` and a diff-added line are the same three characters. **A caller highlighting CSS wants `prefix: false`.**

---

## Install

```bash
bun add @frontierjs/toolbelt
```

---

## Testing

```bash
bun run test           # all specs
bun run test inflect   # only specs whose filename matches
```

Zero dependencies — `test/run.js` is the whole harness, and it runs under node as well as bun.

The corpus in `test/fixtures/guide-samples.json` is 137 real code samples lifted from the `@frontierjs/css` guide — CSS, HTML, JS, shell. Every one is round-tripped through every language and must come back byte-identical, because the one way a highlighter can be catastrophically wrong is silently: it drops a character, the output still looks like code, and the reader copies a sample that does not work. Refresh it with `node test/fixtures/extract.mjs`.

---

## Candidate contents

Nothing here is committed to. Listed so the boundary is legible:

- string: case conversion, slugify, truncate
- object: pick, omit, deep equal, deep clone, dot-path get/set
- array: groupBy, chunk, uniqueBy, partition
- type guards and small predicates
- result/option helpers, if the framework settles on a shape

Date and time helpers are not on that list: they are the `/datetime` kit, and take an explicit `now` for the same reason everything else here does.

---

## Open questions

- ~~Is purity enforced, or only documented?~~ **Enforced** — `scripts/ci.mjs` § hygiene fails the build on a dependency in the manifest, or a clock, a global, a network call or any non-relative import under `src/` (`FJS-258`).
- Whether there is ever a root `.` entry. Today every kit is a subpath, so an app that imports one pulls in one.
- Does toolbelt duplicate anything already living inside litestone or sierra? If so, the copy there moves here and the original re-exports — never two implementations. The two that were open closed this way: `FJS-191` (mesa's forked `glow`) and `FJS-192` (five inflection rule sets).
- `glow` was written elsewhere and adopted; `docs/glow/` keeps the Svelte editor and SCSS theme it arrived with, as reference only. Neither is shipped, and neither is FrontierJS code — the repo has no Svelte, and the SCSS uses UnoCSS's `@apply`.
