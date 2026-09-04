# create-frontier — package map

**The front door.** `npm create frontier@latest my-app` resolves this package,
which resolves `@frontierjs/cli` and runs `fli new`. One implementation of what
a FrontierJS app looks like; this one only handles being invoked.

`bun run test` (bun).

---

## Layout

```
index.js    the whole package — resolve, check, prompt, delegate
test/       what reaches fli, and what happens with no name
```

---

## What bites here

- **The name is the API.** npm and bun both map `create <x>` to the package
  `create-<x>` and run the bin of the same name. Both halves have to be right or
  the command is a 404 mentioning neither, which is why a test asserts them.
- **Arguments are forwarded UNTOUCHED.** An early version sorted argv into flags
  and positionals; that does not survive `--source npm`, which reached fli as
  `--source true` with a stray `npm` beside it. This script cannot know which
  flags take a value — that is fli's table — so it must not reorder any of them.
  The name is `argv[0]` and only `argv[0]`.
- **`--project <cwd>` is load-bearing.** fli finds a project root by walking UP
  from the working directory, which is right for every other command and wrong
  for this one: measured, `fli new hello` from a subdirectory of an existing
  project writes `hello/` into that project's root. The pin makes "here" mean
  here.
- **`createRequire(import.meta.url)` resolves from the REAL path.** Node
  resolves a symlink to its target before resolving imports from it, so a test
  that links `index.js` into a fixture tree looks for the cli beside the source
  file and finds nothing. `test/create.test.js` copies.
- **The bun check runs before anything is written.** Junction is Bun-only —
  `Bun.serve` is the transport, `bun:sqlite` the cache and database — so a
  successful scaffold followed by an install is the worst moment to discover
  there is no bun.
- **`@frontierjs/cli` is `workspace:*`**, so this releases in lockstep with the
  CLI. A dist-tag would not resolve to the workspace copy and would test the
  published scaffold instead of this tree.

## Proving a change

`bun run test` here. The scaffold itself is proved by
`node scripts/scaffold-build.mjs`, which drives `fli new` directly — this package
adds three behaviors on top of it and those are what the tests cover.
