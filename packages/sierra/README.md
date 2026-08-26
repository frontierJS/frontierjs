# @frontierjs/sierra

The UI realm of FrontierJS. Sierra turns a directory of Mesa components into a routed
application: it scans `src/routes/`, emits a route table, produces the whole Vite
config, and binds the running app to a Junction API.

```
db/schema.lite  ──►  Junction (API)  ──►  Sierra (UI)
      │                    │                  │
 generateJsonSchema    services/WS      routes + resources
      └──────────────────────────────────────►┘
                  registerSchemas()
```

Sierra sits at the end of the dependency chain — `Litestone ← Junction ← Sierra` — and
never the reverse. Mesa is the component substrate underneath it.

**Status:** pre-1.0. 970 tests across 48 files pass (`bun run test`), typecheck clean.
All three targets are built and driven in a real browser. The SPA target is solid and
verified end-to-end; `static` prerendering works and its pages are **interactive** —
see [Islands](#islands--making-a-static-page-interactive), verified by clicking a
prerendered button in headless Chrome; `widget` builds one self-contained IIFE per
`.mesa` file — see [Build targets](#build-targets) — and `bun run test:widgets` loads
two of them **cross-origin** onto a host page with hostile CSS.

There is a runnable app in [`example/`](example/) — a real Junction API over real SQLite,
with a form generated entirely from `db/schema.lite`. The whole app is driven in headless
Chrome — navigation, sign-in, form submit, delete — with the console watched for errors;
see its [README](example/README.md) for what was found that way.

```bash
cd example && bun run api    # :8130
cd example && bun run dev    # :8030
```

---

## Installation

```bash
bun add @frontierjs/sierra @frontierjs/mesa
bun add -d vite
```

Sierra imports `@frontierjs/mesa`, `@frontierjs/junction` and `@frontierjs/litestone`
but **declares none of them** as dependencies — it resolves them itself through a
hand-rolled exports-map resolver (`src/virtual/virtual-sierra.js`). Install what you use:

| Package | Needed for |
| --- | --- |
| `@frontierjs/mesa` | always — the compiler and runtime |
| `@frontierjs/junction` | `sierra/junction`, `sierra/presence` |
| `@frontierjs/litestone` | schema seeding from `db/schema.lite` (optional; absence is not an error) |

---

## Quick start

**Sierra owns `web/`, and only `web/`.** A FrontierJS app puts one directory at the root
per realm — `db/` (Data), `api/` (API), `web/` (UI) — so every Sierra file, `config/` and
`src/` included, lives under `web/`. That is also why schema auto-detection looks at
`../db/schema.lite`: the schema is a sibling of `web/`, not something inside it. The full
layout is in the [root README](../../README.md#project-structure).

Inside `web/`, every sub-project follows the same six-folder shape — `config/` to
configure it, `src/` to build it, `public/` for static assets, `test/` for tests, `dist/`
for output, `deploy/` for shipping:

```
my-app/
├── db/
│   └── schema.lite             ← seeds the API and the UI both
├── api/                        ← Junction — a peer of web/, not a parent
└── web/                        ← everything below here is Sierra's; the Vite root
    ├── index.html
    ├── config/
    │   ├── vite.config.js      ← configuration lives in config/
    │   ├── sierra.config.js
    │   └── routes.js           ← generated, do not edit
    ├── public/                 ← static assets, copied verbatim
    ├── src/
    │   ├── main.js
    │   ├── App.mesa
    │   └── routes/
    │       ├── _module.mesa
    │       ├── index.mesa
    │       └── blog/
    │           ├── [slug].mesa
    │           └── [slug].meta.js
    ├── test/
    └── dist/                   ← build output
```

Vite runs with `web/` as its root and the config named explicitly:

```bash
cd web && vite -c config/vite.config.js
cd web && vite build -c config/vite.config.js
```

Paths in `sierra.config.js` (`routesDir`, `outDir`, `routeTable.output`) are relative to
the Vite root — `web/` — never to `config/` and never to the app root.

**`config/vite.config.js`**

```js
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'   // sibling — both live in config/

export default defineConfig(createSierraViteConfig(sierraConfig))
```

**`config/sierra.config.js`**

```js
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  junction: {
    url:       `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`,
    apiPrefix: '/api',       // must match the API's config.apiPrefix
    tokenKey:  'myapp_token',
  },
}
```

**`src/main.js`**

```js
import 'virtual:sierra'                       // boots router, junction, theme, analytics
import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so it must already be in the DOM.
// Passing a string fails with "anchor node has no parentNode".
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
```

**`src/App.mesa`**

```html
<script>
  import { RouterView } from '@frontierjs/sierra/router'
</script>

<RouterView />
```

Then `vite -c config/vite.config.js` for dev and `vite build -c config/vite.config.js`
for production.

> **How `sierra.config.js` is found.** `virtual:sierra` emits a literal
> `import sierraConfig from '<path>'`, so this has to be exact — a wrong answer is a
> `Module not found` at build time, not a degraded mode. Sierra looks, in order:
> beside `vite.config.js`, then in a `config/` folder beneath it, then `config/` under
> the Vite root, then the Vite root itself (`.js`, `.mjs` and `.ts` at each). Both
> layouts therefore work — `config/vite.config.js` next to `config/sierra.config.js`,
> or a root-level `vite.config.js` with the config in `config/`.
>
> Until 2026-08-03 this was a string rewrite of the Vite config path that assumed
> `vite.config.js` sat at the Vite root, so the conventional `config/vite.config.js`
> derived `config/config/sierra.config.js` and could never build.
>
> For a config that lives somewhere neither rule finds, the escape hatch remains:
>
> ```js
> _configPath: new URL('./sierra.config.js', import.meta.url).pathname,
> ```

---

## Routing

The route table is derived from the file tree. Nothing is registered by hand.

### File roles

| Pattern | Role | Result |
| --- | --- | --- |
| `index.mesa` | route | the folder's index — contributes no URL segment |
| `about.mesa` (lowercase) | route | `/about/` |
| `_module.mesa` | layout | wraps every descendant route |
| `Sidebar.mesa` (PascalCase) | component | co-located, never routed |
| `_helper.mesa` (`_` prefix) | component | co-located, never routed |
| `about.meta.js` | companion | `meta` / `load` / `getStaticPaths` for `about.mesa` |
| anything else | ignored | — |

`.md` files route exactly like `.mesa` — the Mesa compiler handles both, and fenced code
blocks are escaped before compilation.

### Path syntax

| File | URL | Notes |
| --- | --- | --- |
| `leads/index.mesa` | `/leads/` | |
| `leads/[leadId].mesa` | `/leads/:leadId/` | `page.params.leadId` |
| `[...404].mesa` | `/*` | catch-all |
| `(auth)/login.mesa` | `/login/` | `(group)` folders are organizational — zero URL impact |
| `account/settings/index.mesa` | `/account/settings/` | |

Trailing slashes are appended by default (`trailingSlash: 'always' | 'never' | 'preserve'`).
A file and a folder with the same name (`leads.mesa` + `leads/`) is a build error.

### Layouts

`_module.mesa` wraps every route beneath it, and layouts nest. A layout renders its child
through `<slot />`:

```html
---
siteName: My App
---
<script>
  import { page, isActive } from '@frontierjs/sierra/router'
  $: (page.siteName, page.route)
</script>

<header>{page.siteName}</header>
<main><slot /></main>
```

Layouts are loaded lazily — only the chain a route actually needs is fetched, and the
chain is complete before the route commits. `reset: true` in a route's frontmatter opts
it out of all layouts.

### Frontmatter

Frontmatter is YAML at the top of a `.mesa`/`.md` file. It is merged in this order, with
the rightmost winning:

```
layout _module.mesa frontmatter → layout _module.meta.js → route .meta.js → route frontmatter → system flags
```

Keys Sierra acts on:

| Key | Effect |
| --- | --- |
| `reset: true` | render this route with no layout |
| `render: static` | prerender to its own `index.html` under `target: 'static'` |
| `redirect: /path/` | navigating here redirects; also emitted to `_redirects` |
| `status: draft` | excluded from `published` and `indexed` |
| `robots: noindex` | excluded from `indexed` and the sitemap |

Everything else is yours, and is spread onto `page` — `siteName: My App` becomes
`{page.siteName}`. System flags (`dynamic`, `spread`, `isIndex`) are added by the scanner.

---

## The `page` object

One import, one object, everything about the current route. It is **not** a signal — it is
a plain object, and components make the fields they use reactive with a `$:` path watch
(Mesa RULE 43):

```html
<script>
  import { page } from '@frontierjs/sierra/router'
  $: (page.params, page.data)
</script>

<h1>{page.title}</h1>
<p>{page.params.slug}</p>
{#if page.error}<p class="error">{page.error.message}</p>{/if}
```

**A list that lives in its URL.** `query` and `directives` are the same split the
API realm makes — filters, and how much of the answer in what order — over the same
table, so the pair goes straight into a call with nothing to translate:

```html
<script>
  import { page } from '@frontierjs/sierra/router'
  import { orders } from '@/resources/Order.mesa'

  $: (page.query, page.directives, () => orders.load(page.query, page.directives))
</script>
```

Filtering, sorting and paging then survive a reload, a back button and a pasted link,
because the URL is where they live. `setParams(obj)` and `updateParams(fn)` write them.
The `$` is transport syntax and reaches neither field (Invariant 10).

Router-owned fields — these are reserved, and the scanner warns if frontmatter shadows one:

| Field | Value |
| --- | --- |
| `path` | current pathname + search |
| `params` | path params — `/leads/:leadId/` → `{ leadId }`. Path captures only |
| `query` | the URL's filters, coerced — `?status=active&tier=3` → `{ status: 'active', tier: 3 }` |
| `directives` | the URL's `$` params, structured — `?$limit=20&$orderBy=-name` → `{ limit: 20, orderBy: '-name' }` |
| `meta` | the raw frontmatter object, un-spread |
| `route` | the matched route node |
| `pending` | the in-flight route during navigation, else `null` |
| `data` | whatever the route's `load()` returned |
| `error` | the error `load()` threw, else `null` |
| `slots` | named slots registered via `provideSlot()` |

`page` replaced eight separate signals (`params`, `activeRoute`, `meta`, `data`, …). The
old names are gone.

**`title` is NOT one of them, and it does two jobs.** It stays an ordinary
frontmatter key spread onto `page`, so `{page.title}` renders in a heading as
every example here shows — and the router also writes it to `document.title` on
every navigation, which is the tab, the bookmark, the history entry and what a
screen reader announces on arrival. The sources are the two the static target
reads, in the same order: `head({ params, data, url })` off the route's `.meta.js`
companion first, then frontmatter, then whatever `index.html` booted with for a
route that declares neither. Nothing is templated and no site name is appended —
the static half composes neither, and an app wanting `Page · Acme` says so in
`head()`, the one place that can see both.

---

## Navigation API

```js
import {
  goto, back, forward, url, isActive, getDirection,
  setParams, updateParams,
  beforeNavigate, afterNavigate,
  prefetch, provideSlot,
} from '@frontierjs/sierra/router'
```

| Call | Behaviour |
| --- | --- |
| `goto(path, query?, { scroll, replace })` | navigate |
| `back()` / `forward()` | history |
| `url(path, query?)` | build a URL with the configured trailing-slash policy |
| `isActive(path, { exact })` | prefix match by default. **Name `page.route` in the expression too** — `aria-current={(page.route, isActive('/leads/')) ? 'page' : null}` — or the call is evaluated once at mount. Mesa reads dependencies out of the expression text, and the route read happens inside `isActive`, where it cannot see it |
| `setParams(obj)` | replace all query params (`replace: true`, no scroll) |
| `updateParams(fn)` | merge query params through a function |
| `getDirection()` | `'next' \| 'prev' \| 'first'` from history indices |
| `prefetch(path)` | preload a route's chunk and data programmatically |

### Guards and hooks

```js
beforeNavigate(async ({ from, to }) => {
  if (to.path.startsWith('/admin/') && !isAdmin()) return '/login/'  // redirect
  if (unsavedChanges) return false                                    // cancel
  return true
})

afterNavigate(({ from, to }) => trackPageview(to.path))
```

Both return an unsubscribe function. Guards run on the boot navigation too — the initial
`_navigate` is deferred by one microtask precisely so guards registered during app mount
are in place before it runs. A guard therefore protects a direct page load and a refresh,
not just client-side navigation.

### Prefetching

Add the attribute to a link:

```html
<a href="/blog/" prefetch>immediate</a>
<a href="/blog/" prefetch="hover">on mouseenter / touchstart</a>
<a href="/blog/" prefetch="visible">on IntersectionObserver entry</a>
```

Prefetch loads both the route chunk and its `load()` payload. Payloads are cached per URL,
capped at 32 entries, and expire after 30s.

A prefetched `load()` runs with the same `fetch` a navigated one does — `sierraFetch`,
which attaches the session token — so a protected route prefetches as the person who is
signed in. And because a payload is an answer to *what may this person see*, the cache is
dropped on `login()`, on `logout()` and on a mid-session 401: prefetching cannot serve one
identity's data to another. The route chunks survive that, being nobody's in particular.

### Named slots

A page pushes content up into its layout. Both sides are compile-time rewrites — you
write markup, not snippet plumbing:

```html
<!-- route: src/routes/blog/[slug].mesa -->
<mesa:slot name="sidebar">
  <nav>…</nav>
</mesa:slot>

<h1>{page.title}</h1>
```

```html
<!-- layout: src/routes/blog/_module.mesa -->
<aside><slot name="sidebar">No sidebar for this page.</slot></aside>
<main><slot /></main>

{#if $slots.sidebar}<p>this page has a sidebar</p>{/if}
```

`<slot />` is the default slot (the route itself), `<slot name="X">` a named one with
optional fallback content, and `$slots` a derived record of which named slots the current
page provided. The underlying `provideSlot(name, snippetFn)` is exported from
`sierra/router` if you need to register a slot imperatively.

A named layout slot currently emits a benign Mesa compiler warning —
`'__slot_sidebar' is already declared` — because the rewrite emits both a watch and an
assignment for the same local. The build succeeds and the slot works.

---

## Data loading

A route gets data from a co-located `.meta.js` companion:

```js
// src/routes/blog/[slug].meta.js

export const meta = { section: 'blog' }        // merged into frontmatter

export async function load({ params, url, meta, fetch }) {
  const res = await fetch(`/posts/${params.slug}`)
  if (!res.ok) throw new Error('Post not found')
  return res.json()                             // → page.data
}

export async function getStaticPaths() {        // static builds only
  return [{ slug: 'hello' }, { slug: 'world' }]
}
```

- `fetch` is `sierraFetch` — it attaches the Junction auth token automatically, so the
  page never needs to know whether Junction is wired.
- Returning a string starting with `/` performs a redirect.
- A thrown error lands in `page.error` and the router **stays on the route** so the page
  can render its own error state. Data failures are not routing failures — there is no
  redirect to the catch-all.
- `load()` runs after the component chunk and the layout chain resolve, and the prefetch
  cache is checked first.

---

## Junction binding

```js
import {
  status, login, logout, getClient, whenReady,
  createResource, createStore, useStore,
} from '@frontierjs/sierra/junction'
```

`initJunction()` is called for you by `virtual:sierra` whenever `junction.url` is set. It
is synchronous — boot is never blocked on a WebSocket handshake. `whenReady` is there for
the rare caller that specifically needs the socket; service calls made before it resolves
simply take the HTTP path.

### Connection state

```html
<script>
  import { status } from '@frontierjs/sierra/junction'
  $: status.connected
</script>

<span class:online={status.connected}></span>
```

`status` is a plain object (`{ connected, reconnecting }`) — same contract as `page`.

### Resources

`createResource` wraps a Junction service with a four-phase hook pipeline that mirrors the
API realm:

```js
import { createResource } from '@frontierjs/sierra/junction'

export const leads = createResource('leads', {
  hooks: {
    around: { all:    [async (ctx, next) => { loading.set(true); await next(); loading.set(false) }] },
    before: { create: [validateLead] },
    after:  { all:    [formatDates] },
    error:  { all:    [handleApiErrors] },
  },
})
```

```
around:enter → before → [network call] → after → around:exit
                             ↓ on throw
                           error
```

Returns `{ service, store, stale, make, load, save, fields, relations, gate, can, validate, normalize, coerce, context, hooks }`.

**A Resource is the model's whole client-side surface** (`FJS-D114`) — the store, the
verbs, the reads it is asked for, and its default form. Three of those are worth naming:

```js
export const leads = createResource('leads', {
  detailQuery:  { directives: { populate: ['company'] } },   // what get(id) asks for
  optionsQuery: { directives: { orderBy: 'name', limit: 500 } },  // what a picker asks for
})

await leads.save(record)                     // create — the record has no id
await leads.save(row)                        // patch  — it has one
await leads.save(row, { mode: 'create' })    // force it
```

`save()` is **the one owner of the write**. `auto` decides off the model's OWN id field,
which is why the decision lives here and not in a component: a caller answering it with
the literal `id` on a model keyed by something else creates a duplicate row while looking
like an edit. `upsert` is an alias of `auto`, not a fourth thing. `<Form {resource} />`
calls exactly this, and everything the pipeline does — coercion, blank-stripping,
validation, the `@version` this screen read, the resource's own hooks — happens on the way
through.

Both declared reads are `{ query, directives }`. It is `detailQuery` rather than plain
`query` because `query` means FILTERS at every other boundary here (Invariant 10).

**Return shapes — read this before `.map()`.** The service methods are a pass-through of
Junction's browser client, and Junction's envelope rule applies unchanged: a list keeps
its envelope, a single record unwraps.

```js
const res = await leads.service.find({}, { limit: 20 })
res.data     // the rows
res.total    // total matching — for a pager

await leads.load()        // → the rows, and populates leads.store
leads.store.get()         // → the rows
```

**The store is live, and it means the query that filled it.** A pushed row outside
that query is not added, one a patch moved out of it is removed, and where `orderBy`
says so the row is placed rather than appended. Two things a browser cannot answer:
whether a new row belongs on an earlier page, and which row slides up when one leaves
a full one. Neither is guessed at — they are counted on `stale`, which has a store's
shape and is cleared by `load()`:

```js
const { get } = useStore(orders.stale)   // 0 = as current as a push can make it
// render `${get()} new — refresh`, and call load() again on the click
```

Reach for `load()`/`store` when rendering a list, and `service.find()` when you need the
count alongside it. `ctx.query` is filters (goes over the wire), `ctx.directives` is
`{ limit, offset, orderBy, select }` (also the wire, and the same word `page.directives`
uses), and `ctx.locals` is per-call scratch that never leaves the browser — how `before`
hands something to `after`.

### Schema seeding

If `db/schema.lite` is present, Sierra runs Litestone's `generateJsonSchema` at build
time and `virtual:sierra` calls `registerSchemas()` before any route module evaluates.
That is why a resource file names a model and nothing else — `make()` gets its field
shape from the schema instead of restating it:

```js
const blank = leads.make({ status: 'new' })   // defaults from db/schema.lite
```

Lookup order is `db/schema.lite`, `../db/schema.lite`, then `schema.lite` — all relative
to the Vite root. In the standard layout the second one is the hit: Vite's root is `web/`
and the schema is at `../db/schema.lite`, its sibling. Override with
`schema: 'path/to/x.lite'`, or disable with `schema: false`.

Only models become resources. Enums, `type T { … }` declarations and `FileRef` are
registered too, but as **definitions** — they are what `$ref` points at, not things you
can `createResource()`.

### Naming: service ⇄ model

A resource is addressed by its **service** name and seeded from a **model**. The registry
bridges the two with English's regular plural rules, so these need no help:

| `createResource(…)` | model | rule |
| --- | --- | --- |
| `'leads'` | `Lead` | `-s` |
| `'companies'` | `Company` | consonant + `y` → `-ies` |
| `'statuses'`, `'boxes'`, `'churches'` | `Status`, `Box`, `Church` | sibilant → `-es` |
| `'lead'`, `'Lead'` | `Lead` | accessor / declared name |

Irregular plurals are not guessable, and Sierra does not guess. Name the model:

```js
createResource('people',   { model: 'Person' })
createResource('children', { model: 'Child'  })
```

`model` is the override for any mismatch, not just plurals — use it whenever a service
is deliberately named something other than its model (`createResource('roster', { model:
'Person' })`). It works in all three signatures, and the service name is still what gets
called on the wire.

When nothing resolves, the warning names the fix and lists what is registered:

```
[resource:children] no schema found for 'children'. make() returns a bare object,
fields is empty, and validate() reports nothing.
  Name the model explicitly: createResource('children', { model: 'Child' })   ← 'Child' looks like the one
  Known models: Lead, Company, Status, Person, Child
```

Once resolved, `ctx.model` and `resource.context.model` report the **model** name as
declared in the `.lite` file — `Status`, not `statuses` — whether you named it or the
plural rules found it.

### Field rules

`resource.fields` is the model's schema flattened into per-field rules, with `$ref`
followed — the same information Junction compiles its server-side validator from:

```js
leads.fields.plan
// { type: 'string', required: true, nullable: false,
//   enum: ['starter', 'pro', 'enterprise'] }

leads.fields.email    // { type:'string', required:true, format:'email' }
leads.fields.name     // { type:'string', required:true, minLength:1, maxLength:200 }
```

That is enough to render a `<select>`, mark a required label, or set an input's
`maxlength` without restating anything from `db/schema.lite`.

`resource.validate(data, mode)` checks a record against those rules and returns
`[{ field, message }]` — empty when the record is acceptable. `mode` is `'create'`
(default) or `'patch'`, which skips absent fields:

```js
const draft = leads.make({ name: 'Ada' })
const problems = leads.validate(draft)
// [{ field: 'email', message: 'email is required' },
//  { field: 'plan',  message: 'plan is required'  }]
```

`validate: true` on the resource *also* runs that check automatically before every
`create` and `patch`, throwing `ResourceValidationError` instead of making the request:

```js
export const leads = createResource('leads', { validate: true })

await leads.service.create({ name: 'Ada' })
// throws ResourceValidationError; err.errors is the same array as validate()
```

**Default off.** The server validates either way — Junction derives its rules from the
same `.lite` file — so this is about failing in the browser before a round trip, not
about being the thing that says no. Turning it on changes *where* an invalid payload
surfaces, which is why existing resources are not opted in for you.

Enforcement runs **after** the `before` hooks, so a hook that completes the record
(stamping a tenant id, coercing a field) is reflected in what gets checked. The throw
travels the normal `error` phase, so an `error` hook can present it — or clear
`ctx.error` to recover.

Both halves are kept honest by a shared rule: `required` means *absent or null*, so an
empty string satisfies a required `String` on the client exactly as it does on the
server. Sierra's checker covers what Litestone's generator actually emits and is not a
general JSON Schema validator.

A bulk create is validated element-wise, and each error carries the row `index`.

### Relations

Relations have no wire representation, so they are absent from `properties` —
`x-relations` is the only place they exist on the client. `resource.relations`
reads it:

```js
leads.relations.account
// { field:'account', type:'belongsTo', model:'Account',
//   foreignKeys:['accountId'], references:['id'], optional:false, onDelete:'Cascade' }

leads.relations.tags
// { field:'tags', type:'m2m', model:'Tag' }
```

`model` is normalised to the name as declared in the `.lite` file, so it can be
handed straight to `schemaFor()` — or used to build the related resource, which
is how a picker finds its options without naming the service:

```js
const related = createResource('accounts', { model: leads.relations.account.model })
```

Foreign keys are also marked on the field rules, because `accountId` is a plain
integer on the wire and a generated form would otherwise render a number input
for a reference:

```js
leads.fields.accountId.references
// { model: 'Account', field: 'id', relation: 'account' }
```

### Gate

`resource.gate` is the model's `@@gate` levels, and `can()` compares a level
against them:

```js
leads.gate                       // { read: 0, create: 4, update: 4, delete: 5 }
leads.can('delete', userLevel)   // false at 4, true at 5
leads.can('patch',  userLevel)   // service method names work too
```

**This is a UI affordance, not a security boundary.** The gate is enforced at the
data layer by Litestone and turned into a status code by Junction; `can()` only
lets you avoid offering a button that is going to 403. Never guard anything on
it that the server does not also guard.

Unknown answers are permissive — no gate declared, no level supplied, an
operation the gate does not mention. Hiding a control the user could have used is
a worse and much quieter failure than showing one that errors.

Levels are Litestone's 0–9 scale (`STRANGER` 0 … `USER` 4 … `OWNER` 6, `SYSTEM`
8). Pass a number: mapping names to numbers here would be a copy of Litestone's
`LEVELS` and exactly the kind of duplicate that drifts.

### Coercion

`el.value` is a string for **every** DOM control — `<input type="number">` and
`<select>` included — and Mesa's `bindInput` passes it through unchanged, correctly,
because it has no idea what the field is. So a form bound to `make()` sends `"42"` for a
`Float` and `"1"` for an `Int`, and both the server and `validate()` reject them.

Only the schema knows what they were meant to be:

```js
export const leads = createResource('leads', { coerce: true })

await leads.service.create({ value: '42', accountId: '1' })
// sent as { value: 42, accountId: 1 }
```

Conservative on purpose:

- **`''` is never coerced.** `Number('')` is `0`, and silently inventing a zero for an
  empty box is worse than a validation error. Blank handling belongs to `blankToNull`,
  which runs after this.
- A string that isn't a clean number is **left alone**, so `validate()` can say so rather
  than NaN reaching the server. `'7.5'` in an `integer` field stays `'7.5'`.
- Only strings are touched; anything already of the right type is left alone.

**Default off**, like the others — but a form bound to DOM inputs almost certainly wants
it, and `validate: true` without it will reject every numeric field.
`resource.coerce(data)` does the same on demand.

The three compose in this order: **coerce → blankToNull → validate**, so validation
judges exactly what will be sent.

### Blank → null

A text input cannot produce "no value" — an untouched box submits `''`. So a form bound
to `make()` writes `''` into a column the schema declared nullable, and SQLite does not
treat those as the same value:

```
two NULLs   : ok | ok
two ''      : ok | REJECTED: UNIQUE constraint failed
```

`String? @unique` accepts any number of NULLs but rejects a second `''` — a create that
works once and then fails, from a default nobody wrote. And `WHERE col IS NULL` never
matches `''`, so "records with no X" silently excludes everything the app created.

`blankToNull: true` replaces `''` with `null` on nullable fields before every create and
patch:

```js
export const leads = createResource('leads', { blankToNull: true })

await leads.service.create({ name: 'Ada', slug: '', notes: '' })
// sent as { name: 'Ada', slug: null, notes: null }
```

The form keeps binding to a string — no `?? ''` at every input, no `null.trim()` — and
the wire carries the distinction the schema actually made. `resource.normalize(data)`
does the same thing on demand, without the flag.

Only **nullable** fields are touched (`''` on a required `String` is a real empty string,
and nulling it would turn a valid record invalid), only fields **present** in the record
(a patch is never widened), and only the exact value `''` — whitespace is content, and
trimming is a separate decision this does not make.

**Default off**, because it changes what is stored. It composes with `validate`:
normalization runs first, so validation judges what will actually be sent.

### Auth

```js
login(token)    // persist + authenticate the client
logout()        // clear the token and close the socket
```

A `401` from any service call fires the client's `unauthorized` event, which clears the
token and redirects to `auth.redirectTo`. Route protection is declarative:

```js
junction: {
  url: '…',
  auth: { publicRoutes: ['/login/', '/blog/*'], redirectTo: '/login/', returnPath: true },
}
```

The guard checks token *presence*, not validity — validity is the server's job.

### Presence

```html
<script>
  import { presence } from '@frontierjs/sierra/presence'
  const members = presence('workspace:42', { meta: { name: user.name } })
</script>

<p>{members.count} here</p>
{#each members.others as m}<span>{m.meta.name}</span>{/each}
```

---

## Configuration

Everything in `sierra.config.js`:

| Key | Default | Meaning |
| --- | --- | --- |
| `target` | `'spa'` | `'spa'` \| `'static'` \| `'widget'` |
| `routesDir` | `'src/routes'` | scanned directory |
| `outDir` | `'dist/client'` | build output |
| `base` | `'/'` | public base path |
| `trailingSlash` | `'always'` | `'always'` \| `'never'` \| `'preserve'` |
| `document` | — | `static` only — the document a prerendered page is wrapped in: `{ bodyClass, lang }`. The build's own CSS assets are linked automatically |
| `routeTable.output` | `'config/routes.js'` | where the generated route table is written |
| `schema` | auto-detect | path to the `.lite` file, or `false` |
| `junction` | — | `{ url, apiPrefix, authPrefix, tokenKey, auth, services, debug, onConnect, … }` |
| `theme` | — | `{ default, persist, attribute, key }` |
| `analytics` | — | `{ provider }` — `'plausible'`, `'gtm'`, or a custom `{ init, pageview, track }` |
| `devtools` | — | `{ port, position, n1Threshold }` |
| `autoImport.components` | `[]` | directories, scanned recursively, whose PascalCase components need no import |
| `autoImport.modules` | `{}` | package → bindings that need no import |
| `siteUrl` | `''` | absolute origin for the sitemap |
| `llms` | `true` | emit `llms.txt` |
| `markdownPages` | `false` | `true` \| `'auto'` — emit `index.md` beside each page |
| `speculationRules` | `true` | inject Speculation Rules for static routes |
| `build.deferJS` | `false` | defer script tags in `index.html` |
| `plugins` | `[]` | extra Vite plugins; those with `closeBundle` also run in the post-build pipeline |
| `vite` | `{}` | raw Vite overrides — deep-merged last, arrays concatenated |

`junction.debug: true` logs every service call with payloads; `'verbose'` adds every
client event. Both are off by default — the console retains logged objects, which on a
WebSocket-heavy app keeps every response payload alive for the tab's lifetime.

---

## Build targets

**`spa`** — the supported path. Vite's default chunking, client-side routing, one
`index.html`. Verified end-to-end.

**`static`** — same bundle, plus a prerender pass in `closeBundle`. Every route declaring
`render: static` in its frontmatter is rendered to its own `index.html` via Mesa's
`renderComponent`, with layouts composed around it. A dynamic route with `render: static`
**must** have a companion exporting `getStaticPaths()` — production builds fail loudly
otherwise. A static build that produces no pages says so rather than silently emitting an
SPA.

> ~~Prerendering writes a temporary module inside the Mesa package directory, so under a
> linked workspace a page or layout importing `@frontierjs/sierra/*` fails to resolve
> and that page is skipped.~~ **Fixed 2026-08-03.** Mesa's `renderComponent` now takes a
> `tmpDir`, and Sierra points it at `node_modules/.sierra/render` inside the app — so
> compiled modules resolve bare imports from the app's own tree.
>
> One caveat remains: `load()` cannot use relative URLs at build time — there is no
> origin, so `sierraFetch` throws and directs you to `getStaticPaths()`. When a render
> does fail, the summary still reports "no route declares `render: static`", which is
> misleading — read the `prerender:` warning above it.

**`static/` is a SURFACE too, and it is `site/`** — a peer of `api/` and `web/`,
never a second config inside the SPA (Invariant 3, `FJS-D127`). Its build
prerenders and checks what it may publish, its tests run against FILES rather
than a running app, and its release is a bucket with no application server behind
it. The fourth answer is what makes folding it in a defect rather than a
preference: **one Vite root is one `dist/`**, so a static site inside `web/` lands
inside the SPA's output, and `vite build` empties `outDir` — the SPA's build
deletes the site and says nothing. `fli make:site` writes the surface;
`fli check`'s `app-layout` reports a `target: 'static'` config found inside
another one.

```
site/                         ← beside api/ and web/, never inside either
  config/
    vite.config.js            ← the Vite root is site/, port 8600
    sierra.config.js          ← target: 'static', plus `db` and `document`
  index.html                  ← the DEV shell; a built page never uses it
  src/
    main.js                   ← the dev entry — routes served as an app
    routes/                   ← file-tree routes, the same convention as web/
    islands/                  ← the only JavaScript a prerendered page runs
  test/                       ← what proves the BUILD: files, not a running app
  deploy/                     ← serve.js + Dockerfile — the site origin
  dist/                       ← one index.html per route, plus island chunks
```

**Dev is an SPA and the build is files.** `target: 'static'` uses the SPA's Vite
config, so `vite dev` on the surface serves the routes client-routed — that is the
writing loop. Everything that makes the target what it is happens in
`closeBundle`, so a change to a `load()` or to frontmatter is proved by building.

**`sierra site --serve`** is the origin the surface deploys with, and a drive
should point at it rather than a `createServer` of its own: it resolves a
directory to its `index.html`, revalidates HTML while leaving hashed assets
immutable, and serves the site's own `404.html` with a 404 status. It sends no
CORS, deliberately — this origin serves documents a browser navigates to.

**`widget`** — an embeddable script for a page this app does not own. One `.mesa` file
in `src/Embeds/` becomes one self-contained IIFE: the component, the Mesa runtime and
the CSS in a single file a host page loads with one `<script src>` and nothing else.

**`widgets/` is a SURFACE, a peer of `api/` and `web/`** — not a folder inside the SPA
(Invariant 3). It earns its own directory because its config, its tests and its release
are all a different set of answers: one Vite root of its own, host pages it does not own
to test against, and static files served from an origin a stranger's page links to.
`fli make:widget <Name>` writes it the first time and tops it up after.

```
widgets/                      ← beside api/ and web/, never inside either
  config/
    vite.config.js            ← the Vite root is widgets/, port 8200
    sierra.config.js          ← target: 'widget'
  src/Embeds/
    Counter.mesa              → dist/embeds/Counter.js
    LeadForm/
      index.mesa              → dist/embeds/LeadForm.js
      Field.mesa                …a part of LeadForm, not a second widget
  test/                       ← a host page per widget, hostile CSS on purpose
  deploy/                     ← serve.js + Dockerfile — the widget origin
```

```html
<!-- the host page: no bundler, no framework, no init call -->
<mt-counter data-start="5"></mt-counter>
<script defer src="https://cdn.example.com/embeds/Counter.js"></script>
```

It mounts in a **shadow root**, so the host page's `button { … !important }` cannot
reach the widget and the widget's styles cannot reach the host page. Props are
`data-*` attributes, camelCased — `data-api-url` → `apiUrl` — and they arrive as
strings, because that is what an HTML attribute is.

A widget says how it is found in `<script module>`, and everything it does not say
comes from the config:

```html
<script module>
  export const widget = {
    // Also mount into pages that already say <div class="mt-counter"> — host
    // markup often lives somewhere its author cannot edit. New pages use the
    // element; both are the same mechanism.
    selector: '.mt-counter',
    // tag:    'mt-counter'   the whole tag, overriding prefix + file name
    // shadow: false          mount in the light DOM instead
  }
</script>
```

```js
// config/sierra.config.js
export default {
  target:  'widget',
  widgets: { dir: 'src/Embeds', outDir: 'dist/embeds', prefix: 'mt-' },
}
```

**Built by `sierra widgets`, not by `vite build`** — a widget is a library build and
Vite's library mode takes one entry, so N widgets is N builds. That is also the cost:
the runtime is in every bundle, once per widget on a page that embeds several. It buys
the property the target exists for — a widget is one file, and a page embedding it
needs to know nothing about the others.

```sh
sierra widgets --config config/sierra.config.js          # from widgets/, the Vite root
sierra widgets --serve --config config/sierra.config.js  # the release — serves dist/embeds
vite --config config/vite.config.js                      # dev, over the surface's own page
```

`--serve` is the surface's release rather than a preview: `bun run test:widgets` builds
the fixture, starts that server and loads the bundles **cross-origin** through it, so the
CORS and cache answers under test are the ones that ship.

An element that arrives after the script has run is mounted too (a tag manager, a CMS,
a host-page route change), and a script included twice produces one widget, not two.

### The document around a prerendered page

Sierra assembles it — Vite's HTML transform never runs on these files, so what
`index.html` gives the SPA has to be stated here:

- **The stylesheets the build emitted are linked automatically.** Without that a
  prerendered page carries every class name the app uses and none of the rules
  (fixed 2026-08-06; before it, a `static` page was unstyled and the SPA built
  from the same source was not). They come before the page's own scoped
  `<style>` blocks, so a component's rules win.
- **`document: { bodyClass, lang }`** is the rest of it. A theme in
  `@frontierjs/css` is one class on an ancestor, so `bodyClass: 'app
  theme-default'` is what makes a prerendered page look like the app. `lang`
  defaults to `en`, and a route may override it with `lang:` in its frontmatter.

### Islands — making a static page interactive

A `target: 'static'` page ships HTML and CSS and **no script**, so on its own it is inert
forever. Islands are how a piece of one comes alive. Mark a component with a `client:*`
directive and Sierra does the rest:

```html
<script>
  import Counter from '../islands/Counter.mesa'
</script>
<main>
  <h1>prerendered, ships no JS</h1>
  <Counter client:load start={7} />
</main>
```

The prerendered HTML carries the island inside comment markers, and Sierra puts a script
tag only on pages that have one:

```html
<main><h1>prerendered, ships no JS</h1>
<!--mesa-island {"component":"Counter","directive":"load","props":{"start":7}}-->
<button>count: 7</button>
<!--/mesa-island--></main>
<script type="module" src="/assets/islands-C6C54-f9.js"></script>
```

| Directive | When it mounts |
|---|---|
| `client:load` | immediately, as soon as the bundle runs |
| `client:idle` | on `requestIdleCallback` (a timeout where that is missing) |
| `client:visible` | when the island's first element scrolls into view |
| `client:media="(min-width: 600px)"` | when the query matches, then and there or on change |
| `client:static` | **never** — "no JS even if the component is reactive"; its chunk is not fetched |

Four things worth knowing:

- **Mounting replaces the prerendered markup**; it does not adopt it. Mesa has no
  hydration, so there is nothing to adopt with. For equal props the markup is identical,
  so nothing visibly moves.
- **An island's CSS ships once.** Scope hashes are content-addressed, so the
  `<style id="mHASH">` in the prerendered page is the same id the island's chunk
  would inject under — and Mesa's `addStyles` skips an id already in the
  document. Each component gets its own `<style>` block rather than one blob.
- **Props must survive JSON.** They are serialized into the marker at render time, so a
  function prop is dropped with a warning and the island mounts without it.
- **One chunk per island, fetched when its directive fires.** A `client:visible` island
  below the fold downloads nothing until it is scrolled to; a `client:media` island whose
  query never matches is never downloaded at all. Verified against resource timing in a
  real browser. The shared entry (Mesa runtime + loader) is loaded by any page with an
  island.
- **A component name is the key.** The marker carries a name, so two different modules
  used under the same component name collide; the build warns and mounts the first.

Turn the whole pass off with `islands: false` in `sierra.config.js`.

`tests/fixtures/island-site/` is a runnable app for this, and `verify.mjs` beside it
proves the claims the only way they can be proved — clicking prerendered buttons in
headless Chrome, and reading resource timing to confirm which chunks were fetched. It
covers all five directives, per-island splitting, and CSS scoping. See its README.

`tests/fixtures/widget-site/` is the same thing for the `widget` target: two widgets, a
plain host page written to be hostile (`button { background: red !important }`), and a
drive that builds the scripts and proves the lot in Chrome — element upgrade, the
selector form, a late-inserted host, shadow isolation in both directions, a delegated
click, and a script included twice producing one widget. See its README.

---

## Post-build pipeline

Runs automatically after `vite build`:

| Step | Condition |
| --- | --- |
| `404/index.html` → `404.html` | always |
| `public/robots.txt` → `dist/robots.txt` | always |
| `_redirects` from routes with `redirect:` | always |
| `sitemap.xml` from `indexed` routes | always |
| `llms.txt` | `llms !== false` |
| per-page `index.md` | `markdownPages` |
| Speculation Rules | `speculationRules !== false` and static routes exist |
| `defer` on script tags | `build.deferJS` |
| theme flash-prevention inline script | `theme` configured |
| user plugin `closeBundle` hooks | `plugins` |

---

## Dev experience

- **HMR.** Editing a route file swaps the component in place. Sierra injects a Mesa HMR
  boundary and suppresses its own `sierra:hmr` event for files that received one, so an
  update is applied once rather than twice. The route table is written byte-stable so
  a no-op rewrite doesn't escalate to a full reload.
- **Error overlay.** Runtime errors are forwarded to an in-page overlay and the terminal.
  `load()` failures are excluded — they are data errors, and the page renders `page.error`.
- **Devtools toolbar.** Injected in dev only. It connects over WebSocket to Junction's
  devtools plugin (`app.configure(devtools())`, port 8503) and shows requests, events,
  logs, connections and an N+1 waterfall. Zero production bundle cost.
- **Build warnings.** Unexported snippets, frontmatter shadowing a reserved `page` field,
  and duplicate snippet/layout-prop names.
- **Auto-import.** Two registries, one namespace:

  ```js
  autoImport: {
    components: ['src/components/UI'],
    modules: {
      'svelte/store':       ['writable', 'readable'],
      '@frontierjs/sierra': [['theme', 'appTheme']],   // named, under an alias
      'some/pkg':           { default: 'Pkg', star: 'ns' },
      dayjs:                'dayjs',                   // shorthand for a default import
    }
  }
  ```

  Component directories are scanned **recursively** and keyed on the basename, so a
  component's directory organises it and its name identifies it. A **component** is
  injected where the template uses it as a `<Tag>`; a **module binding** where any code —
  a `<script>` body or a `{…}` expression — uses it as a bare identifier. Prose is not
  code: `<p>Use dayjs</p>` imports nothing. Neither is a property access (`x.writable`),
  an object key, a string, or a comment.

  A name the file already binds always wins — an explicit import, or a local `const`.
  Two sources providing the same name is a build error, whether they are two directories,
  two packages, or one of each; alias the binding or rename the component.

---

## Theme

```js
import { theme, setTheme, toggleTheme } from '@frontierjs/sierra'
```

`theme` is a plain object — `{ value: 'light' | 'dark' }`, never `'system'` — like `page`
and `status`. Watch it to make it reactive:

```html
<script>
  import { theme, toggleTheme } from '@frontierjs/sierra'
  $: theme.value
</script>

<button on:click={toggleTheme}>{theme.value}</button>
```

Without the `$:` the read is a snapshot taken at mount. Sierra passes
`externalReactivityHints: 'strict'` to the Mesa compiler, so an uncovered member read on
any imported object is reported at build time — say `var` if a one-time read is what you
meant.

With `theme` configured, the post-build pipeline injects an inline `<head>` script that
applies the persisted preference before first paint, so there is no flash.

---

## `virtual:sierra`

Importing it boots the app. Sierra generates the module from your config, so it contains
only what you configured — router init always, then Junction, schemas, analytics and theme
if present, plus the dev-only overlay and HMR bridge. It also re-exports the route table:

```js
import { tree, components, loaders, layouts, published, indexed, redirects } from 'virtual:sierra'
```

| Export | Contents |
| --- | --- |
| `tree` | the route node tree (metadata only) |
| `components` / `loaders` / `layouts` | lazy factory maps |
| `all` / `published` / `indexed` | route paths — raw, minus drafts, minus noindex + dynamic |
| `redirects` | `[[from, to], …]` |

---

## Package exports

| Subpath | Contents |
| --- | --- |
| `@frontierjs/sierra` | `VERSION`, re-exported router + theme API, `createSierraViteConfig` |
| `.../build` | `createSierraViteConfig` |
| `.../router` | navigation, `page`, guards, `RouterView`, `ChainRenderer` |
| `.../router/internals` | chain resolution — used by `RouterView`, not public |
| `.../scanner` | `scan`, `scanAndWrite`, `buildTree`, `classify`, frontmatter parsing |
| `.../junction` | client wiring, `status`, auth, `createResource`, `createStore`, `useStore`, `buildFieldRules`, `buildRelations`, `buildGate`, `canAtLevel`, `validateAgainstFields`, `normalizeBlanks`, `coerceToSchema`, `resolveRef` |
| `.../fetch` | `sierraFetch`, `configureFetch` |
| `.../theme` | `theme`, `setTheme`, `toggleTheme`, `initTheme` |
| `.../presence` | `presence(channelId, opts)` |
| `.../analytics` | `initAnalytics`, `track` |
| `.../devtools` | `initToolbar` |
| `.../postbuild` | `runPostBuild` |
| `.../site/serve` | `serveSite` — the prerendered-site origin |
| `.../widget/serve` | `serveWidgets` — the widget origin |
| `.../components/RouterView` | the router outlet component |

---

## Testing

```bash
bun run test        # vitest — 970 tests, 48 files
bun run typecheck   # scripts/typecheck.mjs — baseline 0
```

Use `bun run test`, not `bun test`: this package's tests are vitest-authored, and the bun
runner reports failures that are runner artifacts rather than bugs.

---

## Known rough edges

- `sierra.config.js` is found by probing four locations relative to `vite.config.js` and
  the Vite root — see the [Quick start](#quick-start) note. Somewhere else entirely still
  needs `_configPath`.
- Mesa, Junction and Litestone are imported but not declared as dependencies. Resolution
  is hand-rolled against each package's `exports` map.
- Every named layout slot emits a duplicate-declaration warning from the Mesa compiler.
  Cosmetic — the build and the slot both work.
- `src/resources/` in `@frontierjs/jetty` is a hand-copy of Sierra's and has already
  diverged. Fix one, audit the other.
- The Mesa HMR algorithm is hand-copied from `mesa-vite/` into two files here.

See [`CHANGES.md`](CHANGES.md) for the detailed history of what was fixed and why, and the
repo's `DECISIONS.md` before relitigating any semantics.
