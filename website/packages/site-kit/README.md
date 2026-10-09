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

A content block names its wrapper with `layout: Block`, and site-kit ships
`Block`. A top-level block renders as a Band (`<section class="band">` holding
a `.container`), a nested one as an `<article>`, and one with a `url` as an
`<a>`. Its look is six front-matter keys, each a word `@frontierjs/css` ships:

```md
---
layout: Block
name: Solution
template: split      # a Layout helper: stack, cluster, center, split, grid
tone: muted          # primary, secondary, muted, info, success, warning, danger
treatment: outlined  # raised, outlined, ghost, glass, bordered
density: roomy       # dense, roomy
align: center        # start, center, end
background: /media/team.jpg   # a photo under the Band's scrim
---
```

A value css does not ship stops the build, naming the key and the choices.
`classes:` stops it too. A look these keys cannot state, such as one that
changes at a breakpoint, goes in the site's own stylesheet under the block's
`name`.

A site can name a **preset**, a package that adds blocks, layouts, stylesheets
and build plugins: `export default { preset: '@kobami/ksite' }` in
`content/settings/site.js`. The package exports `./preset`, a function of the
site returning `{ sierra, plugins, shell }`. A preset that does not load stops
the build by name.

Analytics is Sierra's `analytics` key in the same file — `analytics: {
provider: 'plausible', domain: 'example.com' }` — and the build puts the
vendor's tag in every page's `<head>`.
