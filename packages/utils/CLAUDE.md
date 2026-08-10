# utils — package map

**`@frontierjs/utils`** — pure functions, zero dependencies, importable from
anywhere in the tree including litestone. One rule: **every export is a pure
function** — same input, same output, no I/O, no clock, no globals, no
framework import, no mutation of its arguments.

`bun run test` — `test/run.js` is the whole harness, no dependencies, runs
under node too.

---

## Layout

```
src/glow/glow.js     source code → highlighted HTML. The first export.
docs/glow/           the Svelte editor and SCSS theme glow arrived with.
                     Reference only — not shipped, not FrontierJS code
test/run.js          the harness
test/specs/          one .spec.js per export
test/fixtures/       guide-samples.json — 137 real samples from the css guide
                     extract.mjs — regenerates it
```

---

## What bites here

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
- **A rule that matches more than one character relies on `renderRow`
  encoding it.** Every token is a raw slice of the source, and for a long
  time nothing matched more than one character at a time, so `elem()`
  encoding a lone `<` or `>` was enough — an HTML comment then went to the
  page as live markup. Encoding is now in `renderRow`; do not move it back
  into a per-rule special case.
- **A comment that opens mid-line is a token, not a block.** `/*` anywhere on
  a line used to start a comment block and swallow the code before it, which
  reads as a disabled line. `isTrailingComment()` is the split; a comment
  that opens the line, or runs on, is still a block.
- **glow's output is elements, never classes** — `<em>` a value, `<sup>` a
  comment. `@frontierjs/css`'s `components/code.css` themes exactly that shape,
  so emitting a class here would silently break the theme rather than fail.

## Proving a change

`bun run test`, then `packages/css`: `bun run test code` — 25 assertions that
style *real glow output*, injected by the css harness. A change to the element
glow picks for a token breaks there, not here.
