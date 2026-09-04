# Quickstart — a new app, from empty directory to a deployed server

**This guide is a command now.** It used to be a sequence you typed by hand, and
its own header admitted that half of it had never been executed: §7 *Deploy* was
"documented from the pipeline, not from a live deployment", while the root
README said every command in it had been run. One document, disagreeing with
itself about whether it had ever worked.

So it was made to execute. `fli tutor` is the same path, running: each step
prints its prose, runs the real command, and then **asks the running world
whether it worked** — a port that answers, a table in `sqlite_master`, a row
read back out of the file the app wrote, a container serving the image it
claims to. A step that cannot prove itself stops the lesson and says what it
asked for and what it got instead. It is graded by `bun run ci`'s `tutor`
phase, so a command renamed out from under a step is a red build rather than a
stale paragraph.

```bash
fli tutor            # the eight lessons, and how far through them you are
fli tutor:app        # lesson 1 — an app that runs
```

Every step says what it is about to do and waits — press enter to go on, `n` to
stop. The step you stopped at is the one the next run starts from, so stopping
costs nothing. `--yes` runs a lesson straight through, and `--step N` runs one
step on its own.

## The eight lessons

| | | Needs |
| --- | --- | --- |
| `fli tutor:app` | An empty directory to a running app with a model of your own in it, and a row read back out of the database | — |
| `fli tutor:access` | The gate, the row policy and the field policy, each watched refusing somebody — and every refusal paired with an identical call that is allowed | — |
| `fli tutor:live` | A write reaching a client that asked for nothing — then two sockets against one publish, and the gate deciding which of them is told | — |
| `fli tutor:jobs` | Work that outlives the request: a queue that is a SQLite file, a job named by its own filename, and a response that comes back before the work is done | — |
| `fli tutor:site` | A public site built ahead of time — one HTML file per page with the data in it, and a build that refuses to publish anything gated | — |
| `fli tutor:deploy` | A real deploy to **this machine**: an image, a journal on disk, a redeploy, a revert, and a revert of the revert | Docker · git |
| `fli tutor:change` | Changing a schema that is already deployed: expand, contract, the three-deploy split, and a raised gate that touches no column and is still a contract | — |
| `fli tutor:fleet` | The other release story — a control plane, a machine that reports in, and a signed command that really runs on it | a checkout |

They run in a throwaway directory by default. `--workspace ~/somewhere` keeps
what they build, which is the point if you want to read it afterwards.

The framework is pre-alpha and only some packages are on npm — see the root
[README](../README.md) §Publishing status — so `--source local` (the default
inside a checkout) is the reliable way to run current code.

---

## Where to write what

The one thing here that is a reference rather than a script, and the lessons
assume it rather than teaching it:

| You want to | Edit |
| --- | --- |
| Add a field, a model, an access rule | `db/schema.lite`, then `fli db:push` |
| Add behavior to a service | `api/src/services/<name>.service.ts` — hooks, or a custom method |
| Register a plugin | `api/src/app.ts`, top to bottom, in order |
| Add a page | `web/src/routes/` — the file tree is the route table |
| Bind a page to data | `web/src/resources/` — one Resource per model |
| Change how anything looks | Nothing here defines a colour. Use `@frontierjs/css`: a tone (`danger`) and a treatment (`outlined`) |

A service context has `auth`, `client`, `route`, `locals`, `query` and
`directives`. It has **no `ctx.params`** — that belongs to raw routes only, and
reaching for it is the commonest way to write a role check that silently passes
for everyone. The request-scoped database client is `ctx.locals.db`.

---

## What the lessons do not cover

Real-time channels beyond the connection itself, background jobs
(`@frontierjs/caravan`), outbound mail (`@frontierjs/conduit`), notifications,
prerendered public sites (Sierra's `static` target), and multi-tenancy. Each has
a package README, and [`example/`](../example/) exercises all of them in one app
with drives you can run.

## Where to go next

- [`example/`](../example/) — the kitchen sink: a fleet of shops across five
  surfaces, with real auth, a gate ladder, an order state machine, a public
  prerendered storefront and a payment provider. The place to see a finished
  version of what you just built.
- [`ARCHITECT.md`](../ARCHITECT.md) — the mental model and its vocabulary.
- [`packages/litestone/docs/`](../packages/litestone/docs/) — the schema language
  in full: relations, transitions, policies, migrations.
- [`packages/junction/README.md`](../packages/junction/README.md) — services,
  hooks, actions, channels.
- [`packages/css/guide/`](../packages/css/guide/) — the design system's 53-page
  reference. Start at *Pick a term*.
