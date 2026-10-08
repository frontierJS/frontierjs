---
id: markdown-kit
status: proposed
dated: 2026-09-29
---

# Idea — the kit renders `@syntax(md)`

**Status: PROPOSED.**

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

- Which parser, and whether it ships in `ui` or `toolbelt`.
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
- Server-side render for prerendered pages vs. client-only.
  - **A** — client-only: `Cell` renders the markdown in the browser.
  - **B** — the same function at prerender and in the browser.
  - **Recommend B** — a prerendered careers page that shows `## About the role`
    until hydration is the defect that found this. B costs nothing once the
    renderer is the pure function the first question recommends.
