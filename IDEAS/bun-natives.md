---
id: bun-natives
status: proposed
dated: 2026-09-09
---

# Idea — what Bun 1.4's natives can replace here

**Status: PROPOSED.** Dated 2026-09-09. Every claim below was probed against a real
`bun-1.4.2` binary and against this tree; nothing here is read off the release
notes. Bun 1.4 folds fifteen former dependencies into the runtime — `Bun.markdown`,
`Bun.Image`, `Bun.cron`, `Bun.WebView`, `Bun.Terminal`, `Bun.YAML`, `Bun.XML`,
`Bun.Archive`, `Bun.CSRF`, `Bun.secrets`, `Bun.JSONL` among them — and the obvious
question is which of ours they retire.

The answer is *one*, and the reason the other nine fail is the same reason each time.

---

## The dividing line is the runtime, and it is not a preference

A Bun global is a dependency on an interpreter. Most of this workspace cannot take
one:

- **`fli` is `#!/usr/bin/env node`** and `packages/cli/core/*.js` contains zero
  `Bun.` calls. An installed app's `fli` runs on whatever node the machine has.
- **mesa, sierra, ui, css, jetty and toolbelt are published to consumers** who run
  vite under node. `toolbelt`'s harness is *node or bun* by design and the
  `hygiene` phase already grades that package for taking on dependencies.
- **junction is Bun-only and says so**; `outpost` is a plain Bun service; `litestone`'s
  client needs `bun:sqlite`, though its *parser* is reached from the vscode
  extension under node.

So the adoptable surface is junction, outpost, an app's own code, and the halves of
litestone that already require bun. That excludes, by construction, every place a
native would have replaced something: the markdown is in mesa and the cli, the
frontmatter parsers are in mesa and sierra, the browser driving is in mesa's harness
and the cli's own page driver.

**A conditional adoption is worse than none.** A `typeof Bun` fork in a compiler
gives one source file two possible outputs, which is Invariant 12 (mesa's output is
reproducible, and CSS dedupe across two compilers depends on it). § IV
*batteries vs. smallness* does not license it either: a battery must be severable,
and a second markdown engine reachable by runtime detection is a tendril, not a seam.

---

## The one that lands: `Bun.Image`

**It replaces nothing, which is why it can land.** There is no `sharp`, `jimp` or
`imagemin` anywhere in this workspace and no resize path in any package — so
adopting it adds a capability instead of forking an owner.

Measured, on `fjs-backdrop-portrait.png` with the 1.4.2 binary:

| | |
| --- | --- |
| source | 811,152-byte PNG, 941 × 1672 |
| `.resize(320).webp({quality:70}).bytes()` | 30,172 bytes |
| whole open → metadata → resize → encode | ~25 ms |
| `metadata()` | `{ width, height, format }` — the *real* format |
| `placeholder()` | a `data:image/png;base64,…` blur, ready for an `<img>` |

The API is chainable and terminal at `.bytes()` / `.blob()` / `.buffer()` /
`.dataurl()` / `.write()`, with `avif`, `webp`, `jpeg`, `png`, `heic`, `resize`,
`rotate`, `flip`, `flop` and `modulate`.

> **Corrected 2026-09-12 — the owner named below is gone.** `IFileStorage` and
> junction's own file store were deleted by
> [FJS-D260](../DECISIONS.md#fjs-d260): nothing called them, and file storage has one
> owner, Litestone's `FileStorage` plugin. This section's *one owner* answer is
> therefore wrong as written — a derivative store belongs beside the provider seam,
> which means litestone and not junction, and the objection it raises against itself
> (*not litestone, which would need the bytes*) is the real design question rather
> than a settled one: litestone's providers already `get(key)`, so the bytes are
> reachable there. Re-run the nine against the litestone placement before building.

**Two homes, and the second is a defect rather than a feature.**

1. **Derivatives beside the store.** A variant is the same store keyed by
   `<id>@<width>.<format>`, and `Bun.Image.placeholder()` is what a `File` column
   needs so a catalog grid has something to paint before the bytes arrive.
2. **A stored file's type is currently the caller's word for it.** The storage
   module derives a content type from `extname()` and compensates with
   `x-content-type-options: nosniff`, saying so in a comment; litestone's
   `@accept("application/pdf")` grades the same caller-supplied string. `metadata()`
   answers what the bytes *are*, so *this `.png` is an SVG* becomes decidable at the
   Data boundary instead of being mitigated at the response.

**Filed 2026-09-19 as [FJS-1184](../ISSUES.md#fjs-1184)**, and probed sharper than
written here: `@accept` grades `value.type` off the browser `File` — the uploader's
own word — and that same string is then persisted as `ref.mime` and handed to the
provider as `contentType`. So the declaration whose whole job is *what may be stored
here* is satisfied by any bytes named `.png`.

**The adoption itself is ruled**: [`FJS-D311`](../DECISIONS.md#fjs-d311) takes
`Bun.Image` as the transformer and `placeholder()` as the placeholder, as a
capability the `FileStorage` plugin is GIVEN rather than one it imports — a `Bun.`
reference in litestone's import graph would break its Node proving. Who owns the
derivative store is still open, and this file's own answer is the dead one.

---

## The nine that do not

**`Bun.markdown` → mesa's six remark/rehype dependencies.** The most tempting entry
on this page and the most thoroughly refused. Probed, it renders GFM tables, task
lists and strikethrough, passes `<Foo x={1} />` through untouched — exactly the
`allowDangerousHtml` behavior `compiler-md.js` builds its placeholder dance around —
leaves `<!--MESA:0-->` intact, and emits `<pre><code class="language-js">`, the shape
the glow hand-off already matches. It is **102× faster**, over this repo's own
`packages/mesa/README.md`: 34.83ms against 0.343ms, best of 50.

`render(src, handlers)` is real, and its signature is `handler(children, props)` —
`heading(children, { level })`, measured rather than read off the notes — so
`rehype-slug` IS portable onto it, which this file previously only guessed. What is
not portable is anything the native parser never emits: `remark-gfm`'s autolink
literals leave `https://x.com` as text, and `[^1]` renders as a link reference,
because a handler customizes how a node prints and cannot add a syntax. There is no
`parse` at all, so `remarkPlugins`/`rehypePlugins` — a documented `compileMd` option
with three tests — has nothing to bind to.

**It fails on the runtime line twice, and the second one is absolute.** `.mesa` and
`.md` compile under vite for consumers on node (`vite`'s own bin is
`#!/usr/bin/env node`), and Invariant 12 forbids the fork. And the compiler runs in a
BROWSER: the REPL's importmap loads the unified chain from esm.sh and `examples.js`
ships three `.md` examples compiled client-side, where no `Bun` global can exist at
any version. `Bun.markdown.html()` takes no options either, so a per-flavor knob is
not available to soften any of it.

The chain it would have replaced is still worth removing — 82 packages, 8.7 MB,
measured in this tree — but the door is a kit rather than a native, because a kit
runs in all three places. See `markdown-kit.md`.

**`Bun.markdown` → the cli's literate command runtime.** `fli` is node; and the cli
does not want HTML, it wants *structure* — steps, `<script>` blocks, fenced js. The
visitor form could do it, on a runtime the cli does not have.

**`Bun.cron` → caravan or `app.scheduler`.** Three refusals, measured:
`Bun.cron("* * * * * *")` throws — five fields only, no seconds; `Bun.cron.parse()`
takes a `Date` as its only second argument and resolves in the *host's local zone*
(`0 3 * * 1` answered `2026-09-14T10:00Z` on an MST box), where caravan carries a
per-schedule IANA `timeZone` through `Intl`; and a callback registered in-process
has no dispatch record, where a caravan cron fire is dispatched under
`cron:<job>:<minute>` and is therefore idempotent across a restart. `FJS-D36` gives
caravan the clock and `@frontierjs/toolbelt/cron` is the one expression parser —
adopting a second one re-creates precisely the split that kit was written to end,
where `0 1-5,8 * * *` meant different hours to two parsers.

**`Bun.WebView` → the Chrome-over-CDP harnesses.** It works headless here with no
display, exposes `navigate`, `evaluate`, `screenshot`, `click`, `type` and a raw
`cdp()` — but it is **not its own browser**: it reported
`Chrome/150.0.7871.124`, byte-identical to this machine's `google-chrome`. It
removes no prerequisite, only our launch plumbing, and that plumbing lives in
mesa's harness (node) and `packages/cli/core/browser.js` (node). Nothing gains.

**`Bun.YAML` → the two hand-rolled frontmatter parsers** in
`packages/mesa/src/compiler-md.js` and `packages/sierra/src/scanner/parse-frontmatter.js`.
Both are node-reachable. That there are two of them is a real finding and a
toolbelt question — *what a frontmatter block means* is one fact with two
implementations — but Bun is not the answer to it.

**`Bun.CSRF` → junction's origin check.** `transport/middleware.ts` already answers
CSRF for cookie sessions by checking `Origin`, with the reasoning written down.
A signed token pair is a *different* mechanism, not a better one; adding it gives
one question two owners.

**`Bun.Archive` → `core/vendor.js`.** The pack is `bun pm pack` on purpose: the
tarball's bytes are the thing being graded (the `scaffold` phase reads `files:` out
of exactly those bytes). A different archiver would produce an archive nobody
installs.

**`Bun.secrets` (OS keychain) → deploy credentials.** The credential path is `fli`,
which is node. Revisit only if `fli` ever moves to bun, which is its own decision.

**`bun test --changed` → `fli proves`.** They look alike and are not: `--changed` is
an import graph, and `fli proves` is explicitly not one — half its rows (*a `@@gate`
on a model a SCREEN reads → `verify:account`*) are statements about what a drive can
*see*. Conflating them would turn the content into exceptions.

Worth a separate look, unrelated to natives: **`bun pm licenses`** asks a question
nothing in `bun run ci` asks today, and **`[install] linker = "isolated"`** is
opt-in in 1.4 and changes how workspace packages land in `node_modules` — the
*edits to a workspace package are invisible until reinstall* hazard in the root map
is worth re-measuring against it rather than assumed.

---

## The nine questions

- **Another origin of truth?** `Bun.Image` — no; nothing here processes images.
  Every rejected row above fails *because* it would create one.
- **Concept budget?** Unchanged. A derivative is a file in the store that already
  exists; no new noun.
- **Whose complexity?** The problem's — a catalog needs a thumbnail whatever the
  runtime is.
- **Predictability?** Improved on the type question: what a stored file *is*
  currently depends on what the uploader named it.
- **Derived rather than restated?** Yes, and this is the sharp one — a derivative
  and a placeholder are derived from the stored bytes, never stored beside them as
  a second claim.
- **One owner?** Answered `IFileStorage` in junction, and that answer died with the
  interface ([FJS-D260](../DECISIONS.md#fjs-d260)). The live candidate is litestone's
  provider seam — the *which would need the bytes* objection does not hold, since a
  provider already exposes `get(key)`.
- **Boundary named, typed, tested?** It has to be: a variant method on the storage
  interface, typed there, and a test that a `.png` carrying SVG bytes is refused —
  that assertion is what makes the second item real rather than a claim. Note what
  [FJS-1076](../ISSUES.md#fjs-1076) says about the surviving seam's existing coverage
  before treating *typed there* as sufficient.
- **Failure proportional?** An unreadable image must be a refusal at write time, not
  a broken `<img>` later.
- **Can it be wrong silently?** Yes, in the way that matters: a derivative
  generated from the wrong source, or a format check that passes everything, both
  look like working code. The artefact is the paired assertion the house style
  already demands — the legitimate upload beside the mislabeled one.

**Adjudication named:** § IV *batteries vs. smallness*. Image handling is a battery
and must be severable — one method on one interface, removable without touching the
Data boundary. § IV *preservation vs. evolution* is **not** in tension here; nothing
is being kept for its own sake.

**Tier:** § VII *Assessment*. Nothing here is behavior until it is built; the
mislabeled-upload finding belongs in `ISSUES.md` with an id of its own.
