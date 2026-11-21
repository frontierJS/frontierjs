# A markdown site with site-kit

`@frontierjs/site-kit` is the engine for a markdown-authored marketing site: its blocks, layouts, themes and build. The site is a `content/` folder and nothing else, so upgrading is a version bump, and it builds on Sierra's static target.

```md
---
layout: Block
name: Solution
template: split
tone: muted
treatment: outlined
---
Plain markdown here becomes a band on the page.
```

## What else it can do

- `site-kit dev site`, `site-kit build site` and `site-kit serve site` run it, and `--binary` compiles one executable
- `site-kit deploy site` ships the last build to a Cloudflare Worker, and `--preview` makes a review link
- A route is a markdown file under `content/routes/`, and its path is its URL
- A folder named in parentheses groups routes without adding to the URL
- `content/settings/site.md` front matter becomes names a page uses bare, such as `{company_name}`
- A collection is a folder of markdown under `content/collections/`, listed from a block
- A block's look is a few front-matter keys, each a word `@frontierjs/css` ships
- A preset is a package that adds blocks, layouts and build plugins
- `site-kit check site` reports what is broken before the site ships
- `site-kit fetch site <url>` starts a site from an existing one

**In depth:** [site-kit README](../../../../site-kit/README.md)
