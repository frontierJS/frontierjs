# @frontierjs/toolbelt — changes

## 2026-08-17 — two kits arrive from the resource layer (`FJS-059`)

`/jsonschema` and `/hooks`. Both were pure, zero-dependency and copied by hand
between Sierra's resource and jetty's, which is the definition this package
already wrote for itself (`FJS-D26`) and the reason `FJS-D16` refused a fifth
published package for them.

**`/jsonschema`** is the consumer half of what Litestone emits:
`derefFieldSchema` follows a `$ref` and the non-null branch of an `anyOf` (the
field's own keywords winning over the target's), and `createMakeFromSchema`
answers what a blank record looks like. Three of its rules exist because the
older copy got them wrong: a `readOnly` column is not seeded at all, an enum
with no `@default` is null rather than its first member, and a foreign key is
null rather than `0`.

**`/hooks`** is the four-phase pipeline — `runHooks`, `runAroundHooks`,
`runPhase`, `mergeHooks`. **`mergeHooks` answers a NEW map** where both copies
merged in place: this package's licence is that every export is pure, and a
caller that now forgets the assignment gets a map that never grew rather than
one silently rewritten.

`createStore` was named by the ruling and did NOT come — a store is state, and
purity here is the whole of the argument that litestone and mesa may import
this package. `DECISIONS.md` § `FJS-D16` amended carries it.

**The harness learned to await.** A spec body may be async now — `/hooks` is a
pipeline of awaited calls, and a returned promise nobody awaits is a rejection
that reports as a PASS. 64 passing.

## 2026-08-16 — one row per directive, and the templates that had none (`FJS-306`)

`$withTemplates` and `$onlyTemplates` join the table. `@@hasTemplates` is
`@@softDelete`'s exact parallel in the Data realm — a marker column filtered out
of every read, opted back into per call — and above Litestone it did not exist:
zero references in Junction, zero in Sierra, and no `$` name here. An app
declaring the attribute had a template list screen it could not build over HTTP
or from a browser.

**The shape of the gap was the cost, not its size.** `DIRECTIVE_PARAMS`, the
`parseDirectives` body and `RESERVED_PARAMS` were three hand-written lists of
the same set, so a Data-realm feature that grows a per-call option was invisible
to all three until someone edited all three. They are now one table of
`{ param, name, read }` rows: the exported names are derived from it and the
parse is a loop over it, so a new directive is one row and cannot arrive half
wired. The coercions (`asNumber` / `asIs` / `asText` / `asBool`) are named
functions on those rows rather than a field-by-field body, which is where the
per-key rules — an absent key stays absent, an empty `$search` is not a search —
now live once.


## 2026-08-15 — `/directives`, the `$` convention (FJS-083)

FrontierJS carries two different kinds of thing in one bag of parameters: the
FILTERS (`status=active`) and the DIRECTIVES (`$limit=20`). The `$` is what
tells them apart, and **two boundaries read it, not one** — Junction's bridge,
off an HTTP query string, and Sierra's router, off a URL's search string. Same
grammar, two realms, so the table belongs below both.

`DIRECTIVE_PARAMS` / `TRANSPORT_PARAMS` / `RESERVED_PARAMS` (the union),
`parseDirectives(params)` and `splitParams(params) → { query, directives }`. The
read direction only: Junction's browser client writes `$` names from a typed
`FindParams`, field by field, and its own suite asserts that every name it emits
is one this table strips — which is the property that matters and is not the
same as sharing a function.

Value shapes are deliberately not fixed: over HTTP everything is a string, and a
caller that has already coerced (a URL parser) passes numbers and booleans. Both
are read. A directive this table does not name does not fail — it lands in the
WHERE clause as a column nobody declared, reported three layers from the cause.

13 cases. `test/run.js` gained `assert.deepEqual`, because a kit that answers an
object needs one.

## 0.1.0 — 2026-08-15

**Renamed from `@frontierjs/utils`, which is gone.** Two packages described one
thing: `utils` held the pure functions and shipped them, `toolbelt` was a README
claiming a second tier for helpers that may touch a runtime. The tier never
existed, and the name that reads as *the shared kit* was the one with nothing in
it. One package now, `@frontierjs/toolbelt`, **one kit per subpath** — a
consumer importing `/glow` pays for `/glow` alone, and the kits ship together
because a project that wants one usually ends up wanting two.

- `@frontierjs/utils/glow` → **`@frontierjs/toolbelt/glow`**. The module, its
  harness, its corpus and its `docs/glow/` reference material moved unchanged.
- `packages/datetime-kit/` folded in as the second kit before it had any code:
  its README is now `docs/datetime.md` and its prototype is parked at
  `mockup/datetime/`. `/datetime` is not exported yet.
- **`/inflect` is the second kit** — `pluralize` / `singularize`, English's
  regular rules plus a 21-word irregular table. Five copies of these rules used
  to resolve Invariant 2 and disagree; they now call this one (`FJS-192`). The
  table is consulted FIRST, which litestone's copy did not do — seven of its own
  entries were unreachable behind the sibilant rule, so `index` pluralised to
  `indexes` while the table said `indices`.
- **`encode()` escapes `&`, and the text BETWEEN two tokens is escaped too.** It
  handled `<` and `>` only, so a source line reading `&amp;` came back as
  `&amp;` in the HTML and rendered as a bare `&` — the text the author wrote was
  not the text the reader saw. `&` is escaped first, or the ampersand of an
  escape this function just wrote would be escaped again. The gap between tokens
  was raw for the same reason the old per-token encoding looked safe: `<`, `>`
  and `&` are punctuation rules in most languages and therefore usually arrive
  as tokens, so a language whose rules skip them sent them to the page. Found
  fixing `FJS-261` in mesa, which could not be fixed on its side alone.
- The purity rule stopped being a house style and became the licence: `FJS-D26`
  admits this package as **substrate below the dependency graph**, importable by
  litestone and mesa, and the argument rests entirely on it depending on nothing
  and calling no clock — which `scripts/ci.mjs` § hygiene now fails the build
  over rather than asking politely (`FJS-258`).

Version resets to 0.1.0: `@frontierjs/toolbelt` is a new name on npm. The
`@frontierjs/utils` 0.1.x releases stay published and stop moving.

### As `@frontierjs/utils`

## 0.1.0 — 2026-08-08

First release. The folder had been claimed since 2026-08-05 with a README and
nothing else: no `package.json`, so it did not install, did not test and was
not a workspace member.

**`glow(source, opts)` is the first export** — source code to highlighted HTML,
adopted from an editor component rather than written here. It fits the
package's one rule exactly: a string in, a string out, no clock and no I/O.

- Subpath export `@frontierjs/utils/glow`, so an app that imports one helper
  does not pull in the rest.
- `test/run.js` — the harness. Zero dependencies, runs under node or bun.
- `test/fixtures/guide-samples.json` — 137 real code samples from the
  `@frontierjs/css` guide, round-tripped through eight languages. Regenerate
  with `node test/fixtures/extract.mjs`.
- `docs/glow/` — the Svelte editor and SCSS theme glow arrived with, kept as
  reference. Neither ships; the repo has no Svelte and the SCSS uses UnoCSS's
  `@apply`.

### Fixed on adoption

- **A CSS custom property lost a dash.** With `prefix: true`, a line starting
  `-` is a removed line and the marker is stripped, so `--tint-surface: …`
  rendered as `-tint-surface: …`. Two dashes are never a diff marker, so the
  two features can coexist; found by round-tripping the guide's samples, where
  it corrupted 1 of 137. The `>` and `+` combinators are genuinely ambiguous
  with a diff marker and are not disambiguated — a CSS caller passes
  `prefix: false`.
- **A trailing comment swallowed the line it annotated.** The block-comment
  detector looked for `/*` anywhere on a line and treated the whole line as a
  comment, so `gap: 1rem;  /* default */` rendered entirely as commentary —
  which reads as a disabled line and hides the declaration being annotated.
  A comment that opens mid-line and closes on the same line is now a token
  rather than a block; one that opens the line, or runs on, is unchanged.
  **7 of the guide's 137 samples were affected** and had been shipping that
  way, including one where a whole listing of utility class names rendered as
  a comment.
- **A multi-character token reached the page as live markup.** Every token is
  a raw slice of the source and `elem()` only encoded a token that was a lone
  `<` or `>` — enough while no rule matched more than one character at a time.
  A line comment carrying a tag (`// see <div>`) or an HTML comment therefore
  emitted the tag unescaped. Found by the fix above, which made the first
  multi-character token; the round-trip test could not see it because no
  sample in the corpus has a comment containing markup.
- **An empty source and an empty array disagreed.** `''.split()` is `['']` —
  one empty line, not no lines — so `glow('')` returned an empty `<code>` block
  while `glow([])` returned `''`. Both are `''` now.
