# Sierra example

One `db/schema.lite`, seeding both halves of an app. The API derives its tables,
its 401s and its 400s from it; the browser derives `make()` defaults, field
rules, enum options, relation targets and gate levels from the same file.
Neither side restates the other, and this example exists to prove that claim
over HTTP rather than assert it.

```bash
bun run api     # Junction + Litestone on :3500
bun run dev     # Sierra + Vite on :5273   (proxies /api, /login, /ws)
```

Open <http://localhost:5273>, then sign in from the header — `@@gate("0.4.4.5")`
makes reads public and writes authenticated.

## Read in this order

| file | what it seeds |
| --- | --- |
| [`db/schema.lite`](db/schema.lite) | everything below |
| [`api/services/leads.service.ts`](api/services/leads.service.ts) | 4 lines. CRUD, 401s and 400s are all derived |
| [`src/resources/leads.js`](src/resources/leads.js) | names a model, turns two flags on |
| [`src/routes/leads/create.mesa`](src/routes/leads/create.mesa) | a form with no field list in it |

## What to look at

**The form is generated.** `create.mesa` contains no field names, no types, no enum
values, no required flags, and no mention of the accounts service. Rendered, it
produces:

```html
<input type="text"  maxlength="80">        <!-- @length(1, 80)  -->
<input type="email">                       <!-- @email          -->
<input type="number" min="0">              <!-- @gte(0)         -->
<select>new contacted qualified won lost   <!-- enum Stage, via $ref -->
<select>Acme Corp Globex                   <!-- x-relations → Account -->
```

The stage `<select>` is the interesting one. Litestone emits an enum field as
`{"$ref":"#/$defs/Stage"}`, so the values only exist if the browser resolves that
reference — which it now does, against the same definition table the build ships.

The account `<select>` is the other one. `accountId` is a plain integer on the
wire; the only reason the UI knows it is a reference is `x-relations`, and the
resource it fetches options from is derived from
`leads.relations.account.model`, not written down.

**No `tags` field appears**, although `Lead` has `tags Tag[]`. A relation is not
a column. It used to be emitted as a required array-of-string, which meant the
seed in `api/app.ts` could not have created a lead without inventing one.

**The delete button is disabled until you sign in as admin.** `@@gate("0.4.4.5")`
wants level 5 to delete; `leads.can('delete', session.level)` asks before
rendering. This is an affordance, not a boundary — the server refuses either
way, and you can watch it: signed in as *user*, `DELETE /api/leads/1` is a 403.

**Leave `slug` empty and submit twice.** Both save. `slug String? @unique` means
SQLite accepts any number of NULLs but rejects a second `''`, and an empty text
box submits `''` — so `blankToNull: true` is what stands between the second lead
and a constraint violation nobody wrote. The list page prints the stored value,
so you can see `null` rather than an empty cell.

## Verified

Checked over HTTP against this running pair, not asserted:

```
GET    /api/leads                      → 200, 3 seeded rows
POST   /api/leads         (no token)   → 401   @@gate wants 4 to create
POST   /api/leads         (user)       → 201
DELETE /api/leads/3       (user)       → 403   @@gate wants 5 to delete
DELETE /api/leads/3       (admin)      → 200
POST   {"stage":"gold","email":"nope"} → 400   stage must be one of: new, …
POST   {"slug":null} × 2               → 201, 201
POST   {"slug":""}   × 2               → 201, 500   UNIQUE constraint failed
```

The last line is the case `blankToNull` exists for, and also a rough edge worth
knowing: a constraint violation surfaces as a 500 `GeneralError` rather than a
409, because nothing maps SQLite constraint errors to a client-error status.

And in the browser, over CDP: load `/`, click every nav link, sign in as admin,
fill the form, submit it, delete a row — **0 console errors, 0 exceptions**. The
submitted record lands as `value: 42` (number), `accountId: 1` (integer),
`slug: null`, `notes: null`; submitting twice with a blank slug produces two
NULL rows and no constraint violation.

The markup quoted above is real rendered output, not a sketch.

## Notes on the shape of this example

- `vite.config.js` sits at the Vite root, next to `index.html`. Sierra derives
  the path to `sierra.config.js` by rewriting the resolved Vite config path, so
  a nested `config/vite.config.js` looks for `config/config/sierra.config.js`
  and fails. Set `_configPath` if you must nest it.
- The API and the UI are separate processes, and Vite proxies `/api`, `/login`
  and `/ws` to the API. One origin means the Junction client derives its
  WebSocket URL from the same base as its HTTP calls, and there is no CORS.
- `mount()`'s first argument is an anchor **node**, not an element id — Mesa
  inserts the component after it. See `src/main.js`.

## Found by building this

An example is only worth having if it can fail. This one did, six times — the
last two only once it was **driven** in a browser (navigation, sign-in, form
submit, delete) with the console watched, rather than having two pages dumped:

| | |
| --- | --- |
| `mount('app', …)` | The first argument is an anchor **node**, not an element id. A string throws "anchor node has no parentNode", which says what but not why. Sierra's own README had it wrong; both are fixed. |
| Mesa compiler resolution | Sierra resolved `@frontierjs/mesa/compiler.js` via `createRequire().resolve()`, which **cannot** see it — mesa's exports map declares only an `import` condition. That fallback was dead code and the last resort guessed a path under the app root, so any layout with mesa outside the Vite root failed while claiming it was not installed. Fixed in `src/build/mesa-plugin.js`. |
| A route named `new.mesa` | Mesa names the component function after the file and sanitises invalid *characters* but not reserved *words* — `export default function new(…)`. It runs in dev and fails only at `vite build`. This route is `create.mesa` for that reason. See `packages/mesa/compiler.js:6336`. |
| `ctx.body` in raw routes | A raw route's `ctx` is a `TransportContext`; the parsed body is `ctx.body`. Re-reading the request yields nothing silently — here it made "sign in as admin" quietly grant level 4. |
| `bind:value={draft[key]}` | **Mesa emitted a broken setter.** The read was rewritten through the accessors, the write was not — `($$v) => { draft[key] = $$v }`, referring to a name that no longer exists. Valid JS, mounted fine, threw `ReferenceError: draft is not defined` on the first keystroke. Binding to an object property — which is what every form does — could not accept input at all. Fixed in `packages/mesa/compiler.js`, with regression tests in `emission.test.js`. |
| Numbers arrived as strings | `el.value` is a string for every control, `<select>` and `type="number"` included, and Mesa passes it through unchanged (correctly — it does not know the field). The form failed validation with *"value must be a number"*. Only the schema knows the types, so Sierra now casts them: `coerce: true`. |
