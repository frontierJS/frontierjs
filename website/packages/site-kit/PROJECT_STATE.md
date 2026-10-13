# site-kit — Project State

> `CLAUDE.md` is the map. Read `../../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/site-kit` 0.0.0, private — the engine a markdown-authored
marketing site depends on.

## State

| | |
|---|---|
| Source | the shell, dev entry and build (`bin/site-kit.js`, `config/`, `index.html`, `src/main.js`); the preset loader (`config/preset.js`) and a preset's `public/` (`config/public.js`); the Markdown dialect and its build check (`config/dialect.js`, `dividers.js`, `prose.js`); settings from `site.md` and the `@content` alias (`config/content.js`); `collection()` (`src/collection.js`); `src/layouts/Block.mesa` over `src/block-look.js`, the wrapper `layout: Block` names; one block, `src/blocks/Marquee.mesa` |
| Tests | `test/blocks.mjs`: compile-and-parse every block and layout, render assertions per file, Block's refusals included. `test/preset.mjs`: the loader, its refusals, and dev serving a preset's `public/`. `test/dialect.mjs`: the dialect and the check. `test/words-build.mjs`: a real `site-kit build` refused, then passing. `test/content.mjs`: `collection()` and the settings module. `test/content-build.mjs`: a real build binding a setting, a collection and a menu, and merging a preset's `document` with the site's. The build itself is proved by `website/`'s `bun run test`; nothing here drives `site-kit dev` |
| Consumers | `website/site/`, which is `content/` only and runs through this package; `fjs-prototypes/ksite`, through its preset `@kobami/ksite` |
| Published | no, and not listed anywhere |

## Next

`IDEAS/site-kit-plan.md` is the order of work. Phases 1 and 2 are done, and
Phase 3 steps 1 (`Block.mesa`), 2 (the Markdown dialect), 3 (settings,
menus and collections) and 4 (the head, through Sierra's `document`). Step 5
is measured in the plan: a preset's `public/` moved; the check's generic half
is next, and `document` in dev waits on a ruling.
