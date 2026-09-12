# @frontierjs/mcp

**An MCP surface for a FrontierJS app, derived from `db/schema.lite`.** The gate
is the permission model, and tool visibility is computed per standing rather than
described in a prompt.

**Status: the projection ships; the transport does not.** What is here answers
*which tools may this standing see, and what decided each* — `projectTools()`.
There is no stdio or HTTP server yet, so this package cannot be pointed at an
agent. Ruled as `@frontierjs/mcp` in `DECISIONS.md` (`FJS-D258`); the design is
`IDEAS/agent-surface.md`.

## Why the scoping is the interesting half

Exposing tools is mechanical everywhere. Scoping them is not, and the reason is
structural: in a framework whose authorization lives in handlers, *what may this
agent do* has no answer outside the handlers themselves — so the answer gets
written as prose in a system prompt, which an agent can be talked out of.

Here it is three numbers that already exist, enforced in the database layer:

| MCP needs | Where it comes from |
| --- | --- |
| the tool list | `describe().methods`, after the service's method policy |
| input schema per tool | `generateJsonSchema(schema)` — the document the browser already gets |
| **what the caller may do** | **`@@gate` on the model, `@gate` on a declared move, `@system`** |

## Using it

```js
import { projectTools, schemaViews } from '@frontierjs/mcp'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

const views = schemaViews(db.$schema, generateJsonSchema)

const services = app.services.list().map(name => {
  const d = app.services.get(name).describe()
  return { name, model: d.model, methods: d.methods, inputs: d.inputs }
})

const { tools, withheld, unresolved } = projectTools(services, views, level)
```

`level` is the caller's standing, from `@frontierjs/toolbelt/gate`'s
`gradeStanding` or an app's own resolver.

**`schemaViews` takes the schema and the generator, and the AUDIENCE is not a
parameter** — see the third note below. It reads the schema three ways (`full`
for the rules, `create` and `update` for the arguments) and every call is at
`audience: 'client'`.

Each tool also carries its argument schema and where that came from:

| `input.source` | What it is |
| --- | --- |
| `create-mode` | the model at `mode: 'create'` |
| `update-mode` | an id plus the model at `mode: 'update'`, with `id` stripped from the changes |
| `declared-type` | the `type T { … }` the service named for this method (`describe().inputs`) |
| `id` | one identifier — `get`, `remove`, `restore` |
| `query` | filters plus the directive names, read off `@frontierjs/toolbelt/directives` |
| `null` | nothing in the seed describes one |

`input.schema` is **`null`** rather than `{}` where the source is null. An empty
object schema accepts anything, which is a claim; null is the absence of one, and
an agent handed `{}` will send something and be refused. Over `example`: 157 of
203 tools carry a schema and 46 do not.

Every answer carries what decided it:

| `verdict` | Meaning |
| --- | --- |
| `model-gate` | the model's `@@gate` position for this operation |
| `move-floor` | `max(model update, the move's own @gate)` |
| `move-system` | a `@system` move — no caller, at any standing |
| `ungraded` | nothing in the seed says; permissive, and labelled |

**`ungraded` is not grouped with the two that cleared a number.** *Nothing
refused this* and *a rule allowed it* are different facts, and only one is
evidence. The list of ungraded tools is the one worth shortening in an app.

## Three things worth knowing before you trust the output

**It is an affordance, not a boundary** (Invariant 6). Litestone enforces at the
Data boundary whatever this answers, so a tool wrongly shown is a wasted turn and
a 403. Never guard anything on this that the server does not also guard.

**A move's `@gate` is a FLOOR over the model's update level, not a replacement.**
`example` declares `void @gate 5` on an `Invoice` whose `update` is 8, so the
tool needs 8. Grading by the move's own number offers it two rungs below what the
boundary accepts — the one mistake here that misleads a caller about its own
permissions rather than merely wasting a turn.

**A protected column must never reach a tool description, and the unsafe
default is the tempting one.** `audience: 'system'` includes `@guarded` and
`@secret`, so it would put `Credential.value` — the password hash — and the OAuth
tokens into the *description* of a tool, disclosed before any call is made, to a
caller whose whole job is reading what it is given. *The agent acts for the
application, so give it what the application knows* is the sentence that gets
there, and `FJS-976` is what it cost one realm over: Studio's table dump
defaulted to `asSystem()` and shipped protected columns in plaintext for as long
as nobody was made to choose. That is why the audience is not an option here.

**`describe().model` is not reliably a model.** `Service.model` is optional and
Junction defaults it to the service's own name, so a service declaring no
`model:` reports `orders` — matching no definition, which permissive-unknown
reads as *nothing is declared*. Resolution goes through
`@frontierjs/toolbelt/inflect` and anything that still does not resolve comes
back in `unresolved`, because an open tool list and an ungoverned one look
identical.

## Tests

```
bun run test
```
