---
id: pros-and-cons
status: assessment
dated: 2026-08-03
---

# FrontierJS — Pros and Cons

**Written 2026-08-03; struck items are dated where they stopped being true.** A design-level assessment of FJS as a *developer would experience it*,
not an engineering audit. Two lists: the design decisions that are worth keeping, and the ones
a developer will squint at. Both are about **shipped, fleshed-out decisions** — not gaps, not
bugs, not things still unbuilt (those live in `IDEAS/` and `HANDOFF.md`).

The framing throughout is "what does someone building an app on this actually see and feel."

---

## The 10 design decisions that make FJS worth building

### 1. The schema reaches the browser

This is the whole framework. Every other stack stops the schema at the server — Prisma ends at
the ORM, tRPC ships types but not *rules*, Rails ends at the model. In FJS the constraint table
itself travels: the browser knows `plan` is an enum with three members, that `accountId` is a
reference to `Account` and not just an integer, that `email` has a format, that `bio` is nullable.

So `createResource('posts')` hands you `.fields`, `.relations`, `.gate`, `.validate()`, `.make()`.
A form can build itself, validate itself, and render a picker instead of a number spinner — from
the same file that made the table. Nobody else does this, and everything below is downstream of it.

### 2. Authorization is a number in the model, not code in a middleware

`@@gate("0.4.4.5")` — public read, USER create, USER update, ADMIN delete. A developer reads a
model and knows who can do what, and they *cannot forget to add the check*, because there is
nowhere to forget it.

The deeper move: authz becomes **data**. It is inspectable, diffable in a PR, renderable as a
matrix, and shippable to the client as an affordance layer. Middleware-based authz can never be
any of those things.

### 3. Visibility is declared on the column, per viewer

`@guarded` for "this column never leaves," `@scoped` for "this row set belongs to the caller,"
`@edge` for per-viewer data like *did I like this post*.

The developer never writes a serializer, never writes `delete user.password`, never hand-threads
`WHERE accountId = ?` through forty queries. Multi-tenancy and per-viewer state stop being
architecture and become two keywords. This is the feature most likely to make someone switch.

### 4. A service is a file, not a route table

Drop `posts.service.ts` in `api/src/services/` and you have REST, WebSocket, a channel,
pagination, filtering, and bulk writes — over both transports, with no route registration and no
duplicated logic per protocol. The transport is a detail the developer does not repeat themselves
across.

### 5. Hooks are the *only* extension point

`before` / `after` / `around` / `error`, on every method, mergeable at app level and service level.

Compare to what a Nest or Spring developer holds in their head — middleware *and* guards *and*
interceptors *and* pipes *and* filters *and* decorators, each with its own ordering rules. Here
there is one concept with one ordering rule, and caching, auth, validation, logging, and
multi-tenancy are all the same shape. That is a real reduction in what you have to learn.

### 6. Rendering strategy is per-route; interactivity is per-component

A route declares `render: static | spa`, in the route file, not in a global config — so a marketing
page and a dashboard live in one app without a second project. Then `client:visible` /
`client:media` decides what actually ships, code-split one chunk per island, fetched only when the
directive fires.

The default is a fast page; interactivity is something you ask for by name. Astro proved developers
want this; Astro does not have a real API layer or a schema behind it.

### 7. Reactivity is compiled, not runtime

`let n = 0` and `n++` updates the DOM. No hooks rules, no dependency arrays, no `useMemo`, no VDOM
diff, no re-render mental model. The compiler knows what is reactive because it read your code.

This is the single biggest reduction in *incidental* difficulty in the whole stack — most React
expertise is expertise in React's runtime, not in the app.

### 8. Styling is a vocabulary, not utilities

`<button class="btn danger outlined">` — a tone and a treatment. You name what a thing *is*; the
design system decides what that looks like, and theming / dark mode / a11y are properties of the
system rather than of every component.

The alternative — 40 characters of `bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded` on
every button — means your design system exists only in your muscle memory. A vocabulary of a few dozen
terms is something a team can actually hold.

### 9. Batteries are namespaced plugins, and the outbound edge is declared

`app.jobs`, `app.notify`, `app.mail`, `app.cache`, `app.conduit` — queue, cron, notifications,
email, cache, HTTP client, all from one plugin list. Laravel-shaped completeness, which is the
actual reason people pick Laravel.

The distinctive one is **conduit**: every outbound call is a *declared target*, so "what does this
app talk to, and what happens when it is down" is answerable by reading a config instead of
grepping for `fetch`. That is a question every production app has and no framework answers.

### 10. CLI commands are markdown files

A command's frontmatter *is* its arg and flag spec; its body is the docs; a fenced block is the
implementation. So the help text cannot drift from the behavior, and extending the CLI is writing
a document. Same instinct as the schema — one artifact, read by both a human and the machine.

---

## Where the vision actually is

### Slices are the payoff, and everything above is the setup

Because all three realms derive from one seed, a slice can be a *schema fragment* + services +
resources + routes + jobs, and installing it **merges into your schema** — your migration, your
gates, your generated forms. `authSchemaFragments()` already proves the mechanism works: auth
contributes models *into* your data model rather than living beside it.

Nobody can do this. Rails engines cannot safely touch your schema. npm packages cannot ship data +
API + UI as one unit. If `fli slice:install billing` gives you Stripe models in your schema,
webhook handlers, a customer portal route, and dunning jobs — all gated, all validated, all in your
migration history — that is a category nobody occupies. **This is the thing to build next.**

### Offline-first falls out of decision #1 almost for free

The client already has the constraint table and the validator. That means it can accept a write,
validate it locally against the real rules, queue it, and reconcile — without a hand-written
duplicate of your server logic, which is why offline is hard everywhere else. Most stacks would
need to invent the schema-in-the-browser first. FJS already did it for forms.

### The app is knowable, so show it

One seed means FJS can render your *entire application* as an artifact: models → services → routes
→ channels → jobs → outbound targets, plus the permission matrix, plus what drifted. Not a
dependency graph — a map of the system with authorization on it. That is a thing you fundamentally
cannot build on Next.js, and it is the demo that makes people understand why the schema-first bet
was worth it.

**The through-line:** the schema is the program. The features that make FJS great are the ones that
take that literally — and the ones that will make it *great* are the ones that let a schema be
**installed**, **carried offline**, and **seen whole**.

---

## The 10 a developer will squint at

### 1. SQLite-only, and not behind a driver interface

`bun:sqlite` is a hardcoded import at the top of the client, not a pluggable adapter. Every
evaluation ends at the same sentence: "we're on Postgres."

It cascades into decisions that then look strange on their own — multi-tenancy is db-per-tenant
*because* it's SQLite, `DateTime` is ISO-8601 TEXT *because* it's SQLite, `STRICT` tables
everywhere. The bet may be defensible (one file, no ops, embedded, fast) but it is currently
indistinguishable from "we never got to the second driver," because there is no seam where a
second one would go. **If SQLite-first is the actual thesis, the client needs a driver boundary
anyway so the thesis reads as a choice.**

### 2. `@@gate("2.4.4.5")` — positional magic numbers on a linear ladder

> *Partly answered 2026-08-26.* Named levels are canonical (`FJS-D43`), and the second
> vocabulary exists: `@@capabilities` is a grid beside the ladder, ANDed with the gate
> (`FJS-D146`). The ladder stays the floor.

Two separate problems stacked.

*The syntax:* a dev has to memorize that the positions are read·create·update·delete and that each
defaults forward from the previous. Nothing in `"2.4.4.5"` says so. `@@gate(read: 2, create: 4,
delete: 5)` costs nothing and reads itself.

*The model:* authorization is a **single ordered 0–9 scale**. Real apps are not ordered. "Billing
admin" and "content moderator" are not comparable, and neither is ≥ the other. The moment someone
needs two orthogonal permissions they are back to writing hooks — and the framework's best feature
evaporates exactly when the app gets interesting. A linear ladder is a great *default*; it should
not be the only vocabulary.

### 3. Custom methods dispatch via an `X-Service-Method` header

`POST /posts/42` + `X-Service-Method: publish`. The obvious question: why isn't that
`POST /posts/42/publish`?

The header form is not curl-able from memory, is not linkable, does not show up in access logs or
an API gateway's route rules, cannot be permissioned by path at a proxy, and adds a preflight. It
is decided in `DECISIONS.md`, so it is not an accident — but it is the most "why on earth" thing a
dev meets in the first hour, and the payoff (uniform routing) is invisible to them.

### 4. Every noun has three spellings, and the framework *guesses* between them

`model Post` → `db.post` → service `posts` → `createResource('posts')` → back to `Post`. Four
casings for one concept, bridged by English pluralization rules — consonant+y→ies, sibilant→es.
Irregulars are a manual override: `createResource('people', { model: 'Person' })`.

Worse, a miss is a **console warning**, and the resource silently degrades to a bare `make()`. So
the failure mode for a naming mismatch is "the form quietly has no field rules," discovered a week
later. Something this load-bearing should not be inferred from morphology in any language, let
alone English.

### 5. ~~Derivation is opt-in, and the defaults produce broken behavior~~ — closed

> *Closed.* `coerce`, `blankToNull` and `validate` are on by default; `{ validate: false }`
> is the opt-out (`CLAUDE.md` § Live hazards, UI).

`coerce`, `blankToNull`, and `validate` all default to **off**. So the out-of-the-box experience is:
bind a form to `make()`, type 42 in a number field, send `"42"`, get rejected — and the fix is a
flag you had to know existed.

The functions themselves are carefully conservative (`''` is never coerced, only nullable fields
get nulled), which means they are *safe enough to be on*. Shipping the correct behavior behind
three booleans means the framework's headline feature only works for developers who already read
the source.

### 6. ~~The schema reaches the browser — and then stops one step short of the payoff~~ — closed

> *Closed.* `<Form {resource} />` with no children generates every writable control from
> the field rules, and a contributed control is two registrations (`FJS-D17`). Invariant 18
> makes a Resource file carry its model's default form.

The one that will frustrate people most, because pro #1 sets an expectation this does not meet.

The browser knows `plan` is an enum with three members, that `accountId` references `Account`, that
`email` has a format, that `bio` is nullable. And what you get is `make()` — a blank object. You
still hand-write every `<input>`, every `<select>`, every error message. There is no
`<AutoForm resource={posts}>`, no generated admin, no field component that reads `fields.plan` and
renders the right control. `sierra/src/components/` has two files in it and neither is this.

The hard part is done and the visible part is not, so a dev experiences "I shipped a schema to the
client and got a validator I have to call myself."

### 7. `.mesa` — a new language, a new extension, and syntax-only tooling

Asking a team to adopt a novel component syntax is the largest single cost in the stack, and it is
paid on day one before any benefit lands. Right now the return is "Svelte, but you have never heard
of it": no autocomplete, no go-to-definition, no type-checking inside a component, no Stack
Overflow, no component ecosystem, no AI assistant that knows the syntax.

The compiled-reactivity win is real, but it is a win over React's runtime — not over Svelte or
Solid, which have the same win *and* an ecosystem. A dev will ask what `.mesa` buys over `.svelte`,
and the answer needs to be better than "it's ours."

### 8. There are two reactivity models and you have to know which object you are holding

Plain `let` becomes a compiled signal. Resources come back through `watchProxy`. And mutation
through a member expression — `bind:value={draft[key]}` — *writes* but does not *notify*, so a
`{draft.name}` preview next to the input stays stale while you type.

That is pinned as intended behavior (RULE 43), and it is a reasonable compiler-level position. It
is not a reasonable thing to explain to someone binding a form to an object, which is the most
ordinary thing anyone does. "Reactivity is shallow, except when it isn't, and `bind:` is on the
wrong side of the line" is a rule people hit on day two and never fully trust again.

### 9. The project layout is 18 directories before you write a line — and it fights your tools

Three realms × six folders (`config/ src/ public/ test/ dist/ deploy/`) is a lot of ceremony for
`fli project:new`. And putting `vite.config.js` inside `config/` means every tool that looks for it
in the conventional place — Vite's own CLI, editor plugins, half the docs on the internet — needs a
flag.

Enforcing symmetry across realms is a defensible idea; making it override an ecosystem-wide
convention buys consistency at the cost of everything working by default. A dev's first "ehh"
should not be about where a config file lives.

### 10. The wire shape carries Feathers heritage that no longer earns its keep

Two related ones.

`?$limit=10&status=active` — a dev has to internalize which params get a sigil and which do not,
and `$` needs escaping in half the shells they will type it into.

The envelope asymmetry: `find()` returns `{kind, data:[...], total}` while `get()` returns the bare
record. The reasoning is right — a list has metadata, a single does not — but the cost lands on the
developer: you cannot write one function that handles "a result," and every generic helper needs a
kind check.

Both are **inherited** shapes, not chosen ones, and inherited constraints are the ones worth
re-opening while nothing depends on them.

---

### Honorable mentions (real, but quieter)

- **`/auth/*` bypasses the Service abstraction.** Defensible — login cannot be gated by login — but
  it is the first place a dev looks for the pattern and does not find it.
- **Two validator implementations by design.** "Compared, not copied" is a great engineering answer
  to a question the developer did not ask.
- **The markdown CLI trades types and autocomplete for self-documenting commands.** A fine trade at
  186 commands, a worsening one at 400.

---

## If only two things get fixed

1. ~~**Con #6 — ship the form generator.**~~ Done — see con 6.
2. **Con #2's ladder — give authorization a second vocabulary.** A linear scale is the constraint
   most likely to make someone abandon the framework's best idea mid-project.
