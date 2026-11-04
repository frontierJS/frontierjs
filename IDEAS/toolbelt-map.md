---
id: toolbelt-map
status: proposed
dated: 2026-11-03
---

# Toolbelt map — Deno's standard library as the checklist

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built except where a row
says so. Do not cite this file as describing behavior — see `VERIFYING.md`.

This paper answers the question of which generic pieces the substrate should hold.
It keeps the admission test from
`shared-pure-functions.md` § The rule to adopt — **extract when two copies
drifting apart would be a defect, not when two copies exist** — and
toolbelt's own license (`FJS-D26`): pure, zero dependencies, a fact with
one answer. What it adds is a checklist and a cause. The checklist is
[Deno's standard library](https://jsr.io/@std), 43 single-job modules
on web standards. That library records which helpers JavaScript programs
keep rewriting. The cause is discovery: half of the copies found below
re-implement a kit toolbelt already ships.

`toolbelt-admissions.md` stays the home of the debounce and frontmatter
arguments. `shared-pure-functions.md` § Refuse stays binding on `sleep` and on a
single `deepMerge`.

## The sweep that prompted this

On 2026-11-03 a session found five edit-distance functions (junction config,
litestone ×3, site-kit's `levenshtein`), and another session had just
done the same with a different helper. A sweep of `packages/` and `example/`,
skipping tests and build output, matched definitions by name and by body
shape. **These are leads, not counts.** The 2026-08 survey found name
counts ran about 3× high, so Phase 0 reads each group side by side before
anything moves.

**Kit exists, caller wrote its own anyway:**

| Concept | Toolbelt already has | Copies found |
| --- | --- | --- |
| relative time | `/datetime` `relative(instant, now)` | ~14 `ago`. **Read 2026-11-03:** the mesa, basecamp/web, workbench/web and notices versions already wrap the kit. Haven ×6, `cli/console/Ship.mesa`, `Check.mesa` and `litestone/src/tools/cli.js` print a compact `5m` / `3h`, a form the kit does not have, so they are not copies of it |
| slug | `/inflect` `slug` | ~8: `basecamp/api/src/core/resource.ts`, `create.mesa`, `site-checkout.ts`; cli `decisions.js`, `registers.js`; `site-kit/config/images.js`; `workbench/web/src/lib/claude-edit.js`; `css/guide/search.js` (excluded, see `toolbelt-admissions.md`) |
| format bytes | `/units` `formatBytes` | 6: cli `build-check.js`, `codegraph-page.js`, `bench.js`, `repo-atlas.js`, `checks/app.js`; `sierra/src/build/schema-plugin.js` |
| constant-time compare | `/bearer` `timingSafeEqual` | `toolbelt/src/signature/signature.js` (private). `auth/totp.ts` `constantTimeEqual` wraps `node:crypto`'s own and is not a copy |
| case, plural | `/inflect` | `sierra/src/widget/index.js` `kebab`; `cli/core/text.js` and `site-kit/check/finding.js` `plural(n, word)` |
| edit distance | `/typo` `nearest`, `nearestAll` | the five above. **Built 2026-11-03 by a concurrent session, uncommitted**, with callers moved in fli, junction, litestone and site-kit |

**No kit exists:**

| Concept | Copies found |
| --- | --- |
| HTML escape | ~18 across 11 packages. Two are private inside toolbelt (`markdown.js`, `fill.js`). `shared-pure-functions.md` Tier 1 #4 found one missing `'`, and its step 4 was never done |
| regex escape | ~12 across 7 packages, one private in `toolbelt/src/textedit/textedit.js` |
| base64url | 4: `cli/core/tell-worker.js`, `site-kit/src/editor/handoff.js`, `litestone/src/core/query.js`, `notifications/drivers/webpush.ts` |
| strip ANSI, display width, word wrap | strip ×4 (`cli/core/text.js`, `ci-log.js`, `cli/console/Ship.mesa`, `basecamp/web/src/lib/log-lines.js`). Wrap ×7, two inside cli alone (`tty.js`, `text.js`), plus `litestone/src/tools/cli.js`, `site-kit/check/print.js`, haven ×3 |
| sleep | ~10. Refused in `shared-pure-functions.md` § Refuse; still refused |
| directory walk | `cli/core/fs.js` exports `walk`, yet `terms.js`, `surface.js`, `seams.js`, `bench.js` and `backfills.js` each keep their own, the last nearly identical to `fs.js`. Basecamp, litestone, jetty and site-kit have more |
| deep merge | 3 (jetty, junction, sierra). Refused as one function: sierra concatenates arrays on purpose |

## The map

Each Deno module gets one verdict:

- **have** — a kit answers it.
- **adopt** — a kit answers it and callers bypass it.
- **admit** — passes the test and copies were found.
- **wait** — would pass, but no drifting copies have been found yet.
- **refuse** — fails the test, for the reason given.
- **not substrate** — impure, so it falls under Q1.
- **elsewhere** — another package owns the fact.

`@std/internal` and `@std/webgpu` are left out.

| Deno module | What it holds | Verdict | Here |
| --- | --- | --- | --- |
| `text` | `levenshteinDistance`, `closestString`, case, `truncate`, `slugify`, `dedent` | **adopt** + wait | `/typo`, `/inflect` (case, slug, plural). `truncate` ×3 (cli, haven, litestone) waits |
| `html` | `escape`, `unescape` | **admit** | Phase 2.1 |
| `regexp` | `escape` | **admit** | Phase 2.2. A regex escape that drifts mis-matches a caller's name, which is the shape Invariant 8 exists for |
| `encoding` | base64, base64url, hex, base32, varint | **admit** base64url; wait for the rest | Phase 2.3 |
| `fmt` | `format` bytes, duration, `colors`, `stripAnsiCode`, printf | **adopt** bytes; **admit** strip-ANSI | `/units`, `/tty`. Duration ×2 (mesa, orion) waits |
| `cli` | `parseArgs`, `unicodeWidth`, `promptSecret`, `Spinner` | **admit** width; the rest are not substrate | width beside strip-ANSI, Q2. fli owns its own argument parsing |
| `crypto` | `timingSafeEqual`, digest helpers | **adopt** | `/bearer` |
| `datetime` | format, parse, difference | **adopt** | `/datetime` |
| `collections` | `deepMerge`, `chunk`, `groupBy`, `distinct`, `partition`, `sortBy` | refuse one `deepMerge`; the rest wait | `chunk` had zero real copies in 2026-08, and `Object.groupBy` is native |
| `front-matter` | extract a `---` block | **have** | `/frontmatter` (`FJS-D549`) |
| `yaml` | full YAML | **refuse** | `toolbelt-admissions.md` § 3; the frontmatter subset is the answer |
| `json`, `jsonc` | streaming JSON; JSON with comments | **have** json; wait on jsonc | `/json`. JSONC is unmeasured |
| `csv` | parse, stringify | **have** | `/cells`, with the CSV-injection rule (`FJS-D571`) |
| `media-types` | type ⇄ extension | **have** | `/mime` |
| `uuid`, `ulid` | generate, validate | **have** | `/ids` |
| `dotenv` | parse a `.env` file | wait | `/env` reads one value. Whole-file parsers ×2 (cli, litestone) are unread |
| `path` | join, relative, `globToRegExp` | wait | pure string math, but toolbelt refuses `node:` imports, so it would be hand-written. No copies found |
| `semver` | parse, compare, ranges | wait | one copy (cli); the upgrade and package-host papers may make a second |
| `math` | clamp, round | wait | `/units` holds the money rounding (`roundMinor`, `divRound`) |
| `bytes` | `concat`, `equals` over `Uint8Array` | wait | unmeasured |
| `data-structures` | heap, red-black tree | wait | unmeasured |
| `random` | seeded PRNG | wait | a seeded generator is pure, because its state is passed in |
| `async` | `delay`, `debounce`, `retry`, `deadline`, `pooledMap` | **not substrate** | timers. `sleep` refused; debounce argued in `toolbelt-admissions.md` § 1 |
| `fs` | `walk`, `ensureDir`, `exists`, `expandGlob` | **not substrate** | Q1 and Phase 4 |
| `net` | `getAvailablePort` | not substrate | `cli/core/probe.js` `portFree` is the one copy |
| `io`, `streams`, `tar` | readers, stream helpers, archives | not substrate | `cli/core/zip.js` owns archives |
| `cache` | LRU, memoize | not substrate | state; `FJS-D111` refused `createStore` on the same ground |
| `log` | logger | elsewhere | junction |
| `http` | status, cookies, ETag, negotiation | elsewhere | junction `core/errors.ts`; `statusCodeToReasonPhrase` refused in `toolbelt-admissions.md` |
| `assert`, `expect`, `testing` | assertions, snapshots, fake time | elsewhere | `@frontierjs/testing` |
| `cbor`, `msgpack`, `ini`, `toml`, `xml` | other formats | wait | nothing here asks for them |

**About two-thirds of toolbelt has no Deno row**: query, directives, gate, aria,
predicate, match, cron, hooks, history, frontier, signature, seal, redact, share,
sse, trace, devline, rank, geo, glow, markdown, fill, keys, textbox, textedit,
sugar, jsonschema, transforms, mailbox and qr. That is expected. The standard
library is the generic floor, and those kits are the facts this framework owns.
The map is a checklist for the floor, not a target for the rest.

## Why copies get written

**The writer never sees the index.** The subpath table lives in toolbelt's
`README.md`, which an agent loads only when it is working inside toolbelt. An
agent writing a helper in cli or haven has no prompt to look, so it writes
the helper, and the copy only shows up as a duplicate in a later session.
Two fixes reach that moment:

- **A pointer where helpers are written.** `.claude/rules/code-style.md`
  already loads when a source file is read. One line there names toolbelt's
  subpath table as the place to check before writing a string, encoding or
  formatting helper (Q4).
- **A rule on known shapes.** Each admitted or adopted concept has a
  fingerprint: the regex-escape character class, the `&amp;` replace chain,
  the `+`→`-` base64url chain, an `ago(` definition. A rule in
  `packages/cli/core/checks.js` holds one table of concept, fingerprint and
  kit. Any match outside toolbelt is an error that names the kit, and the
  exclusions are named paths in `scripts/ci-allowances.json` `structure`.
  The same engine runs `fli check` in a client app, where copies also get
  written (Q3).

## Phases

### Phase 0 — Read the copies

Goal: every adopt and admit row carries a count from reading the copies, and says whether they agree.
Done when: each row in § The sweep says *N read, agree / disagree on X*, and every disagreement found is filed in `ISSUES.md`.

- [ ] 0.1 HTML escape: which copies omit `'`, which escape attributes vs text, and whether one escaper fits all callers
- [ ] 0.2 Regex escape: confirm all copies use the same character class
- [ ] 0.3 base64url: whether any token is minted by one copy and read by another (litestone cursors, site-kit handoff)
- [x] 0.4 Relative time: each `ago` against `datetime.relative` on the same inputs, and whether `'never'` is a UI choice rather than a fact
  - Four already wrap the kit. Nine print a compact `5m`, which the kit has no style for. That is a new form to admit or refuse, not an adoption.
- [x] 0.5 Slug: each copy against `inflect.slug` on `a.b_c`, the input that split them in 2026-08
  - `basecamp/api/src/core/resource.ts` already wraps the kit. `create.mesa`, `site-checkout.ts` and `site-kit/config/images.js` differ only on accents and apostrophes, where the kit is right. `cli/core/decisions.js` and `registers.js` build keys and anchors that are stored, so a change orphans them. `workbench/web/src/lib/claude-edit.js` keeps case, `.` and `_`, so it is a different function.
- [x] 0.6 Format bytes: each copy against `units.formatBytes`, binary steps vs decimal steps
  - `cli/core/build-check.js` is decimal on purpose: docker prints a build context in decimal, and `build-check.test.js` pins `2.0 GB`. `cli/core/codegraph-page.js` runs in the browser as page script and cannot import. The other four agreed in kind.
- [ ] 0.7 Terminal text: strip-ANSI patterns, and whether each wrap measures characters or columns. This step settles the `measure` signature Q2 A needs before 2.4

### Phase 1 — Adopt what exists

Goal: callers of a concept toolbelt already answers import it. No new subpath and no naming.
Done when: each adopted fingerprint counts only its documented exclusions; each touched package's own test script passes; `fli done` is clear.

- [x] 1.1 Slug callers → `inflect.slug`
  - Moved `create.mesa`, `site-checkout.ts` `draftBranch` and `site-kit/config/images.js`. The two cli key builders stay, per 0.5.
- [x] 1.2 Format-bytes callers → `units.formatBytes`
  - Moved `cli/core/bench.js`, `repo-atlas.js`, `checks/app.js` and `sierra/src/build/schema-plugin.js`. `repo-live.test.js` now pins `9.3 KB` and `120 B`. Its old `1 KB` floor guarded against `0 KB`, which the kit never prints. build-check keeps its decimal copy, with the reason written beside it.
- [~] 1.3 `ago` callers → `datetime.relative` — dropped: 0.4 found no copies of the kit, only a compact form it lacks
- [x] 1.4 `signature.js` → `bearer.timingSafeEqual`
  - The private copy answered `true` for two non-strings that stringify alike, and the kit refuses them. auth keeps `node:crypto`'s own.
- [ ] 1.5 `kebab` and `plural(n, word)` copies → `/inflect`, or `/inflect` grows a count form if 0.x shows the callers want one
  - `sierra/src/widget/index.js` `kebab` names a widget's custom element and splits acronyms differently (`FAQWidget` → `faqwidget`, where inflect gives `faq-widget`), so moving it renames a published tag. That is the owner's call. `plural(n, word)` is a count phrase `/inflect` has no form for.
- [ ] 1.6 Edit distance → `/typo`. Built by a concurrent session on 2026-11-03; this step only confirms it landed and every copy is gone

### Phase 2 — Admit the pure gaps

Goal: one kit per concept the map admits, with toolbelt's own private copies importing it.
Done when: the admitted fingerprints count only exclusions; CI's substrate-purity phase passes; each new subpath has a `.d.ts` where a TypeScript caller reads it.

- [ ] 2.1 HTML escape (+ unescape if a caller needs it). Subpath name through `decision-rules`; Deno's name is `html`
- [ ] 2.2 Regex escape. Deno's name is `regexp`
- [ ] 2.3 base64url (and hex if 0.3 finds copies). Deno's name is `encoding`
- [ ] 2.4 Strip-ANSI, display width and wrap, placed per Q2

### Phase 3 — Keep it from coming back

Goal: the next copy is refused at the moment it is written.
Done when: adding a regex escape outside toolbelt fails the check by name and points at the kit.

- [ ] 3.1 The pointer line, per Q4
- [ ] 3.2 The fingerprint rule, per Q3

### Phase 4 — Impure helpers

Goal: whatever Q1 rules for sleep, walk, atomic write, read-JSON and port probes.
Done when: Q1 is ruled and its steps are written here.

- [ ] 4.1 cli's private `walk` copies → `cli/core/fs.js` `walk`, the one owner inside cli. This needs no ruling

## Open questions

- **Q1 — Where do impure helpers live?** Deno keeps `async`, `fs` and `net` in its
  standard library. Toolbelt's purity rule keeps them out, so each package
  grows its own.
  - **A** — per package, as today; `shared-pure-functions.md` § Refuse stands.
  - **B** — a sibling package beside toolbelt for runtime helpers (timers, `node:fs`), with its own dependency direction argued.
  - **C** — A, plus each package keeps one module that owns its own helpers (cli's `core/fs.js` is the model), and copies inside a package move to it.
  - **Recommend C** — `sleep` copies cannot drift. The `walk` copies drift in skip sets and depth, and that matters only within one package, where two checks can disagree about which files exist. B waits for a drift that crosses packages.
- **Q2 — Where do strip-ANSI, width and wrap live?**
  - **A** — `/tty` grows them. It holds "the tones as a terminal says them" and nothing else today (`TONES`, `toneOf`), so `wrap` and its `measure` argument are new code. With `measure` passed in, haven's character-count wrap and the terminal's column wrap are one function.
  - **B** — a new `/text` subpath on Deno's model holds wrap, truncate and dedent; strip-ANSI and width go in `/tty`.
  - **Recommend A** — no new noun, and every copy found is terminal-shaped except haven's, which `measure` covers.
- **Q3 — What refuses a new copy?**
  - **A** — a new phase in `scripts/ci.mjs` with a per-concept count in a baseline JSON that only goes down, like `scripts/typecheck-baselines.json`.
  - **B** — a `checks.js` rule at `error` severity: one table of concept, fingerprint and kit; a finding that names the kit; exclusions as named paths in `ci-allowances.json` `structure`, which already reports stale entries.
  - **C** — none; the pointer alone.
  - **Recommend B** — the owner of "a source pattern refused, with named exceptions" is already `checks.js` and the `structure` phase, so A would be a second owner beside it (Invariant 4). A count that only goes down still lets one copy be swapped for another, and named paths do not. B also reaches client apps through `fli check`. **A comes back** if the fingerprints prove too fuzzy to name paths.
- **Q4 — How does a writer find a kit?**
  - **A** — one pointer line in `.claude/rules/code-style.md` naming toolbelt's subpath table.
  - **B** — the full one-line-per-subpath index as its own path-scoped rule.
  - **C** — the README table only, as today.
  - **Recommend A** — B adds about 3 KB to every source-file read (`doc-hygiene` § The two loads). The pointer is still needed beside Q3's rule, because the rule only fires after a copy is written.
