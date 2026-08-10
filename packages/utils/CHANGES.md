# @frontierjs/utils — changes

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
