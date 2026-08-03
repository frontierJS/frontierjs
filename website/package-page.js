/*
 * package-page.js — renders a dedicated page for one package.
 *
 * Every one of the eight package pages is the same forty lines of HTML with a
 * different `data-pkg` on <body>. Everything below the topbar is built from
 * packages.js, so a feature is written once and appears everywhere it belongs.
 *
 * Classic script — packages.js must load first. See the note there.
 */

const { PKGS, esc, hl, theme, SWATCHES, SWATCH_HEX } = window.FJS

const pkg = PKGS.find(p => p.id === document.body.dataset.pkg)
if (!pkg) throw new Error(`Unknown package: ${document.body.dataset.pkg}`)

document.title = `${pkg.name} — ${pkg.realm} | FrontierJS`

// Anchor ids from the feature label: "Go to def" → "go-to-def"
const slug = k => k.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// All features, including the attached-packages block Junction carries.
const groups = [{ title: null, rows: pkg.rows }]
if (pkg.extra) groups.push({ title: pkg.extra.title, rows: pkg.extra.rows })
const all = groups.flatMap(g => g.rows)

const others = PKGS.filter(p => p.id !== pkg.id)

const feature = r => `
  <article class="feat" id="${slug(r.k)}">
    <h2>${esc(r.k)}</h2>
    <p class="one">${r.v}</p>
    <p class="why">${esc(r.why)}</p>
    ${r.code ? `<pre>${hl(r.code)}</pre>` : ''}
    <div class="rep">
      <h4>Replaces</h4>
      ${r.r && r.r.length
        ? `<div class="list">${r.r.map(t => `<span>${esc(t)}</span>`).join('')}</div>`
        : `<p class="none">Nothing — there is no common equivalent to swap out.</p>`}
    </div>
  </article>`

document.getElementById('page').innerHTML = `
  <header class="topbar">
    <div class="container">
      <a class="brand" href="index.html">Frontier<span>JS</span></a>
      <nav class="navset">
        <a href="showroom5.html">All packages</a>
        <a href="showroom2.html">Walkthrough</a>
        <a href="showroom3.html">The ripple</a>
        <a href="showroom4.html">The loop</a>
        <a href="journey.html">The journey</a>
      </nav>
      <div class="swatches" role="group" aria-label="Theme">
        ${SWATCHES.map(t =>
          `<button class="swatch" data-theme="${t}" title="${t[0].toUpperCase() + t.slice(1)}"
                   style="background:${SWATCH_HEX[t]}"></button>`).join('')}
      </div>
    </div>
  </header>

  <nav class="subnav">
    <div class="container">
      ${PKGS.map(p =>
        `<a href="${p.page}"${p.id === pkg.id ? ' aria-current="page"' : ''}>${p.id === 'cli' ? 'fli' : p.id === 'editor' ? 'vscode' : p.id}</a>`
      ).join('')}
    </div>
  </nav>

  <div class="container phero">
    <div class="id">
      <h1>${esc(pkg.name)}</h1>
      <span class="badge ${pkg.tone}">${pkg.realm}</span>
      <span class="who">${esc(pkg.who)}</span>
    </div>
    <p class="pitch" style="font-size:1.1rem; max-width:60ch">${esc(pkg.pitch)}</p>
    <div class="install"><pre>$ ${esc(pkg.install)}</pre></div>
  </div>

  <div class="container pbody">
    <nav class="ptoc" aria-label="Features">
      <p class="lbl">${all.length} features</p>
      ${groups.map(g => `
        ${g.title ? `<p class="lbl" style="margin-top:1rem">${esc(g.title)}</p>` : ''}
        ${g.rows.map(r => `<a href="#${slug(r.k)}">${esc(r.k)}</a>`).join('')}
      `).join('')}
    </nav>

    <div>
      ${groups.map(g => g.rows.map(feature).join('')).join('')}

      ${pkg.chips ? `<div class="chips" style="margin-top:2.5rem; padding-top:1.75rem; border-top:1px solid var(--rule)">
        ${pkg.chips.map(([h, terms]) => `
          <h3>${esc(h)}</h3>
          <div class="chipline">${terms.split(' ').map(t => `<code>${esc(t)}</code>`).join('')}</div>`).join('')}
      </div>` : ''}

      <div style="margin-top:3rem; padding-top:1.75rem; border-top:1px solid var(--rule)">
        <p class="lbl" style="font-size:.68rem; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-mute); margin:0 0 .6rem">
          The rest of the stack
        </p>
        <div class="pnext">
          ${others.map(p => `
            <a href="${p.page}"><b>${esc(p.name)}</b><span>${esc(p.realm)}</span></a>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <footer>
    <div class="container split">
      <span>${esc(pkg.who)} — part of FrontierJS.</span>
      <span><a class="link" href="showroom5.html">← All eight packages</a></span>
    </div>
  </footer>`

theme()

// Highlight the table-of-contents entry for whatever is on screen.
const links = new Map([...document.querySelectorAll('.ptoc a')].map(a => [a.hash.slice(1), a]))
const seen = new Set()
const spy = new IntersectionObserver(entries => {
  for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id)
  const first = [...document.querySelectorAll('.feat')].find(f => seen.has(f.id))
  for (const [id, a] of links) {
    if (first && id === first.id) a.setAttribute('aria-current', 'true')
    else a.removeAttribute('aria-current')
  }
}, { rootMargin: '-88px 0px -60% 0px' })

for (const f of document.querySelectorAll('.feat')) spy.observe(f)
