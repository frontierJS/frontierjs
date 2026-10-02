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

Move the first generic piece out of ksite's `packages/ksite/` engine, so ksite
depends on this package instead of only the website.
