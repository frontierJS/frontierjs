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
- Server-side render for prerendered pages vs. client-only.
