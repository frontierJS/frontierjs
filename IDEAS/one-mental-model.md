---
id: one-mental-model
status: assessment
dated: 2026-08-02
---

# Idea — One mental model: where concepts repeat, and where they only pretend to

**Status: REVIEW + IDEA. Nothing here is a plan.** Dated 2026-08-02. Findings were
probed against the tree (`VERIFYING.md`); evidence is cited inline. Package state
moves — re-probe before acting.

---

## The goal, stated

Keep the mental models small. Repeat concepts where and when it makes sense, so
that learning one part of FJS teaches you the next. The stated exemplars:

- `fli` commands are markdown files; pages can be Mesa files with markdown support
- Context is an object used in every Realm
- The chain of responsibility carries the schema Data → API → UI
- jetty uses the same framework for extensions that pages use in an app

And the destination: **one `.mesa` file should be able to be a component, a static
page, or any other UI/visual need** — a unified interface, eventually reaching
desktop and mobile the way Quasar does.

## The finding, in one line

The instinct is right and mostly holds. But three concepts **repeat in name and
diverge in implementation**, which is worse than not repeating at all — the user
learns the concept once and then gets silently different behavior. Those are the
improvement areas.

---

## 1. Three frontmatter parsers — the clearest leak

"A markdown file with a `---` block" is the most-repeated concept in FJS. It has
three independent implementations with different capabilities:

| Where                                       | Implementation             | Handles                                                              |
| ------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `packages/mesa/compiler-md.js`              | hand-rolled "YAML-ish"     | strings, numbers, booleans, null, inline arrays, multi-line arrays    |
| `packages/sierra/src/scanner/parse-frontmatter.js` | real `js-yaml`       | full YAML; malformed input silently treated as *no frontmatter*        |
| `packages/cli/core/compiler.js`             | a second hand-rolled parser | its own `parseYaml` + `coerceYamlValue` coercion rules                |

A nested object works in a Sierra route, fails in an `fli` command, and fails
*differently* in a Mesa `.md`. The mental model says "frontmatter is frontmatter";
the framework quietly disagrees three ways. Sierra's silent-fallback-on-malformed
is its own trap — a typo'd route frontmatter becomes an untitled, unconfigured
page rather than an error.

**Constraint on the fix:** Mesa is a true leaf with zero workspace deps and must
stay that way. So the answer is a tiny zero-dependency leaf package that Mesa,
Sierra, and the CLI all depend on — *not* "move it into Mesa" and not "import
Sierra's."

## 2. `ctx` names two unrelated things

`ARCHITECT.md` §2 makes **Context** mandatory vocabulary for the request object.
But `packages/mesa/compiler.js:437` uses `ctx` for *compile state* —
`{ setters, accessors, script, proxyFireFns }` — in the package a newcomer is
most likely to read first. Same word, unrelated concept.

Rename the compiler's to something like `compileState`. Trivial change, removes a
collision in the one vocabulary the project declares mandatory.

## 3. Context does not actually repeat — it is four shapes

The stated model is "Context is an object used in every Realm." The code has four
unrelated shapes:

- **Junction** — `{ service, method, id, query, directives, data, auth, client,
  route, locals, app, result, error }` (`packages/junction/src/core/context.ts`)
- **fli** — `{ flags, args, flag, arg, log, answers, echo }`
  (`packages/cli/core/compiler.js:64`)
- **Caravan** — `{ app }` on a job's `perform`
- **Litestone** — no exposed Context concept at all

`ARCHITECT.md` §5 / `CLAUDE.md` already flag this as unsettled, with Junction's
split (`auth` / `client` / `route` / `locals`, plus `query` / `directives`) as the
candidate standard. **Ruling it would collapse four mental models into one.** The
other realms don't need the full shape — they need a conforming subset, so that
`ctx.auth.user` means the same thing wherever a user meets it.

The same pattern appears in extension mechanisms: Junction has **Hooks**,
Litestone has **Plugins**, Sierra has **Vite plugins**. Three names, three shapes,
one idea.

## 4. jetty proves the concept and forks the code

"The same framework for extensions and for pages" is exactly right as a mental
model. The implementation forked: jetty's `src/resources/` is a hand-copy of
Sierra's and has already diverged (`createStore` signature), and the mesa-vite HMR
algorithm exists in three places.

That fork is **structural, not accidental** — see item 6.

---

## 5. The extension-point catalogue — the evidence

Every way to extend an FJS app, probed 2026-08-02. Signatures taken from the real
type declarations; the bodies are illustrative.

### Data realm — three ways

**5a. Schema declaration.** No code, and the most powerful one:

```lite
model Lead {
  id    Int    @id
  email String @email @unique @lower
  @@gate("0.4.4.5")                    // read/create/update/delete levels
  @@allow('read', userId == auth().id) // row policy → compiled into SQL
  @@log(audit)
}
```

**5b. Litestone Plugin — a class you extend** (`packages/litestone/src/core/plugin.js`):

```js
import { Plugin, AccessDeniedError } from '@frontierjs/litestone'

class TenantScope extends Plugin {
  onInit(schema, ctx) { this.models = Object.keys(schema.models) }

  async onBeforeCreate(model, args, ctx) {
    if (!ctx.user?.tenantId) throw new AccessDeniedError('no tenant', { model })
    args.data.tenantId = ctx.user.tenantId
  }

  buildReadFilter(model, ctx) {          // AND-merged into every query's WHERE
    return ctx.user ? { tenantId: ctx.user.tenantId } : null
  }
}

const db = await createClient({ schema, plugins: [new TenantScope()] })
```

Surface: `onInit`, `onBeforeRead/Create/Update/Delete`, `onAfterRead/Write/Delete`,
`buildReadFilter`.

**5c. Row events.**
`await createClient({ schema, onEvent: { create: [fn], change: [fn] } })`

### API realm — four ways

**5d. Junction Plugin — an object literal with lifecycle:**

```ts
export function audit(opts): Plugin {
  const instance = createAuditor(opts)
  return {
    name: 'audit',
    register(app) { app.provide('audit', instance) },   // sync, at configure()
    async boot(app)     { await instance.init() },      // async, at start()
    ready(app)          {},                             // after listening
    async shutdown(app) { await instance.close() },     // at stop()
  }
}
app.configure(audit({ … }))
app.configure(app => app.get('/ping', ctx => ctx.json('ok')))  // bare fn also valid
```

**5e. Service + hooks — four phases** (`packages/junction/src/core/hooks.ts`):

```ts
app.services.register(createService({
  name: 'leads', model: 'lead', channel: 'leads',
  hooks: {
    around: { all:    [async (ctx, next) => { const t = Date.now(); await next() }] },
    before: { create: [ctx => { ctx.data.source ??= 'web' }] },
    after:  { create: [live] },
    error:  { all:    [ctx => { if (recoverable(ctx.error)) ctx.error = null }] },
  },
  async getStats(ctx) { … },        // custom method, dispatched via X-Service-Method
}))
```

**5f. App-wide hooks.** `app.hooks({ before: { all: [logAll] } })`

**5g. Provider — implement a contract.**
`const auth: IAuth = { verifySession, login, logout, createUser, … }` →
`createApp({ db, auth })`

### UI realm — three ways

**5h. Resource + hooks** (`packages/sierra/src/junction/resource.js`):

```js
const leads = createResource('leads', schema, {
  hooks: {
    around: { all:    [async (ctx, next) => { loading.value = true; await next(); loading.value = false }] },
    before: { create: [ctx => { ctx.data.draft = false }] },
    after:  { find:   [ctx => { ctx.result.data.forEach(fmt) }] },
    error:  { all:    [ctx => { toast(ctx.error.message) }] },
  },
})
```

**5i. Mesa component** — a file. **5j. Build plugin** — a Vite plugin.

### Boundary packages — five more shapes

```ts
// 5k. Conduit target — a plain data object
app.conduit.register({ id: 'provider:hetzner', kind: 'provider', protocol: 'http',
                       address: 'https://api.hetzner.com', auth: { ref: 'HETZNER_KEY' } })

// 5l. Conduit transport — extend an abstract class
class GrpcTransport extends BaseTransport {
  readonly protocol = 'grpc'
  async send(req)     { … }
  async *stream(req)  { … }
}

// 5m. Caravan job
export const sendInvoice = defineJob('send-invoice',
  async job => { … }, { queue: 'mail', maxAttempts: 5, retryDelays: [60_000, 300_000] })

// 5n. Notifications driver — object with one method
const slack = { send(user, message, app) { … } }

// 5o. Notification — extend an abstract class
class PaymentReceived extends Notification {
  via(user)     { return ['inApp', 'email'] }
  toInApp(user) { return { … } }
}
```

**5p. fli command** — a markdown file with frontmatter.

### Consistency verdict — five idioms across sixteen extension points

| Idiom                     | Used by                                                  | Consistent?                        |
| ------------------------- | -------------------------------------------------------- | ---------------------------------- |
| 4-phase hooks + Context   | Junction service, Sierra resource                        | **Yes — exactly aligned, on purpose** |
| Object + named lifecycle  | Junction Plugin, notifications driver, conduit target    | Mostly                             |
| Class you extend          | **Litestone Plugin**, `BaseTransport`, `Notification`    | Arbitrary split from the above     |
| Schema declaration        | `@@gate`, `@@allow`, `@@log`                             | Yes — unique to Data, correctly    |
| File in a location        | Mesa component, fli command, Sierra route, Caravan job   | Yes                                |

**The win.** API hooks and UI hooks are the same concept with the same four phase
names and a mirrored Context — `packages/sierra/src/junction/resource.js:9`
documents it as *"Hook phases — match the API realm exactly."* Learn one, you know
the other. This is the mental model actually working, and it is the template for
everything else on this list.

**The break — "Plugin" names two incompatible things:**

|          | Litestone Plugin           | Junction Plugin       |
| -------- | -------------------------- | --------------------- |
| Shape    | class you `extend`         | object literal        |
| Identity | **no `name` field at all** | `name` required       |
| Methods  | 8 × `onBefore*`/`onAfter*` | 4 lifecycle methods   |
| Concept  | intercepts **queries**     | attaches **capability** |

Someone who learns `app.configure(plugin)` and then writes a Litestone plugin is
actively misled. The missing `name` is functional, not cosmetic: Litestone plugins
cannot be introspected, ordered, or reported in `/metrics`.

Litestone's is really a **Hook** in Junction's vocabulary — it intercepts
operations in a pipeline around a Context. Junction's is a **Plugin**. `ARCHITECT.md`
§2 already reserves **Provider** ("a Plugin adds; a Provider replaces"), which
cleanly covers `IAuth`, conduit transports, and notification drivers.

**Proposed four concepts, covering all sixteen points:**

- **Declaration** — schema annotations (Data only)
- **Hook** — 4-phase pipeline over a Context (Junction ✅, Sierra ✅, **Litestone should join**)
- **Plugin** — named object with lifecycle, attaches capability (Junction ✅; Litestone's should be renamed)
- **Provider** — implements a contract; classes are appropriate here
- plus **convention files** for routes, commands, components, jobs

**Highest-value single change: give Litestone's plugin a `name`, and rename the
concept.** It is the one place where a repeated word teaches the wrong thing, and
the fix is mostly naming over machinery.

### 5q. Plugin-protocol findings (Junction + Conduit review, 2026-08-02)

From reading `packages/junction/src/core/app.ts` and all 167 lines of
`packages/conduit/src/plugin.ts`. Both are above the median for production
frameworks — comments explain *why*, not *what*. Specific issues:

- **`register` invites async and is not awaited.** Signature is
  `(app) => void | Promise<void>`, but `configure()` deliberately does not await —
  it catches the rejection and defers the throw to `start()`. So an async
  `register`'s *side effects* may not have landed before the next `configure()` or
  before `start()` reads state. Fix is the type, not machinery: narrow `register`
  to return `void`, force async into `boot`.
- **No ordering or dependency mechanism.** No `depends`/`after`/`priority` exists;
  order is just `configure()` call order. This need has now surfaced three times —
  here, in `IDEAS/slices.md` as `after:`, and as a comment in
  `packages/notifications/examples/wiring.ts` that nothing enforces. It belongs in
  the `Plugin` interface as `requires?: string[]`, checked at boot against
  `app._plugins`.
- **Phase numbering is fiction.** Phases 0, 0a, 0b, 0c, 1, 3, 4, 4.5, 4.6, 5, 6, 7 —
  across *two* sequences, since `_startForTest()` "mirrors phases 1, 4.5, 4.6". A
  test path reimplementing a subset of production ordering is a drift generator.
  Name the phases; share one ordered list with a `bindPort` flag.
- **Conduit's plugin object is single-use and its type does not say so.**
  `conduit(opts)` closes over one `instance`; configuring it on two apps
  half-works (acknowledged in a comment). Since `register` is guaranteed
  synchronous, instance creation could move *into* `register` and make reuse
  actually correct.
- **`app.provide()` already exists** — `app.ts:659`, throws on collision, and
  Caravan already uses it (`packages/caravan/src/index.ts:285`). Conduit's raw
  `app.conduit = instance` is the outlier and should adopt it.
- **Stale landmine:** `CLAUDE.md` says junction and conduit declare `app.conduit`
  with conflicting types. They no longer do — conduit augments the empty
  `AppConduit` interface rather than redeclaring `App.conduit`, which is exactly
  the correct fix, documented at the point of risk in `plugin.ts`.

---

## The good news: Mesa's multi-target vision is largely built

`packages/mesa/render-component.js` opens with *"Unified pipeline: Mesa source →
HTML / email / fragment / JS"* and already handles recursive import resolution,
CSS collection across the component tree, CSS inlining for email/fragment targets,
UnoCSS scanning, email subject extraction, and plain-text fallback generation.
Alongside it: `render.js` (SSR / static via happy-dom), `runtime.js` (client
mount), `compiler-md.js` (markdown source), `css-inliner.js` (email).

So a single `.mesa` or `.md` file **already** becomes a component, a static page,
an email, an isolated fragment, or a JS module map.

The capability exists. It is not named, exposed, or documented as one thing. Giving
that target set a public name and API is mostly labeling work over code that
already runs — and it is the load-bearing claim for the entire unified-interface
vision. This is the highest ratio of vision-value to effort in the repo.

### The target set's missing member: adopting DOM that already exists

**Added 2026-08-05.** Every target above *produces* markup. None of them *adopts*
it. There is no hydration in Mesa at all — `render.js:113` says so in a comment,
`runtime.js:4411` carries a `pop()` no-op reserved for the day there is, and Sierra's
islands **replace** the prerendered range rather than adopting it
(`mesa/docs/SSR_SPEC.md`, `sierra/src/build/island-bundle.js`). That is the right v1
and it is why a static page's interactive parts visibly re-render on mount.

It is worth writing down what the substrate would already support, because it is
unusually strong and it is not a plan:

- The compiler emits a template clone plus an explicit `child()` / `sibling()` walk
  to each node it will ever touch (`runtime.js:4409-4410`). So for every component
  there is already a compile-time path from the template root to each **reactive
  edge** — a text run, an attribute, a block anchor — and everything not on that
  list is provably inert for the life of the page.
- That is the input node-granular adoption needs. Not "hydrate this component", but
  "attach these seven bindings to these seven nodes and ship no code for the rest of
  the subtree". Stronger than Astro's component-boundary islands and needing no
  replay, unlike Qwik's resumability, because the live set is known at compile time
  rather than reconstructed at runtime.

**And it is still not near-term work.** It is not "islands taken further" — it is
hydration, which does not exist, plus a narrowing of it. Sequence is: adopt at all
→ adopt per component → adopt per edge, and only the first is on any list. The
payoff is also mis-weighted against this repo's balance (`IDEAS/overview.md`
§ Where the balance currently sits): it buys render performance, where the
framework's `only` column is authorization-from-the-seed. An island chunk is already
component-sized, and the `static` target already ships mostly-inert HTML, so the
delta is smaller than the idea sounds.

Recorded here rather than as a wave item so that whoever *does* build hydration
knows the per-edge form is available for the asking, and does not design a
component-granular protocol that forecloses it.

---

## 6. The Quasar reframe: one target axis

Quasar's real lesson is not multi-target rendering. It is **one source plus build
*modes*** — spa / ssr / pwa / electron / capacitor / bex — selected at build time
against one component API.

FJS already has the component API (Mesa) and the router (Sierra), and Sierra
already has a target axis: `static` (implemented 2026-08-02) and `widget`
(advertised, no build loop).

**Therefore: jetty should be a Sierra target, not a package.** It is literally
FJS's `bex` mode — Mesa UI plus a service-worker relay to Junction — built as a
separate package instead of as a mode. That is *why* its resources layer is a
hand-copy: a separate package has no way to share the target-independent parts.

Fold it into the target axis and the list becomes: `spa`, `static`, `widget`,
`extension`, and later `desktop`, `mobile`. Each new platform is then an entry on
an existing list rather than a new package with a new hand-copy — which is exactly
the small-mental-model outcome the project wants.

**"and later" is doing too much work in that sentence, and it was noticed 2026-08-15
comparing against an outside framework that makes Desktop a headline feature.**
`desktop` and `mobile` appear in this repository in exactly two places: the clause
above, and the trailing half of the overview row that summarises it. There is no
record, no effort reading, and no stated refusal — which is the worst of the three
available states, because a reader cannot tell whether it is planned, deferred or
declined, and neither can we.

The two are not one item. **Desktop is nearly free and mobile is not.** A desktop
target is the `spa` build inside a shell process (Electron, or Tauri, or Bun's own
single-binary path serving `dist/` to a system webview), and the framework's own
shape helps rather than fights: the database is a file, the API is a process, and
`IDEAS/offline-first-and-release.md` already names *single binary* as an artifact
kind — a desktop app is that artifact with a window in front of it, which is why it
belongs to the Release realm as much as to Sierra. Mobile is a different problem
wearing the same word: a store review process, two signing identities, push
credentials (`IDEAS/ecosystem-gaps.md` 16), a webview whose storage the OS may
evict, and background execution rules that make the offline-first design (4.8) a
prerequisite rather than a companion.

So the honest position is probably: **`desktop` becomes a named entry on the target
axis once jetty is folded in — because by then the only new work is the shell — and
`mobile` is refused until offline-first exists**, stated as a refusal with that
trigger rather than left as an "and later". Whichever way it goes, the outcome
belongs in `DECISIONS.md`; an unwritten maybe is the thing to remove.

---

## Ranked improvements

1. **Give Litestone's Plugin a `name`, and rename the concept** (§5). The one place
   a repeated word teaches the wrong thing; the missing identity also blocks
   introspection, ordering, and `/metrics`. Mostly naming over machinery.
2. **One frontmatter parser.** Zero-dep leaf package, three call sites. Smallest
   change, and it is the concept users touch most often.
3. **Rule the Context shape.** Adopt Junction's split as the base; give fli,
   Caravan, and Litestone conforming subsets. Needs a `DECISIONS.md` entry more
   than it needs code. Note that Sierra's resource Context *already* conforms
   deliberately — it is the proof the ruling is workable, not a new idea.
4. **`Plugin.requires?: string[]`** (§5q) — resolves the undeclared-ordering
   problem in all three places it has surfaced, including `IDEAS/slices.md`'s
   `after:`.
5. **Name Mesa's target set publicly.** Documentation and a public API over code
   that already works. Highest vision-value per unit of effort.
6. **One target axis in Sierra; jetty becomes `extension`.** The structural move —
   it de-forks the hand-copies and makes desktop/mobile cheap later.
7. **Rename Mesa's compiler `ctx`.** Trivial; removes a mandatory-vocabulary
   collision.
8. **Settle the four extension concepts** — Declaration / Hook / Plugin / Provider
   (§5), plus convention files. Decide which distinctions are real (see
   `ARCHITECT.md` §2 "under review": Hook / Guard / Observer / Delegate, and
   Provider). Items 1 and 4 are the first two moves of this.
9. **Narrow Junction's `register` to `() => void`; name the start phases** (§5q).

---

## Interaction with the other ideas

Item 4 changes what a Slice's `resource/` part means: a slice would contribute to
a **target**, not to "the UI" generically — a slice could ship an `extension`
surface and a `spa` surface from one component set. That should be settled before
`IDEAS/slices.md` specifies `resource/`.

Item 3 is also the natural vehicle for `IDEAS/framework-shape.md` item 1
(schema → UI): a schema-derived form is just another Mesa target consumer, and
building it as one keeps it target-independent — which is what
`IDEAS/offline-first-and-release.md` requires anyway.

## See also

- `ARCHITECT.md` §2 (mandatory vocabulary, and the "under review" list) and §5
- `IDEAS/framework-shape.md` — schema → UI is the missing derivation
- `IDEAS/offline-first-and-release.md` — targets and artifacts are the same axis
- `IDEAS/slices.md` — what a slice's `resource/` part contributes to
