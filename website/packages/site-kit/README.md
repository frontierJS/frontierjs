# @frontierjs/site-kit

The engine a markdown-authored marketing site takes as a dependency: its blocks,
layouts, themes and build. The site that depends on it is its `content/` folder
and nothing else, so upgrading a site is a version bump rather than a copy
(`FJS-D33`).

**Private and unlisted while it is built out.** It lives inside `website/`
because frontierjs.com is its first consumer and the place its kinks get found;
the Kobami client template (`fjs-prototypes/ksite`) extends it next, with a
cleaning-company theme and content over the same engine.

A site is its `content/` folder: `site-kit dev site`, `site-kit build site`,
`site-kit preview site`. The shell, the dev entry and the build config live
here; the site's own settings are `content/settings/site.js`. Blocks are
exported as `@frontierjs/site-kit/blocks/<Name>.mesa`.

A site can name a **preset**, a package that adds blocks, layouts, stylesheets
and build plugins: `export default { preset: '@kobami/ksite' }` in
`content/settings/site.js`. The package exports `./preset`, a function of the
site returning `{ sierra, plugins, shell }`. A preset that does not load stops
the build by name.

Analytics is Sierra's `analytics` key in the same file — `analytics: {
provider: 'plausible', domain: 'example.com' }` — and the build puts the
vendor's tag in every page's `<head>`.
