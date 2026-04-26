# fli

A modular CLI automation platform where commands are defined as plain `.md` files. The same command files power three interfaces: a CLI, a Web GUI, and (planned) a TUI.

```
fli hello:greet World --shout --times 3
```

---

## Dev setup

```bash
bun install
bun link        # makes `fli` available globally as a shell command
fli gui         # start the Web GUI at http://localhost:4444
```

After `bun link`, use `fli` directly from any directory:

```bash
fli list
fli hello:greet World
fli gui --open
```

---

## How it works

Each command is a Markdown file with YAML frontmatter and two code sections:

```
cli/src/routes/hello/greet.md
│
├── YAML frontmatter   → title, description, args, flags
├── <script> block     → helper functions (shared across CLI + Web GUI)
└── ```js block        → main command body (runs on execute)
```

When you run `fli hello:greet`, the runtime:

1. Scans `fliRoot/commands/` (core) and `projectRoot/cli/src/routes/` (project)
2. Compiles the `.md` file into an ESM module — no temp files, no build step
3. Validates args and flags against frontmatter definitions
4. Calls `run(context)` with everything the command needs

Commands are **live** — drop a `.md` file and it's immediately available. No rebuilding.

---

## Project structure

```
fli/
├── bin/
│   ├── fli.js           # CLI entrypoint
│   └── server.js        # Web GUI server entrypoint
├── commands/            # Core FLI commands (always available)
│   ├── fli/             # fli:init, fli:edit, fli:gui, fli:update, fli:env
│   ├── make/            # make:command, make:deploy …
│   ├── completion/      # completion:install, completion:generate, completion:query, completion:refresh
│   ├── crypto/          # crypto:keygen
│   ├── db/              # db:push, db:pull, db:reset, db:import …
│   ├── deploy/          # deploy, deploy:setup, deploy:status, deploy:logs, deploy:run, deploy:local, deploy:rollback
│   ├── web/             # web:dev, web:build, web:route, web:component …
│   ├── api/             # api:dev, api:deploy, api:model, api:service
│   ├── utils/           # utils:ssh, utils:killnode, utils:password …
│   └── …
├── core/
│   ├── bootstrap.js     # CLI router — parses argv, looks up command, runs it
│   ├── compiler.js      # .md → ESM compiler
│   ├── config.js        # .fli.json project config loader
│   ├── registry.js      # Scans both command dirs, builds command map
│   ├── runtime.js       # Command() — validates args/flags, builds context
│   ├── server.js        # HTTP server — 3 endpoints + SSE output streaming
│   └── utils.js         # Logger, file finder
├── cli/
│   └── src/routes/      # Your project commands live here
├── web/
│   └── index.html       # Web GUI — single file, no build step
├── .fli.json            # Optional project config (see below)
└── package.json
```

---

## Writing a command

Create a `.md` file anywhere under `cli/src/routes/`. The file path determines nothing — the `title` in frontmatter is the command name.

```markdown
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
```

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `title` | ✅ | Command name in `namespace:command` format |
| `description` | | Short description shown in `fli list` and Web GUI |
| `alias` | | Short name — `fli greet` instead of `fli hello:greet` |
| `examples` | | Array of example invocations |
| `args` | | Ordered positional argument definitions |
| `flags` | | Named flag definitions |

### Arg definition fields

| Field | Description |
|---|---|
| `name` | Used to access the value as `arg.name` |
| `description` | Shown in Web GUI |
| `required` | Throws if missing |
| `defaultValue` | Used when not provided |
| `variadic` | Joins all remaining positional args into one string. Must be last. |

### Flag definition fields

| Field | Description |
|---|---|
| `type` | `string` · `boolean` · `number` |
| `char` | Single-letter shorthand: `-s` instead of `--shout` |
| `description` | Shown in Web GUI |
| `defaultValue` | Applied when flag is not passed |
| `options` | Enum — restricts value to a fixed set |
| `required` | If `true`, the command aborts with a clear error when the flag is not provided. A flag with both `required` and `defaultValue` is always satisfied — the default fills it in. |

---

## Multi-step commands (`_steps/`)

Break large commands into numbered step files that run in sequence and share state:

```
cli/src/routes/deploy/
  index.md          ← orchestrator: defines flags, populates context.config
  _steps/
    01-validate.md  ← runs first
    02-build.md     ← optional: true  (failure warns and continues)
    03-push.md      ← skip: "flag.dry"  (skipped when --dry)
    04-lint.md      ← parallel: true  (runs concurrently with 05 and 06)
    05-typecheck.md ← parallel: true
    06-test.md      ← parallel: true
    07-finish.md    ← serial checkpoint — waits for 04/05/06 to complete
```

Step files are never registered as commands. The orchestrator's `js` block runs first, then steps run in order sharing `context.config`.

```bash
fli deploy:all                # run all steps
fli deploy:all --dry          # step 3 skipped via skip predicate
fli deploy:all --step 2       # re-run only step 2, shows [2/3]
```

Steps sort lexicographically by filename. fli warns at runtime if two step files share the same numeric prefix (e.g. two files starting with `04`) — ordering would be ambiguous.

### Step frontmatter fields

| Field | Description |
|---|---|
| `optional: true` | Failure emits a warning and continues to the next step |
| `skip: "expr"` | JS expression — truthy means skip this step |
| `parallel: true` | Run concurrently with adjacent parallel steps. A non-parallel step is a serial checkpoint — all preceding parallel steps must finish before it starts. Parallel steps share `context.config`; write to distinct keys to avoid race conditions. |

---

## The context object

Your `<script>` block and ` ```js ` block run inside a function that receives `context`:

```js
// Available as top-level locals in the ```js block:
arg          // named positional args       → arg.name, arg.path
flag         // named flags                 → flag.shout, flag.dry
log          // styled logger               → log.info() log.success() log.error() log.warn() log.dry()
context      // full context object
context.config  // shared mutable state for _steps/ commands

// From context:
context.paths   // resolved project paths   → context.paths.root, .api, .web, .cli, .webResources …
context.env     // process.env
context.exec    // synchronous shell command    → context.exec({ command: 'git push' })
context.stream  // async streaming shell command → await context.stream({ command: 'docker logs -f c' })
context.execute // run multiple commands sequentially → context.execute([{ command }, { command }])

// ZX globals (available everywhere):
echo()          // write to stdout
question()      // interactive prompt
$``             // shell execution
```

### log levels

```js
log.info('Starting...')       // blue
log.success('Done')           // green
log.warn('Watch out')         // yellow
log.error('Failed')           // red
log.dry('Would run: ...')     // cyan — use for --dry output
log.debug('value: ' + x)      // gray
```

### context.exec and context.stream

Every command gets `--dry` (`-d`) for free. Both `context.exec` and `context.stream` respect it automatically.

**`context.exec`** — synchronous. Use for short-lived commands where you don't need live output (git operations, quick docker commands, file manipulation):

```js
context.exec({ command: `git push origin ${flag.branch}` })
// With --dry: logs "[dry] git push origin main" without running it
// Without --dry: runs the command, output appears when it completes
```

**`context.stream`** — async. Use for long-running commands where live output matters (docker build, log tailing, bun dev, SSH sessions). In the Web GUI, output streams line-by-line as SSE events instead of appearing all at once:

```js
await context.stream({ command: `ssh ${host} "docker logs --follow ${container}"` })
// Ctrl+C cancels. Output appears in real time in both CLI and Web GUI.
```

---

## Project config — `.fli.json`

Drop a `.fli.json` in your project root to override defaults:

```json
{
  "routesDir":        "cli/src/routes",
  "defaultNamespace": "hello",
  "editor":           "code"
}
```

| Field | Default | Description |
|---|---|---|
| `routesDir` | `cli/src/routes` | Where fli scans for your project commands |
| `defaultNamespace` | `hello` | Default namespace for `fli init` |
| `editor` | `$EDITOR` | Editor opened by `fli edit` |

---

## Core commands

```bash
fli list                        # show all commands (core + project)
fli list --json                 # machine-readable output
fli <command> --help            # show usage, args, flags, examples

fli init                        # scaffold cli/src/routes/ in current project
fli make:command                # scaffold a new command file interactively
fli edit <command>              # open a command file in $EDITOR
fli gui                         # start the Web GUI at http://localhost:4444
fli gui --port 8080 --open      # custom port, open browser automatically
fli update                      # update fli itself (git pull + bun install)
fli config                      # open the global fli env file

fli keygen                      # generate a cryptographic key/secret
fli keygen --name JWT_SECRET --env   # write directly to .env
```

---

## Web GUI

```bash
fli gui                # start on http://localhost:4444
fli gui --port 8080    # custom port
fli gui --open         # start + open browser automatically
```

The Web GUI auto-generates a form for every command from its frontmatter metadata. Output streams live as the command runs, color-coded by log level.

### API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web GUI (HTML) |
| `GET` | `/api/commands` | All command metadata |
| `GET` | `/api/commands/:name` | Single command metadata + source blocks |
| `POST` | `/api/run/:name` | Run a command, returns SSE stream |

#### POST /api/run/:name

```json
{ "args": ["value1"], "flags": { "shout": true, "times": 3 } }
```

SSE event shapes:
```
data: {"type":"output","text":"HELLO, WORLD!\n"}
data: {"type":"log","level":"success","text":"Greeted World 3 time(s)"}
data: {"type":"done"}
data: {"type":"error","text":"arg [name] is required!"}
```

---

## Built-in flags

Every command gets these automatically:

| Flag | Short | Description |
|---|---|---|
| `--dry` | `-d` | Show what would run without executing |
| `--test` | `-t` | Sets `NODE_ENV=test` |
| `--step` | | Re-run a single `_steps/` step by number |

---

## Tab completion

fli supports tab completion for bash, zsh, and fish. One-time setup:

```bash
fli completion:install
source ~/.zshrc   # or ~/.bashrc, or restart your shell
```

Once installed:

```bash
fli <TAB>                  # all commands and aliases
fli dep<TAB>               # deploy, deploy:logs, deploy:run …
fli deploy:logs <TAB>      # --production, --stage, --follow, --tail …
fli db:<TAB>               # db:push, db:pull, db:reset, db:import …
```

The completion script calls `fli completion:query` on every Tab press. A disk cache at `~/.fli/completion-cache.json` makes this fast — it rebuilds automatically whenever any command file changes.

```bash
fli completion:generate             # print the shell script (auto-detects shell)
fli completion:generate --shell fish
fli completion:refresh              # force-rebuild the cache
```

---

## Environment config

```bash
WEB_DIR=frontend      # default: web
API_DIR=backend       # default: api
CLI_DIR=cli           # default: cli
DB_DIR=database       # default: db
FLI_PORT=8080         # default: 4444
```

---

## Compiler constraints

A few things to avoid inside `<script>` blocks:

**No literal triple backticks** — use a variable:
```js
const fence = '`'.repeat(3)
```

**No literal `</script>`** — split the string:
```js
const scriptClose = '</' + 'script>'
```

These only apply when your command *generates* `.md` files (like `make:command` does). Normal commands are unaffected.

---

## Dependencies

| Package | Purpose |
|---|---|
| `zx` | Shell execution (`$`), `question()`, `echo()`, `minimist` |
| `dotenv` | `.env` loading |

---

## Running tests

```bash
npm test
```

Runs two batches (the steps tests must run in a separate process due to Bun's shared module cache):

```bash
bun test tests/compiler.test.js tests/runtime.test.js tests/registry.test.js tests/server.test.js
bun test tests/zz-steps.test.js
```
