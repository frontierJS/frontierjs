---
id: zx-exit
status: shipped
dated: 2026-10-05
---

# Idea — leaving zx: `$` is the command in progress

**Status: SHIPPED 2026-10-06** — `FJS-D593`, `FJS-D594`, `FJS-D595`; Phases 0–4 landed as `docs/changes-archive/cli.md` records. Dated 2026-10-05 as written; Every count below is
an `rg` over `packages/cli` on that day and every runtime claim was probed against
`bun-1.4.2`; nothing is read off release notes. Do not cite this file as behavior —
see `VERIFYING.md`.

zx is the heaviest of the cli's dependencies and the one every compiled command
imports. This file is the order to remove it in, what replaces each piece, and the
one decision that has to come first.

---

## 1. What zx is actually doing here

Less than its footprint suggests. The compiler wraps a ```` ```bash ```` fence in
``await $`…` `` and imports `zx/globals` at the head of every shim — but the
commands never took the shell up on it.

| zx piece | Where it is used | Count |
| --- | --- | --- |
| ```` ```bash ```` fences | none — 387 ```` ```js ```` fences, zero `bash`/`sh` | 0 |
| ``$`…` `` template | `make/factory.md` (`$EDITOR file`), `ksite/serve.md` (`command -v bun`) | 2 sites |
| `echo` | command bodies | 97 files |
| `question` | `deploy/_steps-*`, `git/commit`, `auth/*`, `ksite/*`, `github/clone`, `npm/unpublish`, `ai/ask`, `project/new` | 16 files, ~25 sites |
| `chalk` | `project/map.md`, `register/overview.md` + 3 others; 7 CHAINED calls (`chalk.bold.cyan`) that `core/color.js` refuses on purpose | 5 files |
| `path` (global) | command bodies | 20 files |
| `fs` (fs-extra) | `readFileSync`, `readdirSync`, `existsSync` only | 3 files |
| `sleep` | `ksite/fetch.md` | 2 sites |
| `tmpdir` | `register/decide.md` | 1 site |
| `argv`, `fetch`, `kill`, `ps`, `YAML`, `glob`, `which`, `retry`, `spinner`, `within`, `cd`, `quote`, `dotenv`, `minimist` | not used as zx globals (`argv`/`kill` hits are `process.*` and own helpers) | 0 |

`core/*.js` imports zx in exactly one file, `runtime.js`, for two things: the
`import 'zx/globals'` that makes the shim's free identifiers resolve, and `chalk`,
which it then overrides with a 10-line `plainChalk` proxy because zx's chalk
colors a `NO_COLOR` terminal and styles through `.hex` at level 0.

**What zx costs that nobody asked for:**

- **~110ms per command.** `bun -e "import 'zx/globals'"` is 113ms over a 4ms
  baseline, best of 10; under node 141ms over 29ms. The read-only path already
  dropped it (`fli list` went from ~200ms to ~115ms); every real command still pays.
- **The shim's location is a constraint** (`FJS-166`). A shim must sit where Node
  can walk up to a `node_modules` holding zx, which is why `fliTmpRoot()` symlinks
  `node_modules` beside the fallback dir under a global install. No other bare
  specifier is imported by any command's `<script>` block — every
  `@frontierjs/*` import in a command file is inside a template of generated
  code — so the whole mechanism exists for one import.
- **`log` is a zx global.** A `_module.md` `<script>` that reaches for `log`
  resolves zx's `log` FUNCTION and dies at `log.info is not a function`
  (`packages/cli/CLAUDE.md` § What bites). Without zx it is `log is not defined`,
  which names the problem.
- **`echo` is shadowed by hand.** The web/SSE runner cannot patch `globalThis.echo`
  without crossing requests, so the shim head does `const echo = context.echo ??
  globalThis.echo`. One owner for `echo` retires the dance.
- **Two chalks.** `core/color.js` for the startup path, zx's for a command body,
  reconciled by the `plainChalk` proxy in `runtime.js`.

---

## 2. The decision that comes first: what runtime `fli` is

`packages/cli/package.json` declares `"engines": { "bun": ">=1.4.0" }` (since
2026-09-20). `bin/fli.js` carries `#!/usr/bin/env node`. `packages/cli/CLAUDE.md`
says both — *the shipped shebang is node, but `fli` re-invokes itself with
`process.execPath`, so it runs under whichever runtime started the parent* (line
527) and *`fli` runs under node* (line 936). `IDEAS/bun-natives.md` deferred every
cli native with *revisit only if `fli` ever moves to bun, which is its own decision*.

**That decision is unmade and this plan cannot start without it**, because the
replacement shell is either `Bun.$` or it is not. The code and the document
disagree, which is a hearing under `decision-rules`, not a preference.

| | **A — `fli` runs under bun; `Bun.$` is the shell** | **B — `fli` stays dual-runtime; own `$` over `spawn('bash', ['-c'])`** |
| --- | --- | --- |
| Shebang | flip `bin/fli.js`, `bin/server.js`, `bin/diagnose.js` to `#!/usr/bin/env bun` | unchanged |
| Shell semantics | Bun's shell: `&&`, `\|`, redirects, `$(…)`, `if`, globs all probed OK; **no heredoc, no `for`/`while`** — `bash -c ${script}` is the escape hatch | real bash, everything works, **no Windows** |
| Result shape | `ShellError`/`ShellOutput`: `.exitCode`, `.stdout` (Buffer), `.stderr`, `.text()`, `.json()`, `.lines()`, `.quiet()`, `.nothrow()`, `.cwd()`, `.env()` — zx's names | whatever we write (~80 lines) |
| New code | ~40 lines wrapping `Bun.$` with fli's rules | ~80 lines + quoting of interpolations, which is the part zx got right over years |
| `FJS-D222` | *a harness runs under node* — `scripts/ci.mjs` stays node and `fli ci` only forwards to it, so the harness is untouched; `fli check` becomes a bun process the harness spawns, which D222 permits (*a package runs under what it needs*) | nothing to rule |
| Opens | `Bun.sleep`, `Bun.which`, `Bun.Glob`, `Bun.YAML`, `Bun.secrets` for deploy credentials, `Bun.Terminal` for `tty.js` — every row `bun-natives.md` deferred on *fli is node* | nothing |

**Recommend A.** The engines field already says it, every test and CI invocation
already runs `fli` under bun, junction and litestone's client are bun-only so an
app's `fli` cannot run where its API cannot, and the one argument for node — D222 —
is about harnesses, and `fli` is not one: `fli ci` forwards to `scripts/ci.mjs`
and owns nothing. Record it as a ruling that NAMES D222 and says why it does not
apply; amend `packages/cli/CLAUDE.md` lines 527 and 936 in the same commit.

Either way the rest of this file holds; only § 4's `core/shell.js` body differs.

---

## 3. The design: `$` is the command in progress

**`$` is the context.** Today a command body receives `context` and destructures
`flags, args, flag, arg, log, tty, answers` from it. The proposal is that the
object is spelled `$`, is CALLABLE as the shell tag, and carries everything a body
reaches for — so the shim head becomes:

```js
import path from 'node:path'
import fs   from 'node:fs'
<module script>
<own script>

export const metadata = {…}

export async function run($) {
  const { flags, args, flag, arg, log, tty, echo, chalk } = $
```

and a body reads

```js
const sha = (await $`git rev-parse HEAD`).text().trim()
$.exec({ command: `rsync …`, cwd: $.paths.root })
echo(`${chalk.dim('→')} ${sha}`)
const ok = await tty.line('Continue? (y/N) ')
```

**Why `$`, and not a fourth noun.** It is already the framework's spelling for
*the thing in progress*, realm by realm: Junction's ambient `$` is the call in
progress (`enterCall`/`currentCall`, root `CLAUDE.md` Invariant 10 names it);
Mesa's `$` is the component runtime (*everything the runtime offers is on `$`* —
`tutor/_steps-app/09-mesa.md`). A command in progress is the same idea in the
third realm's tooling, so knowing one teaches the next (§ V q4). It also happens
to be what zx trained every author to type for a shell, so the two live uses
compile unchanged. No command body uses a bare `$` identifier today — every hit is
inside a string (`$EDITOR`, `$HOME`, `$(fli …)`).

**It is a parameter, not an ambient.** Junction needs `AsyncLocalStorage` because a
service hook has no handle; a command body is one function with one argument, and
a parameter is concurrency-safe for free, which is exactly what the web runner's
`globalThis.echo` workaround was paying for. A `_module.md` helper that wants `$`
takes it as a parameter, as `tutor/_module.md`'s `startServer(context, …)` already
does.

**The injected globals are three: `$`, `path`, `fs`.** `path` and `fs` are node
builtins — they resolve from anywhere, cost nothing, and 23 files use them without
importing — so the shim head imports them rather than making 23 files grow a
`<script>` block. Everything else is destructured from `$`, so the free-identifier
budget (`IDEAS/shipped/scope-checking.md` § 3) drops from zx's ~45 names to three, which is
small enough to write down and GRADE. The alternative — `$` alone, explicit imports
in each file — is cleaner by one rule and costs 23 edits plus every future
command's first two lines; the owner picks.

**`$` is built once, in `runtime.js`,** where `config` is built today — a Proxy
over a function whose `get`/`set`/`has` traps read the same `config` object, so
the thing parallel steps share (`context.config`) is unchanged, and `apply` is the
shell. No second object, no copy.

### What `` $`…` `` means

- **Runs under Bun's shell** (route A) with interpolations escaped as single
  arguments, which is zx's rule too. Bun's shell has no heredoc and no `for`/`while`
  (probed: both exit 1); a fence that needs bash spells `` $`bash -c ${script}` ``,
  and this is a hazard line in the package `CLAUDE.md`, not a surprise.
- **Captures by default, prints under `--verbose`.** zx's default; `Bun.$`'s
  default is the opposite (stdout inherits), so the wrapper applies `.quiet()`
  unless `$.flag.verbose`. The one existing `.quiet()` call becomes a no-op and
  can go.
- **Honors `--dry` the way `$.exec` does** — logs the command at `dry` level and
  resolves to an empty result. Two ways to run a shell with two dry rules is one
  owner too many (Invariant 4); the rule lives in one place and both call it.
- **`.stdout` is a Buffer**, where zx's was a string. Neither live site reads it;
  a hazard line says `.text()`.
- **A non-zero exit throws** `ShellError` with `.exitCode`, `.stdout`, `.stderr`,
  as zx's `ProcessOutput` did; `.nothrow()` to opt out. The runtime's existing
  signal handling (SIGINT → 130) wraps it the same as `$.exec`.

### What replaces `question`

`tty.line(prompt, { default })` in `core/tty.js`, beside `keys()`. This closes
**`FJS-1406`** (*a command's `tty` has one-key input and no line input, and the line
input a markdown command does have is zx's*). Same rules as `keys()`: `--yes`
answers the default, a run with no terminal refuses BY NAME rather than hanging on
stdin, and the web runner gets a `{ type: 'question' }` event instead of a
`readline` nobody is attached to. The 25 `question(` sites become `tty.line(` in
the flip commit; nothing is kept under the old name.

### What replaces `chalk`

`core/color.js`, which already exists and is chalk-compatible for every
non-chained call the package makes. The 7 chained sites (`chalk.bold.cyan(x)`,
`chalk.cyan.bold(x)`, `chalk.bold.hex(…)(x)`) become nested calls; `color.js` stays
chain-free, as its header says it must. `runtime.js`'s `plainChalk` proxy and
`globalThis.chalk` assignment go. `IDEAS/overview.md` 5.21 (a tone vocabulary
instead of color names) is then a one-file change and is not part of this.

---

## 4. The order

Each phase ends green on the cli suite (`cd packages/cli && bun run test`),
`fli check`, and `bun run ci:fast`; the proof drives are `fli proves --from main`.

**Phase 0 — the runtime ruling.** Half a day. Run `decision-rules` on § 2; write
the `FJS-D###`. Under A: flip the three shebangs, run the whole cli suite and a
hand smoke of `fli list`, `fli help`, `fli version`, `fli check`, `fli ci --dry`,
`fli new` into a temp dir under bun; fix what breaks (expected: nothing — every
test and CI run is already bun). Amend `packages/cli/CLAUDE.md` lines 527/936 and
`IDEAS/bun-natives.md`'s *fli is node* premise. **Then run the nine against the
rest of this file** — late answers are named as late.

**Phase 1 — build beside, zx still installed.** One day. Additive only; nothing a
command sees changes yet.

- `core/shell.js` — `shellFor($)`: the tag, with the quiet/verbose/dry rules
  above. Test: dry logs and runs nothing; non-zero throws with `.exitCode`;
  interpolation with a space is one argument; `--verbose` streams.
- `core/tty.js` — `line(prompt, { default })`. Test beside `keys()`'s: `--yes`,
  no-terminal refusal, web event.
- `core/runtime.js` — build the callable `$` over `config`; `config.echo` defined
  on the CLI branch too (writes stdout) so there is one owner; `config.chalk` from
  `color.js`.
- Rewrite the 7 chained-chalk sites to nested calls (they compile under either
  chalk).

**Phase 2 — the flip.** One day, ONE commit, because a half-renamed tree runs
nothing.

- `core/compiler.js` — the head in § 3. `compiler.test.js` asserts on
  `import 'zx/globals'`, `run(context)` and the `bash` wrapper change with it.
- Codemod, mechanical and reviewed as a diff: `context.` → `$.` (1,696 refs in 368
  command files, plus `example/cli/src/routes/` and the generator templates that
  write an app's commands, so `fli make:cli` emits `$`); `(context,` parameters in
  `_module.md` helpers; `question(` → `tty.line(`; `sleep(` → `Bun.sleep(`;
  `tmpdir()` gains its `node:os` import; `fli ni zx dotenv` in `npm/install.md`
  names some other package.
- `README.md` § The context and `CLAUDE.md` move with the code (`doc-hygiene`).
- Compile every command (`core/registry.js` knows them all) and scan the shims for
  free identifiers outside `$`, `path`, `fs` and JS/node globals. This is the
  check `FJS-730` wanted and `IDEAS/shipped/scope-checking.md` costed; with three injected
  names its false-positive budget is three lines. It lands as a `fli check` rule
  over an app's commands and runs over fli's own in the `structure` phase — the
  `core/checks.js` shape, one engine, two callers.
- Tests touched: `compiler.test.js` (3 asserts), `tty.test.js` (zx chalk comment
  and `echo` identity), `make-resource.test.js`, `zz-steps.test.js`, the 5 tests
  that build a context and call `run()`.

**Phase 3 — delete.** Half a day.

- `package.json` drops `zx`; `bun.lock` follows; `fli ws:exports` and the
  repo-atlas snapshots regenerate (the `snapshots` phase fails them stale).
- `runtime.js`: `import 'zx/globals'`, `import { chalk } from 'zx'`, `plainChalk`,
  the `globalThis.echo` comments.
- `utils.js` `fliTmpRoot()`: the `node_modules` symlink fallback goes — a shim
  imports nothing bare, so the constraint it served is gone. The directory
  fallback itself stays (a root-owned prefix is still not writable).
  `project-root.test.js`'s symlink case becomes *the compiled shim contains no bare
  specifier*, which is the assertion that keeps `FJS-166` closed.
- Docs: `README.md` lines 119, 349, 540–545, 576; `CLAUDE.md` 590–604, 911;
  `color.js` header; `IDEAS/terminal-surface.md` § 1 and `scope-checking.md` § 3
  mention zx as present tense.
- `CHANGES.md` entry; `ISSUES.md` closes `FJS-1406`.

**Phase 4 — prove.** `fli proves --from main`, `fli prove`, `fli done`, and four
things no suite covers:

1. **Time.** `fli <command>` wall time before and after, 10 runs, same command —
   the claim is ~110ms per invocation and it is written down with the number.
2. **Global install.** `bun pm pack`, `npm i -g` the tarball into a root-owned
   prefix, run one command — the `FJS-166` class, now without the symlink.
3. **Two concurrent web runs** each `echo` into their own SSE stream — the thing
   the `globalThis.echo` shadow was for.
4. **`fli make:factory --open`** — the editor must come up on the terminal.
   `tty.aside()` already exists for *the screen lent to an editor*; this site
   should use it rather than `` $`${editor} ${file}` ``, which inherits no stdin
   under zx or Bun.

---

## 5. What dies

`zx` and its ~110ms · `plainChalk` and `globalThis.chalk` · the `globalThis.echo`
shadow and its two comments · the `node_modules` symlink fallback in
`fliTmpRoot()` · the `log`-is-a-zx-function hazard · `question` as a free global ·
two chalks · `.quiet()` on `command -v bun`.

## 6. What a package `CLAUDE.md` gains

Three hazard lines, written when the code lands: Bun's shell is not bash (no
heredoc, no loops; `bash -c ${script}`); `` $`…` `` captures and `.stdout` is a
Buffer, read `.text()`; a `_module.md` `<script>` sees `$` only as a parameter.

---

## The nine questions

- **Another origin of truth?** Fewer. `echo`, `chalk` and the dry rule each go
  from two owners to one; the shim's resolution constraint goes from a comment in
  three files to nothing.
- **Concept budget?** Zero new nouns. `$` is the existing spelling for *the thing
  in progress* in Junction and Mesa; `tty.line` is a sibling of `tty.keys`.
- **Whose complexity?** The problem's shrinks: zx was carrying 45 globals so that
  commands could use nine, and a symlink so that one import could resolve.
- **Predictability?** `$` in a command, `$` in a service, `$` in a component —
  one lesson. `tty.line` behaves as `tty.keys` does under `--yes` and without a
  terminal.
- **Derived rather than restated?** The runner column is already derived
  (`FJS-D222`); the injected-globals list is the compiler's head and the check
  reads the same list, not a copy.
- **One owner?** `core/shell.js` owns *run a shell*, `core/tty.js` owns *ask the
  person*, `core/color.js` owns *color* — each already does or was about to.
- **Boundary named, typed, tested?** `run($)` is the boundary; what `$` carries is
  `README.md` § The context; `shell.js` and `tty.line` get tests beside their
  siblings.
- **Failure proportional?** A missing `question` is a `ReferenceError` at compile
  of the one file, not a hang on stdin; a fence that needs bash fails loudly with
  Bun's own message.
- **Can it be wrong silently?** Yes in one way: a command reaching for a name zx
  used to inject, in a branch no test runs. **Artefact:** the free-identifier
  check in Phase 2, over every compiled command, in the `structure` phase.

**Adjudication named:** § IV *doctrine vs. discovery* for § 2 — the engines field,
the shebang and the package `CLAUDE.md` disagree, and the hearing is Phase 0 rather
than a side taken here; *preservation vs. evolution* — the `context` spelling
and the `question` name are this framework's own past and are owed nothing;
*batteries vs. smallness* for the shell — Bun's is the runtime's, severable by
construction. *Familiarity vs. precision* is **not** the row: zx's `$` is an
ecosystem habit and it is being kept because it is precise here, not because it
is familiar.

**Tier:** § VII *Assessment* until Phase 0's ruling, which is *Register*.

## Open questions

- ~~**What runtime is `fli`?**~~ **Answered 2026-10-06 (`FJS-D593`): A — `fli` runs under bun; `Bun.$` is the shell. The three shebangs flip, a missing bun is refused by name, and `create-frontier` (reached through `npm create`, so still node) spawns `bun` rather than `process.execPath`.** `package.json` says `engines.bun >= 1.4.0`, the three
  shebangs say node, and the package `CLAUDE.md` says both. § 2 is the hearing.
  - **A** — `fli` runs under bun; `Bun.$` is the shell. The three shebangs flip, a
    missing bun is refused by name, and `create-frontier` (reached through `npm
    create`, so still node) spawns `bun` rather than `process.execPath`.
  - **B** — `fli` stays dual-runtime; its own `$` over `spawn('bash', ['-c'])`, no
    Windows.
  - **Recommend A** — the engines field already says it, every test and CI
    invocation already runs `fli` under bun, and junction and litestone's client
    are bun-only, so an app's `fli` cannot run where its API cannot. `FJS-D222`
    does not bind: it rules that a HARNESS runs under node, and `fli` is not one —
    `fli ci` only forwards to `scripts/ci.mjs`, which stays node, and `fli check`
    is a package the harness spawns, which D222 permits (*a package runs under
    what it needs*). The one node-only argument, `IDEAS/bun-natives.md`'s *fli is
    node*, was a premise and not a ruling.
- ~~**Which names does the compiled shim inject?**~~ **Answered 2026-10-06 (`FJS-D594`): A — three: `$`, `path`, `fs`. The two builtins resolve from anywhere and 23 command files use them without importing.** Everything else is destructured
  from `$`.
  - **A** — three: `$`, `path`, `fs`. The two builtins resolve from anywhere and
    23 command files use them without importing.
  - **B** — `$` alone; each file imports what it uses.
  - **Recommend A** — three names is a list short enough to write down and grade,
    and B costs 23 edits plus the first two lines of every future command for one
    rule fewer.
- ~~**What replaces zx's `question()`?**~~ **Answered 2026-10-06 (`FJS-D595`): A — `tty.line(prompt, { default })` beside `tty.keys()`, with the same rules: `--yes` answers the default, no terminal refuses by name, the web runner gets an event.**
  - **A** — `tty.line(prompt, { default })` beside `tty.keys()`, with the same
    rules: `--yes` answers the default, no terminal refuses by name, the web
    runner gets an event.
  - **B** — keep `question` as a name destructured from `$`.
  - **Recommend A** — the input already has an owner, `core/tty.js`, and
    `FJS-1406` is the measurement that a second one beside it breaks the first.
