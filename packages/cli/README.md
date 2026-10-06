# fli

**The developer interface to FrontierJS** — domain 01 of the FJS World, and the
one command you type. It scaffolds an application, checks it against the rules
the framework publishes, runs the realms, brokers the ports, and ships the
result to a server.

```bash
fli new my-app          # the whole application — db/ api/ web/, deploy, CI
fli check               # the arch tests: `fli check --list` names every rule
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

Commands are markdown files under `commands/`, one namespace per directory —
`fli --help` is the list. The ones that carry the framework:

| | |
| --- | --- |
| `fli new` · `fli make:*` | Scaffold — an app, a model, a service, a resource, a route, a widget, an extension, a deploy config |
| `fli check` | **The arch tests.** `fli check --list` names every rule over the file tree — see below |
| `fli dev` · `fli api:dev` · `fli web:dev` | Run the realms. `dev` refuses a port already answering, and warns about an empty database |
| `fli db:*` | The Data realm — `push`, `pull`, `migrate`, `seed`, `studio`, `tinker`, `reset`, `tables` |
| `fli test:*` | `access`, `ddl`, `snapshots`, `mutate`, `types` — the Testing realm's committed-artefact half |
| `fli release:check` | Can the release still serving and the release starting share one database? |
| `fli auth:*` | Install the schema fragments, create a user, revoke sessions, rotate the key |
| `fli deploy` · `deploy:*` | Setup a server, build, swap, health-check, roll back. `deploy:local` is the same pipeline against Docker on this machine |
| `fli ws:*` | The workspace — version, status, add, install, link, npm, exec, run, changed, clean, graph, exports, invariants, atlas, init; `fli list` names the rest |
| `fli ps` | What holds each port the scheme can name, and which dev slot each app has |
| `fli project:map` | What this application IS — one reading, three presentations (`--as=report\|serve\|json`) |

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

A rule earns its place by being **silent when broken**:

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
| `command-parses` | 15 | A project command under `cli/src/routes/` whose compiled JavaScript does not parse — compiled with its `_module.md`, since the two share a scope, and reported at the `.md` line. A command compiles when it runs, so one nobody has run is broken in silence. Run it after editing a command: `fli check --only command-parses` |

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

**Only a fence runs.** ` ```js `/` ```ts ` is the body as written and ` ```bash `
runs through `$`, the shell; every other fence, and all prose, is a comment. An indented
block is prose too — markdown's indented code block is not code here, so an
example indented in a paragraph cannot break the command.

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
arg.name ??= await tty.line('Who should I greet?')

const greeting = buildGreeting(arg.name, flag.shout)

for (let i = 0; i < (flag.times ?? 1); i++) {
  echo(greeting)
}

log.success(`Greeted ${arg.name} ${flag.times} time(s)`)
```
````

`fli make:command` scaffolds this interactively; `fli edit <command>` opens an
existing one.

### A shortcut

A command line you type often can have a name of its own:

```
fli make:shortcut go-time "fli ws:atlas --open --live"
```

Typing that name now runs it, from the project root, with anything typed after
the name appended verbatim. What that writes is an ordinary command file under
`cli/src/routes/shortcut/`, so `fli list`, completion and `fli edit` find it with
no further wiring — and a shortcut that grows into a real command is an edit to
that file rather than a migration out of a table. A leading `fli` is rewritten to
the fli that is running, so a shortcut cannot reach a different install than the
one that made it.

A name the registry already answers to is refused, naming what holds it. That
refusal is the reason the command exists rather than a line in a config file: a
project command overrides a core one in silence, which is right for authoring and
wrong for a name typed from memory — `fli make:shortcut new "…"` would otherwise
eat `fli new` and say nothing.

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
| `mode` | | `strict` refuses an undeclared flag · `passthrough` accepts it in silence |
| `effects` | | What the command does beyond this machine, one line — shown by `--help`, `fli list --json` and the GUI |
| `confirm` | | `human`: a person approves each run. Needs `effects` |

**`confirm: human` is enforced before the body runs.** At a terminal, the person
typing the command is the approval. Anywhere else — an agent's shell, a pipe,
`fli gui` — the run is refused unless it carries `--approved`, a flag fli adds to
the command rather than one it declares. `--dry` does not skip it, because
whether a dry run touches nothing is the command's promise, not fli's. `fli
gui` asks the person at the page and sends `--approved` on a yes.

```yaml
effects: sends a message to a customer
confirm: human
```

**`--approved` is only as good as whoever grants it.** fli cannot tell a person
from an agent typing the flag itself; the enforcement is that the agent has to
ask. An agent host's permission rule that holds any command line carrying
`--approved` for a person makes that real, and the person sees the whole line —
so a reply passed as `--body` is approved word for word, and one passed as
`--file` is approved by its path.

**Arg fields** — `name` (read as `arg.name`), `description`, `required`,
`defaultValue`, `variadic` (joins the remaining positionals into one string;
must be last).

**Flag fields** — `type` (`string` · `boolean` · `number`), `char` (single-letter
shorthand), `description`, `defaultValue`, `required`, `multiple` (the flag may
be given more than once and arrives as an array). A flag with both `required`
and `defaultValue` is always satisfied — the default fills it in.

**Constraints** — `choices`, a list of the values allowed, and `min`/`max` on a
`number` flag, both inclusive. A value outside them is refused with a message
written from the declaration, `--help` prints them beside the type, and the GUI
draws `choices` as a select. A broken declaration — a range on a string, a
`choices` that is not a list — is refused on every run, not only on the run
that passes the flag.

```yaml
flags:
  every:
    type: number
    min: 5
    max: 90
  sort:
    type: string
    choices:
      - name
      - size
```

**A flag is named for what it does.** A boolean that is on unless asked is
declared `push` with `defaultValue: true`, typed `--no-push` (the argv parser's
own reading), and read as `flag.push`. Its `description` says what `--no-push`
does, because that is the spelling `--help` and completion print. A flag
declared `no-push` is refused by name.

**JSON is `--json`, on every command** (`FJS-D401`). A command a program might
read declares a `json` boolean and prints its model when it is set. `--as`
picks among the layouts a PERSON reads — `--as=report`, `--as=page` — which may
change on any commit, because nothing reads them but people. An `as` whose
`choices` include `json` is refused, and `--as=json` names `--json` in the
refusal.

---

## Multi-step commands — `_steps/`

A large command breaks into numbered step files that run in order and share
state. Step files are never registered as commands of their own.

```
commands/deploy/
  index.md          ← orchestrator: defines the flags, populates $.config
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
| `parallel: true` | Runs with adjacent parallel steps. A non-parallel step is a serial checkpoint — everything before it must finish first. Parallel steps share `$.config`, so write to distinct keys |

Steps sort lexicographically by filename, and **two files sharing a numeric
prefix warn at runtime** rather than picking an order nobody wrote.

---

## The context — `$`

The ` ```js ` block runs inside `run($)`. **`$` is the command in progress**: the
context, and callable as the shell. It is one per invocation and it is not a
request context — nothing here acts on behalf of a remote caller, so there is no
principal, no `auth`, no `query`; the fields are capabilities rather than inputs.
The spelling is the framework's: Junction's `$` is the call in progress and
Mesa's is the component runtime, so knowing one teaches the next.

```js
// Destructured from $ at the top of the body:
arg             // positional args        → arg.name, arg.path
flag            // flags                  → flag.dry, flag.force
log             // the styled logger      → log.info/success/warn/error/dry/detail
tty             // the terminal, held     → tty.keys/line/live/aside/onExit/title/wrap
echo            // one output line (stdout, or the GUI's event stream)
chalk           // core/color.js — follows NO_COLOR, as fli's own output does

// On $:
$.config   // shared mutable state across _steps/
$.paths    // the resolved project → .root .api .web .db .cli .widgets …
$.env      // process.env
$.git      // repo access — pkgState(name, dir), wsRepo(packages)
$.exec     // a synchronous shell command
$.stream   // an async streaming one
$.execute  // several, in sequence
$.wsRoot() // the workspace root, found from cwd

// $ itself, as a tag — Bun's shell, under fli's rules:
const sha = (await $`git rev-parse HEAD`).text().trim()

// Imported for every command, so they need no <script>:
path  fs
```

**`` $`…` `` captures by default** and prints only under `--verbose`; `.stdout`
is a Buffer, so read `.text()`, `.json()` or `.lines()`. **`--dry` runs
nothing** and logs the command, the rule `$.exec` has, through the same owner.
A non-zero exit throws with the command in the message and `.exitCode`,
`.stdout`, `.stderr` on the error; `.nothrow()` opts out. **The shell is Bun's,
not bash**: no heredoc and no `for`/`while` — a body that needs them spells
`` $`bash -c ${script}` ``. An interpolation is one argument whatever it
holds.

**A `<script>` block is module scope and sees none of the destructured names**
— `log`, `echo`, `tty`, `flag` are `ReferenceError`s there. A helper takes what
it needs as a parameter. `fli check`'s `command-resolves` rule reports every
such name at its line, and a name declared in both the namespace module and
the command.

**`$.git` asks with a pathspec, and that is not a nicety.** Every member of
this workspace shares one `.git`, so a bare `git status --porcelain` run from
`packages/mesa` describes the whole monorepo — which had all sixteen `ws:*` rows
reporting one another's state.

### `exec` and `stream`

**Every command gets `--dry` for free and both respect it.**

`$.exec` is synchronous — for short work whose output can arrive at the
end (git, a quick docker call, file manipulation):

```js
$.exec({ command: `git push origin ${flag.branch}` })
// --dry logs "[dry] git push origin main" and runs nothing
```

`$.stream` is async — for long work where live output is the point (a
docker build, tailing logs, a dev server, an SSH session). In the GUI it streams
line by line as SSE rather than landing all at once:

```js
await $.stream({ command: `ssh ${host} "docker logs --follow ${container}"` })
```

### `tty` — a command that holds the terminal

For a command that stays open: a single-key prompt, a status line pinned to the
bottom, the screen handed to an editor and taken back.

```js
tty.onExit(() => api('POST', '/status', { online: false }))  // Ctrl-C included, capped at 3s
tty.title('● online')
const bar = tty.live(() => [chalk.green('● online'), `${waiting} waiting`, chalk.dim('? keys')])

const k = await tty.keys(`Send #${id}?`, { y: 'yes', e: 'edit', s: 'skip' })
if (k === 'e') await tty.aside(() => $.stream({ command: `$EDITOR ${file}` }))
```

**Whatever the command prints lands above the footer**: `echo`, `log` and
`console` all clear it, print, and redraw it, so nothing has to be routed
through `tty`. `live` takes a string or an array of parts, and parts drop from
the right until the line fits. `keys` takes one keypress with no Enter: Enter
picks a question's first choice, which is shown upper-case (`[Y]es`), Esc is a
choice only when one is named `esc`, and a `null` question listens without
taking the footer and with no default — a menu under the status line. **The terminal is put back however the
command ends**: raw mode, the footer and the title on a return, a throw, Ctrl-C
or SIGTERM. `onExit` runs on all four, and a second Ctrl-C does not wait for
it. While `aside` runs, Ctrl-C belongs to the child, and this command's own
output waits until it returns.

**With no terminal — a pipe, or `fli gui` — `tty.interactive` is false**: `live`,
`title` and `aside` add nothing, and `keys` refuses by name, or answers with
its first choice when the command declares `--yes` and it was passed. Check
`tty.interactive` before offering keys.

---

## Which project am I in

`$.paths.*` all hang off one root, walked up from the working directory:

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

`--project` is consumed before the command runs — it sets `$.paths.*` and
is stripped from the command's own flags, so it drives an application from
outside it: `fli project:map --project packages/basecamp`.

---

## Ports

**`core/ports.js` is the scheme, and it is the whole of it** —
`port = env*1000 + category*100 + project*10 + service`. env: 7 test · 8 dev ·
9 prod. category: 0 fe · 1 be · 2 widgets-dev · 3 widgets-served · 4 extension ·
5 tooling · 6 site-dev · 7 site-served · 8 desktop-dev.

A scaffolded app is project 0 — web on `8000`, API on `8100`. **`fli dev` gives
each such app a slot of its own**, the service digit: the second app you start
runs on `8001`/`8101`, and the slot is remembered per app directory in
`~/.fli/sessions.lock`, so it comes back on the same ports next time. The ports
reach the servers as `FLI_PORT_FE`, `FLI_PORT_BE`, `FLI_PORT_SITE`,
`FLI_PORT_WIDGET` and `FLI_PORT_DESKTOP`, which the scaffolded configs read; an
app whose configs ignore them stays on slot 0. `fli ps` lists the slots. Global
fli tooling is reserved — the whole of **8500–8509**, of which **8500 is the GUI, 8501 `project:map --as=serve`, 8502 db studio and 8503 junction's devtools console** — and the
formula refuses those to any app.

---

## The Web GUI

```bash
fli gui                # http://localhost:8500
fli gui --port 8080    # or FLI_PORT
fli gui --open         # and open a browser
```

The GUI builds a form for every command out of its frontmatter — the same file,
no second definition — and streams output live, colored by log level. A sample
of its routes, `core/server.js` for the rest:

| Method | Path | |
|---|---|---|
| `GET` | `/` | The GUI |
| `GET` | `/api/commands` | All command metadata |
| `GET` | `/api/commands/:name` | One command, with its source blocks |
| `POST` | `/api/run/:name` | Run it; answers an SSE stream |
| `GET` | `/api/proves` | Which drive proves the change you just made |
| `GET` | `/api/check` | The arch-test rules over this project |
| `GET` | `/api/release` | The Release realm's pivot verdict |

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
at `~/.fli/cache/registry-<key>.json` that rebuilds when any command file changes.
`completion:generate` prints the script; `completion:refresh` forces a rebuild.

---

## Traps

- **The read-only path imports no command runtime.** `list`, `help`, `?` and
  completion take color from `core/color.js` and reach `runtime.js` only at the
  call site that runs a command, never at the top of `bootstrap.js` — a static
  import there is paid by every `fli list`.
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
| `linkedom` · `turndown` | Optional peers, only for `ksite:fetch` — HTML into markdown. The app installs them: `bun add -d linkedom turndown` |

---

## Running tests

```bash
bun run test
```

Two batches, and the split is load-bearing: the `_steps/` tests must run in a
separate process, because bun's shared module cache carries state between them.

`bun run test:browser` is the GUI's own drive — one spec per panel of `fli
gui`'s front page, over mesa's harness. A change to a scaffold is proved by
scaffolding into a temp directory and running what comes out —
`node scripts/scaffold-build.mjs` from the repo root does exactly that, and the
`scaffold` CI phase runs it against packed tarballs. A change to
`core/checks.js` also needs `node scripts/ci.mjs --fast`, because this repo is
its other caller.
