# site-kit — Project State

> `CLAUDE.md` is the map. Read `../../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/site-kit` 0.0.0, private — the engine a markdown-authored
marketing site depends on.

## State

| | |
|---|---|
| Source | the shell, dev entry and build (`bin/site-kit.js`, `config/`, `index.html`, `src/main.js`); one block, `src/blocks/Marquee.mesa` |
| Tests | `test/blocks.mjs`: compile-and-parse every block, render assertions per block. The build itself is proved by `website/`'s `bun run test`; nothing here drives `site-kit dev` |
| Consumers | `website/site/`, which is `content/` only and runs through this package; `fjs-prototypes/ksite` (planned) |
| Published | no, and not listed anywhere |

## Next

`IDEAS/site-kit-plan.md` is the order of work. Its Phase 1 (re-prove the ksite
split) needs no ruling; Phase 2 waits on its open questions.
