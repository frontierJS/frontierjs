# cli (`fli`) — package map

**A markdown-native command runtime.** A command is a `.md` file: prose and
fenced code, compiled to JavaScript and run. 197 command files. Scaffolds,
deploy, the workspace/release commands and the port broker live here.
`bun run test` (bun).

---

## Layout

```
bin/       fli.js (the entry) · server.js · diagnose.js
core/
  compiler.js   .md command → JavaScript
  runtime.js    executes a compiled command
  registry.js   command discovery and resolution
  prose.js      the markdown side
  config.js · bootstrap.js · ports.js · utils.js · server.js
commands/  one directory per namespace — db, auth, api, web, site, deploy, git,
           github, npm, env, make, project, ports, browser, crypto, fetch, ai,
           cloudflare, caprover, completion, admin, literate, utils, fli
cli/src/   the CLI's own source tree
web/       the browser-facing side
tests/     compiler · runtime · registry · server · deploy · project-root · steps
```

---

## What bites here

- **A clean compile is not proof of valid JS** (Invariant 15). Compiling all 195
  command files and *parsing* the output found 14 producing broken JavaScript
  that the compiler reported as fine. Every command file now has a parse test —
  a new command needs one too.
- **`commands/auth/install.md` carries a hand copy of `@frontierjs/auth`'s
  schema fragments.** Change one, change both; it has drifted before.
- **A git question asked from a package directory answers repo-wide.** In this
  repo every member shares one `.git`, so `git status --porcelain` and
  `git describe --tags` run from `packages/mesa` describe the whole monorepo —
  which had all sixteen `ws:*` rows reporting one another's state. Ask through
  `context.git.pkgState(name, dir)`, which uses a pathspec and the
  `<name>@<version>` tag scheme. `context.wsRepo(packages)` is the other half:
  it says whether a release should be one commit or one per package.
- **A fenced block in a `_module.md` renders as an empty heading.** Module prose
  has every ``` block stripped, because in a command file a fence IS the body.
  Namespace overviews are written as plain lists.
- **The parse sweep compiles each command with NO module script**, so a command
  using a `_module.md` helper parses whether or not the module defines it. Run
  the command.
- **The edges are aspirational.** Several documented commands do not do what the
  prose says, and three packages' docs advertise `fli` commands that do not
  exist. Verify a command by running it before citing it.
- The port broker implements the FJS port scheme; the scheme itself is documented
  in `packages/jetty/src/dev/fjs-ports.js`.

## Proving a change

`bun run test`. There is no browser drive for `fli` — a change to a scaffold is
proved by scaffolding into a temp directory and running what comes out.
