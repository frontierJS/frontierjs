# toolbelt — layout

The file-by-file map of `@frontierjs/toolbelt`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
src/glow/glow.js     source code → highlighted HTML. The first kit.
src/inflect/         How a name is spelled — number, shape, and the reader.
                     One definition across litestone, junction and sierra, plus
                     `humanize` for the screen. The third axis is the one that
                     may change when a reader changes and the other two may
                     not (`FJS-D236`). `toolName` is the MCP spelling of a
                     method, here because the projection AND the view a host
                     loads in an iframe both say it (`FJS-D197`)
src/cron/            what a five-field cron expression ADMITS — a Set per
                     field. Caravan and junction's `app.scheduler` each had a
                     parser and they were broken differently, so one expression
                     named two schedules (`FJS-767`). Four fields AND and the
                     two date fields OR (`FJS-1008`). Which clock, and when a
                     timer looks, stays with each scheduler: `cronMatches` takes
                     clock parts rather than a `Date`. Ships a `.d.ts` — both
                     callers are TypeScript
src/ids/             the generators behind `@default(uuid()|ulid()|cuid()|
                     nanoid())`, plus `mintId(kind)`. Two callers were on a
                     server — litestone's SQLite client at insert time and its
                     jsonl driver — and the third is a BROWSER: a row written
                     with no server reachable is referenced by its children
                     before any INSERT has happened, so the client states the
                     key. `crypto.getRandomValues` and never `node:crypto`,
                     which parses on a server and kills a bundle at PARSE.
                     `mintId` answers null for a kind it has no generator for,
                     because the caller is deciding whether it CAN. Ships a
                     `.d.ts` — sierra reads it
src/geo/             where a row is, as arithmetic over two numbers. Five
                     functions by ruling (`FJS-D325`) — a hull and a buffer are
                     a geometry spine and stay out. **`boundingBox` returns a
                     LIST of boxes**: a radius crossing ±180 is TWO, and one
                     inverted box matches nothing and says nothing; a radius
                     reaching a pole widens to the whole parallel and says
                     `full`, so a compiler drops the clause rather than emitting
                     a tautology. Every box is a PREFILTER and wider than the
                     circle, so the exact `distance` runs after it — the spec
                     compares against a brute-force scan at the equator, at a
                     pole and across the seam. `centroid` averages as VECTORS
                     (the mean of -179 and 179 is 180, not the wrong ocean) and
                     `polygonArea` is spherical excess. Ships a `.d.ts` — the
                     browser client reads it
src/units/           a magnitude with a unit, as a person reads it. Bytes:
                     binary steps, familiar labels, adaptive precision — four
                     callers had four copies and two answers (`FJS-408`).
                     Money: `Intl.NumberFormat`, one locale, the bare symbol —
                     five copies in one app and two email bodies with no
                     currency at all (`FJS-440`). Arithmetic: `roundMinor`,
                     `divRound` (the same two modes over a BigInt quotient,
                     for a rate × quantity past 2^53, `FJS-2142`) and
                     `allocate`, the rounding mode and the leftover unit
                     `@money` deliberately left to the app (`FJS-D154`).
                     MEASURES: the symbol table behind `.lite`'s `@unit`
                     (`FJS-D348`) — one row per unit, carrying its dimension
                     and its factor to that dimension's base. Length and
                     information are READ off `LENGTH`/`BYTE_UNITS` rather
                     than restated, so a unit added there is one a schema can
                     declare; `mo` and `yr` carry `factor: null`, because a
                     month has no fixed length and a factor would be a lie a
                     caller could not see — `convertUnit` refuses them by name
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
src/directives/      the `$` convention — which params are directives, how a
                     bag of them splits into filters + directives, and the way
                     back. Two boundaries read it (junction's bridge, sierra's
                     router) and two callers WRITE one: junction's browser
                     client, and a page rebuilding a URL. Also `orderByPair` and
                     `orderByValue`, the one directive whose VALUE has three
                     legal shapes — read by `<Table>`, which is a third realm
                     again (`FJS-1077`). Ships a `.d.ts`, for `/query`'s reason
src/query/           what a query STRING means — types, structure, and the way
                     back. Sibling of /directives: that one says which params
                     are directives, this one says what the values are. Three
                     readers — junction's transport, junction's client writing
                     one, sierra's router. Ships a `.d.ts`, because junction's
                     browser client reaches it. Also what a `$orderBy` /
                     `$select` VALUE means (`normalizeOrderBy`, `normalizeSelect`,
                     `comparatorFor`): the server compiles it, the live list
                     places a pushed row by it, and `<Table>` sorts its own
                     rows by it (`FJS-D672`)
src/docfences/       the fenced blocks of a markdown page and the contract on
                     their info string (`fragment`, `throws`, `failing`), with
                     the schema in scope for each. Litestone's doc-example
                     runner, `fli check`'s `doc-examples-run` and the doc audit
                     each had a fence regex and disagreed on indentation, `~~~`
                     and what closes a block (`FJS-D909`, `FJS-2331`). A
                     fence closes on the same character at least as long, so
                     a four-backtick block can show a three-backtick one
src/frontmatter/     what a `---` block MEANS — a declared YAML subset
                     (`FJS-D549`): block maps and lists, `|`/`>`, flow, quotes,
                     YAML 1.2 core scalars (a date stays a string). Anchors,
                     aliases, tags and merge keys are REFUSED by name, which is
                     what retired sierra's `FJS-821` expansion bound. Read by
                     sierra's scanner, mesa's `.md` compiler and fli's command
                     files — two readers answered two objects for one ksite
                     menu (`FJS-1541`). `frontmatterValue` is the writer's
                     half: plain where plain reads back, otherwise quoted.
                     `frontmatterPositions` is where each value is written
                     (path, line, and a one-line value's offsets): Mesa
                     stamps a preview with it and site-kit writes one back
src/cells/           one cell of a file somebody else wrote, read as the type
                     its column declares or a reason it cannot be — never a
                     guess, and a reason never quotes the cell, since the text
                     may be what the column protects. Litestone's seeder and
                     its query reader
src/history/         `occurrenceKey` — the one definition of *this unit of work
                     already happened*
src/match/           does this record still belong in that query's results.
                     Three answers, `null` meaning *ask the server*, because a
                     matcher forced to return a boolean has to guess. Read by
                     sierra's tether and jetty's. It reads TWO other kits
                     and both are deliberate: `/directives`, so a `$` name is
                     not graded as a column, and `/geo` + `/units` for `near`,
                     which is the one operator whose operand is a structure —
                     a distance between two points this side is holding is not
                     a fact it may plead ignorance of (`FJS-D326`)
src/mime/            what a file's bytes ARE, and what may be said about them
                     on a wire. Five questions because the four callers each
                     answered a different subset — the type, its charset,
                     whether to compress, whether it may be served INLINE, and
                     `sniff`, which reads the magic number and is the only thing
                     that can grade a NAME's claim against its bytes. Four
                     tables disagreed on 24 of 32 extensions and the recorded
                     `.wasm` fix had reached one of them (`FJS-1186`). Ships a
                     `.d.ts` — junction's static transport is TypeScript
src/mailbox/         `formatMailbox(address, name)`, a mailbox as a header
                     writes it. Junction's SMTP writer and each inbound mail
                     connector rendered it, and the copies drifted; a connector
                     may not import junction (`FJS-D1091`). Renders, never
                     grades; encoded-words for a non-ASCII name stay junction's,
                     because they are a wire encoding. Ships a `.d.ts`
src/env/             `envSource(key, env)` and `fileValue(text)`: a key held
                     in the variable or in the file `<KEY>_FILE` names, both set
                     refused. Junction's `defineEnv` and litestone's CLI both
                     read ENCRYPTION_KEY, and litestone may not import junction.
                     The caller reads the file. Ships a `.d.ts`
src/bearer/          what a bearer secret looks like at rest — `fingerprint`
                     (a keyed digest, `purpose` REQUIRED so one token does not
                     digest identically in two tables), `matchesFingerprint`
                     and `timingSafeEqual`. A fast digest rather than bcrypt on
                     purpose: a minted token cannot be guessed at any cost and a
                     guest pays this per call, so the expense would buy nothing
                     and cost the hot path (`FJS-D339`). Ships a `.d.ts` —
                     junction's resolver is TypeScript
src/signature/       what a signed machine-to-machine request is — canonical
                     string, sign, verify. Three signers existed and no verifier.
                     Two forms of one scheme: a shared `secret` (`v1-sha256=`)
                     or an Ed25519 key pair (`v1-ed25519=`,
                     `generateSigningKeys`) for a stranger whose server
                     shares nothing with it (`FJS-D981`).
                     `signMessage`/`verifyMessage` are that pair over a
                     message outside any request — a Pony Express letter.
                     Also `mintToken`/`readToken`: a short, case-safe token over
                     ONE id for a plus-address — lower-case Crockford base32, an
                     80-bit MAC over `purpose:id`, expiry read from the id's ULID
                     (`FJS-1941`)
src/frontier/        what a Frontier member IS — a chain of links, each signed
                     by one of its machines, from a root link signing the first
                     machine and the sealing key (`FJS-D1416`); a `link` adds a
                     machine, countersigned by the new one (`FJS-D1418`), a
                     `revoke` takes one out and carries a new sealing key
                     (`FJS-D1419`), a `paper` is a `link` whose key is printed
                     as words (`FJS-D1420`), and `askCode` is the hash a new
                     machine's eight words read. A machine's box key is its own
                     pair, claimed outside the chain. Also the member ROW
                     (`signRow`, `readRow`, `ROW_AGE`): the post's word on a
                     nick, number and lineage, signed with the post's own key
                     and refused past a day (`FJS-D1445`, `FJS-D1467`). Read by
                     fli, by the post's Worker (bundled by wrangler, so nothing
                     here may need node) and by Haven's login
src/seal/            a value only one key can open — `seal(publicKey, data)`,
                     `open(privateKey, sealed)`, `generateSealingKeys`. RFC
                     9180's base mode (DHKEM-X25519, HKDF-SHA256, AES-256-GCM)
                     in WebCrypto, so a terminal and a browser seal with one
                     function; any HPKE library opens it under `info`
                     `frontierjs/seal v1`. A second X25519 pair beside the
                     Ed25519 one, never converted from it (`FJS-D1400`).
                     Both generators take a 32-byte `seed` and draw nothing,
                     through `signature/seeded.js` (not an entry), so a key
                     written down as words is the same key typed back
                     `open` answers null for what does not open and throws
                     only for a private key that does not parse. Pony
                     Express's letters are the caller (`FJS-D1400`,
                     `FJS-D1402`)
src/sigv4/           AWS Signature V4 — sign, presign, `deriveSigningKey`, and
                     the canonical-URI rules AWS's own suite grades. Litestone's
                     `File` columns and `conduit-s3` sign the same requests, and
                     conduit may not be imported by litestone (`FJS-D892`).
                     **The clock and the signing-key cache are the CALLER's**:
                     `opts.now` is required (a missing one throws rather than
                     reading the host clock) and `opts.signingKey` is the day's
                     key a caller derived once. Ships a `.d.ts`
src/trace/           what a W3C `traceparent` says — `parseTraceparent`.
                     Junction derives a request's correlation id from it and
                     conduit continues the trace with it, so a header one
                     accepted and the other refused would split one request
                     into two ids (`FJS-D660`). Ships a `.d.ts` — both
                     callers are TypeScript
src/sse/             the `text/event-stream` frame, both ways — `formatEvent`,
                     which junction's `ctx.sse()` writes with, and
                     `parseEvents`, one decoded chunk plus the state the last call
                     answered (a rescan of the pending event per chunk was
                     quadratic, `FJS-2193`), which
                     sierra's `readEvents` reads with. Every page reading a
                     stream had written a reader, splitting on `\n\n`
                     (`FJS-1581`). `data` is JSON both ways; a line that is not
                     JSON reads as its text. Ships a `.d.ts` — junction's
                     `SseEvent` extends it
src/devline/         the one line a dev server prints for the `fli dev` that
                     started it, under `FLI_DEV` — `ready` (URL, one row per
                     thing it brought up) or `warn` (a file and a message).
                     Junction and Sierra write it, fli reads it; a line that
                     does not parse is `null` and printed as ordinary output,
                     so a drifted writer costs a summary row and never a line.
                     Ships a `.d.ts` — junction writes it
src/rank/            the key behind `@rank(scope:)` — a base-62 string compared
                     BYTE by byte, never ending in '0', so there is always room
                     between two. `between` splits a gap at its middle,
                     `jittered` by coin flips so two devices splitting one gap
                     rarely tie, `after` is the shortest later key (the append
                     default; the midpoint to the end grows a digit every six),
                     `spread` the even fixed-width keys a rebalance writes.
                     Litestone mints the default and the rebalance, sierra's
                     `resource.move()` mints on a device that may be offline,
                     and the two must agree on the comparison (`FJS-D366`).
                     Ships a `.d.ts` — sierra reads it
src/redact/          *is this key a credential* — the question
                     `$protectedFields` cannot answer, because `authorization`
                     and `cookie` are on no row. Junction's logger, `defineEnv`
                     and conduit's URL userinfo all asked it, and a list each
                     would have drifted. It owns the WALK too, so
                     `redactProtected` is a predicate rather than a second walker
src/predicate/       the `.lite` expression language, whole. `tokenize.js` is the
                     LEXER — litestone's, moved, so a schema and a flow
                     expression cannot lex two ways (`FJS-D287`). `parse.js` is
                     the GRAMMAR, in two dialects over a cursor the caller
                     supplies: a policy's, over one record, and a flow's, which
                     adds `$.a.b`, calls and lambdas and refuses a bare name
                     (`FJS-D271`, `FJS-D284`-`FJS-D286`). The rest:
                     does this record satisfy a declared expression —
                     litestone's own `evalJs`, MOVED rather than copied, because
                     a `@required(where: …)` condition is answered against the
                     record on screen as somebody types and neither sierra nor
                     `@frontierjs/ui` may reach litestone's internals.
                     `compileSql` and this are still the two halves an oracle
                     holds together, so a second CALLER is not `FJS-195`'s third
                     compilation (`FJS-D259`). `values.js` is the same language
                     as TEXT that yields VALUES (a stored template's `{ … }`):
                     `parseText` makes the cursor and refuses trailing tokens,
                     `assertValues` refuses `auth()`, `now()`, `check()`,
                     `.some()` and any name off the caller's closed list (own
                     keys only), and `evaluateValues` grades again before it
                     answers, because `evaluate`'s resolver defaults are a
                     policy's (`FJS-1998`). `template.js` is a `@generated`
                     backtick template: `templateShape`, which litestone
                     compiles to SQL, and `formatTemplate`, which a screen
                     previews a draft with, so the two cannot shape it two ways
                     (`FJS-D1112`)
src/fill/            merge fields into text a user wrote -- `fill(source, ctx,
                     { mode })` and `check(source, names)` (`FJS-D980`). A hole
                     is `{path}` or a `/predicate` values expression; `\{` is a
                     literal brace. `mode` is REQUIRED, `html` escaping a value
                     and `text` not, because a body's format is stated and never
                     sniffed from its tags. `segments(source)` is the scan both read, exported for a
                     caller that hides holes from another reader (email-kit's markdown). orion's `data.template` and every
                     app that stores a template are the callers. `mergeFields`
                     is the catalog (`FJS-2683`): `{ key: 'owner.field', label,
                     example, default, type }` declared once, read as the
                     editor's `list`, the preview's `example`, the save-time
                     `check` and the render's `fill` (a `default` stands in for
                     a missing value); `.with(rowFields)` adds a template row's
                     own; `schema(filter)` is the sender's form as a JSON
                     Schema keyed by `owner.field`, which Sierra's field rules
                     grade and draw (`FJS-D1204`) -- a `money` field must state
                     its `currency`. Ships a `.d.ts`
src/search/          ranked fuzzy matching, adapted from quick-score (MIT,
                     `LICENSE` beside it). Two callers, both in @frontierjs/ui:
                     CommandPalette and MultiSelect. `rank`'s `words` and
                     `weights` call the scorer per word per field themselves,
                     because QuickScore scores one query and keeps one key
src/hooks/           the four-phase resource pipeline — before · after · around
                     · error — plus `hookContext`/`answered`, which is whether
                     anything ever produced a result, and `hookChainMessage`,
                     what to say when nothing did. Two callers: sierra's
                     createResource and jetty's
src/json/            reading, editing and COMPARING a JSON document nothing
                     describes — classify, the immutable writes, the flattened
                     tree, and diffDocs. Two callers, both in @frontierjs/ui:
                     the Json viewer and the JsonInput control
src/transforms/      what `@trim`/`@lower`/`@upper`/`@slug` do to a value, in
                     declaration order and BEFORE any check. Litestone applies
                     them at the Data boundary, junction before it grades a
                     payload, sierra before it grades a form field; two tables
                     would disagree about what is valid (`FJS-401`)
src/jsonschema/      the CONSUMER half of what litestone emits — follow a
                     `$ref`, and what a blank record of this model looks like.
                     Same two callers
src/markdown/        Markdown somebody else wrote → HTML with no tag the text
                     wrote (`IDEAS/markdown-kit.md` option C). Raw HTML is
                     escaped, never passed through, so there is no sanitizer;
                     a link is http, https, mailto or relative; an image is a
                     link to it. The same function at prerender and in the
                     browser (`FJS-D821`). Caller: ui's Markdown component
src/keys/            a key sequence read against a keymap — vim's chord
                     spelling (`FJS-D1383`), the trie built once per platform,
                     and `step`/`flush`, pure over a `now` and a text flag the
                     host passes (`IDEAS/keys.md`). `chordOf(e)` is the one
                     crossing from an event. Mesa's `keys()` and `hotkey()`
                     are the hosts, ui's `rowlist`, and sierra's terminal shell, which steps
                     a keypress before the runtime makes a keydown of it. `browserOwned` lists the rows a
                     tab never receives — `BROWSER_OWNS`, read from Chromium's
                     and Firefox's reserved keys and the OS defaults — on BOTH
                     platforms, so a refusal is the same on every machine; a
                     key a page may cancel (`<Mod-s>`) is not on it.
                     `withOverrides(table, changes, { actions })` is khat's:
                     `nop` unbinds, a row that cannot apply is a warning and
                     never a throw, and the table it answers always builds
src/textbox/         a text control edited by vim's keys — `textbox()` state,
                     `edit(state, action)`, and `NORMAL`/`INSERT`, the
                     tables a host hands to `/keys`'s `keymap()` and steps
                     with `text: false` in both modes, since under `true` Esc
                     is the control's (`FJS-D1386`). khat's `input.rs` cut to
                     L1 (`IDEAS/keys.md` 4.1): flat rows, no operator grammar,
                     no `j`/`k`. Offsets are UTF-16, a `<textarea>`'s unit;
                     `h l x` step a grapheme. `edit(s, 'sync', { text,
                     cursor, anchor })` takes back what the control typed or
                     where a click left it; a sync that only moves the cursor
                     keeps `redo`. Caller: ui's `<Textbox>`
src/textedit/        `locateText` — an element's words swapped where its
                     `.mesa` or `.md` source wrote them, or `{ why }` when that
                     takes a guess (interpolated, split by markup, written
                     twice, or new words carrying markup). A `.md` is
                     searched in the block the stamp's line opens, then the
                     whole body when a save has moved that line. Pure over
                     the source text, so a caller holding a git blob makes the
                     edit a dev server's disk does. Callers: fli's ask panel
                     (`/text` in `core/vite-ask.js`) and basecamp's
                     `drafts.save` (an owner's click on a draft's preview)
src/tty/             `@frontierjs/css`'s tones as a terminal says them — each an
                     ANSI palette INDEX, so the terminal's theme picks the shade,
                     and `muted` the dim bit (`FJS-D37` §1, `FJS-D1423`).
                     `toneOf(cls)` reads one off a class attribute. Mesa's
                     terminal runtime is the caller; its `terminal-tags.test.js`
                     holds the names to `tones.css`
docs/glow/           the Svelte editor and SCSS theme glow arrived with.
                     Reference only — not shipped, not FrontierJS code
src/datetime/        an instant read as a place's wall clock, and written back —
                     partsIn, resolveWall/fromWall (0, 1 or 2 instants),
                     format's token language, relative, and createDatetime,
                     which binds locale, zone and an app-supplied clock.
                     Plus the PLAIN DATE half — plainDateIn, addToDate,
                     daysBetween, startOfDay — a day in no zone, which is what
                     a billing period is (`FJS-D288`): the zone is spent at the
                     two crossings and the calendar arithmetic has none.
                     Temporal's words over plain values, not its classes
                     (`FJS-D268`). And `dueAt`, when a `@@commitment` falls due
                     on a row — here because litestone answers it beside its
                     SQL and a screen answers it off `x-commitments`, and two
                     copies disagree first about a month added to the 31st.
                     It reads `/units` for a duration's factor. Ships a
                     `.d.ts` — caravan reads zone parts
test/run.js          the harness
test/specs/          one .spec.js per export
test/fixtures/       guide-samples.json — 137 real samples from the css guide
                     extract.mjs — regenerates it
                     datetime-vectors.json — Temporal's answers around every
                     transition in twelve zones; datetime-vectors.mjs regenerates
                     it from a polyfill installed OUTSIDE this package
                     frontmatter-compare.mjs — the kit against js-yaml's core
                     schema over real files; js-yaml installed OUTSIDE too
```

**`@frontierjs/utils` and `packages/datetime-kit/` are gone** — both folded in
here. An import of either name is stale, and the published `@frontierjs/utils`
0.1.x on npm no longer moves. **`createStore` did not come with them and must
not** (`FJS-D111`): a store is state, and purity is the whole argument for the
license.
