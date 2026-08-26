---
id: app-conventions-audit
status: assessment
dated: 2026-08-21
---

# Assessment — conventions from a pre-prototype app, and which of them FrontierJS should keep

**Status: ASSESSMENT. Nothing here is built and nothing here is a defect.** It is a
reading of one real application, kept so the reasoning survives the session that
produced it. Where a finding is genuinely open it has an id in `ISSUES.md` and is
named below; where it is settled it is in `DECISIONS.md`. **This file is not a
register** — do not treat a heading here as open work.

## What was read

`KOBAMI/my.maid.tech`, `web/` only: 474 files, 56,381 lines of Svelte 5 + Routify v3
against `@frontierjs/web@0.0.29`, the pre-FJS client. It is the largest application
written to this framework's ideas by somebody who was not writing the framework, which
is the whole of why it is worth reading: every convention in it was kept because it
paid, or kept because nobody stopped it, and the two are separable by counting.

Four layers, of which two have a rule: `core/` (app singletons), `resources/` (36
files, one per model), `components/` (33 + subfolders), `routes/` (280 files).

---

## 1 · Adopted

### 1.1 A resource file carries its model's default form — **ruled, `FJS-D112`**

Every one of the 36 resource files is `<script context='module'>` (store, service,
make, domain verbs) **plus** an instance script **plus** the model's edit form. What
that buys is visible in the routes: `webhooks/create.svelte` is eight lines rendering
`<Webhook />`, `webhooks/[webhookId].svelte` is twenty, and the form exists once.

Invariant 18 said the opposite — no markup, everything in `<script module>` — and the
markup half is now reversed. The data half was right and stays.

What is **not** ruled is whether a generated Resource should CONTAIN that form, which
is `FJS-D114` below.

---

## 2 · Open — each has an id

### 2.1 A Resource owning its named queries — `FJS-D114`

The strongest unadopted idea here. `Task.svelte` declares three things beside the
model and every consumer reads them:

- `optionsQuery` — the thin `$select` a dropdown wants
- `query` — the canonical include-shape for the detail view
- `save(data)` — upsert plus the coercion the model needs (date + time strings → Date)

`createResource` in this repo already takes `optionsQuery` and nothing in the tree passes it — no generator, no
app — so one of the three is permitted and undemonstrated rather than missing; `query` and `save` have no home at
all. The drift in the app shows what having no home costs:
in maid.tech the convention is followed **6 times out of 36**, and **80 route files
hand-write their own `$include` shape**. Where the answer has no home it is written
per call site, and the version in the file nobody edited is the stale one.

### 2.2 Nothing executes the generators — `FJS-372`

Filed off this session rather than off the app. Both defects found here
(`FJS-363`, `FJS-364`) lived in commands no test runs.

### 2.3 Invariant 13 has no check — `FJS-373`

maid.tech HAS the semantic layer — `theme-primary`, `theme-danger`, `.btn.outlined`,
`.btn.danger` — and independently arrived at tone + treatment, which is good evidence
the invariant is right. It is also losing **578 raw colour utilities to 156 semantic
ones**, about 4:1. A vocabulary that exists and is not enforced is a vocabulary that
documents what the first six months intended.

---

## 3 · Worth taking — filed 2026-08-22

Each of these now carries an id, so the register answers for them rather than this
file. Nothing below is built.

### 3.1 `data-confirm` — a declarative confirm with one delegated listener — `FJS-D115`

A button writes `data-confirm="Delete forever?"`. One document-level capture listener
shows the popover, then re-fires the click behind a flag. Zero per-component wiring,
works on any element, and the markup degrades to a plain button.

FrontierJS has no equivalent and the shape is already house doctrine — Invariant 11
says the nearest delegation root owns an event. The trap the app shows is worth
copying too: it also has a `use:confirm` Svelte action in `core/actions.js` with
**zero call sites**, because the attribute won. Two mechanisms for one idea, one of
them dead, which is Invariant 4's argument in miniature.

Sibling: `data-return`, same shape, stashes a return path.

### 3.2 An async affordance returns a HANDLE, not an id — `FJS-390`

`const release = Element.temporary(e.target)` → `release('There was an error')`. Lock
and restore in one value. This repo already chose the same shape for toasts
(`toasts.loading()` → `{update, dismiss}`, `FJS-119`), independently. Worth stating
once as house style rather than rediscovering per component.

### 3.3 A component file exports its own actions from module scope — `FJS-D116`

`import Table, { empty, exportCSV } from '.../Table.svelte'`, then
`use:empty={{name:'webhooks', span:5}}`. Same shape as a resource: the file owns the
noun and the verbs that touch it. Also `Map.svelte` → `getGeoLocation`,
`Form.svelte` → `useForm`.

### 3.4 Route-folder naming that survives a flat search — `FJS-D117`

- `index` / `create` / `[xId]` — pages
- `_module` — layout
- `_Plural.mesa` — the reusable collection panel, imported cross-route
- `_plural.Thing.mesa` — the folder-scoped part

The namespaced filename (`_tasks.TaskStatus.svelte`) means an import list is readable
without paths and a flat search is unambiguous — better than twelve files named
`List.svelte`. See 4.4 for how it fails.

### 3.5 The page owns its own title — `FJS-389`

Not read off the app until a second pass; the app sets a `$title` store from the page
and the layout renders it. Sierra has the data half and not the effect: `title:` is
ordinary frontmatter, spread onto `page`, and `document.title` is assigned nowhere in
`packages/sierra/src` outside the prerenderer — so a `static` build titles every file
correctly and an SPA shows `index.html`'s one string on every route.

---

## 4 · Rejected — measured, not disliked

### 4.1 The browser authors Prisma queries

Route files ship raw Prisma to the server: nested `$include` with
`where: { deletedAt: null }`, `OR` arrays built from split search text,
`tags: { some: { name: { contains: term } } }`. **80** hand-written `$include` shapes
in `routes/`, 30 more in `resources/`, and no whitelist found in the API's `core/`.

This is the single largest architectural difference, and it is what
Invariant 10 + `@@allow` + `$checkWhere` / `$checkOrderBy` exist to replace: the
client states a filter, the server compiles it against declared policy. Caller-supplied
search text also reaches a query object directly, which is Invariant 8's territory.

### 4.2 Fork-by-copy as the reuse mechanism

Measured: `routes/contacts/` holds **four byte-identical copies** of `routes/clients/`
files, still named `_clients.*` inside the contacts folder. `routes/messages/` is a
fork of `routes/notes/` (16–31 lines of drift) still named `_notes.*`.
`routes/system/reports/_views/` is a fork of `routes/reports/_views/` (8–105 lines).
`Task.svelte` opens with `<!--This file was copied and pasted from Task.svelte-->`.

The failure is specific and it is 3.4's: a fork keeps the old namespace prefix, so the
prefix — the thing that made the convention worth having — starts lying.

### 4.3 A version in the filename

`Input.svelte` (57 importers) and `Input2.svelte` (19) both alive. `Dropdown` 17 /
`Dropdown2` 1. `FileTree` 2 / `FileTree2` 1. `Switch2` — **zero importers, still
shipped**. `exportCSV` beside `exportCSV2`. `_tags.ListNew.svelte`.

Nobody ever finishes the migration. A number in a filename is a fork that cannot be
completed because nothing records what completing it would mean.

### 4.4 Cargo-culted dead exports

`createResource` returns `{schema, modelSchema, service, store, make}` — **no
`context`**. Seventeen of 36 resource files nonetheless destructure and re-export
`context`, which is `undefined` in all seventeen, with **zero importers**. Copied
forward because it was in the template.

Same shape: `setContext('resource', …)` appears **16** times, `getContext('resource')`
**once**.

Litestone already throws on an unknown property, and this is the evidence for why: a
destructure that silently yields `undefined` is how a convention rots without anything
going red.

### 4.5 Prototype patching as a standard library

`core/preload.js` installs ~25 globals — `Object.grab/put/delete/map`,
`Array.groupBy/objectify/sortBy/upsert/remove`, `String.is/isUrl/isMediaPath`,
`String.prototype.humanCase/slugify`, `Date.Relative/Range/getSprint`,
`Promise.debounce`, `Promise.make`, `Element.temporary/lock/tempText`, plus five
`window.*`.

**The library depends on the app having done it**: `@frontierjs/web/resource.js` calls
`Array.upsert` and `Array.remove`, which only exist because the consumer patched them
first. That is an import-order landmine with no error at either end.

`@frontierjs/toolbelt` is the right answer and already exists — one kit per subpath,
zero deps, no globals (`FJS-D26`). Take the functions; never the patching. The
`// TODO: [later] - review and integrate the below extensions into frontierjs core`
in that file should be read as a warning rather than a plan.

### 4.6 No layer direction

**22** files under `components/` import from `@/resources/`; **4** import from
`@/routes/`; there are **237** cross-route imports, with `routes/tags/_Tags.svelte`
imported by **29** files. So `routes/` is also the component library and
`components/` is also model-aware, with nothing enforcing either way.

Invariant 1 and `fli check` are the answer on the API side; there is no web-side rule
today, and this is the case for one — *a route file may not be imported by a non-route
file*. Not filed: it is a proposed rule rather than a broken one, and it wants the
`FJS-D114` conversation first, since a Resource that carries its default form changes
what legitimately imports what.

### 4.7 A scaffold that ships dead code, once per model

`routes/webhooks/_Webhooks.svelte` is 130 lines of which roughly 20 are live. Dead:
`containsQuery`, `tagsTextQuery`, `createdAtQuery` (unreferenced), `toggleWebhooks`
(unreferenced), `searchTags` / `tagScope` / `filters` (never read), `exportAllOptions`
(never set true), an empty `onMount`, an empty `const query = {}`, an empty `catch`.

Repo-wide: 257 commented-out JS lines, 113 commented-out markup lines, 76 TODO, 64
`console.log`, 7 empty catches.

That is not laziness — it is one template with every option switched on, pasted per
model. **Every dead line in a scaffold template is multiplied by the model count**,
which is the argument for generating the minimum and letting `fli make:` add.

### 4.8 Permission logic in three places

`core/app.js` has `currentUser.access(route)`, a derived `access` store, and
`beforeUrlChange` — three regex walks over a `user.permissions` array of route
patterns, at three different times, two of which throw if the match misses
(`perm.split('')` on `undefined`). No server mirror is visible from the client.

`@@gate` / `@@allow` declared in the schema and enforced at the Data boundary, with
`x-gate` as a client affordance only (Invariant 6), is the answer — and this is the
evidence for it rather than an assertion of it.

### 4.9 Two Field abstractions, one unused

`Select.svelte` wraps `<Field>`, which owns label, help and error markup.
`Input.svelte` duplicates all of it inline and never imports `Field`. Both define
`convertNameToLabel` locally, twice.

This repo already solved it — `$context.form` plus one `field-rules.js` — and hit the
same bug on the way (`FJS-077`, nine controls resolving their own label, four more
shadowing the schema).

---

## 5 · What the reading is worth

Two conventions here were invented independently of this repo and match it — tone +
treatment styling, and the async handle — which is the useful kind of agreement.

One convention was invented independently and **beats** what this repo ruled, which is
`FJS-D112`.

Everything in §4 is a mechanism with no owner: a query shape with no home, a name with
no rule, a global with no module, a permission with no boundary. That is the same
diagnosis `IDEAS/overview.md` records from the ten-problem survey — *strong wherever
the compiler or the schema owns a fact, weak wherever the fact lives in imperative
client glue* — arrived at from a completely different direction.
