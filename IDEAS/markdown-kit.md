---
id: markdown-kit
status: partial
dated: 2026-09-29
revised: 2026-11-23
---

# Idea — the kit renders `@syntax(md)`

**Status: PARTIAL.** The renderer shipped as option C below:
`@frontierjs/toolbelt/markdown`, drawn by `ui`'s `Markdown.mesa` and by `Cell`
for a markdown column. § Streaming — Phases 0–3 is proposed and nothing in it is
built.

`@syntax(md)` in the schema only refuses a bad value; nothing in the kit renders
one. `Cell` shows it as plain text, so `## About the role` and `**bold**` reach
the reader verbatim, and HTML whitespace folds the lines into one paragraph.

Found in `fjs-prototypes/jazzhr` — the public careers page
(`web/src/routes/careers/[id].mesa`) shows a job's `description @syntax(md)`.
Patched there with `white-space: pre-line` so the line breaks survive.

## What it would be

- `Cell` (and a display-mode field) sees `@syntax(md)` on the column and renders
  it — the column already carries the attribute, so no app code changes.
- Sanitized: the text is written by users, and a careers page is public. A
  parser (`marked`/`micromark`) plus DOMPurify, or a small safe subset.
- Styled by `prose`, which already exists in the css vocabulary.
- The form side: a textarea with preview, optional.

## Open questions

- ~~**Which parser, and whether it ships in `ui` or `toolbelt`.**~~ **Answered 2026-11-23 (`FJS-D2346`): C — a small safe subset written as `@frontierjs/toolbelt/markdown`, zero dependencies, emitting no raw HTML so there is nothing to sanitize.**
  - **A** — unified and remark, the chain mesa's `compiler-md.js` already uses,
    plus `rehype-sanitize`, as an optional peer of `ui`.
  - **B** — `marked` plus DOMPurify in `ui`.
  - **C** — a small safe subset written as `@frontierjs/toolbelt/markdown`, zero
    dependencies, emitting no raw HTML so there is nothing to sanitize.
  - **Recommend C** — the text is written by strangers and shown in public, and
    a renderer that never emits raw HTML cannot be talked into a script, where
    A and B are only as safe as a sanitizer's configuration. A pure function in
    the substrate runs on the server and in the browser, which answers the next
    question too. Page `.md` keeps remark, since it needs Mesa components
    inside the markup and its author is trusted.
- ~~**Server-side render for prerendered pages vs.**~~ **Answered 2026-10-09 (`FJS-D821`): B — the same function at prerender and in the browser.** client-only.
  - **A** — client-only: `Cell` renders the markdown in the browser.
  - **B** — the same function at prerender and in the browser.
  - **Recommend B** — a prerendered careers page that shows `## About the role`
    until hydration is the defect that found this. B costs nothing once the
    renderer is the pure function the first question recommends.

## Streaming — text that is still arriving

**The defect.** `<Markdown text={…}>` is drawn from text that grows: a model's
reply as its tokens land (`chat-surface.md` Part 1), and `MarkdownInput`'s
preview as somebody types. Each change re-runs `markdown()` over the whole text and
replaces the whole `{@html}`, and the function reads a prefix as if it were
finished. Every 2026-11-23 measurement below was a cut of one fixed reply:

| Prefix ends | Draws | Then becomes |
| --- | --- | --- |
| `Here is **bold` | `Here is **bold` | **bold**, the `**` gone |
| `[link](https` | `[link](https` | an anchor, the brackets gone |
| `\| a \| b` (no delimiter row yet) | `<p>\| a \| b</p>` | a table |

Replacing the whole subtree also drops a selection the reader is making, and it
re-highlights every fence on every chunk. Cost: about 1 MB/s for every block
type, linear in length — `inline()` and `escText()` are 34% of self time. A
5 KB reply renders in about 3 ms. A 28 KB reply re-rendered at every 64-character
chunk spends 6 s of main thread over the stream.

**Prior art: `@pierre/words`** (diffs.com/words, beta, read 2026-11-23), a Wasm
streaming renderer. Two of its properties are taken: a half-written construct
settles in place rather than flickering ("parse incomplete"), and text already
drawn keeps its node while new text arrives. Its dependency is not taken, because
option C above is the ruling: a Wasm parser with raw-HTML passthrough, Mermaid,
TeX and live components in fences is the surface this kit exists to avoid. Its
string-returning render hooks are already covered by `resolveUrl`, `classes` and
`onnavigate`. Its published benchmark method — 256-unit chunks, 40 ms apart,
median of 3 fresh browsers — is the shape Phase 0 uses.

### Phase 0 — The defect as rows

Goal: the flicker and the cost, reproducible from the repo.
Done when: `packages/toolbelt`: `bun run test markdown` holds the prefix rows,
marked as expected-to-fail, and the browser numbers are recorded under 0.2.

- [ ] 0.1 Prefix rows in `test/specs/markdown.spec.js`: every cut of two fixed
  replies, one prose-heavy and one with a fence, a table and a nested list, plus
  markers that never close — `**kwargs`, a lone `*`, an unclosed backtick.
- [ ] 0.2 Main-thread time in a real browser for the 28 KB reply streamed by
  Words' method, through `Markdown.mesa`, via `packages/ui` `test:browser`'s
  markdown fixture.

### Phase 1 — A prefix draws as a prefix

Goal: `markdown(text, { streaming: true })` draws nothing that a later chunk
takes back.
Done when: for every prefix in 0.1, the visible text of the streaming render is a
prefix of the visible text of the final non-streaming render, except that a marker
which never closes (`**kwargs`) reappears once, when the stream ends.

- [ ] 1.1 Inline tail: an unclosed emphasis, strike or code run, and a link whose
  `(url` has not closed, settle by `Q1`'s answer.
- [ ] 1.2 Block tail: a last line that can still become a table header waits for
  its delimiter row. An open fence already draws as code and stays so.
- [ ] 1.3 `<Markdown streaming>` passes it through, and `MarkdownInput`'s preview
  sets it. Close `FJS-4570` in the same step, so `Markdown.mesa` forwards
  `markdown()`'s options rather than growing one prop per option. Proved by
  `packages/ui` `test:browser`.

### Phase 2 — Finished blocks keep their nodes

Goal: a growing reply re-renders only its last top-level block.
Done when: `packages/ui` `test:browser` keeps a selection inside block 1 across
50 appended chunks, and block 1 is the same DOM node throughout.

- [ ] 2.1 `markdownBlocks(text, opts)` answers one HTML string per top-level
  block, and `markdown()` is their join. The subset makes the boundaries
  append-stable: no setext headings and no link reference definitions, so a
  later line cannot reach back into a finished block. The spec asserts it for
  every 0.1 prefix and for a prefix sweep over generated text, since two fixed
  replies cannot show it holds for any input.
- [ ] 2.2 `Markdown.mesa` draws the blocks keyed, so only the last one is
  replaced. Read `ui-hazards` and `FJS-4557` first, since both cover a keyed
  `{#each}` over `{@html}`.
- [ ] 2.3 Arrival motion, by `Q2`'s answer, in `@frontierjs/css`, only while
  `streaming` and off under `prefers-reduced-motion`. A static or prerendered
  page does not animate.

### Phase 3 — Speed, if 0.2 says it is felt

Goal: the 28 KB reply streams without a long task.
Done when: 0.2's measurement shows no task over 50 ms.

- [ ] 3.1 `inline()` collects text by run rather than by character, and matches
  autolinks and URLs with sticky regexes rather than `src.slice(i)`.

### Open questions — streaming

- **Q1 — How does an unclosed inline construct draw at the tail?**
  - **A** — hold it back: `**bol` draws `bol`, and the strong appears when it
    closes.
  - **B** — close it early: `**bol` draws **bol** now. A run never closed draws
    its marker in the final render.
  - **Recommend B for emphasis, strike and code, A for a link** — the reader
    sees the weight the writer meant while it arrives, which is what Words
    does. A link's target is unknown until `)`, so its text draws without an
    anchor until then. Under either answer a marker that never closes jumps
    back in at the end of the stream; Q1 only decides how visible that jump is,
    and A everywhere is the flatter choice if B's jump reads badly.
- **Q2 — What moves when text arrives?**
  - **A** — nothing.
  - **B** — a block fades in when it first appears.
  - **C** — new words fade in as they land, as Words does.
  - **Recommend B** — Phase 2 gives a block's first appearance for free, while C
    has to diff text nodes inside the one block Phase 2 re-renders wholesale.
    Revisit C only if B reads as jumpy.
