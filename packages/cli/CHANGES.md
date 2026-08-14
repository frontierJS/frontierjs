# Changes — @frontierjs/cli

## 2026-08-13 — the deploy pipeline installs dependencies before it builds

`fli deploy` never ran `bun install` — not in any of the nine steps. The API side
was covered by accident, because its Dockerfile installs inside the image; the web
side went straight from `git pull` to `bun run build` against whatever
`node_modules` the server happened to be carrying. A deploy that adds a dependency
therefore either built against the previous tree or died mid-build with the deploy
lock already held. `03-build-web` now installs at the project root first, with
`--frozen-lockfile`, which is the point of the step rather than a flag on it: a
resolve on the server would produce a tree the lockfile never described and nothing
downstream could say so.

Found by grading the pipeline against the twelve-factor build/release/run split,
which it fails in a larger way as well — see `IDEAS/deploy-plane.md` and `FJS-232`.

## 2026-08-13 — `fli api:routes`, and the scaffold stops installing CORS twice

Asks a **running** app what it serves, via the routes list `manifestPlugin` now
carries on `/manifest`. There was no way to ask before: the HTTP surface is
emergent — services auto-mount, plugins register their own — and `hasRoute()`
answers a matching question rather than an existence one, so a route in the
wrong place stayed invisible until something 404'd. `FJS-091`.

```
fli api:routes            # everything, service templates marked
fli api:routes --raw      # only what a plugin or the app registered
fli api:routes --method POST
fli api:routes --json
```

`manifestPlugin()` is now in the scaffold, because a command about a plugin
nobody configures is not a command.

**The scaffold no longer calls `cors()` by hand.** It also declared
`middleware.cors` in `config/junction.config.js`, and `cors()` both patches the
router's middleware and registers `OPTIONS /*` — so every scaffolded app ran the
CORS middleware twice and carried two identical wildcard preflight routes. Found
by running `fli api:routes` against a fresh scaffold, on its first outing. The
config entry is the one owner now; configure it by hand only when the app also
uses `csrf()`, which has to come after it. `FJS-225` is the framework half — a
duplicate exact route is registered in silence.

## 2026-08-12 — `fli check`: architecture rules, enforced as assertions

Ten rules over the file tree — model names, resource files, and the two
configuration lines whose absence is silent. `core/checks.js` is the engine;
`fli check --list` prints the table.

```
fli check
fli check --only resource-file-name,vite-strict-port
fli check --json
```

**The membership test is that a rule is silent when broken.** A rule whose
violation already raises an error belongs in the thing that raises it. So half
the table is FrontierJS invariants that no compiler enforces — a model name is
PascalCase singular, `src/resources/` holds `.mesa`, a resource file is named for
its model, one Resource per file — and half is hazards with a long memory:
`strictPort` absent from a vite config, and the body tag written inside a comment
in an `index.html`.

**`scripts/ci.mjs` imports the same module by relative path** and runs it as a
new `structure` phase over this repo's own apps and packages. Two
implementations of one rule is exactly how a framework ends up breaking rules it
publishes, so there is one, and it is loosened for the repo only where it is
loosened for every app.

**Six findings on the first run, four of them real.** The worst is `FJS-198`:
`packages/sierra/example/web/index.html` explained in a comment that the theme
goes on the body tag, so vite injected the built `<script>` and the stylesheet
*inside* that comment and the example's production build shipped no JavaScript at
all. The build succeeded and the file looked right. Also found `leads.mesa` —
lowercase, three Resources in one file — and two packages with a fifth markdown
file at their root.

The two that were not real became rules: a Resource over no model may take its
own service noun singularised (basecamp's `Hub.mesa` is `createResource('hub')`
and is correct), and a schema with neither `api/` nor `web/` beside it is a
fixture rather than an app that got the layout wrong.

**An exception is a named entry with a reason.** There is no ignore comment;
`runChecks({ allow })` is keyed `'<rule>:<path>'`, and a stale allowance is
reported — an exception that outlives the thing it excused is an unenforced rule
nobody knows is unenforced.
