# @frontierjs/sierra — for agents

Compressed reference for writing routes, resources and pages in an app that
installed this package. The README is written for a person reading once; this
file is written for a program that must get one screen right without reading the
rest.

If you are changing this package rather than consuming it, read `CLAUDE.md`
instead — the rules are different and the suite enforces them.

**It does not teach the `.mesa` language** (`@frontierjs/mesa/AGENTS.md`), the
classes (`@frontierjs/css/AGENTS.md`) or the schema (`@frontierjs/litestone/AGENTS.md`),
all under `node_modules/`. **Nor does it list your routes**: `sierra routes --config
config/sierra.config.js`, run from the surface root, writes `routes.snapshot.md`.

---

## The one rule

**Name the model and ask the resource. Do not restate the schema in the browser.**

`virtual:sierra` registers the schema generated from `db/schema.lite` before any
route runs, so a resource already knows its fields, enums, relations, gates and
state machine. A field list or an `if (role === …)` in a page is a second answer
that drifts, and the form, the table and the validator stop agreeing with the server.

```html
<!-- web/src/resources/Order.mesa — named for the MODEL, exports the accessor -->
<script module>
  import { createResource } from '@frontierjs/sierra/junction'
  export const orders = createResource('orders')
</script>

<script>
  import Form from '@frontierjs/ui/components/forms/Form.mesa'
  export let record = undefined
</script>

<Form resource={orders} bind:record={record} {...$attributes} />
```

`<script module>` runs once at import; the markup is the model's default form, so
a create page is `<Order method="create" />`. An irregular plural states the model
(`createResource('people', { model: 'Person' })`), a resource over no model says
`model: null`, and `fli make:resource` writes the file.

---

## Where things go

| File under `src/routes/` | Is |
|---|---|
| `orders/index.mesa`, `about.mesa` (lowercase) | a route — `/orders/`, `/about/` |
| `orders/[id].mesa` · `[...404].mesa` · `(auth)/login.mesa` | `:id` · catch-all · a group with no URL segment |
| `_module.mesa` | the layout for everything beneath it; renders the child with `<slot />` |
| `Row.mesa`, `_row.mesa` (PascalCase or `_`) | a co-located component, **never routed** |
| `orders/[id].meta.js` | the companion — `load`, `head`, `getStaticPaths` |

`@/` resolves to the surface's own `src/`, so `@/resources/Order.mesa` in `web/`
and in `site/` are different files. Route matching is case-sensitive.

---

## Wrong guesses

What a habit from another framework produces, and what this package wants.

| You will write | Sierra wants |
|---|---|
| `app/orders/page.tsx`, `+page.svelte`, `_layout.mesa` | `routes/orders/index.mesa`, and `_module.mesa` for a layout |
| `+page.server.js` / `getServerSideProps` importing the db | nothing — in an SPA a companion's `load()` runs **in the browser** and anything it imports ships. Data comes from a resource |
| `useRouter()`, `useParams()`, a `$page` store | `import { page } from '@frontierjs/sierra/router'` and `$: page.params` |
| `router.push(url)` | `goto(path, query?, { replace, scroll })` |
| `page.path`, `to.path` | `page.pathname` and `page.search` — `path` reads `undefined` |
| `page.params.status` for `?status=paid` | `page.query.status`; `?$limit=20` is `page.directives.limit` |
| `useQuery(['orders'], fetch)`, `fetch('/api/orders')` in a component | `orders.list()`, or `orders.load(page.query, page.directives)` |
| `orders.service.find({ limit: 20 })` | `find(query, directives)` — the first argument is FILTERS: `find({}, { limit: 20 })`, answering `{ data, total }` where `load()` answers the rows |
| `await orders.service.get(id)` kept in a variable | `orders.record(id)` — a live view |
| `resources/orders.js`, two resources in one file | `resources/Order.mesa` exporting `orders`, one per file |
| hand-written inputs plus a submit handler | `<Order />`, or `<Form resource={orders}>` |
| `localStorage.setItem('token', …)` after a `fetch('/login')` | `signIn(email, password)` and `session` from `@frontierjs/sierra/junction` |

---

## Routes, `page` and data

`page`, `status`, `session` and `theme` are **plain objects, not signals**. A
component subscribes by naming the path in a `$:` line; a read without one
renders once.

```html
---
title: Orders
---
<script>
  import { orders } from '@/resources/Order.mesa'
  import Table      from '@frontierjs/ui/components/display/Table.mesa'
  import Cell       from '@frontierjs/ui/components/display/Cell.mesa'
  import FilterBar  from '@frontierjs/ui/components/display/FilterBar.mesa'
  import Button     from '@frontierjs/ui/components/forms/Button.mesa'

  const { columns } = orders.columns()          // ranked from the schema
  const { filters, search } = orders.filters()
  const list = orders.list()                    // the URL is the state
</script>

<FilterBar {filters} {search} value={list.query} directives={list.directives} onchange={list.apply} />
<Table {columns} rows={list.rows} orderBy={list.directives.orderBy} onsort={list.sort}>
  {#snippet row(order)}
    <tr>{#each columns as c (c.name)}<td><Cell value={order[c.name]} column={c} record={order} /></td>{/each}</tr>
  {/snippet}
</Table>
{#if list.hasMore}<Button onclick={list.more}>Load more</Button>{/if}
```

The kit's components, their callbacks and what a `<Table>` needs are
`node_modules/@frontierjs/ui/AGENTS.md`.

`list()` owns the store, the load, the re-run when the URL changes and the keyset
window. `list({ state: 'local', where: { projectId } })` is an embedded list that
writes nothing to the address bar. A list you wire by hand reads the store with
`useStore(orders.store)` and re-runs on `$: page.query, page.directives, () => load()`.

```js
// src/routes/blog/[slug].meta.js
export async function load({ params, url, meta, fetch }) { … }  // → page.data and the `data` prop
export function head({ params, data, url }) { return { title: data.title } }
export async function getStaticPaths() { return [{ slug: 'a' }] } // static target only
```

A thrown `load()` lands in `page.error` and the router stays on the route. A
returned string that is a path on this origin redirects. `fetch` is
`sierraFetch`, which attaches the session to the app's own origin and to nothing
else. Guards are `beforeNavigate(({ from, to }) => …)` — `false` cancels, a path
redirects — and they run on a cold load and on the Back button.

A detail screen watches its row:

```js
let order   = null
let missing = false
let unwatch = null
const row = orders.record(page.params.id)   // { composed: true } if get() answers includes
unwatch = row.subscribe(v => { order = v })
row.ready.then(v => { if (v == null) missing = true })
$.onDestroy(() => { unwatch?.(); row.release() })
```

Write the handle as a `let` assigned on its own line, as above — the reason is a
language rule and lives in Mesa's AGENTS file.

---

## Writes and forms

**`save(record, { mode })` is the one write.** `auto` decides create or patch from
the schema's key, a patch sends only the keys that changed against the row this
resource READ, and an explicit `null` still clears. `service.patch(id, data)`
sends exactly what it is handed.

**Every create and patch coerces, turns `''` into `null` on nullable fields, and
validates — in the browser, before a request.** A failure throws
`ResourceValidationError`; `<Form>` renders it. `{ validate: false }` is for a
service that accepts a shape the model does not describe.

**`<Form resource={r}>` with no default children IS the form** — every writable
column in schema order. Buttons go in `slot="actions"`, which keeps generation
on; `only` and `except` narrow it. Default children mean *I am writing this form*
and turn generation off.

**A `409` from a `@version` column is the right answer**, not a bug to retry
around: `orders.conflict(err)` gives `{ model, field, expected, actual }`.

**`orders.can('delete', session.level)` is an affordance, never a boundary.**

---

## Static pages and islands

A prerendered site is its own surface, `site/`, beside `web/` — never a second
config inside it, because `vite build` empties the shared `dist/`. `fli make:site`
writes it.

```js
// site/config/sierra.config.js
export default { target: 'static', routesDir: 'src/routes', outDir: 'dist', db: '../api/src/core/db.ts' }
```

```html
---
render: static
publishes: 4
---
<script>
  import LiveStock from '../islands/LiveStock.mesa'
  export let data = null
</script>
<h1>{data?.name}</h1>
<LiveStock client:visible productId={data?.id} />
```

**The build proves what a page may publish.** It taps the `db` client while
`load()` and `getStaticPaths()` run and compares every model read to its
`@@gate`, reads through `asSystem()` included. A read above the page's
`publishes:` level (default `0`, public) fails the build; a read it could not
observe fails it whatever `publishes:` says. Raising the level is a written
statement that data gated at that level may be served to anyone.

**A prerendered page never loads `virtual:sierra`** — no router, no `session`, no
booted client. An island builds its own client inside `$.onMount` with
`createJunctionClient` from `@frontierjs/junction/client`, because its script also
runs during the build. Island props are serialized as JSON. Mounting replaces the
prerendered markup; there is no hydration. Directives are `client:load`,
`client:idle`, `client:visible`, `client:media="(…)"` and `client:static`.

**Dev on a static surface is an SPA; only the build prerenders and checks.** The
dev server runs a static `load()` itself and must be `bun --bun vite` — under node
it fails with a `bun:` protocol error. A relative URL in a build-time `load()` throws.

---

## Silent failures

Everything above is loud. These are not.

- **`import 'virtual:sierra'` must be the first import in `main.js`.** A resource
  module evaluated before the client exists — or in an app with no `junction.url`,
  or on a prerendered page — logs *Junction client not ready — returning empty
  resource* once and stays empty for the tab: every call rejects and `can()`
  answers `false`.

- **`can()` with an unknown level answers `true`.** `session.level` is `null`
  unless the API's auth plugin configures `services: { level }`, so every button
  is offered to everyone. Unknown is permissive; the server still refuses.

- **`isActive('/orders/')` in markup is evaluated once** unless the expression
  also names the route: `aria-current={(page.route, isActive('/orders/')) ? 'page' : null}`.

- **Inside a watch on `page.*`, read `page.*`, not a `$:` value derived from it.**
  The two update in no guaranteed order, so the call sends the PREVIOUS query and
  the list trails the URL by one click.

- **A query change never remounts a page, and a layout both routes share is
  reused.** A leaf route remounts when its own path params change. A layout that
  copied `page.params` at setup keeps the old value.

- **`service.get(id)` answers a plain object nothing updates.** A write from
  another tab, a job or a webhook reaches the store and never that variable. If
  the service's `get()` returns more than the row, a plain `record(id)` drops the
  extra keys at the first push — declare `{ composed: true }`.

- **`record(id).ready` resolves `null` for a missing row AND a refused one.** It
  does not reject for either, so a spinner keyed on `order == null` spins
  forever. Key it on whether the read has answered.

- **A patch can take a row OUT of a live list.** A store means the query that
  filled it, so a row edited out of the filter is removed. Past the first page a
  pushed row is not inserted — it is counted on `orders.stale` for a
  *3 new — refresh* affordance.

- **A `@money` column is an integer of minor units.** `{order.total}` prints a
  price a hundred times too big. Render it with `<Cell value={…} column={c} />`
  from `resource.columns()`, or `formatMoney(fromMinor(v, code), code)` from
  `@frontierjs/toolbelt/units`. A generated form has no built-in control for it —
  the app registers one with `registerControl`.

- **`junction.cookieAuth` must match the server's auth plugin.** Left off against
  a cookie-mode API, a signed-in caller reads as signed out and a sign-out never
  reaches the server.

---

## Checklist before emitting a route or resource

1. A resource is `src/resources/<Model>.mesa`, one `createResource` in
   `<script module>`; an irregular plural or a renamed service states `model:`.
2. No field name, type, enum member or required list is written in a page.
3. Every `page.*`, `session.*` or `status.*` a component renders is named in a `$:`.
4. Filters travel as `page.query`, directives as `page.directives`; no `$`-key
   is hand-built into an object.
5. A kept row is `record(id)`, released on destroy; a list is `list()` or a
   watched store.
6. Money is rendered through the declaration, never as the integer.
7. A `site/` route declaring `render: static` has `db:` in its surface config, a
   `getStaticPaths` if it is dynamic, and no `publishes:` it does not mean.
8. `import 'virtual:sierra'` is the first line of `main.js`; every Vite config sets
   `strictPort: true`.

---

## What grades it

**`fli check` is the executable half of this document.** The rules that read a
Sierra surface:

| Rule | Catches |
|---|---|
| `resource-dir-mesa` · `resource-script` · `resource-file-name` · `resource-one-per-file` | a non-`.mesa` file in `src/resources/`; no `<script module>`; a file not named for its model; two resources in one file |
| `resource-model-miss` | `createResource('x')` that resolves to no model where one plausibly exists |
| `route-part-prefix` | a `_folder.Part.mesa` sitting in a different folder than its prefix names |
| `page-path-retired` · `detail-read-dead` | `page.path` / `to.path`; a `service.get()` result kept in screen state |
| `table-column-key` · `money-rendered-raw` | a `<Table>` column spelled `key` instead of `name`; a `@money` column interpolated bare |
| `static-publish-db` · `static-publishes-0` | a `target: 'static'` surface with companions and no `db:`; `publishes: 0`, the default, stating nothing |
| `app-layout` · `surface-config` · `widget-entry-name` | a surface in the wrong place; config outside `config/`; a misnamed widget |
| `vite-strict-port` · `body-tag-in-comment` | a Vite config that can hop ports; a first body tag inside a comment in `index.html` |

`sierra routes --check` fails on a stale `routes.snapshot.md`, and
`db/jsonschema.snapshot.md` is exactly what every resource reads. In the browser
console, a `[resource:<name>]` warning means that resource is not schema-derived.
Run `fli check` after writing, not instead.
