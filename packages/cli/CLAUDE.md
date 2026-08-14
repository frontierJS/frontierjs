# cli (`fli`) — package map

**A markdown-native command runtime.** A command is a `.md` file: prose and
fenced code, compiled to JavaScript and run. 202 command files. Scaffolds,
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
  checks.js     the architecture rules — shared with scripts/ci.mjs
  config.js · bootstrap.js · ports.js · utils.js · server.js
commands/  one directory per namespace — db, auth, api, web, site, deploy, git,
           github, npm, env, make, project, ports, browser, crypto, fetch, ai,
           cloudflare, caprover, completion, admin, literate, utils, fli
cli/src/   the CLI's own source tree
web/       the browser-facing side
tests/     compiler · checks · runtime · registry · server · deploy · project-root · steps
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
  the command. This is not theoretical: `completion/_module.md` used `join`,
  `homedir`, `existsSync` and `statSync` without importing any of them, so all
  five completion commands threw `join is not defined` and **Tab completion had
  never worked**, while every suite stayed green (`FJS-167`).
- **Nothing on the read-only path may import zx.** zx is ~85ms of what was a
  ~200ms invocation, and `fli list`, `help`, `?` and completion wanted one thing
  from it — chalk, which is now `core/color.js`. The same rule is why
  `bootstrap.js` imports `runtime.js` at the call site rather than at the top: a
  static import pulls zx back in for every `fli list`. A command body is
  unaffected, since its compiled shim imports `zx/globals` itself.
- **`module.register()` costs 56ms because it starts a hooks thread**, and the
  `.md` loader hook is not what runs a command — the runtime compiles WITH the
  namespace module script (which a hooks thread cannot see) and imports the
  shim. No entry point registers it.
- **The edges are aspirational.** Several documented commands do not do what the
  prose says, and three packages' docs advertise `fli` commands that do not
  exist. Verify a command by running it before citing it.
- **A compiled command is a real file, so where it may be written is a
  constraint, not a detail.** The shim imports `zx/globals` by bare specifier and
  Node resolves that from the importing file's own directory — which is why the
  location is `fliTmpRoot()`'s decision in `core/utils.js` and nobody else's, and
  why the read-only fallback symlinks `node_modules` beside the shim. The
  workspace copy is always writable, so nothing here can see the install shape
  that is not (`FJS-166`).
- The port broker implements the FJS port scheme; the scheme itself is documented
  in `packages/jetty/src/dev/fjs-ports.js`.
- **`ws:exports` writes the published-surface snapshot, and it asks the packer.**
  `bun pm pack --dry-run` per publishable package, then every `exports` subpath,
  `bin`, `main` and `types` target is looked for in that listing. Two things it
  is easy to get wrong and both were: npm's `files:` globs have their own rules
  (a bare directory name means everything under it, README/LICENSE/package.json
  are always in), so the listing is asked for rather than derived; and a `*` in
  an `exports` target is **Node's subpath pattern, which matches across `/`** —
  read as a shell glob it reports `@frontierjs/ui` as shipping none of its 64
  components. The snapshot records top-level entries only, so adding a source
  file does not move it.
- **`core/checks.js` has two callers and one of them is not in this package.**
  `scripts/ci.mjs` imports it by relative path and runs it over this repo as the
  `structure` phase. Loosening a rule here loosens it for every app on the next
  release, and tightening one can fail the repo's own CI — which is the point.
  Zero dependencies, plain ESM, node or bun; a package import would break the
  `ci.mjs` caller, which runs on plain node before anything is installed.
- **A rule belongs there only if it is SILENT when broken.** A violation that
  already raises an error belongs in the thing that raises it. `--list` prints
  the table with the invariant each rule comes from.

## Proving a change

`bun run test`. There is no browser drive for `fli` — a change to a scaffold is
proved by scaffolding into a temp directory and running what comes out. A change
to `core/checks.js` also needs `node scripts/ci.mjs --fast`, because the repo is
its other caller.
