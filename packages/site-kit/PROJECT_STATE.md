# site-kit — Project State

> `CLAUDE.md` is the map. Read `../../CLAUDE.md` first for repo-wide vocabulary.

## What it is

`@frontierjs/site-kit` 0.0.0, private — the engine a markdown-authored
marketing site depends on.

## State

| | |
|---|---|
| Source | the shell, dev entry and build (`bin/site-kit.js`, `config/`, `index.html`, `src/main.js`); the preset loader (`config/preset.js`) and a preset's `public/` (`config/public.js`); the Markdown dialect and its build check (`config/dialect.js`, `dividers.js`, `prose.js`); settings from `site.md` and the `@content` alias (`config/content.js`); `collection()` (`src/collection.js`); `src/layouts/Block.mesa` over `src/block-look.js`, the wrapper `layout: Block` names; one block, `src/blocks/Marquee.mesa`; the pre-ship check (`check/`, `site-kit check`); the import from an existing site (`fetch/`, `site-kit fetch`) |
| Tests | `test/blocks.mjs`: compile-and-parse every block and layout, render assertions per file, Block's refusals included. `test/preset.mjs`: the loader, its refusals, and dev serving a preset's `public/`. `test/dialect.mjs`: the dialect and the check. `test/words-build.mjs`: a real `site-kit build` refused, then passing. `test/content.mjs`: `collection()` and the settings module. `test/content-build.mjs`: a real build binding a setting, a collection and a menu, and merging a preset's `document` with the site's. `test/check.mjs`: a built site's check, kit rules and a preset's. `test/fetch.mjs`: `site-kit fetch` against a site it serves. The build itself is proved by `website/`'s `bun run test`; nothing here drives `site-kit dev` |
| Consumers | `website/site/`, which is `content/` only and runs through this package; `fjs-prototypes/ksite`, through its preset `@kobami/ksite` |
| Published | no. A local registry has carried it (`fjs-prototypes/ksite/baseline/upgrade.mjs`); the real publish is `site-kit-plan.md` Phase 5 step 4 |

## Next

`IDEAS/site-kit-plan.md` is the order of work; its next step is the first
open box. Phases 1–4 are done, and Phase 5's first three steps: the move to
`packages/`, `site-kit fetch`, and the bump proved on a local registry. Step 4
is the real publish, behind the owner's go.
