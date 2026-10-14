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
`site-kit preview site`. `site-kit build site --binary` then compiles `site/dist`
and its server into one executable at `site/bin/site` (`./site/bin/site --port 8080`). The shell, the dev entry and the build config live
here. `content/settings/site.js` is the site's Sierra config, and
`content/settings/site.md` is its settings. Blocks are exported as
`@frontierjs/site-kit/blocks/<Name>.mesa`.

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
site returning `{ sierra, plugins, shell, rules }`. A preset that does not load stops
the build by name. A `public/` directory at the preset's package root ships
beneath the site's `content/public/`, so its fonts and images keep their URLs
(`/theme/fonts/…`); a file the site's `public/` also has is the site's.

A site's own redirects are `content/settings/_redirects`, one `FROM TO [STATUS]`
per line, the format Cloudflare and Netlify read. The build merges them with
every route's `redirect:` into `dist/_redirects`, and one path sent two places
stops it. A `_redirects` in `content/public/`, or a `_redirects` or `_headers`
in a preset's `public/`, stops the build by name (`FJS-D961`).

`site-kit check site` says what is broken or unfinished before a site ships,
and where: `file:line` for content, the page path for built output. It reads
`content/` (an unknown `<Tag>` or `layout:`, a `{merge_field}` no setting
holds, a divider with no blank line above, front-matter that is not YAML,
`robots.txt`, the redirects) and `dist/` when there is one (the sitemap,
canonicals, titles, descriptions, headings, `og:image`, every internal link
and image, and the JSON-LD against schema.org). It exits 1 on an error;
warnings and notes never block. `--source` skips the build, `--live` reads the
deployed site at its `siteUrl`, `--only schema` runs one group or rule,
`--json` is for scripts, and `--all` lists every location. A preset's `rules`
run beside the kit's, and one with a kit rule's id replaces it (`FJS-D962`);
any other `--flag` reaches those rules (`@kobami/ksite` reads `--launch`).

Analytics is Sierra's `analytics` key in the same file — `analytics: {
provider: 'plausible', domain: 'example.com' }` — and the build puts the
vendor's tag in every page's `<head>`.

**Settings** are `content/settings/site.md`'s front-matter, and every key is a
name a page uses bare: `company_name: Acme` makes `{company_name}` in prose
read *Acme*. A key that is not a JavaScript name stops the build by name. In
`vite dev` an edited value shows on reload; a key added or removed needs the
server restarted, and the log says so. A block reads the whole object as
`import { frontmatter as settings } from '@content/settings/site.md'`.
`@content` is the site's `content/` folder wherever the block renders, so a
menu is `@content/menus/main-menu.md` the same way.

**A collection** is a folder of Markdown under `content/collections/`, one
item per file. A block lists one with an eager glob it writes itself, because
the glob has to be a literal in the `.mesa` file for the prerender to expand it:

```js
import { collection } from '@frontierjs/site-kit/collection'
const reviews = collection(import.meta.glob('/content/collections/reviews/*.md', { eager: true }))
// [{ slug: '1-stacy', frontmatter: { rating: 5, … }, Body }, …] in file-name order
```

Items come in file-name order by code unit, so `9-grant.md` comes before
`91-alison.md`. A folder that does not exist is an empty list.
