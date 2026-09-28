---
id: single-binary
status: proposed
dated: 2026-09-27
---

# Idea — the whole app as one executable

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-27. Do not cite this
file as behavior — see `VERIFYING.md`.

**The question:** can `fli build` hand back ONE file — `api/`, the built `web/`
assets and litestone — that runs the full stack on a machine with nothing
installed? For demos, a prototype handed to a client, an offline field box, or
a snapshot of an app kept as an archive.

---

## The claim

**Mostly yes, and cheaper than any other packaging, because junction is
already Bun-only.** `bun build --compile` produces a single native binary with
the runtime inside. `Bun.serve` is the transport, `bun:sqlite` is the database,
and neither needs anything the binary does not carry. SvelteKit reaches the same
place through Node's SEA or a third-party wrapper; here it is the runtime's own
flag.

**Out of scope: the single-file HTML export** (a Gwtar-style `.html` carrying the
Mesa bundle and a seed `.db` for litestone's OPFS engine, `FJS-D305`). It needs
an answer for what runs the services when there is no Bun. Not this file.

## What breaks — measured 2026-09-27

`example/api` compiled with Bun 1.4.2: `bun build --compile api/index.ts` bundles
351 modules into an **84 MB** binary in 0.3 s with no error. It does not boot.
Probed from an empty directory, on a scratch copy with each break worked around
in turn to reach the next. The real tree was not edited.

**The runtime facts every item below follows from**, each checked with a
throwaway binary:

- **A binary cannot resolve a package from disk.** `createRequire().resolve` and
  `Bun.resolveSync` both fail even with `node_modules` beside the file being
  resolved from.
- **The embedded filesystem (`/$bunfs/root`) is a flat list of files.** Paths keep
  their source prefix (`api/src/services/x.service.js`), `.ts` becomes `.js`,
  `readdir` of the root lists everything, and `stat` of any directory is `ENOENT`.
  `import()` of an embedded path works under either extension. `Bun.Glob` finds nothing.
- **Bundling moves `import.meta.url`.** `new URL('./services', import.meta.url)` in
  `app.ts` resolves against the bundle, not the source file.
- **An embedded asset gets a content-hashed name.** `Bun.file` reads it; `realpath`
  and `lstat` fail.

**The breaks, in the order boot met them:**

1. **Schema path derived from `import.meta.dir`** (`api/src/core/db.ts`) — looks for
   `/db/schema.lite`. An app-side fix, and every app has one.
2. **`.lite` imports resolve at runtime** (`parser.js` via `createRequire`) — the
   schema's `import "@frontierjs/auth/schema.lite"` lines fail. **Worked around
   cleanly:** `parseFile` at build time gives plain JSON (235 KB, no class instances or
   functions) and `createTenantRegistry({ parsed, path })` boots on it, `path` kept
   only to anchor the data files. This is the cheapest real fix found.
3. **Four boot loaders glob a directory, then `import()` the files:** junction services
   (`core/loader.ts`), caravan jobs (`autoload.ts`), notifications (`loader.ts`),
   junction SQL migrations (`storage/database/index.ts`). Pointed at disk, their files
   import packages and fail (junction's authoring check refused all 37 services by
   name, which is the right failure). Pointed at `/$bunfs`, the directory check
   fails first. **Needs a generated manifest** each loader accepts in place of a
   directory. This is the real work, and it spans three packages.
4. **Config dir** (`config/index.ts` `import(path)`) — the same folder check; it
   booted on defaults silently apart from one warning line.
5. **Data paths written into code as relative to the source file** (`jobs.db` in
   `junction.config.js`, the tenant dir, audit, `db/public` storage) — caravan's boot
   failed opening `jobs.db` inside the read-only `/$bunfs`. Needs one data-root
   input that every declared path anchors to.
6. **Static serving** (`transport/static.ts`) — the `realpath` guard fails on
   embedded files, and hashed names need a map from URL to embedded file. A second
   static source, in `static.ts`.
7. **Runtime `.mesa` render** (`mesa/src/render-component.js`) — writes a temp module
   that imports `@frontierjs/mesa/runtime.js` by package name, so email templates
   break at send time, not boot. Precompile them at build time.

**Not reached, so not known:** native addons (`sqlite-vec` is loaded lazily through
`createRequire` in `engines/bun-sqlite.js`, and would fail the same way as item 2 if
a schema uses vectors), the `web/` build itself, and one binary per OS.

**The effort, from what was measured:** items 1, 2, 4 and 5 are small and mostly
per-app. Item 6 is one file. Item 3 is the build step `fli build --binary` owes:
emit a manifest of every service, job, notification and migration, and teach
four loaders to take it. Item 7 is a precompile pass. **No blocker in Bun was
found**: every break is a place FJS reads its own source tree at runtime.

## Reproducing the run

Nothing below is committed; it was built in a session scratch directory. Work on a
COPY of `example/` whose `node_modules` and `packages` are symlinks, so the real
tree is untouched.

1. **Compile.** `bun build --compile api/index.ts --outfile bin/example-api`, then
   run it from an empty directory with `API_PORT=7110 MAIL_SINK_PORT=7111`.
2. **Pre-parse the schema** (break 2). At build time, `parseFile('db/schema.lite')`
   and `JSON.stringify` the result into `api/src/core/parsed.json`. In `db.ts`,
   `import PARSED from './parsed.json'` and pass `parsed: PARSED` beside `path:` in
   BOTH the registry options and `clientOptions`. The client parses again on its own
   if only the registry gets it.
3. **Embed the loaded files.** List every `*.service.ts`, `*.job.ts`,
   `*.notification.ts` and `api/config/*.js` as extra entrypoints after the main one,
   and they land in `/$bunfs/root/api/...` as `.js`.
4. **Glob shim** (break 3, first half). An entry that replaces `Bun.Glob` with a
   recursive `readdirSync` over `/$bunfs`, returning names with `.js` changed back to
   `.ts` so each loader's pattern and derived name still match, then
   `await import('./index.ts')`. It gets past the glob and dies on the directory
   check, which is what established that `/$bunfs` has no directories.

**The throwaway probes behind the four runtime facts**, each a ten-line file
compiled on its own:

- `createRequire(pathToFileURL(schemaFile)).resolve('@frontierjs/auth/schema.lite')`
  and `Bun.resolveSync(...)`: both resolve under `bun run`, and both fail compiled.
- An entry plus `svc/a.service.ts` as a second entrypoint: `readdirSync` returns
  `["a.service.js"]`, `Bun.Glob('**/*.service.ts').scanSync(dir)` returns `[]`,
  `import()` of the `.ts`, `.js` and relative path all load.
- `import html from './dist/index.html' with { type: 'file' }`: the path is
  `/$bunfs/root/index-<hash>.html`, `Bun.file(html).text()` reads it, and
  `realpath(html)` is `ENOENT` on `lstat`.

**Where each break lives:** schema path `example/api/src/core/db.ts:12` · `.lite`
resolve `litestone/src/core/parser.js:7915` · services
`junction/src/core/loader.ts:148` · jobs `caravan/src/autoload.ts:59` ·
notifications `notifications/loader.ts:99` · migrations
`junction/src/storage/database/index.ts:118` · config
`junction/src/config/index.ts:582` · static `junction/src/transport/static.ts` ·
email render `mesa/src/render-component.js:593` · vectors
`litestone/src/engines/bun-sqlite.js:49`.

## The nine, briefly

1 origin — the app tree stays the one origin; the binary is derived output.
2 concept — no new noun; it is a build target beside `spa`/`static`/`widget`.
3 complexity — cost is the generated import manifest (item 3), which the problem requires; the rest is FJS reading its own tree at runtime.
4 predictability — boots through the same `runStartPhases` as `bun run`.
5 derived — the manifest is generated, never hand-listed.
6 owner — the build belongs to `fli build`/sierra's postbuild; static stays in `static.ts`, with a second source added there and not beside it.
7 boundary — a caller runs `./app --data ./data`; nothing about the inside leaks.
8 failure — a missing embedded asset or an unresolved dynamic import refuses at build, not at request.
9 silence — must stay true: the binary serves the same routes as the dev app. Fails when it stops: none yet; owed is a drive that boots the binary and hits the `example` routes (the `verify-build.mjs` shape).

Tension: *batteries vs. smallness* (§ IV) — this is a battery, and the reason it
costs little is that Bun already provides it.
Tier: Assessment (an `IDEAS/` proposal).

## Next step

The loader manifest (item 3) for junction services alone, then compile again. Past
that point the binary should reach `listening`, and the drive the ninth question owes
can be written against it.
