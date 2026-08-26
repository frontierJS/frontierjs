# fli

**The developer interface to FrontierJS** — domain 01 of the FJS World, and the
one command you type. It scaffolds an application, checks it against the rules
the framework publishes, runs the realms, brokers the ports, and ships the
result to a server.

```bash
fli new my-app          # the whole application — db/ api/ web/, deploy, CI
fli check               # the arch tests: twelve rules over the file tree
fli dev                 # both servers, after a port preflight
fli deploy              # to a machine you own
```

It is also a **markdown-native command runtime**: every command above is a `.md`
file — prose, frontmatter, and a fenced code block that runs. That is the *how*
rather than the *what*, and it is [below](#a-command-is-a-markdown-file). Your
application's own commands are written the same way and sit beside the
framework's.

---

## Install

```bash
npm install -g @frontierjs/cli     # global
fli new my-app
```

`npm create frontier@latest my-app` is the same scaffold through the front door
— `create-frontier` resolves this package and runs `fli new`, so there is one
implementation of what an application looks like.

Working on `fli` itself, from a clone of the monorepo:

```bash
cd packages/cli
bun install
bun link                # `fli` on PATH, pointed at this tree
```

---

## What it does for an application

170 commands over 27 namespaces. The ones that carry the framework:

| | |
| --- | --- |
| `fli new` · `fli make:*` | Scaffold — an app, a model, a service, a resource, a route, a widget, an extension, a deploy config |
| `fli check` | **The arch tests.** Eleven rules over the file tree — see below |
| `fli dev` · `fli api:dev` · `fli web:dev` | Run the realms. `dev` refuses a port already answering, and warns about an empty database |
| `fli db:*` | The Data realm — `push`, `pull`, `migrate`, `seed`, `studio`, `tinker`, `reset`, `schema`, `tables` |
| `fli test:*` | `access`, `ddl`, `snapshots`, `mutate`, `types` — the Testing realm's committed-artefact half |
| `fli release:check` | Can the release still serving and the release starting share one database? |
| `fli auth:*` | Install the schema fragments, create a user, revoke sessions, rotate the key |
| `fli deploy` · `deploy:*` | Setup a server, build, swap, health-check, roll back. `deploy:local` is the same pipeline against Docker on this machine |
| `fli ws:*` | The workspace — version, publish, tag, push, map, atlas, exports, graph |
| `fli ports:claim` | Take a session's ports out of the scheme rather than guessing |
| `fli project:map` · `project:view` | What this application IS, read off its committed surface |

`fli list` prints all of them, `fli <command> --help` prints one, and
`fli list --json` is the machine-readable form.

**The edges are aspirational and this is the honest warning.** Several
documented commands do not do what their prose says, and the count above is
files rather than commands that have been run. Verify a command by running it
before citing it.

---

## `fli check` — the rules a linter cannot reach

A Biome or an ESLint owns generic JavaScript. **`fli check` owns everything
derived from the seed**, and the boundary is not tooling immaturity: neither
linter reads `.mesa` or `.lite`, and the questions worth asking here are
cross-file. *Does this resource name resolve to a model?* cannot be answered
from the file it appears in.

Eleven rules, and a rule earns its place by being **silent when broken**:

| Rule | Invariant | What it catches |
| --- | --- | --- |
| `model-name-case` · `model-name-plural` | 2 | A model that is not PascalCase singular. Three resolvers agree only because it is |
| `resource-dir-mesa` · `resource-script` | 18 | A `src/resources/` file that is not `.mesa`, or has markup outside `<script module>` |
| `resource-file-name` · `resource-one-per-file` | 19 | A Resource not named for its noun, or two in one file |
| `vite-strict-port` | — | A Vite config without `strictPort` — vite otherwise hops to the next free port in silence and the second app's drive tests the first app's app |
| `body-tag-in-comment` | — | The body tag mentioned inside an HTML comment. Vite injects the built `<script>` at the first textual match and does not skip comments, so the build succeeds and the page loads no JavaScript |
| `app-layout` | 3 | A surface hiding inside another one, or a schema that is not at the root |
| `widget-entry-name` | 19 | A widget whose name cannot be a custom element |
| `package-root-md` | 17 | A fifth markdown file at a package root — a warning naming it, because the rule cannot tell a stray design note from the next thing everyone needs |

**`core/checks.js` is the engine and this repo is its other caller.** The
`structure` phase of `bun run ci` imports it directly and runs it over
FrontierJS itself, so a rule loosened for this repo is loosened for every
application on the next release — which is the point. Two implementations of one
rule is how a framework ends up breaking rules it publishes.

`fli check --list` prints the table with the invariant each rule comes from.

---

## A command is a markdown file

Prose, YAML frontmatter, and code. The same file is the documentation, the CLI
command, and the form the Web GUI renders — so there is nothing to keep in sync.

```
commands/hello/greet.md
│
├── YAML frontmatter   → title, description, args, flags, examples
├── <script> block     → helpers, shared by the CLI and the GUI
└── ```js block        → the body — runs on execute
```

Running one:

1. Scan `<fliRoot>/commands/` (the framework's) and `<projectRoot>/cli/src/routes/` (yours)
2. Compile the `.md` to an ESM module — no temp build, no bundler
3. Validate args and flags against the frontmatter
4. Call the body with a `context`

Commands are **live**: drop a `.md` file in and it runs. Nothing is rebuilt.

### Writing one

The file path decides nothing — `title` is the command name.

````markdown
---
title: hello:greet
description: Greet someone from the command line
alias: greet
examples:
  - fli hello:greet World
  - fli hello:greet World --shout
args:
  -
    name: name
    description: Name to greet
    required: true
flags:
  shout:
    type: boolean
    char: s
    description: Uppercase the greeting
    defaultValue: false
  times:
    type: number
    char: n
    description: How many times to greet
    defaultValue: 1
---

<script>
const buildGreeting = (name, shout) => {
  const msg = `Hello, ${name}!`
  return shout ? msg.toUpperCase() : msg
}
</script>

```js
arg.name ??= await question('Who should I greet? ')

const greeting = buildGreeting(arg.name, flag.shout)

for (let i = 0; i < (flag.times ?? 1); i++) {
  echo(greeting)
}

log.success(`Greeted ${arg.name} ${flag.times} time(s)`)
```
````

`fli make:command` scaffolds this interactively; `fli edit <command>` opens an
existing one.

**An alias is claimed first-come and a contested one is a bug.** Two commands
claiming one alias warns, and the winner is whichever loads last — the walk is
sorted so that is at least reproducible, but nothing about `utils` sorting after
`ports` says which should own `dev`. Resolve it by renaming one side.

### Frontmatter

| Field | Required | Description |
|---|---|---|
| `title` | ✅ | Command name, `namespace:command` |
| `description` | | Shown in `fli list` and the GUI |
| `alias` | | Short name — `fli new` for `project:new` |
| `examples` | | Example invocations |
| `args` | | Ordered positional definitions |
| `flags` | | Named flag definitions |

**Arg fields** — `name` (read as `arg.name`), `description`, `required`,
`defaultValue`, `variadic` (joins the remaining positionals into one string;
must be last).

**Flag fields** — `type` (`string` · `boolean` · `number`), `char` (single-letter
shorthand), `description`, `defaultValue`, `options` (an enum), `required`. A
flag with both `required` and `defaultValue` is always satisfied — the default
fills it in.

---

## Multi-step commands — `_steps/`

A large command breaks into numbered step files that run in order and share
state. Step files are never registered as commands of their own.

```
commands/deploy/
  index.md          ← orchestrator: defines the flags, populates context.config
  _steps/
    01-validate.md
    02-build.md     ← optional: true   — failure warns and continues
    03-push.md      ← skip: "flag.dry" — skipped when --dry
    04-lint.md      ← parallel: true   — runs with 05 and 06
    05-typecheck.md ← parallel: true
    06-test.md      ← parallel: true
    07-finish.md    ← serial checkpoint — waits for 04/05/06
```

```bash
fli deploy              # every step
fli deploy --dry        # 03 skipped by its own predicate
fli deploy --step 2     # re-run one step, shown as [2/3]
```

| Field | Description |
|---|---|
| `optional: true` | A failure warns and the run continues |
| `skip: "expr"` | A JS expression; truthy means skip |
| `parallel: true` | Runs with adjacent parallel steps. A non-parallel step is a serial checkpoint — everything before it must finish first. Parallel steps share `context.config`, so write to distinct keys |

Steps sort lexicographically by filename, and **two files sharing a numeric
prefix warn at runtime** rather than picking an order nobody wrote.

---

## The context

The `<script>` and ` ```js ` blocks run inside a function handed a `context`.
It is **one per invocation, and it is not a request context** — nothing here
acts on behalf of a remote caller, so there is no principal, no `auth`, no
`query`. The fields are capabilities rather than inputs.

```js
// Top-level locals in the ```js block:
arg             // positional args        → arg.name, arg.path
flag            // flags                  → flag.dry, flag.force
log             // the styled logger      → log.info/success/warn/error/dry/debug
context         // everything below
context.config  // shared mutable state across _steps/

// On the context:
context.paths    // the resolved project → .root .api .web .db .cli .widgets …
context.env      // process.env
context.git      // repo access — pkgState(name, dir), wsRepo(packages)
context.exec     // a synchronous shell command
context.stream   // an async streaming one
context.execute  // several, in sequence
context.wsRoot() // the workspace root, found from cwd

// zx globals, everywhere:
echo()  question()  $``
```

**`context.git` asks with a pathspec, and that is not a nicety.** Every member of
this workspace shares one `.git`, so a bare `git status --porcelain` run from
`packages/mesa` describes the whole monorepo — which had all sixteen `ws:*` rows
reporting one another's state.

### `exec` and `stream`

**Every command gets `--dry` for free and both respect it.**

`context.exec` is synchronous — for short work whose output can arrive at the
end (git, a quick docker call, file manipulation):

```js
context.exec({ command: `git push origin ${flag.branch}` })
// --dry logs "[dry] git push origin main" and runs nothing
```

`context.stream` is async — for long work where live output is the point (a
docker build, tailing logs, a dev server, an SSH session). In the GUI it streams
line by line as SSE rather than landing all at once:

```js
await context.stream({ command: `ssh ${host} "docker logs --follow ${container}"` })
```

---

## Which project am I in

`context.paths.*` all hang off one root, walked up from the working directory:

1. `--project <dir>` / `FLI_PROJECT` — explicit, beats everything
2. `.fli.json` — an explicit marker. Deepest match wins
3. `db/schema.lite` — an FJS application root. Deepest match wins
4. `.git/` — the repo root, skipped when running inside fli's own checkout
5. `package.json` — the fallback for a project not in git

**Rule 3 is what makes a monorepo work.** `example/` and `packages/basecamp/`
are each their own application, so `fli project:map` inside either resolves to
that application rather than to the repo's `.git`. It is also why
`create-frontier` pins `--project`: walking up is right for every other command
and wrong for a scaffold, which would otherwise write into the enclosing
repository's root.

### `.fli.json`

```json
{
  "routesDir":        "cli/src/routes",
  "defaultNamespace": "hello",
  "editor":           "code"
}
```

| Field | Default | |
|---|---|---|
| `routesDir` | `cli/src/routes` | Where your own commands live |
| `defaultNamespace` | `hello` | For `fli init` and `make:command` |
| `editor` | `$EDITOR` | Opened by `fli edit` |

Directory names are environment variables, one per surface — `WEB_DIR`,
`API_DIR`, `DB_DIR`, `CLI_DIR`, `WIDGETS_DIR`, `EXTENSION_DIR`, `SITE_DIR`,
`MOBILE_DIR`, `TESTS_DIR`, `WIKI_DIR`.

---

## Built-in flags

| Flag | Short | |
|---|---|---|
| `--dry` | `-d` | Show what would run, run nothing |
| `--test` | `-t` | `NODE_ENV=test` |
| `--step` | | Re-run one `_steps/` step by number |
| `--project <dir>` | | Run against that root instead of resolving one |

`--project` is consumed before the command runs — it sets `context.paths.*` and
is stripped from the command's own flags, so it drives an application from
outside it: `fli project:view --project packages/basecamp`.

---

## Ports

**`core/ports.js` is the scheme, and it is the whole of it** —
`port = env*1000 + category*100 + project*10 + service`. env: 7 test · 8 dev ·
9 prod. category: 0 fe · 1 be · 2 widgets-dev · 3 widgets-served · 4 extension ·
5 tooling.

A scaffolded app is project 0 — web on `8000`, API on `8100`. Global fli tooling
is reserved — the whole of **8500–8509**, of which **8500 is the GUI, 8501 `project:view`, 8502 db studio and 8503 junction's devtools console** — and the
broker refuses to hand those out to anything else. `fli ports:claim` takes a
session's ports out of the scheme and exports them, rather than every app
hard-coding a guess.

---

## The Web GUI

```bash
fli gui                # http://localhost:8500
fli gui --port 8080    # or FLI_PORT
fli gui --open         # and open a browser
```

The GUI builds a form for every command out of its frontmatter — the same file,
no second definition — and streams output live, coloured by log level.

| Method | Path | |
|---|---|---|
| `GET` | `/` | The GUI |
| `GET` | `/api/commands` | All command metadata |
| `GET` | `/api/commands/:name` | One command, with its source blocks |
| `POST` | `/api/run/:name` | Run it; answers an SSE stream |

```json
{ "args": ["value1"], "flags": { "shout": true, "times": 3 } }
```

```
data: {"type":"output","text":"HELLO, WORLD!\n"}
data: {"type":"log","level":"success","text":"Greeted World 3 time(s)"}
data: {"type":"done"}
data: {"type":"error","text":"arg [name] is required!"}
```

---

## Tab completion

```bash
fli completion:install
source ~/.zshrc            # or ~/.bashrc, or restart the shell
```

```bash
fli <TAB>                  # every command and alias
fli dep<TAB>               # deploy, deploy:logs, deploy:run …
fli deploy:logs <TAB>      # --production, --stage, --follow, --tail …
```

The script calls `fli completion:query` on every Tab press, against a disk cache
at `~/.fli/completion-cache.json` that rebuilds when any command file changes.
`completion:generate` prints the script; `completion:refresh` forces a rebuild.

---

## Traps

- **Nothing on the read-only path may import zx.** It is ~85ms of what was a
  ~200ms invocation, and `list`, `help`, `?` and completion wanted one thing from
  it — colour, which is `core/color.js` now. That is also why `bootstrap.js`
  imports `runtime.js` at the call site rather than at the top: a static import
  pulls zx back in for every `fli list`. A command body is unaffected, since its
  compiled shim imports `zx/globals` itself.
- **A clean compile is not proof of valid JS** (Invariant 15). Compiling every
  command file and *parsing* the output found 14 producing broken JavaScript the
  compiler reported as fine. Every command file has a parse test; a new one needs
  one too.
- **The parse sweep compiles a command with no namespace module**, so a command
  using a `_module.md` helper parses whether or not the module defines it. That
  is not theoretical: `completion/_module.md` used four imports it did not have,
  so all five completion commands threw and **Tab completion had never worked**
  while every suite stayed green. A command whose only proof is the sweep has not
  been run.
- **A fenced block in a `_module.md` renders as an empty heading.** Module prose
  has every fence stripped, because in a command file a fence IS the body. Write
  a namespace overview as a plain list.

### Inside a `<script>` block

Two things the compiler cannot see through, and both only matter when your
command *generates* `.md` files — `make:command` does:

```js
const fence       = '`'.repeat(3)     // no literal triple backticks
const scriptClose = '</' + 'script>'  // no literal closing script tag
```

---

## Dependencies

| Package | |
|---|---|
| `zx` | Shell execution (`$`), `question()`, `echo()` |
| `minimist` | argv parsing |
| `linkedom` · `turndown` | `fetch:*` — HTML into markdown |

---

## Running tests

```bash
bun run test
```

Two batches, and the split is load-bearing: the `_steps/` tests must run in a
separate process, because bun's shared module cache carries state between them.

There is **no browser drive for `fli`**. A change to a scaffold is proved by
scaffolding into a temp directory and running what comes out —
`node scripts/scaffold-build.mjs` from the repo root does exactly that, and the
`scaffold` CI phase runs it against packed tarballs. A change to
`core/checks.js` also needs `node scripts/ci.mjs --fast`, because this repo is
its other caller.
