# toolbelt — package map

**`@frontierjs/toolbelt`** — pure functions, zero dependencies, importable from
anywhere in the tree including litestone and mesa. One rule: **every export is a
pure function** — same input, same output, no I/O, no clock, no globals, no
framework import, no mutation of its arguments. The rule is the package's
license, not its style: `FJS-D26` admits toolbelt as substrate *below* the
dependency graph on the strength of it, so breaking purity costs the standing.

**One kit per subpath.** `/cron`, `/gate`, `/glow`, `/inflect`, `/directives`,
`/history`, `/hooks`, `/json`, `/jsonschema`, `/match`, `/query`, `/redact`,
`/search`, `/signature` and `/units` today; a caller
importing one gets nothing else. There is no root `.` entry.

`bun run test` — `test/run.js` is the whole harness, no dependencies, runs
under node too.

---

## Layout

```
src/glow/glow.js     source code → highlighted HTML. The first kit.
src/inflect/         English singular ⇄ plural. One definition, five callers
                     across litestone, junction and sierra
src/cron/            what a five-field cron expression ADMITS — a Set per
                     field. Caravan and junction's `app.scheduler` each had a
                     parser and they were broken differently, so one expression
                     named two schedules (`FJS-767`). Which clock, and when a
                     timer looks, stays with each scheduler: `cronMatches` takes
                     clock parts rather than a `Date`. Ships a `.d.ts` — both
                     callers are TypeScript
src/units/           a magnitude with a unit, as a person reads it. Bytes:
                     binary steps, familiar labels, adaptive precision — four
                     callers had four copies and two answers (`FJS-408`).
                     Money: `Intl.NumberFormat`, one locale, the bare symbol —
                     five copies in one app and two email bodies with no
                     currency at all (`FJS-440`). Arithmetic: `roundMinor` and
                     `allocate`, the rounding mode and the leftover unit
                     `@money` deliberately left to the app (`FJS-D154`)
src/gate/            the access LADDER — the 0-9 scale, `levelPasses` (8 and 9
                     are SENTINELS, so it is not `>=`), and `gradeStanding`,
                     the session shape -> level. Four hand copies across three
                     realms, each carrying a comment saying *change one, change
                     both*, and they drifted on the branch none of their tests
                     could see (`FJS-520`, ruled `FJS-D197`). Litestone
                     enforces, junction grades the caller, sierra renders a
                     screen from it in plain node — and the dependency
                     direction forbids two of the three from asking the first.
                     Ships a `.d.ts`: junction re-exports the type
src/directives/      the `$` convention — which params are directives, and how
                     a bag of them splits into filters + directives. Two
                     boundaries read it: junction's bridge and sierra's router
src/query/           what a query STRING means — types, structure, and the way
                     back. Sibling of /directives: that one says which params
                     are directives, this one says what the values are. Three
                     readers — junction's transport, junction's client writing
                     one, sierra's router. Ships a `.d.ts`, because junction's
                     browser client reaches it
src/hooks/           the four-phase resource pipeline — before · after · around
                     · error — plus `hookContext`/`answered`, which is whether
                     anything ever produced a result, and `hookChainMessage`,
                     what to say when nothing did. Two callers: sierra's
                     createResource and jetty's
src/json/            reading, editing and COMPARING a JSON document nothing
                     describes — classify, the immutable writes, the flattened
                     tree, and diffDocs. Two callers, both in @frontierjs/ui:
                     the Json viewer and the JsonInput control
src/jsonschema/      the CONSUMER half of what litestone emits — follow a
                     `$ref`, and what a blank record of this model looks like.
                     Same two callers
docs/glow/           the Svelte editor and SCSS theme glow arrived with.
                     Reference only — not shipped, not FrontierJS code
docs/datetime.md     the /datetime kit's intent — no code yet
mockup/datetime/     the prototype /datetime is being rebuilt from. Parked,
                     below the packages/* glob, allowance-named in CI
test/run.js          the harness
test/specs/          one .spec.js per export
test/fixtures/       guide-samples.json — 137 real samples from the css guide
                     extract.mjs — regenerates it
```

**`@frontierjs/utils` and `packages/datetime-kit/` are gone** — both folded in
here. An import of either name is stale, and the published `@frontierjs/utils`
0.1.x on npm no longer moves.

---

## What bites here

- **`/query`'s number rule is one line and it is the whole design.** A string is
  a number only if `String(Number(v)) === v`. Every trap of the obvious
  `parseFloat` version falls out of it — `'007'` stays a SKU, `'+1'` stays a
  phone number, `'1.50'` keeps its cents, `'9007199254740993'` stays text because
  the round trip loses its last digit. Adding a "helpful" case (trimming
  whitespace, accepting `1e5`, accepting hex) puts one of those back. `FJS-D125`.
- **`encodePairs` answers PAIRS, not an object, and that is not a style
  choice.** An object cannot hold `k[]=1&k[]=2` — the second write lands on the
  same key and the array comes back with one element, which is the shape the kit
  exists to carry.
- **The parser must never run over a WS frame.** A frame is JSON and already has
  its types; parsing it would turn a filter that genuinely says the string `'5'`
  into 5. Only a query STRING lost the types, so only a query string is parsed.

- **`diffDocs` answers a MERGED document, and that is the whole point.** A
  removed key is in neither the new document nor any tree built from it, so a
  caller diffing by walking `after` can show every change except the ones that
  took something away — which is the half people are looking for. `merged`
  carries a removed entry at its OLD value, marked, so one walk renders all
  three states. Two things follow: `count` is LEAF level, because a container
  is marked `changed` only as a rollup and counting both reports one edit
  twice; and `open` is every ANCESTOR row on the route to a difference, not the
  differing row itself, since opening a row shows its children.
- **Arrays are compared BY POSITION, and it is stated rather than hidden.**
  Removing the first of three items reads as two changes and one removal. True
  about the document, and not the most useful reading — the alternative is a
  longest-common-subsequence pass, which is a different feature with its own
  decision in it (*what makes two objects the same item?*) and is deliberately
  not guessed at. A container whose two sides are different KINDS is one
  `changed` and is not recursed into, because nothing below it corresponds.
- **`accessorPath` and `jsonPointer` exist because the naive join is wrong in
  the way that looks right.** `a.content-type` parses as a subtraction, `a.0`
  is a syntax error, and a pointer joined with slashes names a member that does
  not exist as soon as a key holds one. Two spellings because they answer
  different questions: the accessor goes into code, the pointer is what a JSON
  Schema validator names when it refuses a member.
- **`searchDoc` answers `open` as well as `keep`, and that is the half that is
  easy to miss.** `treeRows` emits children of an OPEN container only, so a
  match four levels down is not a row yet — a filter that does not open its own
  ancestors finds everything and shows nothing. A container whose key matches
  keeps its whole subtree (*find me `tags`* is not a search for the word), a
  value is matched as the text a reader SEES (so `null` and a number's digits
  are findable), and `count` is hits rather than kept rows.
- **`markRuns` marks every occurrence and keeps the original casing.** One
  marked and the next not says *this is the one*, which a highlighter cannot
  know; and returning the query's casing would rewrite the document on screen.
- **`convertTo` is the deliberate counterpart to `coerceLike`, and both are
  live at once.** `coerceLike` keeps the type an edit replaces (a text box hands
  back text, so the type has to survive); `convertTo` changes it on purpose.
  Without the second, a document can be edited and never RESHAPED — typing `{}`
  into a string field gives the string `"{}"`. It is lossless where a mapping
  exists, including a string that PARSES as the kind asked for, and drops the
  value where none does. Two easy-to-invert rules: `'false'` is `false`, and an
  unreadable number is `0` and never `NaN`, which is not a JSON value.
- **`sameValue` is deep equality for JSON and nothing else** — no Map, no Set,
  no cycle guard, no NaN. A general one here would be a second answer to a
  question this kit already scopes.

- **`ctx.result` is an ACCESSOR and the value is not the test.** Three ordinary
  hook mistakes end the pipeline with nothing having run — an `around` that
  returns without calling `next()`, an `around` that catches and does not
  rethrow, an `error` hook that clears `ctx.error` and sets nothing — and all
  three used to resolve the call to the `null` the context was born with, which
  a screen reads as an answer. `null` is also a legitimate answer (a `get` for
  a row that is not there), so what separates them is whether anything ever
  ASSIGNED it. `hookContext` tracks that; `answered(ctx)` reports it. A context
  from anywhere else answers `false`, so a caller that has not adopted it is
  never told its pipeline broke.
- **The WORDS have one owner here and the Error class does not.** Both callers
  throw a `ResourceHookError` of their own type — each package's errors are its
  own surface, and this package exports only pure functions (`FJS-D26`). What
  would drift between two hand-written messages is which phase and the two ways
  out, so that is `hookChainMessage`.
- **`mergeHooks` answers a NEW map.** It merged in place in both copies it came
  from; a pure function may not mutate its arguments, and that rule is this
  package's license rather than its style (`FJS-D26`). A caller upgrading has to
  assign the result. The failure mode after the change is a map that never grew,
  which is louder than one silently rewritten.
- **`formatMoney` is `Intl` and not a symbol table, and the reason is JPY.**
  What separates two currencies is not the glyph: it is which side it sits on,
  whether there is a space and how thousands are grouped. A hand-rolled
  `toFixed(2)` invents a minor unit the yen does not have. One locale by default — `en-US` with `currencyDisplay:
  'narrowSymbol'` answers `$28.00`, `£28.00`, `€28.00`; asking for each
  currency's home locale instead answers `US$28.00` for dollars, which is
  correct and is not what a price tag says.
- **The currency table is SHIPPED and the host's ICU is not asked** (`FJS-745`).
  Two facts made that necessary. `Intl.supportedValuesOf('currency')` answers 162
  codes under node and 306 under bun, differing on 145 — so `@money(ZWG)` parsed
  on one runtime and was refused as a typo on the other. And
  `resolvedOptions().maximumFractionDigits` disagrees on fourteen codes both
  carry: node says the Iraqi dinar has no decimal places, bun says three, ISO
  says three. **Neither runtime is wrong** — that number answers how an amount is
  DISPLAYED, which is CLDR's question, and `@money` derives its scale from how it
  is STORED, which is ISO 4217's exponent. `formatMoney` still asks `Intl` for the
  glyph, its side and the grouping, and pins the decimals to the exponent so one
  stored amount renders identically wherever it is read.
- **`minorUnits` refuses a code with no minor unit in its own words.** `XAU`,
  `XDR`, `XXX` and ten more are ISO codes and are not amounts — `isKnownCurrency`
  is true for them and `minorUnits` throws, because answering 2 would let
  `toMinor` invent a hundredth of a troy ounce. A typo and a metal are different
  refusals with different ways out.
- **An unrecognised 3-letter code does NOT throw, and the separator is a
  no-break space.** Intl accepts any well-formed code and prints it where the
  symbol goes, joined with U+00A0. Only a malformed code (fewer than three
  letters) raises, and that is the branch the `catch` exists for. An assertion
  written with a plain space fails against two strings that are identical in the
  diff.
- **`formatMoney`'s amount is MAJOR units.** 28.5 is twenty-eight fifty. It does
  not guess between major and minor, because a caller storing integer cents
  knows it and a caller storing a float does not — guessing between them is how
  a price gains two zeroes. `fromMinor`/`toMinor` are the crossing, and
  `roundMinor`/`allocate` are on the other side of it: everything they touch is
  minor units, and neither takes a currency at all.
- **`roundMinor` throws where every formatter here answers `''`.** Not a number
  is not zero either way, but display can say nothing and arithmetic cannot: a
  silent 0 in a total is a receipt that balances and is wrong. `allocate`
  refuses for the same reason rather than splitting evenly when the ratios sum
  to zero — a guess that adds up is the worst kind.
- **`allocate` has no `scale` and no currency, and that is not an omission.**
  The smallest thing a split can hand out is one of whatever `amount` is counted
  in, which the caller decided by holding an integer. `FJS-D154` was filed with
  a third parameter and it did not survive being written.
- **The canonical string is six lines and the query is the third.** Method,
  path, query, timestamp, nonce, body hash — joined with newlines, so no part
  may contain one. The query is the one line allowed to be EMPTY: a request with
  no parameters signs an empty line rather than omitting one, or a query could
  be smuggled into the path. It is canonicalised — pairs sorted by key then
  value, RFC 3986 encoded (`encodeURIComponent` leaves `!'()*` alone and the RFC
  reserves them) — because nothing preserves parameter order across a proxy or a
  client library, and an order-sensitive signature fails intermittently and
  reads as a clock problem.
- **The version rides in the signature VALUE, `v1-sha256=…`, and it is carried
  before anything needs it.** A signature on another version is refused by name
  before the digest is compared, because *signature does not match* is the same
  sentence a wrong secret produces and is the wrong half to spend an outage on.
  Nothing outside this repo signs anything, so there has only ever been one
  version; what the marker buys is that a second one costs
  `SIGNATURE_VERSION` and the prefix beside it, where a change that only alters
  the canonical string is a fleet-wide 401 nobody can diagnose.
- **`canonicalQuery` checks `Array.isArray` BEFORE `.entries()`.** An Array has
  an `entries()` of its own and it answers index/value pairs, so a list of pairs
  canonicalises as `0=to%2Calice` — a well-formed string that agrees with
  nothing.
- **`createStore` is NOT here and must not arrive.** `FJS-D16` named it to move
  and the ruling is amended: a store is state. Admitting one costs the standing
  that lets litestone and mesa import this package at all.
- **A spec body may be async, and the harness had to learn it.** `test(name,
  fn)` awaits a returned promise now; before that a rejection inside an async
  spec was an unhandled rejection reported as a PASS.
- **A highlighter fails silently or not at all.** It drops a character, the
  output still looks like code, and the reader copies a sample that does not
  work. The round-trip test over the whole corpus is the only one that matters;
  everything else in `glow.spec.js` is a detail.
- **`prefix: true` eats the first character of a CSS line.** `+`, `-` and `>`
  start a diff marker and are stripped. `--custom-prop` is disambiguated (two
  dashes are never a marker); `> .child` and `+ .sibling` cannot be, so a CSS
  caller passes `prefix: false`.
- **The corpus is a snapshot, not a mirror.** It is committed so this package
  has no cross-package dependency. A new *kind* of sample in the css guide is
  not covered until someone runs `extract.mjs`.
- **Everything `renderRow` pushes is a raw slice of the source, tokens and the
  gaps between them alike.** Both go through `encode()`. Two shapes have
  already leaked here: a rule matching more than one character, back when
  `elem()` encoded only a lone `<` or `>` (an HTML comment went to the page as
  live markup), and the gap text, which looked safe only because `<`, `>` and
  `&` are punctuation rules in most languages and so usually arrive as tokens.
  Do not move encoding back into a per-rule special case.
- **`encode()` escapes `&` FIRST.** Reverse the order and the ampersand of an
  escape the function just wrote gets escaped again, so a source line reading
  `&lt;` renders as a `<` the author never typed. Callers depend on this:
  mesa's `compiler-md.js` decodes a fence body precisely because glow re-encodes
  what it emits.
- **A comment that opens mid-line is a token, not a block.** `/*` anywhere on
  a line used to start a comment block and swallow the code before it, which
  reads as a disabled line. `isTrailingComment()` is the split; a comment
  that opens the line, or runs on, is still a block.
- **glow's output is elements, never classes** — `<em>` a value, `<sup>` a
  comment. `@frontierjs/css`'s `components/code.css` themes exactly that shape,
  so emitting a class here would silently break the theme rather than fail.
- **CI fails the build on an import that is not relative.** `scripts/ci.mjs`
  § hygiene checks the manifest for dependencies and every file under `src/`
  for a clock, a global, a network call and a non-relative specifier — the
  blunt rule catches a node builtin, a sibling and a registry package at once.
  A kit that genuinely needs one of those does not belong in this package.
- **`inflect` is load-bearing for Invariant 2, not a convenience.** litestone
  derives a table name with `pluralize` and reads it back with `singularize`,
  junction derives a model name from a service name, sierra indexes both
  directions — so a rule changed here renames tables. The irregular table is
  whole-word only for that reason: teaching it to reach inside `audit_index`
  would rename a table in every schema that already has one.
- **`directives` is load-bearing the same way `inflect` is.** A `$` key it does
  not name is not refused — it falls through as a FILTER, so the Data boundary
  reports a column nobody declared and the cause is three layers away. The kit
  holds the read direction only; junction's browser client writes `$` names from
  a typed `QueryDirectives` on two paths that share nothing, and junction's own suite
  asserts every name it emits is one this table strips. Adding a directive means
  both ends, and that test is what says so.
- **A new subpath is invisible to a vite that is already running.** The exports
  map is read at server start, so the error names the very file that plainly
  has the entry — *"./directives" is not exported ... (see exports field in
  .../toolbelt/package.json)* — and the app it was added for does not mount.
  Restart the dev server; nothing about the code is wrong.
- **`-ses` is split by a LIST and it has to be.** `statuses` → `status` and
  `cases` → `case` differ by whether the stem before `es` is itself a word, and
  no ending can see that — `status` and `cas` both end in a vowel plus `s`. So
  the default is strip one `s`, with an `-ss` rule and a closed list of
  singulars that genuinely end in a bare `s`. It stripped `es` for both until
  `FJS-479`, which made `purchases` resolve to `purchas`, which is a model
  junction cannot find, which is **no `@@gate` and no validation** on that
  service. Adding a word to the list is cheap; changing the default is not.
- **The irregular table is DATA ABOUT ENGLISH and a spelling sweep will eat
  it.** `analyses` is the plural of `analysis` on both sides of the Atlantic; a
  find/replace of `analyse` → `analyze` rewrote it to `analyzes` here **and in
  the test that asserted it**, in one commit, so the suite stayed green and
  `singularize('analyses')` answered `analyse` — a model junction cannot find.
  The header carries a warning; the structural guard is the one below.
- **The spec READS the table for the round trip and hand-writes the plurals for
  correctness, and the split is the point.** A copy of the table in the test
  grades nothing — it agrees with whatever the table says, including a plural
  nobody speaks. Measured: reintroducing `analyzes` leaves *every irregular
  round-trips* green and fails the corpus, and so does dropping `half`.
- **A round trip is not a correctness test here.** `pluralize('cas')` is
  `cases`, so `singularize`/`pluralize` agreed with each other for as long as
  both were wrong. Assert the singular you expect, not that it survives.
- **A word the rules cannot reach is still not a bug to fix here.** `lens` as
  an INPUT singularises to `len`: `pens` is a real plural with the same ending,
  so telling them apart needs a dictionary. `inflect.spec.js` asserts that
  limit rather than hiding it. (`lenses` → `lens` does work — that is the list.)

## Proving a change

`bun run test`, then the callers — a kit here is only correct in them:

| Changed | Run |
| --- | --- |
| `glow` | `packages/css`: `bun run test code` — it styles *real glow output*, injected by the css harness. A change to the element glow picks for a token breaks there, not here. Then `packages/mesa`: `bun run test`, whose markdown fences run it |
| `inflect` | `packages/litestone`: `bun run test` (table names), `packages/junction` and `packages/sierra`: `bun run test` (model resolution). A rule changed here renames tables — read the DDL snapshot diff before believing a green run |
| `units` | `packages/toolbelt`: `bun run test`, then `example`: `verify` and `verify:site` — the prices on a live screen and in a PRERENDERED file, which is the one place the formatter runs in node with no browser under it |
| `gate` | `packages/litestone`: `bun run test` (the boundary that enforces it) · `packages/junction`: `bun run test` — `session-gate-level.test.ts` asserts the export IS the kit's binding, which is the assertion four hand copies could not make · `packages/sierra`: `bun run test` (the screen's verdict). The kit's own spec walks the whole 216-case grid and the whole 0-9 square, because the drift was one branch and asking one grader about one caller is what hid it |
| `directives` | `packages/junction`: `bun run test` — the bridge strips by this table, and `live-order.test.ts` asserts both transports only emit names it holds. Then `packages/sierra`: `bun run test` (`page-query.test.js`), and `example`: `verify` for a real navigation |
