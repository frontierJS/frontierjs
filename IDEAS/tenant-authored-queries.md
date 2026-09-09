---
id: tenant-authored-queries
status: proposed
dated: 2026-09-08
---

# Idea — When the tenant writes the query: reports, transforms, and the view

**Status: IDEA. Nothing here is built.** Dated 2026-09-08. Every number below was
read off a real application's database or produced by running the probe named
beside it, on Bun 1.3.11; nothing is quoted from a document. Do not cite this
file as behavior — see `VERIFYING.md`.

---

## Trigger

`conversion-maid-tech.md` — a seven-year-old Feathers + Prisma application being
read for what would make it hard to bring onto FrontierJS. Most of its blockers
turned out to have an owner here already. This one does not, and it is the only
place in that audit where the honest answer was *FJS has nothing, and neither
does anyone else*.

The application lets an operator define a report. What gets stored is not a
parameter — it is **three separate pieces of executable material in three
columns of one row**:

| Column | Holds | Rows using it |
| --- | --- | --- |
| `sql` | hand-written SQL, executed against the unscoped client | 62 of 72 |
| `prisma` | a query object — `{ model, query, groupBy }` — spread into `db[model].findMany(...)` | 22 of 72 |
| `meta.transformer` | a JavaScript function body, run in `node:vm` over each row | 13 of 72 |
| `view` | the name of a component, compiled by a Vite-in-the-request-path service | all 72 |

That is four axes, not one feature, and they fail differently. Reading them as
one thing is what let the shape survive: the SQL half looks like a reporting
tool, the transformer half looks like a formatting convenience, and nobody
priced them together.

---

## The measurement that decides the transformer axis

The transformer runs through `vm.createContext` + `vm.runInContext` with a
`timeout`. That pattern is widely believed to be a sandbox. It is not one, on
Node or on Bun, and the belief is what makes it dangerous rather than merely
weak.

Probed directly on Bun 1.3.11, from inside a context created exactly the way the
application creates it:

```js
const ctx = vm.createContext({ data: { a: 1 } })
const F = 'this.constructor.constructor'          // Function, via the context's own Object
vm.runInContext(`${F}("return Object.keys(process.env).length")()`, ctx)  // → 89
vm.runInContext(`${F}("return process.cwd()")()`, ctx)                    // → the process's cwd
vm.runInContext(`${F}("return typeof Bun")()`, ctx)                       // → "object"
```

**The context reaches `process.env`, the working directory, and the `Bun`
global** — which is `Bun.file` for any path the process can read and `Bun.spawn`
for anything it can run. The escape is one expression long and needs no import.

The `timeout` option is real for synchronous work — `while(true){}` under
`{ timeout: 100 }` threw `Script execution timed out after 100ms` — and **is not
applied to asynchronous work**: returning a Promise from the constructed
function leaves it running with the timeout already satisfied.

> **Security, stated plainly and outside this file's proposal:** in the audited
> application this is a live path from a stored database row to arbitrary code
> running with the API process's credentials — its database URL, its JWT signing
> secret, its mail and payment provider keys. It is reachable by anyone who can
> write a `reports` row. This is true of the application as it runs today and is
> not created by any migration. It wants triage on its own timetable, separate
> from anything argued here.

**What that measurement settles:** the question is not *which sandbox*. Bun
offers no isolate API, no `sqlite3_set_authorizer` equivalent for JavaScript, and
no permission model on `Worker` — a Worker has the same filesystem and network
reach the main thread does. The only mechanisms that would actually bound this
are a separate process under OS-level limits, or not running caller-authored
JavaScript at all. The first is a battery with tendrils; the second is a
language question, and this framework has already answered language questions
this way twice.

---

## Two of the four axes already have an owner here

**The query object.** `example/api/src/domain/shop/custom-fields.ts` is the
precedent and its header states the argument: `compileSegment` rewrites stored
terms into an ordinary litestone `where`, which keeps the model's `@@gate`, both
row policies and `@@softDelete` **for free**, because the read goes through the
caller's own accessor. A stored `where` compiled that way is a different object
from a stored `where` spread into a client call: the second names its own model
and reaches the unscoped client, which is how `db[model].findMany(query)` comes
to answer across every tenant. `aggregate` and `groupBy` take plain arguments on
the same accessor, so a projection built from an allowlist inherits the same
rules with nothing new built.

**The raw SQL.** Already ruled. Raw SQL is `asSystem()`-only on any schema that
declares access rules (`FJS-005`, `DECISIONS.md` § Access control), and
`scoped-sql.md` records why the scoped-view design stayed unbuilt — the
statement allowlist has no sound mechanism, because `bun:sqlite` exposes no
`sqlite3_set_authorizer` and a hand-written SQL validator's failure mode is a
*false* guarantee. In the audited app all 62 SQL reports are cross-account
administrative reads that want `asSystem()` anyway. Nothing here argues for
reopening that ruling; it argues that this application is evidence **for** it.

**The view.** `renderComponent` / `renderFile` with `target: 'email' |
'fragment' | 'js'` already does what the application's Vite-in-the-request-path
compiler service does, in one call. It carries the same trust question as the
transformer and for the same reason — a compiled component is JavaScript that
runs — so it is the same decision, not a second one.

---

## What is actually missing

One thing, and it is a language rather than a runtime:

**A declared expression an operator may author, that is evaluated and never
executed.** The transformer column is doing four jobs in the rows that use it —
deriving a column from two others, formatting a number, filtering a group, and
naming a series. All four are expressions. None of them needs a statement, a
loop, a closure or an import.

**Litestone already has this language and it already has two compilers.** The
policy expression parser, `compileSql` for the SQL side and `evalJs` for the JS
side, held together by a real oracle in `test/policy-interpreters.test.ts` — the
same predicate over the same rows, asked of both. `declared-field-state.md`
already proposes moving `evalJs` into `@frontierjs/toolbelt` so a third reader
can have it, and names the risk in the same breath: **a third compilation with
no oracle is how `@@allow`'s two halves drifted before (`FJS-195`)**. A
report transform would be that third reader, and it arrives with the same
obligation.

That convergence is the interesting part of this record. Two proposals arrived
at *the expression language wants a third consumer* from opposite directions —
one from a form that greys out a field, one from an operator computing a column
in a report — and neither is a good enough reason on its own to pay for a third
reader. Together they may be.

---

## What a build would have to answer

1. **Is a report a `view` an operator composes, or a row an operator writes?**
   A `view` is declared, gated, and diffed by `fli check`; a row is editable at
   runtime and reviewed by nobody. The audited app's 72 rows split cleanly — the
   `@system/*` ones are a fixed catalog wearing a table's clothes.
2. **Does the expression language get a third compiler, or does the transform
   compile to `where`/`select` terms it already has?** The second is cheaper and
   covers three of the transformer's four jobs.
3. **What refuses the fourth job?** Some transforms are genuinely arbitrary. The
   answer *you cannot express that* has to be said out loud, in the surface, with
   the thing that CAN be expressed named beside it — `familiarity vs. precision`,
   fail the muscle memory loudly and helpfully.
4. **Who authors a view component?** Staff-only is a defensible boundary and is
   probably the real one; it needs stating rather than assuming, because the
   audited app assumed it and stored the components in a tenant-scoped table.

---

## The nine questions

Answered before writing, on the record rather than on the build.

- **Another origin of truth?** No, and refusing one is the point — the proposal
  routes a stored query through the compiler that already exists and a stored
  transform through the expression language that already exists. A sandbox
  runtime would be the second origin.
- **Concept budget?** No noun coined here. Naming one would be doing the build's
  job with none of the build's information.
- **Complexity ours or the problem's?** The problem's. An operator who defines a
  report is an ordinary requirement, met 72 times in one application.
- **Predictability?** Improves it. *A report is a gated read through your own
  accessor* is predictable; *a report is whatever is in the column* is not.
- **Derived rather than restated?** Two of the four axes derive entirely from
  what ships. That is the whole finding.
- **One owner?** Named per axis — litestone's compiler for the query, the policy
  expression language for the transform, `renderComponent` for the view. A
  fourth owner is what this record exists to refuse.
- **Boundary explicit?** Today it is absent, and the probe above is how that was
  established rather than assumed.
- **Failure proportional?** The failure of the current shape is arbitrary code
  execution with the process's own credentials — measured. That is what makes
  *no caller-authored JavaScript* proportionate rather than precious.
- **Wrong without anything saying so?** Yes, and that is the class this sits in:
  a leaking sandbox renders correctly, answers correctly, and says nothing. Any
  build here owes a test that asserts the escape is refused, beside a legitimate
  expression that still evaluates — a mechanism that refused everything would
  satisfy a test asking only about the refusal.

**Adjudication** (`PHILOSOPHY.md` § IV) — *ergonomics vs. strictness*, resolved
per-surface by what a mistake destroys. Here a mistake destroys the process's
credentials, so the strict answer wins on cost and not on temperament.
*Batteries vs. smallness* is the secondary one: a sandboxing runtime is not
severable, so it is refused rather than sized.

**Tier** — Assessment. Nothing here may be cited as behavior.
