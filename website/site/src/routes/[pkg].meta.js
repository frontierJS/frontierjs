// site/src/routes/[pkg].meta.js — one page per package, from packages.js.
//
// This replaces eight hand-written HTML files that were identical except for a
// `data-pkg` attribute, each shipping an empty <div id="page"> that a classic
// script filled in on load. A crawler saw eight empty pages; a visitor with
// slow JavaScript saw nothing. The content is in the file now.
//
// `getStaticPaths()` answers WHICH pages exist, `load()` answers what is in
// one, and `head()` gives each its own title and description — frontmatter is
// static text, so without it eight pages share one title, which is the single
// field a search result is built from.
//
// The URL slug is the old page's filename: `cli` publishes at `/fli/` and
// `editor` at `/vscode/`, because those are the names the subnav shows and the
// names anyone has ever linked.

import { loadFJS } from '../data/packages.js'
import { block, sniff } from '../data/code.js'

/** `litestone.html` → `litestone`. The old URL, minus the extension. */
const slugFor = (pkg) => pkg.page.replace(/\.html$/, '')

export async function getStaticPaths() {
  const { PKGS } = await loadFJS()
  return PKGS.map((p) => ({ pkg: slugFor(p) }))
}

export async function load({ params }) {
  const { PKGS } = await loadFJS()

  const pkg = PKGS.find((p) => slugFor(p) === params.pkg)
  if (!pkg) throw new Error(`no package publishes at /${params.pkg}/`)

  // Anchor ids from the feature label: "Go to def" → "go-to-def".
  const slug = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  // Junction carries a second block of attached packages; every other package
  // has one unnamed group.
  const groups = [{ title: null, rows: pkg.rows }]
  if (pkg.extra) groups.push({ title: pkg.extra.title, rows: pkg.extra.rows })

  // Highlighted HERE rather than in the page, because `v` and the code samples
  // are HTML — `v` may carry inline <code>, and glow marks up the samples.
  // Doing it at build time is what lets the page render them with {@html} and
  // ship no highlighter.
  return {
    name:   pkg.name,
    realm:  pkg.realm,
    tone:   pkg.tone,
    who:    pkg.who,
    pitch:  pkg.pitch,
    install: pkg.install,
    count:  groups.reduce((n, g) => n + g.rows.length, 0),
    groups: groups.map((g) => ({
      title: g.title,
      rows:  g.rows.map((r) => ({
        id:      slug(r.k),
        k:       r.k,
        v:       r.v,                                    // already HTML
        why:     r.why,
        code:    r.code ? block(r.code, sniff(r.code)) : null,  // already HTML
        replaces: r.r ?? [],
      })),
    })),
    chips: (pkg.chips ?? []).map(([heading, terms]) => ({
      heading, terms: terms.split(' '),
    })),
    // Every package in the site's nav, and the rest of the stack at the foot.
    nav: PKGS.map((p) => ({
      slug: slugFor(p), label: slugFor(p), current: p.id === pkg.id,
    })),
    others: PKGS.filter((p) => p.id !== pkg.id)
      .map((p) => ({ slug: slugFor(p), name: p.name, realm: p.realm })),
  }
}

export function head({ data }) {
  return {
    title:       `${data.name} — ${data.realm} | FrontierJS`,
    description: data.pitch,
  }
}
