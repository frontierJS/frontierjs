# @frontierjs/junction — for agents

Compressed reference for writing a service, a hook or a raw route in an app that
installed this package. The README is written for a person reading once; this
file is written for a program that must get one service right without reading
the rest.

If you are changing this package rather than consuming it, read `CLAUDE.md` in
the repository instead — the rules are different and the suite enforces them.

**This file does not list the API surface of your app.** What your app actually
serves is read off the built app by `junction surface --app src/app.ts
--services src/services` (run from `api/`), which writes `surface.snapshot.md`
and rechecks it with `--check`. What is here is the half a generated table
cannot carry: which shape to reach for, and where a legal spelling does
something you did not intend.

Junction is **Bun-only**. Its `exports` point at `.ts` files; nothing here runs
under node.

---

## The one rule

**The schema grades the caller. A service names the work.**

A service over a model is one line, and the model's `@@gate`, `@@allow`,
`@system`, `@guarded` and field rules already give it its 401s, 403s, 400s and
row filtering. Access rules belong in `db/schema.lite`, never in a hook — a hook
guards the callers that pass through it and nobody else. Read
`node_modules/@frontierjs/litestone/AGENTS.md` for how to declare them.

```ts
// api/src/services/orders.service.ts
import { createBaseService } from '@frontierjs/junction'

export function createOrdersService() {
  return createBaseService({ channel: 'orders' })
}
```

The file name is the service name (`orders`), the service name resolves the
model (`Order`, accessor `db.order`), and the file is autoloaded — nothing
registers it. `order-lines.service.ts` becomes the service `orderLines` over
`OrderLine`. Where the name cannot reach the model — a service `sales` over
`Order` — state `model: 'Order'`. A
`*.service.ts` exporting no `create…Service` factory is an authoring error that
refuses `start()`.

---

## Wrong guesses

Ranked by how often Feathers, Express, Nest and Prisma habits produce them.

| You will write | Junction wants |
|---|---|
| `async pay(data, params)` / `ctx.params.user` | a method receives the context: `$.data`, `$.me`, or `(ctx) => ctx.auth.user`. There is no `params` anywhere |
| `$.me.id` / `req.user.id` | `$.me.userId` — a string. The schema side reads the same value as `auth().id` |
| `import { db } from '../core/db'` inside a service | `$.db` — the client scoped to this caller |
| `if (!user.isAdmin) throw` in a `before` hook | `@@gate` / `@@allow` in the schema |
| `app.get('/orders/:id', …)` | `app.get('/orders/{id}', …)`, read as `ctx.route.id` |
| `GET /posts?limit=10&sort=-createdAt` | `?$limit=10&$orderBy=-createdAt`; the service sees `ctx.directives` |
| a route per action, `POST /orders/:id/pay` | a custom method: `POST /orders/{id}` with `X-Service-Method: pay` |
| `PUT` replaces the row | `update` merges like `patch` and requires an id; an unnamed column is left alone, an explicit `null` clears |
| sending mail from an `after` hook | `$.afterCommit(fn)`, or `$.enqueue(job, payload)` when it must survive a crash |
| `app.service('posts').find({}, { limit: 10 })` | `find(filters, { directives: { limit: 10 } })` |
| `throw new Error('Not found')` | `throw new NotFound()` — or any error carrying a numeric `status` |
| setting a `@system` column in a hook | `ctx.system.add('slug')` beside the assignment, or the write is a 403 |
| `app.myThing = value` in a plugin | `app.claim('myThing', value)`, typed by augmenting an exported interface |
| `app.scheduler.every(…, () => app.jobs.dispatch(…))` | `app.jobs.schedule(name, expr, fn)` — the queue owns its clock |

---

## The context you are inside

`$` is the service call in progress, imported from `@frontierjs/junction`. It
works in a service method, any hook, an `afterCommit` effect and anything they
call. **Outside a call it throws** — at module scope, in a job handler, and in a
`setTimeout` that fires after the call has finished. Capture what a deferred
callback needs before the call ends.

```ts
$.db          // this caller's Litestone client
$.me          // the principal (SessionContext) or null
$.data        // the payload — a row, or an ARRAY of rows on a bulk create
$.id          // the id from the URL, or null
$.query       // filters: becomes the WHERE
$.directives  // { limit, offset, orderBy, select, … } — never a filter
$.locals      // per-call scratch; fresh every call, not inherited
$.log         // a logger already tagged with correlation id, user and tenant
$.config      // app configuration, per tenant where the app declares one
$.afterCommit(fn)          // runs once, on success, after the commit
$.enqueue(job, payload)    // an outbox row inside this transaction
$.system.add('col')        // this call supplies that @system column
$.dispatch = false         // announce nothing for this call
```

**Only `data`, `query`, `id`, `result`, `error`, `statusCode` and `dispatch` can
be assigned.** `$.anything = x` throws by name; per-call state goes in
`$.locals`, app state in `app.claim()`.

A raw route gets a different context: `ctx.user` (flat, may be `null`),
`ctx.route`, `ctx.headers`, `ctx.query` with `$` keys still present, `ctx.body`,
`ctx.rawBody`, and `ctx.json(body, status)` to answer. It runs no hook pipeline
and no gate, so reach for one only where there is no service shape — a vendor's
webhook, a file stream — and call a service from it for anything touching a
model. Verify a signature over `ctx.rawBody`, never a re-serialized `ctx.body`.

---

## Services

```ts
export function createOrdersService() {
  return createBaseService({
    channel: 'orders',

    // The whole surface. Anything absent answers 405.
    methods: [
      'find', 'get', 'create', 'patch', 'remove',
      { method: 'ship', gate: 5 },                              // above the model's read gate
      { method: 'recordTracking', input: 'TrackingUpdate' },    // a `type` in schema.lite
    ],

    transactional: ['ship'],   // or true

    hooks: {
      before:    { create: [(ctx) => { /* shape ctx.data */ }] },
      validated: { create: [async (ctx) => { /* a rule that reads the database */ }] },
    },

    async ship() {
      return $.db.order.transition($.id, 'ship')
    },

    async recordTracking() {
      const { trackingCode } = $.data as { trackingCode: string }
      return $.db.order.update({ where: { id: Number($.id) }, data: { trackingCode }, system: ['trackingCode'] })
    },
  })
}
```

**Declaring `methods:` declares the whole surface.** A service with no list
answers every CRUD verb and finds custom methods by scanning; the moment one
entry exists — including one added only to carry an `input:` — every verb it
does not name is a 405.

**A custom method takes the model's READ gate as a floor** and runs nothing for
a caller below it. `gate: n` raises that floor for one method. A method called by
something that is not a session (a signed webhook, an invitation link) states
`gate: 0`.

**The hook order is `around → before → validated → method → after`, and the
derived gate wraps all of it.** A stranger is refused before any hook an app
wrote runs. `before` shapes the raw payload; the schema validator runs after it;
a rule that needs the coerced payload or reads the database belongs in
`validated:`. `before: { all: [...] }` reaches custom methods too.

**`transactional:` wraps the whole pipeline**, `after` hooks included, and holds
SQLite's write lock for that long. `find` and `get` are never wrapped.
`$.enqueue` refuses outside a transaction.

**Report a rule the schema cannot state the way the schema reports its own:**

```ts
import { validateFields, BadRequest, Forbidden, NotFound, Conflict } from '@frontierjs/junction'

await validateFields(e => {
  if (total >= 100_000 && !note) e.invalid('note', 'An order this large needs a note')
})
// → 400 with data: [{ field: 'note', message: '…' }], rendered under the control
```

---

## Calling a service from code

```ts
app.service('posts').find({ status: 'open' }, { directives: { limit: 10 } })
app.service('posts').get(id)
app.service('posts').patch(id, { title })
app.service('orders').call('pay', id, data)
app.service('orders').call('pay', id, data, { auth: { user: SYSTEM } })
```

**A call that names no `auth` inherits the principal in scope**, at any depth,
including from a raw route handling a signed-in request. `{ auth: { user: null } }`
is a different statement — *as nobody* — and is how you ask what a stranger would
see.

`find` answers the list envelope `{ kind: 'list', data, total, … }`, not a bare
array. Branch on `kind`.

In the browser: `client.service('orders').invoke('pay', id, data)`.

---

## Silent failures

Everything above is loud. These are not.

- **The module client sees nobody.** A service reading `db` imported from
  `core/db.ts` runs with `auth()` null, so every `ownerId == auth().id` policy
  matches nothing — the caller's own rows vanish from a 200. Writes belong to
  nobody in the audit trail. Use `$.db`.

- **`$.me.id` is `undefined`.** The principal's id is `userId`, a string.
  `ctx.params` is `undefined` too, so a role check reading `ctx.params.user`
  passes for everyone.

- **A payload key the caller may not write is dropped with a 201.** A key that
  names no field is a 400 naming it; `id` on a create, `createdAt`, or a
  `@guarded` column is removed and the write proceeds. A client echoing a fetched
  row back relies on this.

- **An `after` hook that throws answers 500 over a committed write.** Without
  `transactional:` the row is saved and the caller is told it failed. Declare
  the method transactional, or move the work to `$.afterCommit`.

- **A flat option on an internal call does nothing.**
  `find({}, { limit: 1 })` returns every row; directives go under `directives:`
  and filters in the first argument.

- **A publish reaches only connections that joined the channel.** `channel:
  'orders'` announces every write; nothing arrives until something calls
  `app.channel('orders').join(conn)`. The scaffold's `api/src/core/channels.ts`
  joins every declared channel on connect. Each frame is then graded per
  recipient against the model's `@@gate` and `@@allow`, so joining is a
  subscription, not a permission.

- **A custom method's RESULT is announced under its own name** (`orders pay`) on
  the service's channel. A read-shaped method that answers something other than
  a row — a count, a report, a credential — sets `$.dispatch = false`, or that
  answer goes to every joined socket.

- **A header a caller varies per call must be listed in
  `config.http.callHeaders`.** Over HTTP it arrives regardless; over the
  WebSocket, which the browser client prefers once connected, an undeclared
  header is absent — a token-scoped row policy then answers empty.

- **`apiPrefix` moves raw routes too.** `app.get('/webhook', …)` under
  `apiPrefix: '/api'` is served at `/api/webhook` only. A path that must not move
  goes on `app.http.router`.

- **`createApp({ config })` beats `api/config/junction.config.js` at the leaf.**
  A field stated in both keeps the code's value and the file's is decoration.

- **A hook on `create` receives an array for a bulk create.** Narrow with
  `Array.isArray($.data)` and map, or the hook writes properties onto the array.

- **`app.scheduler` is in-process only.** It is not persisted, not retried, has
  no principal, and runs in every replica. Durable or once-per-cluster work is
  `app.jobs`.

---

## Checklist before emitting a service

1. The file is `api/src/services/<plural>.service.ts` and exports
   `create<Plural>Service()`.
2. The service name resolves to a PascalCase singular model, or `model:` states
   it.
3. No role, ownership or tenant check in a hook — it is an `@@gate`, `@@allow`
   or `tenancy` declaration.
4. Every database read or write goes through `$.db`, never a module-level
   client; `asSystem()` is taken off `$.db` and only where the bypass is the
   point.
5. If `methods:` is present it names every verb the screens call, custom methods
   included.
6. A custom method called by a machine or a stranger states its `gate:`.
7. Irreversible effects are in `$.afterCommit` or `$.enqueue`, not `after`.
8. A method that writes more than once is `transactional:`.
9. A read-shaped custom method sets `$.dispatch = false`.
10. Raw routes use `{param}` and call services rather than the database.

---

## What grades it

**`fli check` is the executable half of this document.** Its app rules read your
service source for the shapes above, by id:

| Rule | Catches |
|---|---|
| `service-module-db` | a service reading the module client instead of `$.db` |
| `service-as-system` | `asSystem()` off the app client, which crosses tenants |
| `service-model` | a service whose name resolves to no model |
| `ctx-params` | `ctx.params` |
| `raw-route-param` | `:id` in a raw route |
| `set-auth-discarded` | `db.$setAuth(user)` called for its side effect |
| `call-header-declared` | a per-call header missing from `http.callHeaders` |
| `scheduler-dispatch` | `app.scheduler` dispatching into the queue |
| `queue-operator-verb` | a service pausing, resuming or draining a queue |
| `transition-methods` | a `@@transitions` move and the method that makes it drifting apart |

Run it after writing, not instead. Three more ways to ask:

```
fli api:routes                                          # every route the running API serves
junction surface --app src/app.ts --services src/services   # from api/: the committed surface
fli test:snapshots                                      # recheck every committed snapshot
```

`surface.snapshot.md` carries each service's policy-applied method list and its
hook chain in run order, so a verb that stopped being answered is a diff before
it is a 405.
