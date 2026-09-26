# @frontierjs/mcp

**An MCP surface for a FrontierJS app, derived from `db/schema.lite`.** The gate
is the permission model, and tool visibility is computed per standing rather than
described in a prompt.

**Status: an agent can reach your app.** `mcpPlugin()` mounts an MCP endpoint
inside the API you are already running, and `projectTools()` is what it serves —
*which tools may this standing see, and what decided each*. Ruled as
`@frontierjs/mcp` in `DECISIONS.md` (`FJS-D258`); the design is
`IDEAS/agent-surface.md`.

## Mounting it

```js
import { mcpPlugin } from '@frontierjs/mcp'

app.configure(mcpPlugin())          // POST/GET/DELETE at {apiPrefix}/mcp
```

That is the whole setup. There is nothing to declare: the tool list is your
services, the arguments are your schema, and what a caller may reach is the gate
they are already graded by. A caller with no session is a stranger and sees a
stranger's tools.

| Option | Default | What it is |
| --- | --- | --- |
| `path` | `/mcp` | mounted under the app's own `apiPrefix` |
| `name` · `version` | `frontierjs` · `0.0.0` | what the server calls itself to a client |
| `keepAliveMs` | `5000` | **must be under your `http.idleTimeout`**, which defaults to Bun's 10s — the SDK's own default is 15s, so the event stream would die before its first keep-alive |

**A tool call goes through `app.service(name)`**, with the caller bound at
Junction's `CALL_OPTIONS_AT`. It is the same execution path an HTTP or WebSocket
call takes — the same hooks, the same transaction, the same announcement — so
there is no second boundary to keep in step with the first, and nothing an agent
does is invisible to a browser tab watching the same rows.

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
| **what the caller may do** | **`@@gate` on the model, `@gate` on a declared move** |

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
| `call-args` | `call(id, data)`'s shape, where the seed describes no payload — `data` stays open rather than guessed shut |
| `null` | nothing in the seed describes one |

`input.schema` is **`null`** rather than `{}` where the source is null. An empty
object schema accepts anything, which is a claim; null is the absence of one, and
an agent handed `{}` will send something and be refused. Over `example`: 236 of
248 tools carry a schema.

Every answer carries what decided it:

| `verdict` | Meaning |
| --- | --- |
| `model-gate` | the model's `@@gate` position for this operation |
| `move-floor` | `max(model update, the move's own @gate)` — a `@system` move included, since `@system` says whose decision it is and not how senior the caller must be (`FJS-D150`) |
| `method-gate` | the level the service declared for this custom method (`methods: [{ method, gate }]`) |
| `method-floor` | a SESSION is required and the level is not compared — the API boundary's rule for a custom verb on a gated model. `needs` is `null`, because naming the read gate would state a requirement nobody is held to |
| `ungraded` | nothing says; permissive, and labelled |

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
there, and `FJS-976` is what it cost one realm over: Litestone Studio's table dump
defaulted to `asSystem()` and shipped protected columns in plaintext for as long
as nobody was made to choose. That is why the audience is not an option here.

**`describe().model` is not reliably a model.** `Service.model` is optional and
Junction defaults it to the service's own name, so a service declaring no
`model:` reports `orders` — matching no definition, which permissive-unknown
reads as *nothing is declared*. Resolution goes through
`@frontierjs/toolbelt/inflect` and anything that still does not resolve comes
back in `unresolved`, because an open tool list and an ungoverned one look
identical.

## The app CLI

**The same tool list, on a command line, for people** (`FJS-D397`). An app with
a `cli/` surface ships a program named for itself, `shop orders find`. Its
commands are `/mcp`'s tools at the signed-in key's standing, read when the
program starts and cached per build, plus the ones you write by hand.

```
cli/
  config/cli.config.js     name · tenantHeader · url (where a first login goes)
  src/main.js              the entry, three lines
  src/routes/<service>/<method>.js   a hand-written command
  dist/                    what fli cli:build writes
```

```js
// cli/config/cli.config.js
export default { name: 'shop', tenantHeader: 'x-workspace-id', url: 'https://shop.example/mcp' }

// cli/src/main.js
import config   from '../config/cli.config.js'
import { main } from '@frontierjs/mcp/client'
await main({ ...config, routes: new URL('./routes/', import.meta.url) })
```

**A route adds a command or replaces a derived one of the same name.** It
declares every tool it calls in `uses`. It is offered only to a caller who holds
all of them, and `checkRoutes` names a route whose tool is gone.

```js
// cli/src/routes/orders/summary.js  →  shop orders summary
import { defineCommand } from '@frontierjs/mcp/client'
export default defineCommand({
  description: 'Orders per state.',
  uses:        ['orders_find'],
  async run({ call, out }) {
    const { data } = await call('orders_find', { directives: { limit: 500 } })
    out(`${data.length} orders`)
  },
})
```

**Build it with `fli cli:build`.** The result needs no bun, no node_modules and
no source tree:

```sh
fli cli:build                                            # this machine → cli/dist/shop
fli cli:build --target bun-darwin-arm64,bun-linux-x64,bun-windows-x64
```

Only this build embeds `src/routes/`, because routes are read off the directory
at run time. A binary made with a plain `bun build --compile` refuses to start
and says so. A target other than this machine's downloads its runtime once.
`buildCli({ root, targets })` from `@frontierjs/mcp/client/build` is the same
thing as a function.

**Using it.** Get a key from the app's API keys screen, then:

```sh
shop login --api-key -                 # asks for the key (or reads a pipe); --url when config names none
shop --help                            # what this key may do
shop orders find --status paid --json
shop use <tenant>                      # switch tenant; --workspace <id> for one call
shop logout
```

The profile is stored in `~/.config/<name>/` (mode 0600) and the command cache in
`~/.cache/<name>/`. A script passes everything through the environment
instead: `FJS_MCP_URL`, `FJS_TOKEN`, `FJS_TENANT`, `FJS_PROFILE`, and
`FJS_CLI_TRACE=1` to see what it does. The exit codes are 0 ok, 1 refused by
the app, 2 a usage error or not offered, and 3 unreachable.

### Teaching an agent

**Nothing needs generating.** The tool list already describes itself at the
caller's standing, and a skill written from it would go stale, since it can't
know which key will read it. An agent reaches the app one of two ways:

1. **The MCP endpoint (recommended).** The agent is offered the tools its key may
   call, each with a description and an input schema, and calls them under the
   same checks as any other caller. Give it a key of its own, scoped to its job,
   and send the tenant header, or the key holds no role and sees almost nothing:

   ```sh
   claude mcp add --transport http shop https://shop.example/mcp \
     --header "Authorization: Bearer <api-key>" --header "x-workspace-id: <id>"
   ```

2. **The program, from a shell.** `--help` lists what the key is offered, and
   `<service> <method> --help --agent` prints one command's input schema as
   JSON. Pass `--json` on every call, and branch on the exit code. Hand-written
   routes are only reachable this way, because they aren't MCP tools.

**`shop --help --agent` prints this guide for the running app**: the
`claude mcp add` line filled in with the endpoint and tenant it is connected
with (never the key), the routes this key is offered, and the command list.

## Tests

```
bun run test
```
