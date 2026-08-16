# Idea — the command surface: what `fli` should learn from oclif

**Status: IDEA. Nothing here is built.** Dated 2026-08-10. Written after sizing
`packages/cli` against oclif, Salesforce's CLI framework. Do not cite this file as
describing behaviour — see `VERIFYING.md`.

---

## Why oclif is the comparison

`fli` is not a flag parser with commands bolted on. A command is a `.md` file —
prose, frontmatter and a fenced body — compiled to JavaScript and run, and no other
CLI framework does that. Against commander or yargs the comparison is not close, and
against oclif it is not the same axis at all: **oclif solves distribution and rigour,
`fli` solves authoring.** The question worth asking is therefore not *should we
switch* but *what does a CLI that ships to strangers need that a CLI used from its own
checkout never demands.*

Five answers, and they are not evenly weighted. The first repays itself immediately
because it closes a defect class this repo has already paid for twice; the last two
are cheap. The whole list is smaller than one wave of framework work.

What `fli` already has, so it is not proposed here: registry over 197 command files
with project overrides, frontmatter args and flags with short chars, enum `options`,
required args *and* flags, namespace modules with an env `requires:` gate,
`--dry` threaded through `exec`/`stream`, `--project`, `--debug`, did-you-mean
suggestions, shell completion for bash/zsh/fish, `_steps/` orchestration, a web GUI
over SSE, and the port broker.

---

## 1. A package ships its own commands

**The observation.** A command comes from exactly two places: `<fliRoot>/commands/`
and the project's `cli/src/routes/`. A *package* cannot contribute one. So a command
that belongs to `@frontierjs/auth` is written into the CLI's tree instead, and
`commands/auth/install.md` now carries a hand copy of auth's schema fragments —
recorded as a live hazard in the CLI's own `CLAUDE.md`, and it has drifted before.
The bridge index lists it under *duplication worth closing*.

The same shape reaches further than one file. Three packages' docs advertise `fli`
commands that do not exist, which is what happens when the package that owns the
capability cannot own the command that invokes it.

**The proposal.** A package declares its commands and the registry finds them —
`"fli": { "commands": "./commands" }` in the manifest, resolved from the project's
dependency tree, namespaced by the package rather than by the directory it landed
in. oclif does this with `plugins:install` from npm plus a plugin list in the user's
config; the FJS version is narrower and better, because the dependency tree is
already the declaration and no second install step is needed.

**Why it ranks first.** It converts *keep two copies in sync* into *there is one
copy*. It is also the same mechanism `IDEAS/slices.md` needs — a slice that
contributes a model, a service and a Resource should be able to contribute the
command that installs it, and 3.1 (bare-specifier `.lite` imports) kills the auth
hand-copy from the schema side while this kills it from the command side. Do both
and the file has no reason to exist.

**Watch for:** command name collisions across packages, which oclif resolves by
precedence and a warning. The registry already has that rule for project-over-core;
it needs a third tier and a way to say which one answered.

## 2. Every command answers a machine

**The observation.** `--json` exists on exactly one command, `fli list`. Everything
else prints for a human, and every failure exits `1` — `bin/fli.js` catches the throw,
prints one red line and exits, so a script cannot tell *the flag was wrong* from *the
deploy failed* from *the SSH host is down*.

**The proposal.** Three parts, all small:

- `--json` as a global contract rather than a per-command courtesy. oclif's
  `enableJsonFlag` is the shape: a command returns a value, the framework decides
  whether to render it or serialise it. `fli`'s `run(context)` already returns
  `context`, so the return channel exists and nothing reads it.
- A JSON error envelope on the same switch — code, message, the command, and the
  suggestions the did-you-mean engine already computes.
- Exit codes with meaning. Signals are already right (130/143); the rest is one
  table — usage error, refused precondition, the command's own failure.

**Why it matters more here than in oclif.** This is the CLI half of
`IDEAS/agent-surface.md`. A registry of 197 commands, each with a described,
typed flag set and a machine-readable result, **is** a tool catalogue — the same
derivation `herald` proposes over services, over a surface that already exists and
already has descriptions written by hand. Nothing else in this list changes what the
framework can be pointed at.

## 3. The reference is generated, and the drift is a test failure

**The observation.** The CLI's own `CLAUDE.md` says it plainly: *the edges are
aspirational — several documented commands do not do what the prose says, and three
packages' docs advertise `fli` commands that do not exist.* That is a documentation
problem with a mechanical fix, in a tool whose commands are already prose.

**The proposal.** `fli docs` renders the reference from the registry — every command,
its description, args, flags, examples, and the namespace overview `_module.md`
already carries. oclif does this as `oclif readme` and it is unremarkable there;
here it is nearly free, because the input is markdown that a human already wrote for
a human.

The second half is the one that pays. A test asserts every `fli <command>` mentioned
in any package's markdown resolves in the registry. That is a grep and a Map lookup,
it runs in CI, and it makes the entire class — *docs advertising a command that does
not exist* — impossible to reintroduce rather than merely fixed once.

**Watch for:** the fenced-block rule. A `_module.md`'s fences are stripped, because in
a command file a fence IS the body; a doc renderer reading module prose has to know
that, and it is exactly the kind of thing the renderer should state once.

## 4. Flag relations belong in frontmatter

**The observation.** A flag today declares `type`, `char`, `description`,
`defaultValue`, `required` and `options`. Everything else a real command needs is
hand-written inside the body, or not written at all. `deploy:doctor` declares
`--production` and `--stage`, which are mutually exclusive, and nothing says so:
pass both and the command picks one silently.

**The proposal.** The vocabulary oclif settled on, in frontmatter, validated once by
the runtime instead of per command: `exclusive`, `dependsOn`, `exactlyOne`,
`multiple` (a flag given more than once collects), `env` (a flag backed by an
environment variable — the namespace `requires:` gate is already half of this), and
`allowNo` for `--no-x`.

**Why it is more than parity.** Every one of these is a fact the command file already
knows and currently states in prose above the fence, where nothing reads it. Declared,
they reach three readers at once: the runtime refuses the bad combination, `--help`
renders it, and completion (item 2's sibling) can stop offering a flag that the
already-typed one excludes. That is the same *declare it at the boundary* argument
the rest of the framework runs on, applied to the one surface that has been getting
it by convention.

## 5. A command can be run by a test

**The observation.** The parse sweep is a real invariant (15) and it has a stated
hole: it compiles each command with **no module script**, so a command using a
namespace helper parses whether or not the helper exists. The CLAUDE.md's own advice
for that gap is *run the command*, which nothing automated does. `_steps/` chains are
in the same position — `zz-steps.test.js` exercises the orchestration, not the steps
as a user meets them.

**The proposal.** Export `runCommand(name, { args, flags, dry })` — resolve through
the real registry, compile with the real module script, capture the output, return
the context. `--dry` already makes this safe for the majority of commands, because
`exec` and `stream` both honour it and print instead of running.

oclif ships `@oclif/test` for exactly this and it is the least interesting item on
their list; here it is the one that closes a hole the repo has already written down.

---

## 6. `fli tinker` — a console that boots at a gate level — **shipped 2026-08-15**

`litestone repl --as alice@example.com --gate ./api/gate.ts`, and `fli tinker`
over it. `db` is the standing you asked for; `sys` is `asSystem()`.

**Three of this record's claims were wrong and the corrections are the useful
part.** It said there is no REPL anywhere and every grep hit for `repl` is inside
the word `replace` — `litestone repl` had shipped, with a preload and a
subprocess. It said there is no `bun repl` and the subcommand falls through to
`bun run` — on bun 1.3.11 it prints a welcome banner and works. And it said the
interesting version, booting as a principal, does not exist: **Studio had it
already.** `POST /api/repl` evaluates arbitrary expressions with `db` bound to
`activeDb.$setAuth(pickedUser)`, `sys` bound to `asSystem()` beside it, every
statement tapped through `$tapQuery`, and an auth picker fed from the `@@auth`
model.

So the engine existed twice and the item was a terminal door. Which leaves the
lesson: **this record was written from a grep and the grep was for the wrong
word.** The `only` claim was right, the inventory was not, and a survey that had
opened Studio would have found the whole thing.

**What genuinely was not there, and it is the rule the item rests on.** A
subprocess REPL owns its prompt, so it cannot say what it is running as — and a
console that does not show its standing is a god-mode console with an extra flag.
`bun repl` + a temp file + `.load` + two fixed sleeps became `node:readline`
hosted in the command's own process, which also removed the restriction that the
REPL could not run from a standalone binary.

**`--gate <path[#export]>` is the flag the feature turned out to need, and it is
the whole honesty of it.** Without it a console grades with
`FrontierGateGetLevel` — the default resolver, not necessarily the one the app
installed. Measured on `example`: the default grades `ops@acme.test` at 3
(CREATOR); the app's own `shopGateLevel` grades the same row at 4 (USER); `Order`
is `@@gate("0.4.4.5")`, so a create is refused in the console and permitted in
the app. A console that is *approximately* somebody's session is worse than no
console, because you act on what it shows you. The banner names which resolver
answered.

**`--as` and `--level` stayed separate**, which this record had right for the
right reason. One runs a resolver over a real row; the other fixes the answer. A
ladder walked with the second says nothing about whether the first works — the
same split `createTestEnv` keeps between `actingAs` and `atLevel`. A `--level`
standing also has no `auth()`, so every `auth().id ==` row policy matches nothing
and its model answers an empty list rather than refusing, which the console says
out loud because the two are indistinguishable from the result.

**A trap that has nothing to do with consoles and would bite any of them.**
`rl.pause()` does not hold back lines readline has already buffered, so a pasted
block fires every handler and the statements complete in whatever order their
awaits finish — against a database, writes landing in an order nobody wrote.
Serialising is a promise chain, and `close` has to await it too.

**What is left is the `M` this record predicted, and it is the API realm.** `db`
and nothing above it: a console over the app's *services* — hooks, the result
envelope, custom methods — is `@frontierjs/testing`'s `as(user).service(name)`
handed to this prompt, which needs the app booted rather than the schema read.
And `asSystem()` is reachable here but not attributed to the operator, which is
the same question `IDEAS/compliance-from-the-seed.md` §6 asks about support mode
and should be answered once for both rather than twice.

---

## Smaller, still worth doing

| Item | Why |
| --- | --- |
| ~~**A manifest**~~ | **Built 2026-08-10, and the measurement moved the answer.** `buildRegistry()` did re-parse ~200 files per invocation, but at 13-23ms it was never the cost: `module.register()`'s hooks thread was 56ms and zx was ~85ms, on every `fli list`. All three are gone — a per-file frontmatter cache under `~/.fli/cache/` keyed by mtime+size, no `.md` loader hook, and no zx on the read-only path — and a read-only invocation is ~119ms where it was ~306ms. Not oclif's shape: a manifest built at pack time cannot see a command file dropped into a project, and that is the authoring model |
| **Spaced subcommands** | `fli deploy logs` alongside `fli deploy:logs`. oclif makes the separator configurable. The colon is already fighting bash, which splits words on it — `completion/generate.md` passes the raw `COMP_LINE` specifically to dodge that |
| **`deprecated` / `state: beta`** | One frontmatter key, a warning on use. There is no way today to retire a command or an alias except to delete it and let somebody's script break |

## Not proposed, and why

**Self-update and packaged installers.** oclif's `plugin-update`, S3 channels,
`.pkg`/`.exe`/Homebrew builds. This is the largest thing oclif does that `fli` does
not, and it is aimed at a CLI distributed outside a package manager to people who do
not have Node. `fli` ships on npm to people who already have it; `npm i -g` is the
update mechanism and a version-check warning is the whole remainder.

**A `Command` class hierarchy.** oclif's inheritance model is how a TypeScript CLI
shares behaviour between commands. `_module.md` already answers that here, from the
namespace rather than from a base class, and it answers it in the language the
command is written in.

---

## See also

- `IDEAS/agent-surface.md` — item 2 is its CLI half; the registry is already a tool catalogue with the descriptions written
- `IDEAS/slices.md` — item 1 is the command-shaped part of the same mechanism (3.1, 3.2)
- `IDEAS/diagnostics.md` — `fli doctor` is the other half of item 3: one turns the hazard list executable, the other turns the command list honest
- `packages/cli/CLAUDE.md` — the traps each of these is aimed at
- `ISSUES.md` `FJS-158` — the temp-root defect found during this audit. Closed; it is not one of these five, it is what a global install does today
