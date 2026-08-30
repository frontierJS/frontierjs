# Changes — @frontierjs/toolbelt

## 2026-08-29 — `fromMinor` / `toMinor`, beside the scale they read

`@money` stores a whole number of MINOR units and `formatMoney` takes MAJOR
ones, so something between a column and a screen has to divide. Every caller
reached for `/ 100`, which is right for the dollar, wrong for the yen by a
hundred and wrong for the dinar by ten — the same mistake `formatMoney` was
added to stop (`FJS-440`), one step earlier in the pipe.

The pair is in `/units` because `minorUnits` already is: the divisor is read
off ICU rather than shipped as a table, so it is the currency's answer and never
the caller's. `toMinor` ROUNDS, and that is the substance — `8.29 * 100` is
828.9999999999999, so the truncation a form reaches for first loses a cent on
the prices that look exact. An unknown code throws in both directions, as
`minorUnits` does.

`formatMoney` is unchanged and still takes major units: one function, one unit.

## 2026-08-29 — a compound survives its own round trip (`FJS-571`)

`singularize`'s two whole-word lookups — the irregular table and the `-ses`
bare-s list — never reached a compound, so `UserStatus` became the table
`user_statuses` and read back as **`user_statuse`**; `UserAlias` as
`user_aliase`; `sales_people` unchanged. A compound now goes through its head,
and through the SUFFIX RULES ONLY.

**`pluralize` is deliberately untouched.** Reaching inside a compound there
turns `audit_index` into `audit_indices` and renames a table in every schema
that already has one — a choice `inflect.spec.js` already pinned, and it stands.
The asymmetry is what makes the trip close: the table a model gets comes from
the regular rules, so reading it back must use those same rules.

The stakes are the ones the file already stated — junction derives a model name
from a service name with this, and a service that resolves to no model has no
`@@gate` and no validation, so the miss fails open.

## 2026-08-26 — `/match`, and `fieldShapes` under it

**`@frontierjs/toolbelt/match` — does this record belong in that query's
results?** `matchesQuery(fields, record, query)`, three answers: `true` upsert,
`false` REMOVE, `null` *cannot decide, ask the server*.

It moved out of sierra because there are two live stores and they had one
implementation between them. Sierra's asked; jetty's upserted whatever its
channel delivered, so a row that had LEFT the loaded filter went straight back
into the list (`FJS-493`). jetty may not import sierra, and a hand copy is what
`FJS-059` already paid for once — the fourth pure half to come down for exactly
that reason, after `/hooks`, `/jsonschema` and `/inflect`.

**`fieldShapes` is in `/jsonschema` and is the minimum `/match` reads**: field
name → `{ type, nullable }`. Two questions in one walk, because they come off
different places — nullability is on the RAW schema, and `derefFieldSchema`
follows the non-null branch of an `anyOf`, so by the time the target is in hand
the null branch is gone. Sierra's `buildFieldRules` computes its own `type` and
`nullable` through it now, so there is one answer to *what type is this field*.

The type is read for one reason and it is worth stating: the wire is text, so a
query built from a URL or a form control sends `'5'` for an Int, and SQLite's
affinity makes `WHERE id = '5'` match row 5 where `5 === '5'` does not. `{}` is
a legal fields table and degrades exactly one way — a string operand against a
numeric column reads as no match — which is what sierra has always done on a
schema-registry miss.

31 cases moved with the function (`test/specs/match.spec.js`), 6 more for the
shapes. Sierra keeps the SEAM: that `createResource` hands the matcher down,
built over the model it resolved, plus one line asserting its re-export is this
function and not a copy.

## 2026-08-26 — `$after` joins the directive table (`FJS-D145`)

One row, and both of Junction's transports plus Sierra's router read it — which
is the whole reason the table exists. Read with `asText` and never `asNumber`:
the token is base64 and a numeric-looking one must not be turned into a number.

# @frontierjs/toolbelt — changes

## 2026-08-25 — `/glow`: the languages this repo writes, and transcripts (`FJS-515`)

Found by moving `website/` off its own hand-rolled highlighter and onto this
one. Three of the four languages the site is written in were not highlighted,
and the fourth kind of sample — a transcript — could not be highlighted at all.

**`.lite`.** Both halves of a schema came out wrong. The generic attribute rule
takes one `@`, so it matched at the second one and every `@@gate` rendered as a
stray punctuation mark followed by an attribute. And a field's TYPE was coloured
only where the common keyword list happened to contain it case-insensitively:
`Int` and `String` were lit, `DateTime`, `Json`, `Boolean` and a relation to
another model were not. Matched by shape now — a capitalised word — so a new
scalar and a relation both work with no edit here.

**SQL.** Nothing in the common list is SQL and `--` was not read as a comment,
so a `CREATE TABLE` was one unlit line with its string literals coloured. The
shape of DDL is its keywords, which were the only part not marked.

**Shell, in the other direction.** `my`, `use`, `end`, `local`, `next`, `get`
and `set` are all in the common list and all ordinary argument text, so
`cd my-app` came out with `my` coloured as a keyword and `-app` as punctuation
after it — the directory name a reader is meant to type, in three pieces, on an
install command. `sh`/`bash`/`shell` join yaml/html/json in the keyword
exclusion; what replaces the keywords is the COMMAND, which is the token
somebody reading a shell line is looking for, plus flags and hyphenated words
kept whole.

**`language` may be a LIST.** A command and the SQL it compiled to, a request
and its JSON response, a query beside the WHERE clause a policy appended to it
— these are one block and two languages, and given either alone half of it goes
dark. `{ language: ['js', 'sql'] }` merges the rules, the keyword sets and the
line-comment syntaxes; the first entry stays primary and is what the wrapper's
`language` attribute carries, so `@frontierjs/css`'s theme is unchanged.
`mesa` was registered as a mixed-HTML language while there.

Five tests, each asserting the TEXT is unchanged as well as the marking — a
highlighter's one catastrophic failure is eating a character while the block
still looks like code. Green: toolbelt 210, css 470.

## 2026-08-24 — `/inflect`: `-ses` was stripping the wrong letter (`FJS-479`)

`singularize('purchases')` answered `purchas`. The `-ses` branch stripped `es`
for every word, which is right for `statuses` → `status` and wrong for most of
the language: `cases`, `releases`, `licenses`, `expenses`, `responses`,
`databases`, `warehouses`, `leases`, `houses`, `phases`, `courses` all resolved
to a word that is not one.

**The cost is not spelling.** `/inflect` is Invariant 2's one owner and
junction's `deriveModelName` is a caller, so a service named `purchases` over
`model Purchase` matched no model — and `_gateLevels` reads a lookup miss as
*no `@@gate` declared*. Measured against a real Litestone client: a `find` with
no caller at all passed `gateAuthAround` where the identical `posts`/`Post` pair
answered 401. `autoValidate` fails open through the same miss.

**A round trip could not see it.** `pluralize('cas')` is `cases`, so both
directions agreed on a non-word, and the spec asserted the round trip.

The fix is a default and a list: strip one `s`, strip `es` for an `-ss` stem,
and name the closed set of singulars that end in a bare `s` (`status`, `bus`,
`lens`, `bias`, `atlas`, …). A list rather than a rule because `status` and
`cas` both end in a vowel plus `s` — the distinction is *is the stem a word*,
which no ending carries. 22 pairs asserted in both directions.

Found by putting a real ERP's 188-model schema through litestone, where
`task_leases` became `model TaskLeas`. Nothing in this repo has a model ending
in `-se`, which is why the whole class was unreachable from its own schemas.

## 2026-08-23 — `/query`, the tenth kit: what a query string means

183 → 205 specs. The fourth invariant with as many answers as it had callers,
after `/inflect`, `/directives` and `/history`.

Sierra's router inferred types off a URL with `Number(value)`, so `?sku=007` was
the number 7 — the guess Sierra's own widget props already refuse for
`data-pid="007"`. Junction's transport did not infer at all, so a browser sending
`{ live: true }` reached the Data boundary as `"true"` and matched no rows. And
Junction's own two transports disagreed: the socket spread real JSON into a frame
and was always right, while HTTP `String()`d every scalar and dropped `null`
outright (`FJS-450`, ruled as `FJS-D125`).

**The number rule is one line and it is the substance**: a string is a number
only if `String(Number(v)) === v`. `'007'`, `'0x10'`, `'+1'`, `'1e5'`, `' 12 '`,
`'1.50'` and `'9007199254740993'` all stay strings — the last because the round
trip loses its final digit, which is how a snowflake id survives being filtered
on. `true`/`false`/`null` are themselves, structure is bracket notation
(`?qty[gte]=10&id[in][]=1`), a repeated key is an array, and `?code="5"` is the
one escape for text that would otherwise read back as something else.

`encodePairs` answers PAIRS rather than an object, because an object cannot hold
`k[]=1&k[]=2` — the second write lands on the same key and the array arrives with
one element, which is the shape the kit exists to carry.

**It ships a `.d.ts`**, the first kit here that does. Every other one is imported
from a package whose tsconfig sets `allowJs`, which is what `@frontierjs/config`
gives an app; this one is reached from `@frontierjs/junction/client`, whose type
surface an app may compile under its own options — where a kit with no
declaration is a TS7016 in somebody else's build.


## 2026-08-23 — `/units` grows money

180 tests, 0 fail.

The other magnitude every app formats by hand. `example` wrote
`` `£${n.toFixed(2)}` `` in five files and its API wrote a bare `toFixed(2)`
into two email bodies — an amount with no currency at all, in the one place a
reader is being told what they were charged. `FJS-408`'s shape, one magnitude
later (`FJS-440`).

`Intl.NumberFormat` and not a symbol table, because what separates two
currencies is not the glyph: it is which side it sits on, whether there is a
space, how thousands are grouped and how many decimals the currency HAS. JPY
takes none and a hand-rolled `toFixed(2)` invents two.

One locale by default. `en-US` with `currencyDisplay: 'narrowSymbol'` answers
`$28.00`, `£28.00`, `€28.00` — the bare symbol every time. Each currency's own
home locale would answer `US$28.00` for dollars read from London, which is
correct and is not what a price tag says.


## 2026-08-22 — `/json` can name a place in a document

`accessorPath(path, root)` → `headers["content-type"]`, and
`jsonPointer(path)` → `/odd/a~1b`.

Both exist because the naive spelling is the one that looks right and does not
work. `a.content-type` parses as a subtraction and `a.0` is a syntax error, so
an accessor built by joining with dots produces something a reader copies and
pastes and then has to debug. A pointer built by joining with slashes names a
member that does not exist the moment a key contains one — which is exactly
what RFC 6901's `~0`/`~1` escapes are for, and the whole reason it needs a
function rather than a join.

Two spellings rather than one because they answer different questions: the
accessor is what goes into code, the pointer is how a JSON Schema validator
says which member it refused, so a pointer copied out of a tree can be searched
for in a validation report.

## 2026-08-22 — `/json` can find something in a document

`searchDoc(value, term)` and `markRuns(text, term)`.

`searchDoc` has the same shape as `diffDocs` on purpose: a caller filtering a
tree and a caller diffing one are answering the same question about the same
walk — *which of these rows matter, and what has to be open for them to be on
screen at all*. The second half is the one that is easy to miss. `treeRows`
only emits children of an OPEN container, so a match four levels down is not a
row yet; a filter that does not answer `open` finds everything and shows
nothing.

Two rules that make it behave the way a person means it. A container whose own
key matches keeps its whole subtree, because *find me `tags`* is not a search
for the word. And a value is matched as **the text a reader sees** — so `null`
is findable by the word on screen and a number by its digits, which is what
gets typed.

`count` is hits, not kept rows: the ancestors carried along to reach a match
are not matches.

`markRuns` splits text into runs, every occurrence marked rather than the
first — marking one and not the next says *this is the one*, which is a claim a
highlighter cannot make — and the runs carry the ORIGINAL casing, so
highlighting never rewrites what the document says.

## 2026-08-22 — `/json` can change what KIND a value is

`convertTo(value, kind)` and `JSON_KINDS`. The deliberate counterpart to
`coerceLike`, and the two are not in tension: an ordinary edit hands back text
from a text box, so the type it replaces has to survive — without that every
edit degrades one step until a boolean is the string `"false"`, which is truthy.
Changing the type is a different act and now says so.

Lossless wherever a natural mapping exists, and it exists more often than it
looks: an object becomes an array of its values, an array becomes an object
keyed by index (and that round-trips), and a **string that parses as the kind
being asked for becomes the parsed value** — so pasting a document into a text
field and then saying *object* does what it looks like it should.

Two rules that are easy to get backwards. `'false'` converts to `false`, because
that is what a person typing it means and every non-empty string is truthy in
JavaScript. And a number that cannot be read is `0`, never `NaN` — NaN is not a
JSON value, so the alternative is a document that cannot be serialised, written
by a control that looked like it worked.

Where no mapping exists the value is dropped: a string asked to become an object
has nothing to carry over, and inventing a key to put it under would be worse
than losing it.

## 2026-08-22 — `/json` can compare two documents

`diffDocs(before, after)` and `sameValue(a, b)`. The first answers a merged
document plus what happened at each path, which is what makes a diff renderable
at all: a removed key is in neither `after` nor any tree built from it, so a
viewer handed only the new document shows every change except the ones that
took something away. `merged` carries a removed entry at its old value, marked,
and one walk renders all three states.

It also answers `open` — every ancestor row on the route to a difference — so a
change three levels down is not folded away behind a summary that says nothing.

Two limits are stated rather than papered over: arrays compare **by position**,
so removing the first of three reads as two changes and one removal; and a path
whose two sides are containers of different kinds is one `changed` and is not
recursed into, because nothing below it corresponds and every descendant would
otherwise be reported twice over.

`count` is leaf level. A container is marked `changed` in `status` so a
collapsed branch can say something moved, but it does not add to the count — it
is a rollup of the rows under it.

## 2026-08-22 — `/units`, because four copies gave one disk two sizes (`FJS-408`)

145 tests, 0 fail.

`formatBytes` was written four times: once in `@frontierjs/ui`'s `FileUpload` and
once each in basecamp's hub, cleanup and volumes screens. The app copies rounded
to whole units and the kit's answered one decimal, so the same number read
differently on two screens of one application — and three of the four were
formatting DISKS, which is nothing to do with an upload.

Binary steps with familiar labels (1024, called MB), adaptive precision (one
decimal below ten of a unit, none above, never on bytes), `decimals` to fix it,
and `''` rather than `0 B` for a value nothing has answered.

It is here rather than in the component that owned it first because the server
reports those same sizes and a `.mesa` import needs the Mesa build plugin —
`FJS-D116`'s second boundary, met the day it was ruled.

## 2026-08-22 — `glow` gives JSON its three keywords (`FJS-405`)

`true`, `false` and `null` were the only values in a highlighted JSON document
with no colour at all. `getTags` withholds the COMMON_WORDS keyword pass from
json, yaml and html — rightly, since every other bare word in a JSON document is
inside a string — which left the three literals matched by nothing, so a `null`
and a key spelled `"null"` rendered identically.

One rule in `RULES.json`, using the role `@frontierjs/css` already themes
(`code[language] strong`), so it cost no stylesheet.

**A keyword inside a string is safe by position, not by rule order.** A rule
added to `RULES.json` is unshifted to the FRONT of the tag list, so nothing
about the ordering protects `"is null"`; what does is `renderRow` dropping a
token that opens inside one already emitted, and the string token starts at the
quote, which is earlier. That is the property the new spec asserts, along with
a key spelled like a keyword staying a key.

## 2026-08-22 — `/json`, the eighth kit

135 tests, 0 fail.

Reading and editing a JSON document nothing describes. `classify`, `arrayKind`,
`mergeKeys`, `summarize`, `preview`, `tryParse`, `format`, `coerceLike`,
`pathKey`, `getIn`, `setIn`, `removeIn`, `insertIn`, `renameKey`, `treeRows`,
`expandToDepth`.

Every other shape this framework renders arrives with a schema and a control
chosen for it by one table; a `Json` column is the exception — the seed says
`Json` and stops — so the only description of what is inside is the value
itself. Deciding what a value IS, what an edit does to it and which rows a tree
shows are pure questions, which is why they are here rather than inside the two
components that ask them (`@frontierjs/ui`'s `Json` and `JsonInput`).

**Every write answers a copy.** An in-place edit reaches a reactive runtime as a
value `===` to the one it replaced, so nothing re-renders — and the two edits
people make most often are the two an in-place model gets wrong. `renameKey`
rebuilds the object in place in the key order, because `delete` + set sends the
key to the end and correcting a typo in the first field of a form drops it to
the bottom with no way back; `removeIn` removes by INDEX, because removing by
value identity takes the first equal item, which for `["a","b","a"]` is not the
one that was clicked. Both shapes were live in the Svelte tree this kit was
read from.

**A path is an array, never a joined string.** `['a.b']` and `['a','b']` join to
one string, so a view keyed by that join renders one row for two nodes and
expands both at once — the same injectivity argument `/history` makes about an
occurrence key. `pathKey()` is JSON for exactly that reason.

`tryParse` answers `{ok, value}` or `{ok, error, position}`. The shape it
replaces returned `undefined` for a failure and for a valid `null` alike, and
rejected `42`, `"text"` and `true` — three of the seven things a JSON document
may be — as invalid.

## 2026-08-19 — `/signature`, the seventh kit (`FJS-349`)

82 tests, 0 fail.

What a signed machine-to-machine request looks like: `canonicalRequest`,
`signRequest`, `verifyRequest`, `sha256Hex`. Method, path, timestamp, nonce and
a hash of the body, joined with newlines — byte-identical to what conduit's
transport built by hand, which now reads this instead.

**Three signers existed and no verifier.** Conduit signed what it sent to an
Outpost, junction's webhook plugin signed a delivery with a different string,
and basecamp's Outpost endpoints took no credential at all behind a comment
saying the transport had verified one. A verifier is not a second
implementation of a signer, and one function is how you are sure of that.

`verifyRequest` answers `{ok, reason}` rather than a boolean — a clock 40
seconds out and a wrong secret are the same 401 to a caller and completely
different problems to whoever is fixing it — and the replay check runs LAST, so
a caller who never held a valid signature cannot fill somebody's nonce store.
The comparison is constant-time. Storing nonces is I/O, so it stays the
caller's: `seenNonce` is a function, and omitting it is a decision rather than a
silent default.

The test harness gained `assert.match` for the same reason: a spec asserting
only `ok === false` passes against a verifier that refuses everything.


## 2026-08-18 — `/history`, the occurrence key (`FJS-342`)

71 tests, 7 of them new, 0 fail.

Four mechanisms answered *has this exact unit of work already happened?* and each
built its own key at its call site: junction's idempotency claim, junction's
outbox relay, caravan's cron fire, and the id a caller states on a dispatch.
There was no place to ask what an occurrence key IS, which is how two of them
came to interpolate caller-supplied text into a `:`-joined string without
escaping it.

`occurrenceKey(kind, ...parts)` is the one definition, and the property it
exists for is INJECTIVITY. `%` is escaped before `:` — escaping only the
separator is not injective, so a part reading `%3A` and a part holding a real
colon would encode to the same bytes. A `null` or `undefined` part is refused
rather than stringified, because `cron:daily:undefined` is one key every fire of
that job shares, made permanent by the primary key it becomes.

The `kind` is separate from the parts so two mechanisms writing into one table
cannot collide by arithmetic: an outbox row with id 7 and a caller who states
`7` are not the same unit of work, and only a namespace can say so.

`assert.throws` joined the harness with it — every other kit here is total, so
nothing had needed one.

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
