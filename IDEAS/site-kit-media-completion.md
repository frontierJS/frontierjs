---
id: site-kit-media-completion
status: proposed
dated: 2026-11-17
---

# Proposal — media-path completion for site-kit content in the VS Code extension

**Status: PROPOSED. Nothing built. Do not cite as behavior.**

A site-kit page names its images by URL in front-matter and Markdown:
`background: /media/team.jpg` resolves to `content/public/media/team.jpg`,
and a preset's own `public/` ships beneath it (`/theme/…`, `config/public.js`).
Today an author types that path from memory, and a typo surfaces as a broken
image in the browser. `packages/frontierjs-vscode` should complete it.

## Prior art

`LEGACY/vscode-ext-frontier` (2025, never published) did this for ksite: a
`CompletionItemProvider` on `markdown` and `yaml` that fired after `/media/`,
fuzzy-matched files under a configured `media` folder with fuse.js, and
replaced the typed fragment with the chosen path. Kept from it: the two
languages, the trigger on `/`, and replacing the typed fragment. Dropped:

- **The git extension as the way to find the root** — it picked
  `repositories[0]`, which is wrong in a multi-root workspace. Probe for the
  site instead (`content/settings/site.md` beside a `content/public/`), per
  Invariant 3.
- **The 5-second rescan** — a `FileSystemWatcher` on `content/public/**`.
- **fuse.js** — VS Code's suggest widget fuzzy-matches on `filterText`
  already, and the extension is esbuild-bundled, so a dependency is weight
  with nothing to show for it.
- **A configured folder name and extension list** — the URL space is
  `content/public/` plus the preset's `public/`, which site-kit already
  defines, so the extension reads it rather than restating it.

## Plan

### Phase 0 — Groundwork

Goal: know which URLs a site exposes and where they are typed.
Done when: the URL list for one real site (kobami.com) matches what its dev
server serves.

- [ ] 0.1 Export one lister from `packages/site-kit/config/public.js` —
  `publicUrls({ dir, site })`, the union of the site's `content/public/` and
  the preset's `public/` with the site winning a shared path. Today only the
  `presetPublic` plugin builds that union, privately. `generateBundle`, the
  extension and `check` all call the lister; the extension loads it from the
  workspace's own site-kit, the way it loads the workspace's Mesa compiler,
  so there is one owner (Invariants 4, 5).
- [ ] 0.2 Collect where paths appear in real content: front-matter keys
  (`image:`, `background:`, …), Markdown `![](…)`, and block attributes.

### Phase 1 — Completion

Goal: typing `/` in a path position under `content/` offers the site's files.
Done when: a test in `packages/frontierjs-vscode/test/` against
`vscode-stub.js` completes `/media/te` to `/media/team.jpg` from a fixture
site, the extension's full list equals the set `presetPublic` emits for the
same fixture (so completion and serving cannot drift), and
`npm run verify:package` passes with the new manifest.

- [ ] 1.1 Activate on `workspaceContains:**/content/settings/site.md` alone.
  Activation events are OR'd, so adding `onLanguage:markdown` would wake the
  extension on every Markdown file anywhere. `activationEvents` is `[]` today,
  implicit from `contributes.languages`, which covers neither language.
  The provider finds its site from the document's own path — the nearest
  `content/settings/site.md` upward — so a multi-root workspace picks the
  right one.
- [ ] 1.2 Provider: items labelled by URL, `filterText` the basename, `kind`
  `File`, range the typed fragment.
- [ ] 1.3 Watcher invalidates the list on create/delete/rename.

### Phase 2 — Seeing the path

Goal: the path is checked and previewed where it is written.
Done when: the fixture site's broken path shows a warning and a good one
shows a preview on hover.

- [ ] 2.1 Hover on a `/…` URL renders the image (`MarkdownString` with the
  file URI).
- [ ] 2.2 Warning diagnostic on a URL with no file behind it.
  `site-kit/check/rules/links.js` already flags a missing image, but only in
  the built `dist/`. Share its test rather than writing a second one beside it.

## Open questions

- ~~**Q1 — Which paths complete?**~~ **Answered 2026-11-17 (`FJS-D2254`): B — any `/` in a path position, so `/theme/…` and other public files complete too.**
  - **A** — only after `/media/`, as the legacy extension did.
  - **B** — any `/` in a path position, so `/theme/…` and other public files
    complete too.
  - **Recommend B** — site-kit's URL space is all of `public/`, and `/media/`
    is a ksite habit rather than a site-kit rule. The extension already asks
    Litestone's catalog for what the language contains rather than listing
    it, so B is the same shape.
- ~~**Q2 — Does it ship before the extension's first marketplace publish?**~~ **Answered 2026-11-17 (`FJS-D2255`): A — yes, in 0.1.x.**
  The extension is unpublished (`PROJECT_STATE.md` § Publishing).
  - **A** — yes, in 0.1.x.
  - **B** — after, as the first feature release.
  - **Recommend A** — publishing waits only on the PAT, and no release
    boundary exists yet for B to respect.
