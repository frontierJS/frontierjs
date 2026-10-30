// ─── scaffold/web.js — the web/ surface fli new writes ─────────────────────
//
// Sierra + Mesa + Vite: the shell, the configs, the layout, the home page and
// the auth pages. Each builder returns the file's text; `commands/project/new.md`
// decides which are written. A backtick inside a comment inside one of these
// literals closes the literal — plain words or -- quoting.
// ─────────────────────────────────────────────────────────────────────────────

import { scaffoldPort, surfaceIndexHtml, surfaceViteConfig } from './surface.js'

export function makeIndexHtml(appName) {
  return surfaceIndexHtml({
    title: appName,
    head:  `    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
`,
    // class="app" is what gives the page @frontierjs/css's font and ground; the
    // package has no bare body rule, so without it text outside a component
    // falls back to the browser's serif.
    bodyClass: 'app',
    body:  `    <div id="app"></div>
    <script type="module" src="virtual:sierra"></script>
`,
  })
}

// What makes the built app one a browser offers to install, and the build
// grades it: `sierra` prints `manifest.webmanifest — installable` or names
// the rule a change broke, since an install button that stops appearing says
// so nowhere else. An SVG counts as an icon of any size.
export function makeWebManifest(appName) {
  return `${JSON.stringify({
    name:             appName,
    short_name:       appName,
    start_url:        '/',
    display:          'standalone',
    background_color: '#ffffff',
    icons:            [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }, null, 2)}
`
}

export function makeIconSvg(appName) {
  const letter = (appName.replace(/[^a-z0-9]/gi, '')[0] ?? 'a').toUpperCase()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2b4c7e"/>
  <text x="32" y="44" font-family="system-ui, sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">${letter}</text>
</svg>
`
}

export function makeViteConfig(useApi = true) {
  return surfaceViteConfig({ surface: 'web', port: scaffoldPort('fe'), proxy: useApi, about: useApi ? `
Sierra produces the route table and the schema seed from sierra.config.js;
the dev proxy is this file's job, because only the app knows where its own
API listens.
` : `
Sierra produces the route table from sierra.config.js. This app has no API,
so there is no dev proxy to add.
` })
}

export function makeSierraConfig(appName, useApi = true) {
  return `// web/config/sierra.config.js
// Sierra runtime config — routes dir, build target${useApi ? ', junction connection' : ''}.
// Paths are relative to the Vite root (web/), since the web script cd's into web/
// before invoking vite -c config/vite.config.js.
${useApi ? `
import api from '../../api/config/junction.config.js'
` : ''}
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  // Two of @frontierjs/css's themes, following the OS until somebody presses the
  // switch in the topbar. Sierra writes the class on <html> from a <head> script,
  // before first paint — anything the app ran itself would flash the default
  // first. Add any other theme-* class the package ships to the list and the
  // switch cycles through it.
  theme: {
    themes:  ['theme-default', 'theme-dark'],
    default: 'system',
  },
${useApi ? `
  junction: {
    // Where the API is when there is no page — a terminal, a prerender. A page
    // calls its own origin, which is right while Vite or nginx proxies /api to
    // it. An API on its own origin (api.example.com beside app.example.com) or
    // a build a native shell bundles has no proxy in front of it, so the build
    // names it, and Sierra inlines it into the page:
    //   FRONTIER_PUBLIC_API_URL=https://api.example.com bun run build
    // The client upgrades to ws itself, so this stays http.
    url:      'http://localhost:8000',
    tokenKey: '${appName}_token',
    // Read from the API's config, which states it once: Junction defaults to
    // no prefix, so a client that guessed would request paths the server
    // never registered.
    apiPrefix: api.app.apiPrefix,
  },
` : ''}}
`
}

export function makeAppMesa() {
  return `<script>
  import { RouterView } from '@frontierjs/sierra/router'
</script>

<RouterView />
`
}

export function makeMainJs(useApi = true) {
  return `// web/src/main.js — the app's side-effect imports. index.html loads
// virtual:sierra, which boots the router and the client, imports this file and
// then mounts App.mesa into #app (FJS-D1085).

// Methods on the built-in types -- (1299).toMoney(). Before anything that
// renders, so a template never meets a number without them.
import './lib/sugar.js'
${useApi ? `
// Contributed form controls, registered before any route renders.
import './lib/controls.js'
` : ''}
// The design system. One import, no build step, no config.
import '@frontierjs/css'
`
}

// A stub, imported by main.js before any route renders: a control is registered
// at startup or a generated form has already picked its own.
export function makeControlsJs() {
  return `// web/src/lib/controls.js -- the form controls this app contributes, imported by
// main.js before any route renders. A generated form asks controlFor(rule) which
// control a column gets, and a name registered here replaces a built-in of that
// name. Two halves, one per side of the dependency rule:
//
//   import { registerControl }     from '@frontierjs/sierra/resource'
//   import { registerFormControl } from '@frontierjs/ui/controls'
//   import Rating from '../components/Rating.mesa'
//
//   registerControl('rating', (rule, { field }) => (field === 'rating' ? 'rating' : null))
//   registerFormControl('rating', Rating)
`
}

// The generated file is JS inside this literal, so it builds its strings by
// concatenation: a backtick or a dollar-brace below would be read HERE.
export function makeSugarJs(currency = 'USD') {
  const money = currency ? `number({ currency: '${currency}' })` : 'number()'
  return `// web/src/lib/sugar.js -- convenience methods on the built-in types, so a template
// writes {order.total?.toMoney()} and {user.name.initials()}. The methods are
// @frontierjs/toolbelt/sugar's and this file installs them; main.js imports it
// first. Delete a line to drop a group, or this file and its import to drop
// all of them. No framework package calls these, so removing them breaks only
// this app's own code.
//
// toMoney is CENTS, what a @money column stores: (1299).toMoney() is $12.99.
// toCurrency is DOLLARS: (12.99).toCurrency() is $12.99. Read a column with ?.
// -- a missing amount renders blank in a template, and a method called on it
// throws.

import { number, bigint, string, date, array, object, json, func } from '@frontierjs/toolbelt/sugar'
import { dt } from '@frontierjs/mesa/browser'

// A name the platform already has is refused, never replaced: a library that
// shadowed Array.prototype.flatten made the language rename its own to flat.
const SUGAR = Symbol.for('frontierjs.sugar')

function install(Type, { proto = {}, statics = {} }) {
  const label = Type.name || Type[Symbol.toStringTag]
  for (const [target, methods, at] of [[Type.prototype, proto, '.prototype.'], [Type, statics, '.']]) {
    for (const [name, value] of Object.entries(methods)) {
      if (name in target && !target[name]?.[SUGAR]) throw new Error('sugar: ' + label + at + name + ' already exists')
      value[SUGAR] = true
      Object.defineProperty(target, name, { value, writable: true, configurable: true })
    }
  }
}

install(Number,   ${money})
install(BigInt,   bigint())
install(String,   string({ dt }))
install(Date,     date(dt))
install(Array,    array())
install(Object,   object())
install(JSON,     json())
install(Function, func())

// ─── extras ─────────────────────────────────────────────────────────────────
// Timers, the network, and calls that change what they are given: not pure,
// so not in the kit, and this copy is the app's own.

install(Promise, { statics: {
  sleep: (seconds = 1) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),

  // Every call settles. A call superseded inside the window gets the result of
  // the one that ran, where dropping its timer left its caller awaiting forever.
  debounce(fn, delay, { leading = true } = {}) {
    let timer, waiting = false, queued = []
    return (...args) => new Promise((resolve, reject) => {
      const run = () => Promise.resolve().then(() => fn(...args))
      if (leading && !waiting) {
        waiting = true
        run().then(resolve, reject)
        timer = setTimeout(() => { waiting = false }, delay)
        return
      }
      clearTimeout(timer)
      queued.push([resolve, reject])
      timer = setTimeout(() => {
        const settle = queued
        queued = []
        waiting = false
        run().then((v) => settle.forEach(([ok]) => ok(v)), (e) => settle.forEach(([, no]) => no(e)))
      }, delay)
    })
  },
} })

install(URL, {
  proto: {
    fetch(type = 'json') { return fetch(this).then((res) => res[type]()) },
  },
  statics: {
    async exists(url) {
      try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
    },
  },
})

install(Array, { statics: {
  upsert(items, instance, { position = 'end' } = {}) {
    const index = items.findIndex((item) => item.id === instance.id)
    if (index !== -1) items[index] = instance
    else if (typeof position === 'number') items.splice(position, 0, instance)
    else if (position === 'start') items.unshift(instance)
    else items.push(instance)
    return items
  },
  // Reassigns the row in place so a reactive list sees it change. An id not in
  // the list is left alone; index -1 wrote a property named '-1'.
  reset(items, instance) {
    const index = items.findIndex((item) => item.id === instance.id)
    // biome-ignore lint/correctness/noSelfAssign: the self-assign is how a Mesa list learns a row changed
    if (index !== -1) items[index] = items[index]
    return items
  },
} })

install(Object, { statics: {
  // A missing step on the way is made, where the legacy copy threw on it.
  put(path, obj, value, cb) {
    const keys = path.split('.')
    let at = obj
    for (const key of keys.slice(0, -1)) at = at[key] ??= {}
    return (at[keys.at(-1)] = cb ? cb(value) : value)
  },
  delete(path, obj) {
    const keys = path.split('.')
    const at = keys.slice(0, -1).reduce((acc, key) => acc?.[key], obj)
    if (at != null) delete at[keys.at(-1)]
  },
} })
`
}

// The nav table. The Shell draws it and `make:scaffold` appends to it, so a new
// model's list is reachable without anyone editing the layout.
export function makeNavJs(useAuth) {
  return `// The app's navigation table, drawn by the Shell in routes/_module.mesa.
// \`fli make:scaffold\` appends an entry here for each model it lays out.
//
// A \`show\` is an affordance and never the boundary: the server
// refuses whatever the nav offers, so hiding a link changes what is worth
// clicking and nothing about what is reachable.
${useAuth ? `
// db/schema.lite gates User at level 4, so the link is for members: a nav that
// offers a stranger a page that always answers "Authentication required" is a
// working app reporting itself broken.
const members = ({ user }) => !!user
` : ''}
export const groups = [
  { label: null, entries: [
    { href: '/', label: 'Home', exact: true },
${useAuth ? "    { href: '/users/', label: 'Users', show: members },\n" : ''}  ] },
]
`
}

// The live WebSocket as a dot, last in the topbar: the word 'live' / 'offline'
// changed width when the socket dropped and moved every control beside it.
const LIVE_DOT = `    <Dot tone={status.connected ? 'success' : 'muted'} role="status"
         title={status.connected ? 'Live' : 'Offline'}
         label={status.connected ? 'Live' : 'Offline'} />
`
const DOT_IMPORT = "  import Dot from '@frontierjs/ui/components/display/Dot.mesa'\n"

export function makeRouteModule(appName, useAuth, useApi = true) {
  if (useAuth) {
    return `---
siteName: ${appName}
---
<script>
  import { goto, isActive, page } from '@frontierjs/sierra/router'
  import { status, session, signOut } from '@frontierjs/sierra/resource'
  import { theme, toggleTheme } from '@frontierjs/sierra/theme'
  import Shell from '@frontierjs/ui/components/layout/Shell.mesa'
${DOT_IMPORT}
  import { groups } from '../lib/nav.js'

  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  //
  // session.checked is here for the same reason and answers a different
  // question: the boot restore is asynchronous, so on a cold load session.user
  // is null for a caller who IS signed in. The Shell draws nothing until it
  // settles, because the signed-out frame in its place is the redirect flash.
  $: (page.siteName, page.route, page.pathname, page.query)
  $: (status.connected, session.user, session.level, session.checked, theme.value)

  // Awaited: signOut ends the session at the SERVER and then locally, and
  // navigating first would send the guard past a session that is still there.
  async function out() {
    await signOut()
    goto('/login/')
  }
</script>

<!--
  Every class here is @frontierjs/css, imported once in main.js, so there is no
  <style> block: a color written here is one a theme cannot reach.

  The Shell draws the bar and the nav from src/lib/nav.js and marks the current
  page with aria-current through Sierra's isActive. Home is public, so a
  visitor with no account gets the same frame and its Sign in button.
-->
<Shell {groups} layout="topbar"
       path={page.pathname} query={page.query}
       user={session.user} level={session.level} checked={session.checked}
       {isActive} onsignout={out}>
  {#snippet brand()}
    <strong>{page.siteName}</strong>
  {/snippet}

  {#snippet topbar()}
    <button class="btn ghost square" onclick={toggleTheme}
            aria-label={theme.value === 'theme-dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme.value === 'theme-dark' ? '☀' : '☾'}
    </button>
    {#if session.user}
      <a class="navlink" href="/account/" aria-current={(page.route, isActive('/account/')) ? 'page' : null}>{session.user.email}</a>
    {:else}
      <a class="btn primary" href="/login/">Sign in</a>
    {/if}
${LIVE_DOT}  {/snippet}

  <slot />
</Shell>
`
  }

  return `---
siteName: ${appName}
---
<script>
  import { isActive, page } from '@frontierjs/sierra/router'
${useApi ? "  import { status } from '@frontierjs/sierra/resource'\n" : ''}  import { theme, toggleTheme } from '@frontierjs/sierra/theme'
  import Shell from '@frontierjs/ui/components/layout/Shell.mesa'
${useApi ? DOT_IMPORT : ''}
  import { groups } from '../lib/nav.js'

${useApi ? `  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  $: (page.siteName, page.pathname, page.query, status.connected, theme.value)
` : `  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  $: (page.siteName, page.pathname, page.query, theme.value)
`}</script>

<!--
  Every class here is @frontierjs/css, imported once in main.js, so there is no
  <style> block: a color written here is one a theme cannot reach.

  The Shell draws the bar and the nav from src/lib/nav.js and marks the current
  page with aria-current through Sierra's isActive.
-->
<Shell {groups} layout="topbar"
       path={page.pathname} query={page.query}
       {isActive}>
  {#snippet brand()}
    <strong>{page.siteName}</strong>
  {/snippet}

  {#snippet topbar()}
    <button class="btn ghost square" onclick={toggleTheme}
            aria-label={theme.value === 'theme-dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme.value === 'theme-dark' ? '☀' : '☾'}
    </button>
${useApi ? LIVE_DOT : ''}  {/snippet}

  <slot />
</Shell>
`
}

// The catch-all. Without it an unknown URL renders the layout around nothing,
// which reads as a page that failed to load rather than one that does not exist.
export function makeRouteNotFound() {
  return `---
title: Not found
---
<script>
  import { page } from '@frontierjs/sierra/router'

  // [...404] is the catch-all: Sierra matches it only after every other route
  // has declined, and puts the unmatched path under params['404'].
  $: page.params
</script>

<div class="empty">
  <div class="empty-icon" aria-hidden="true">🧭</div>
  <div class="empty-title">Nothing lives at <code>/{page.params['404']}</code></div>
  <div class="empty-text">The link may be old, or the address mistyped.</div>
  <div class="empty-actions">
    <a class="btn primary" href="/">Go home</a>
  </div>
</div>
`
}

export function makeRouteIndex(appName, useApi = true) {
  return `---
title: Home
---
<script>
${useApi ? `  import { status } from '@frontierjs/sierra/resource'

  // The $: line is the subscription — without it this renders once at the
  // initial false and never changes.
  $: status.connected

  // status.connected is the SOCKET, and the client opens one only once it holds
  // a token — so a signed-out visitor is correctly false and it says nothing
  // about whether the API is up. This page used to print that as
  // "connecting…" forever on a scaffold nobody had signed into yet, which is a
  // working app reporting itself broken on its own front page.
  // Same origin — web/config/vite.config.js proxies /api to the API in dev, and
  // a deployed build serves both from one host. '/api' is this app's apiPrefix,
  // set in api/config/junction.config.js; change it there and here.
  // One request read by two blocks: the badge, and the sentence under it that
  // only a failure needs.
  const health = fetch('/api/health').then(r => {
    if (!r.ok) throw new Error('API answered ' + r.status)
    return r.json()
  })
` : ''}
  // ─── the tour ──────────────────────────────────────────────────────
  // Everything from here down is a worked example of the language this file
  // is written in, placed so it can be read beside what it renders. Delete it
  // when you write your own home page; nothing else imports any of it.

  let count = 0
  let name  = ''

  // A $: line re-runs when anything it READ changes. Nothing is declared as a
  // dependency, and nothing has to be.
  $: greeting = name ? 'Hello, ' + name : 'Hello'

  const realms = [
${useApi ? `    { noun: 'Model',    realm: 'Data', where: 'db/schema.lite' },
    { noun: 'Service',  realm: 'API',  where: 'api/src/services/' },
    { noun: 'Resource', realm: 'UI',   where: 'web/src/resources/' },
` : `    { noun: 'Route',     realm: 'UI', where: 'web/src/routes/' },
    { noun: 'Component', realm: 'UI', where: 'web/src/components/' },
`}  ]
</script>

<!--
  Every class on this page is a word from @frontierjs/css — what a thing IS
  (card, badge, btn) and what is true about it (primary, success, muted). The
  <style> block at the bottom holds one grid and no color, because a color
  written here is one no theme can reach.
-->
<header class="stack gap-sm">
  <h1>Welcome to ${appName}</h1>
  <p class="text-lg text-muted">
    This page is <code>web/src/routes/index.mesa</code>, and the tour below is
    running rather than quoted — every point does the thing it describes.
  </p>

${useApi ? `  <div class="cluster">
    {#await health}
      <span class="badge muted">API · checking</span>
    {:then}
      <span class="badge success">API · reachable</span>
    {:catch}
      <span class="badge danger">API · unreachable</span>
    {/await}
    <span class="badge" class:success={status.connected} class:muted={!status.connected}>
      Socket · {status.connected ? 'open' : 'opens when you sign in'}
    </span>
  </div>

  {#await health}{:then}{:catch error}
    <div class="alert danger" role="alert">
      <div class="alert-content">
        Is <code>bun run api</code> running? ({error.message})
      </div>
    </div>
  {/await}
` : ''}</header>

<section class="tour stack gap-md">
  <h2>Mesa in a minute</h2>

  <div class="grid">
    <article class="card stack gap-sm">
      <h3>1 · State is a variable</h3>
      <p>No store, no hook, no setter. Assign to it, and the markup that read it
         is what updates.</p>
      <div class="cluster">
        <button class="btn primary" onclick={() => count++}>Press me</button>
        <span class="pill" class:muted={count === 0} class:success={count > 0}>pressed {count} times</span>
      </div>
    </article>

    <article class="card stack gap-sm">
      <h3>2 · A <code>$:</code> line re-runs when what it read changes</h3>
      <p>The subscription is the line itself — there is no dependency array to
         keep in step with the body.</p>
      <input class="field" bind:value={name} placeholder="your name" aria-label="your name" />
      <p class="text-lg">{greeting}</p>
    </article>

    <article class="card stack gap-sm">
      <h3>3 · Blocks are markup</h3>
      <p><code>&#123;#each&#125;</code> and <code>&#123;#if&#125;</code> are
         compiled to DOM operations rather than re-run as functions. Both are
         below, over ${useApi ? 'the three nouns this framework has' : 'the folders this app has'}.</p>
      <dl class="facts divided">
        {#each realms as r}
          <dt>{r.noun}</dt>
          <dd>the {r.realm} realm, in <code>{r.where}</code></dd>
        {/each}
      </dl>
      {#if count > 2}
        <p class="text-sm text-muted">…and the button in card 1 has been pressed {count} times.</p>
      {/if}
    </article>

    <article class="card stack gap-sm">
      <h3>4 · Styles are scoped to the file</h3>
      <p>The <code>&lt;style&gt;</code> block at the bottom cannot leak out of
         this component, and cannot reach into a child one. To cross that line
         you write <code>:global(…)</code>, which is a thing you can grep for.</p>
    </article>

    <article class="card stack gap-sm">
      <h3>5 · Everything the runtime offers is on <code>$</code></h3>
      <p><code>$.onMount</code>, <code>$.emit</code>, <code>$.tick</code>. Five
         members keep a bare spelling because they are read as a bag in the
         middle of markup: <code>$props</code>, <code>$attributes</code>,
         <code>$slots</code>, <code>$context</code>, <code>$async</code>.</p>
    </article>
  </div>
</section>

<section class="next stack gap-md">
  <h2>Where to go next</h2>
  <ol class="steps vertical">
${useApi ? `    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>db/schema.lite</code></span>
      <span class="step-hint">The seed. Models, gates and policies; the API and
        these screens are derived from it.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>fli scaffold Note --fields "title:string body:text"</code></span>
      <span class="step-hint">One command, a stanza in the seed and a working screen.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>fli tutor:access</code></span>
      <span class="step-hint">The next lesson: a gate and a row policy, watched
        refusing somebody.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><a class="link" href="https://github.com/frontierjs/frontierjs">github.com/frontierjs/frontierjs</a></span>
      <span class="step-hint">Mesa's reference is <code>packages/mesa/docs/</code>,
        the schema language is <code>packages/litestone/docs/</code>.</span>
    </li>
` : `    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>web/src/routes/index.mesa</code></span>
      <span class="step-hint">This page. Replace it; a file under <code>routes/</code> is a URL.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>fli make:component Card</code></span>
      <span class="step-hint">A component in <code>web/src/components/</code>.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><a class="link" href="https://github.com/frontierjs/frontierjs">github.com/frontierjs/frontierjs</a></span>
      <span class="step-hint">Mesa's reference is <code>packages/mesa/docs/</code>.</span>
    </li>
`}
  </ol>
</section>

<style>
  .tour, .next { margin-top: var(--space-3xl) }
  h3 { margin: 0 }
  p  { margin: 0 }
</style>
`
}

export function makeRouteLogin() {
  return `---
title: Sign in
---
<script>
  import { goto }                                    from '@frontierjs/sierra/router'
  import { session, signIn, completeSignIn, signOut } from '@frontierjs/sierra/resource'
  import Code                                        from '@frontierjs/ui/components/display/Code.mesa'

  let email    = ''
  let password = ''
  let code     = ''
  let error    = ''
  let loading  = false

  // A password is not always the whole answer. An account with two-step
  // sign-in turned on answers a CHALLENGE: nothing is stored, nobody is signed
  // in, and \`session.awaitingCode\` holds when the attempt lapses. The code box
  // below renders from it — without that branch this page sent a person with a
  // second factor to / signed out, with nothing on screen saying why.
  $: session.awaitingCode

  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      // signIn does the whole thing: POST to the auth plugin's own login
      // route (the client composes apiPrefix + authPrefix, so no path is
      // written here), store the token, open the socket, and load the session
      // — so \`session.user\` is there on the next line, unless a code is owed.
      await signIn(email, password)
      password = ''
      if (session.user) goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleCode() {
    loading = true
    error   = ''
    try {
      // The ticket is the client's; this sends the code. A refusal that ends
      // the attempt clears \`session.awaitingCode\`, which puts the password
      // form back.
      await completeSignIn(code.trim())
      code = ''
      goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function startOver() {
    await signOut()
    code = ''; error = ''
  }
</script>

<!-- A <form>, so Enter in either box signs in. Buttons that do not submit say
     type="button", or Enter would press the first of them. -->
<form class="auth-card card stack gap-md" onsubmit|preventDefault={session.awaitingCode ? handleCode : handleSubmit}>
  <h1 class="text-xl">Sign in</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  {#if session.awaitingCode}
    <p class="text-sm text-muted">Enter the code from your authenticator app, or one of your recovery codes.</p>
    <input class="field" bind:value={code} autocomplete="one-time-code" inputmode="numeric" placeholder="123456" aria-label="Code" />
    <button class="btn primary" type="submit" disabled={loading}>
      {loading ? 'Checking…' : 'Verify'}
    </button>
    <button class="btn ghost" type="button" onclick={startOver} disabled={loading}>Start over</button>
  {:else}
    <input class="field" bind:value={email}    type="email"    placeholder="Email"    aria-label="Email"    autocomplete="username" />
    <input class="field" bind:value={password} type="password" placeholder="Password" aria-label="Password" autocomplete="current-password" />
    <button class="btn primary" type="submit" disabled={loading}>
      {loading ? 'Signing in…' : 'Sign in'}
    </button>

    <p class="text-sm text-muted">
      <a class="link" href="/reset/">Forgot your password?</a> · No account? <a class="link" href="/register/">Create one</a>
    </p>
  {/if}

  <!-- A fresh app has no rows in \`user\`, so the first person to open this
       page cannot sign in and there is nothing on screen saying why. The
       browser cannot count rows, so the hint is worded for a visitor who may
       already have an account. The other door is the CLI, which is also the
       only way to mint an ADMIN — register gives everybody role "user", and
       db/schema.lite gates delete at 5. -->
  {#if import.meta.env.DEV}
    <div class="alert info">
      <div class="alert-content text-sm stack gap-xs">
        <p>Dev only: no account to sign in with yet? Create one, or from the app root:</p>
        <Code text="fli auth:create-user you@example.com --role admin" />
      </div>
    </div>
  {/if}
</form>

<style>
  .auth-card { max-width: var(--auth-card-width, 24rem); margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}

// The page a password-reset link opens, and the page that asks for one. Written
// with auth, since both halves are routes @frontierjs/auth mounts.
export function makeRouteReset() {
  return `---
title: Reset your password
---
<script>
  // Both halves of a reset, told apart by the URL. Without a token this asks for
  // an address; the link that request produces lands back here WITH one, and
  // then this sets the new password.
  //
  // The token is read from the fragment (/reset/#token=…), which no request,
  // Referer or access log carries and an analytics tag does not forward.
  //
  // Nothing here signs anybody in. Confirming a reset ends every session the
  // account holds, so the next stop is the sign-in page.
  import { page }      from '@frontierjs/sierra/router'
  import { getClient } from '@frontierjs/sierra/resource'

  $: page.hash

  let email    = ''
  let password = ''
  let again    = ''
  let busy     = false
  let error    = ''
  let sent     = false
  let done     = false

  const token = () => new URLSearchParams(String(page.hash ?? '').replace(/^#/, '')).get('token') ?? ''

  async function run(fn) {
    busy  = true
    error = ''
    try { await fn() } catch (e) { error = e.message } finally { busy = false }
  }

  // The route answers the same whether or not the address has an account, so
  // "sent" is all this page can honestly say.
  const request = () => run(async () => {
    await getClient().auth.requestPasswordReset(email.trim())
    sent = true
  })

  const confirm = () => run(async () => {
    // The server sees one box. A typo in a password nobody can see is a
    // password nobody can use, so the second box is checked here.
    if (password !== again) throw new Error('The two passwords are not the same.')
    await getClient().auth.confirmPasswordReset(token(), password)
    password = ''; again = ''
    done = true
  })
</script>

<form class="auth-card card stack gap-md" onsubmit|preventDefault={token() ? confirm : request}>
  <h1 class="text-xl">Reset your password</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  {#if done}
    <div class="alert success" role="status">
      <div class="alert-content">Your password is set, and every other place you were signed in has been signed out.</div>
    </div>
    <a class="btn primary" href="/login/">Sign in</a>
  {:else if token()}
    <input class="field" bind:value={password} type="password" placeholder="New password"     aria-label="New password"     autocomplete="new-password" />
    <input class="field" bind:value={again}    type="password" placeholder="The same again"   aria-label="The same again"   autocomplete="new-password" />
    <button class="btn primary" type="submit" disabled={busy}>
      {busy ? 'Saving…' : 'Set password'}
    </button>
  {:else if sent}
    <div class="alert success" role="status">
      <div class="alert-content">If <strong>{email}</strong> has an account, a reset link is on its way.</div>
    </div>
    <!-- auth.ts prints the link instead of mailing it until the app has a
         mailer, and nothing on this page could say so otherwise. -->
    {#if import.meta.env.DEV}
      <div class="alert info">
        <div class="alert-content text-sm">No mailer is wired yet, so the link is printed in the terminal running the API.</div>
      </div>
    {/if}
    <a class="link text-sm" href="/login/">Back to sign in</a>
  {:else}
    <p class="text-sm text-muted">Enter the address you sign in with and we will send a link to set a new password.</p>
    <input class="field" bind:value={email} type="email" placeholder="Email" aria-label="Email" autocomplete="email" />
    <button class="btn primary" type="submit" disabled={busy || !email.trim()}>
      {busy ? 'Sending…' : 'Send reset link'}
    </button>
    <a class="link text-sm" href="/login/">Back to sign in</a>
  {/if}
</form>

<style>
  .auth-card { max-width: var(--auth-card-width, 24rem); margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}

// The page a verification link opens. The token is spent by a button, never on
// load: POST /auth/email/verify exists so a mail scanner that fetches the link
// cannot burn it, and a page that posted by itself would hand that back.
export function makeRouteVerifyEmail() {
  return `---
title: Verify your email
---
<script>
  // The token is read from the fragment, for the reason the reset page gives.
  //
  // A registration's link makes the account and signs in, so verifyEmail
  // loads the session and the page moves on. An account with two-step sign-in
  // owes its code first, which the sign-in page asks for. A link that confirms
  // an address an account already has signs nobody in.
  import { page, goto }          from '@frontierjs/sierra/router'
  import { session, verifyEmail } from '@frontierjs/sierra/resource'

  $: page.hash
  $: session.user

  let busy  = false
  let error = ''
  let done  = false

  const token = () => new URLSearchParams(String(page.hash ?? '').replace(/^#/, '')).get('token') ?? ''

  async function confirm() {
    busy  = true
    error = ''
    try {
      await verifyEmail(token())
      if (session.user)         return goto('/')
      if (session.awaitingCode) return goto('/login/')
      done = true
    } catch (e) {
      error = e.message
    } finally {
      busy = false
    }
  }
</script>

<div class="auth-card card stack gap-md">
  <h1 class="text-xl">Verify your email</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  {#if done}
    <div class="alert success" role="status">
      <div class="alert-content">Your email address is confirmed.</div>
    </div>
    <a class="btn primary" href="/login/">Sign in</a>
  {:else if token()}
    <p class="text-sm text-muted">Confirm that this address is yours.</p>
    <button class="btn primary" type="button" onclick={confirm} disabled={busy}>
      {busy ? 'Confirming…' : 'Confirm email'}
    </button>
  {:else}
    <p class="text-sm text-muted">This page needs the link from the verification email.</p>
    <a class="link text-sm" href="/login/">Back to sign in</a>
  {/if}
</div>

<style>
  .auth-card { max-width: var(--auth-card-width, 24rem); margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}

// The signed-in person's own account. \`withName\` is whether the example users
// service exists, which is the only way this app can write a User row.
export function makeRouteAccount(withName) {
  return `---
title: Account
---
<script>
  // The signed-in person's own account: their name, their password, and every
  // place they are signed in.
  //
${withName ? `  // The password and the sessions go through client.auth, which is the account
  // and sessions services scoped to the CALLER — nothing here names a user id
  // for them, because nothing there will take one. The name is the User row,
  // written through the users service; db/schema.lite's @@allow(update,
  // id == auth().id || …) is what lets a person write their own.
  import { getClient, session, refresh } from '@frontierjs/sierra/resource'
  import { at } from '@frontierjs/mesa/browser'` : `  // The password and the sessions go through client.auth, which is the account
  // and sessions services scoped to the CALLER — nothing here names a user id,
  // because nothing there will take one. The name is not editable here: that
  // is a write to the User row, and this app has no users service to make it.
  import { getClient, session } from '@frontierjs/sierra/resource'
  import { at } from '@frontierjs/mesa/browser'`}

  $: (session.user, session.checked)

  let name     = ''
  let current  = ''
  let next     = ''
  let sessions = []
  let notice   = ''
  let error    = ''
  let busy     = false

  const auth = () => getClient().auth

  // Asked whenever the person changes, not once at mount: the session restore
  // may still be in flight when this page mounts, and signing out in another
  // tab makes the last answer somebody else's.
  $: {
    if (session.user) { name = session.user.name ?? ''; loadSessions() }
    else sessions = []
  }

  async function loadSessions() {
    try { sessions = await auth().sessions() } catch (e) { error = e.message }
  }

  // Each action answers the sentence to show when it worked.
  async function run(fn) {
    busy   = true
    error  = ''
    notice = ''
    try { notice = await fn() } catch (e) { error = e.message } finally { busy = false }
  }

${withName ? `  const saveName = () => run(async () => {
    await getClient().service('users').patch(session.user.id, { name: name.trim() })
    // The session is what the topbar reads, and it was built before the write.
    await refresh()
    return 'Name saved.'
  })

` : ``}  const changePassword = () => run(async () => {
    await auth().changePassword(current, next)
    current = ''; next = ''
    return 'Password changed.'
  })

  const signOutOthers = () => run(async () => {
    const { revoked } = await auth().revokeOtherSessions()
    await loadSessions()
    return revoked === 1 ? 'Signed out of 1 other session.' : \`Signed out of \${revoked} other sessions.\`
  })

  const signOutOne = (id) => run(async () => {
    await auth().revokeSession(id)
    await loadSessions()
    return 'Signed out.'
  })
</script>

<header class="stack gap-sm">
  <h1>Account</h1>
  <p class="text-muted">Your name, your password, and where you are signed in.</p>
</header>

{#if !session.checked}
  <p class="text-muted">…</p>
{:else if !session.user}
  <div class="alert info"><div class="alert-content"><a class="link" href="/login/">Sign in</a> to manage your account.</div></div>
{:else}
  {#if error}<div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>{/if}
  {#if notice}<div class="alert success" role="status"><div class="alert-content">{notice}</div></div>{/if}

  <div class="grid panels">
    <section class="card stack gap-sm">
      <h2 class="text-lg">Profile</h2>
      <dl class="facts">
        <dt>Email</dt>
        <dd>{session.user.email}</dd>
      </dl>
${withName ? `      <form class="stack gap-sm" onsubmit|preventDefault={saveName}>
        <input class="field" bind:value={name} placeholder="Your name" aria-label="Name" autocomplete="name" />
        <button class="btn primary" type="submit" disabled={busy}>Save name</button>
      </form>
` : ``}    </section>

    <form class="card stack gap-sm" onsubmit|preventDefault={changePassword}>
      <h2 class="text-lg">Password</h2>
      <input class="field" bind:value={current} type="password" placeholder="Current password" aria-label="Current password" autocomplete="current-password" />
      <input class="field" bind:value={next}    type="password" placeholder="New password"     aria-label="New password"     autocomplete="new-password" />
      <button class="btn primary" type="submit" disabled={busy || !current || !next}>Change password</button>
    </form>
  </div>

  <section class="card stack gap-sm sessions">
    <div class="split">
      <h2 class="text-lg">Where you are signed in</h2>
      <button class="btn outlined" onclick={signOutOthers} disabled={busy || sessions.length < 2}>Sign out everywhere else</button>
    </div>
    <dl class="facts divided">
      {#each sessions as s}
        <dt>{at(s.createdAt)}</dt>
        <dd class="split">
          {#if s.current}
            <span class="badge success">this browser</span>
          {:else}
            <span class="text-sm text-muted">expires {at(s.expiresAt)}</span>
            <button class="btn ghost" onclick={() => signOutOne(s.id)} disabled={busy}>Sign out</button>
          {/if}
        </dd>
      {/each}
    </dl>
  </section>
{/if}

<style>
  .panels { margin-top: var(--space-2xl) }
  .sessions { margin-top: var(--space-lg) }
  h1, h2, p { margin: 0 }
</style>
`
}

export function makeRouteRegister() {
  return `---
title: Create an account
---
<script>
  import { goto }   from '@frontierjs/sierra/router'
  import { signUp } from '@frontierjs/sierra/resource'

  let email    = ''
  let password = ''
  let name     = ''
  let error    = ''
  let loading  = false
  let sent     = false

  // The API mounts {apiPrefix}/auth/register whether or not a page like this
  // exists, so this screen adds no surface — it is the one that was missing.
  // Delete the file and the route is still open; close it in api/src/app.ts.
  //
  // Everyone who arrives this way gets role "user", which db/schema.lite grades
  // as USER(4). ADMINISTRATOR(5) comes from \`fli auth:create-user --role admin\`
  // or from an admin editing the row: role carries @allow(write, auth().isAdmin),
  // so a caller cannot promote themselves on the way in.
  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      // With a mailer wired the answer is the same for every address and the
      // account is made when the mailed link is clicked; without one signUp
      // signs the new account IN and there is no second trip through /login/.
      const result = await signUp({ email, password, name })
      if (result.user) goto('/')
      else sent = true
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
</script>

{#if sent}
<div class="auth-card card stack gap-md">
  <h1 class="text-xl">Check your email</h1>
  <p>If {email} can have an account, a link to finish creating it is on its way.</p>
</div>
{:else}
<form class="auth-card card stack gap-md" onsubmit|preventDefault={handleSubmit}>
  <h1 class="text-xl">Create an account</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  <input class="field" bind:value={name}     type="text"     placeholder="Name"     aria-label="Name"     autocomplete="name" />
  <input class="field" bind:value={email}    type="email"    placeholder="Email"    aria-label="Email"    autocomplete="username" />
  <input class="field" bind:value={password} type="password" placeholder="Password" aria-label="Password" autocomplete="new-password" />
  <button class="btn primary" type="submit" disabled={loading}>
    {loading ? 'Creating…' : 'Create account'}
  </button>

  <p class="text-sm text-muted">Already have one? <a class="link" href="/login/">Sign in</a></p>
</form>
{/if}

<style>
  .auth-card { max-width: var(--auth-card-width, 24rem); margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}
