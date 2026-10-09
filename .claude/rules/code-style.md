---
paths:
  - "**/*.{js,mjs,cjs,ts,mts,mesa}"
---

# Code style

Loaded when a source file is read. Match the file you are in first; this is what the repo does when there is no local precedent. The one-line version is in the root `CLAUDE.md` § House style, because a rule scoped by path does not load while a NEW file is being written.

- **Comments explain the failure, not the mechanism.** `// increment the counter` is noise; `// vite hops ports silently, so the drive would talk to the other app` is the house voice.
- **A comment must be load-bearing. Delete it otherwise.** Test: if it vanished, could someone editing this file make a mistake it would have prevented?
  - **No edit history in code** ("used to be", "this replaced X", "merged 2026-08-08"). That is `DECISIONS.md` and git. Narrow exception: a past bug stated because the shape still invites it (`--ring` in `tokens.css`), where the history IS the warning.
  - **No dates in code comments.** If the comment needs one, it belongs in a decision record the code points at.
  - **No persuasion** — "the whole point", "deliberately", "which is exactly why", italics for emphasis. State the constraint flatly; if it needs selling, it needs a ruling.
  - **Never narrate your own edit.** The reader does not know a change happened.
- **Never put a backtick in a comment inside a template literal.** A SQL schema, an nginx config and a shell script are all written as one here, and a comment quoting `an identifier` closes the literal — the file then fails to PARSE, so the failure is nothing to do with what the comment says and points at a line further down. Twice in one day: `packages/caravan/src/db.ts` (every `bun run api` and therefore every drive) and the nginx deploy template (the cli suite). Use plain words or `--` quoting; the cli's *every shipped command compiles to parseable JS* test is the only thing that catches it, and it only covers `commands/`.
- **Every non-trivial file opens with a header block** — what it is, and what it is for. Test harnesses document their own traps at the top (`example/web/test/verify.mjs`).
- **Section dividers inside a file**: `// ─── name ──────` (box-drawing, padded to a consistent width). Not `// ---`, not banner boxes.
- **Aligned columns** where a run of lines is parallel — imports, object literals, `const` blocks. See `example/api/src/app.ts`.
- **No semicolons**, single quotes, 2-space indent, in TS and JS alike (`packages/css`'s own build/test scripts are the one holdout). TypeScript in junction, auth, caravan, conduit, notifications, mcp, testing; plain ESM JavaScript in every other package. Do not introduce TS into a JS package.
- **Fake clients hide real bugs.** Cross-package behavior is tested against the real dependency — `{ post: {…} }` passed every test and failed every real Litestone client.
- **A new `on*` states its tier** (`FJS-D06` §1) — **Hook** may mutate the arguments or halt the operation, **Guard** answers allow/deny, **Observer** receives and cannot act. The word goes on the option that holds it: conduit's callbacks are `observers:` because a throw in one is swallowed, and `management.hooks` beside it keeps *hook* because that pipeline can refuse the call.
