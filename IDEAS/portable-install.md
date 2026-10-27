---
id: portable-install
status: proposed
dated: 2026-10-27
---

# Idea — the portable install: an FJS app in one folder, copied onto a Linux desktop

**Status: PROPOSED.** Dated 2026-10-27. Nothing here is in `fli`. Do not cite this
file as describing behavior — see `VERIFYING.md`. A prototype was built and run
outside the tree that day against `fjs-prototypes/thod` (a single-owner
wholesaler app: 41 services, 30 routes, 2 jobs, print templates, a report
sandbox); every result below was observed, and the prototype's source is at the
end so it can be rebuilt without this session.

---

## The ask

*"Can we bundle this app onto a thumb drive, and somebody installs it on their
Ubuntu machine, and it works?"* No server, no internet, no bun, no node, no
Chrome on the target. It is the **single binary** artifact kind that
`offline-first-and-release.md` and `overview.md` 2.3 name and that `fli` has no
path to (`app-cli.md` compiles `cli/` only; `site:build --compile` a site only;
`desktop/` is a shell whose API is "always another origin", `FJS-D263`).

## What was proved, 2026-10-27

| Where | Result |
| --- | --- |
| Host, run from a folder outside the tree | boots, 41 services / 30 routes / 2 job handlers, fresh `app.db` created beside it |
| `ubuntu:24.04` container, non-root, no bun/node/Chrome | `create-owner`, login, SPA page, deep-link refresh, fixed report, custom report (worker), PDF (20 KB, `%PDF-1.4`) all pass, `mode: production` |
| `ubuntu:20.04` (glibc 2.31) | boots and answers |
| Headless screenshot of `/admin/items` | the SPA renders from the folder, calls `/api`, live dot green |

The container got only the shared libraries a stock Ubuntu desktop already has
(NSS, ATK-bridge, GBM, X11 family, ALSA, DejaVu/Liberation fonts) — those are
what the bundled Chromium links against; the binary itself needs only libc.

**Size: 379 MB** — the binary 115 MB (Bun + every `@frontierjs` package), the
app's own files under 1 MB, the built SPA, and a headless Chromium at 262 MB.

## How the prototype works

```
drive/
  thod          bun build --compile: launcher + every @frontierjs package the app imports
  app/          the app's OWN files, on disk: api/ (minus test, scripts), db/schema.lite
    node_modules/@frontierjs/*   generated stubs + the packages' data files (.lite, .css)
    db/         app.db, audit.db, jobs.db, encryption.key — made on first run
  web/          web/dist/client, served on the API's port
  chrome/       chrome-headless-shell (Chromium, from Chrome for Testing / Playwright)
```

**Compiling the whole app does not work, so only the packages are compiled.** In
a `--compile` binary every module's `import.meta.url` is `/$bunfs/root/<name>`,
so everything anchored to its own file breaks — `core/db.ts`'s schema path,
`core/paths.ts`, `junction.config.js`'s jobs path, `createApp({ root })`'s
autoload of `services/`, `routes/`, `jobs/`, the print templates read by
`render.ts`, the sandbox `Worker` URL. Keeping the app's files on disk leaves every
one of those right with no edit to the app.

**A stub per package makes the on-disk files share the compiled-in instances.**
`bundled.ts` imports each specifier the app uses and puts the module objects on
`globalThis.__thodBundled`. `make-drive.ts` writes
`app/node_modules/@frontierjs/<pkg>/<sub>.js` as
`export const { a, b, … } = globalThis.__thodBundled['<spec>']`, with a
`package.json` whose `exports` maps each subpath to its stub and copies each
non-code export (schema fragments, `print.css`) from the real package. One
instance matters: `$` context, the registry and mesa's render environment are
module state.

**The launcher fills in what a deploy would**: `ENCRYPTION_KEY` generated into
`db/encryption.key` on first run, `NODE_ENV=production`, `FJS_CHROME` pointed at
the drive's Chromium, `FRONTIER_APP_URL` at its own port, `create-owner` (sign-up
is closed in thod), `open` (server, then `xdg-open`), and a `Bun.serve` wrapper
serving `web/` with an `index.html` fallback beside the API.

## The walls, each with where a real fix belongs

1. **`import.meta.url` is `/$bunfs/root/…` in a compiled binary** — the reason the
   app stays on disk (above). A real fix is a root the app takes from the
   process (`execPath`) rather than its file, across `createApp`, the scaffold's
   `core/paths.ts` and `db.ts`; or a generated static manifest of services,
   routes and jobs, which is the true single-file build.
2. **`Bun.plugin` cannot stand in for the stubs.** A runtime `onResolve` never
   fired for the on-disk imports; `build.module()` virtual modules did, but a
   virtual `@frontierjs/auth` hides `@frontierjs/auth/schema.lite` from
   `createRequire().resolve` (litestone's schema-import resolver,
   `packages/litestone/src/core/parser.js` `resolveImportSpecifier`). Hence real
   stub files.
3. **Bun 1.4.4's compiled resolver does not follow a renaming `exports` entry.**
   `"./schema.lite": "./db/auth.lite"` and `"./print.css": "./src/print.css"`
   fail inside the binary while plain bun resolves them; the wildcard
   `"./references/*": "./references/*"` works. Workaround: the file is also
   copied to the literal subpath. Bun's to fix; worth a minimal repro upstream.
4. **Mesa's compiled template imports the runtime by the renderer's sibling
   path** (`packages/mesa/src/render-component.js` `runtimePath()`), which in the
   binary is `/$bunfs/root/runtime.js`. Workaround: a third compile entry named
   `runtime.js` re-exporting the bundled copy. A real fix is an option or env
   naming the runtime module, kept to one copy as that function's comment demands.
5. **A `Worker` is a fresh global**, so the report sandbox's
   `sandbox.worker.ts` found no `__thodBundled`. Workaround: the launcher wraps
   `globalThis.Worker` to start every worker on a compiled-in `worker-boot.ts`
   that fills the global and then imports the requested file
   (`THOD_WORKER_ENTRY`).
6. **`bun build` inlines `process.env.NODE_ENV` as `"development"`** into
   compiled code whatever the environment says. Workaround:
   `--define process.env.NODE_ENV="production"`; the app's on-disk files read the
   real env, which the launcher sets.
7. **What a deploy supplies is missing.** print-kit refuses to boot with no Chrome
   (the Dockerfile `apt install`s chromium); Junction's static branch
   (`packages/junction/src/transport/http.ts`) has no SPA fallback, so nginx's
   `try_files` has no stand-in; there is no first-run key; sign-up is closed so
   the owner needs a command. And **print-kit hangs a PDF request until Bun's
   10 s idle timeout when Chromium cannot start** (a missing `libXfixes` was the
   case seen) rather than refusing by name — a print-kit bug regardless of this
   idea.

## What a real version still needs

- **Install, never run from the stick.** udisks2 mounts a FAT/exFAT stick with
  `showexec`, so `./thod` is not executable there (not probed), and SQLite's WAL
  on FAT is a risk. An `install.sh` copies the folder to `~/.local/share/<app>`
  and writes an XDG entry running `<app> open` — `fli desktop:install` writes the
  same entry for a checkout.
- **Bind `127.0.0.1`.** The prototype listens on `0.0.0.0`, which on a desktop is
  every machine on the network.
- **A config file instead of `.env`**: SMTP and the rest, read by the launcher.
- **Backups name both halves**: `db/` and `encryption.key` together.
- **Upgrades** replace `thod`, `app/`, `web/` and keep `db/`; after an app leaves
  Alpha that means migration files applied on start.
- **Chromium, not Chrome.** Chromium / Chrome for Testing is redistributable; a
  copy of `/opt/google/chrome` is not.
- **Derived, not hand-listed.** `bundled.ts` is thod's eleven specifiers plus
  `mesa/runtime`, found by grepping `api/src` and `api/config`; the names
  `thod`/`__thodBundled`/`THOD_*` are the app's.

## Plan

### Phase 0 — the prototype

Goal: prove a thumb-drive install of a real app is possible with today's packages.
Done when: the container run in § What was proved passes.

- [x] 0.1 Compile `api/index.ts` whole — fails on `/db/schema.lite` (wall 1)
- [x] 0.2 Packages compiled in, app on disk, stubs over `__thodBundled` (walls 2–3)
- [x] 0.3 Print templates and the report worker (walls 4–5)
- [x] 0.4 Launcher: key, production mode (wall 6), Chromium, SPA serving, `create-owner`, `open`
- [x] 0.5 Clean `ubuntu:24.04` and `ubuntu:20.04` runs

**Done 2026-10-27.** Every wall had a workaround outside the packages; walls 3, 4,
6 and the print-kit hang are worth fixing on their own.

### Phase 1 — upstream the fixes the workarounds stand in for

Goal: the prototype loses its hacks one by one.
Done when: `make-drive.ts` has no literal-subpath copy and no `runtime.js` entry.

- [ ] 1.1 print-kit refuses a PDF by name when Chromium cannot launch, instead of hanging
- [ ] 1.2 mesa: the runtime module a compiled template imports is nameable
- [ ] 1.3 Bun: minimal repro of wall 3 filed upstream
- [ ] 1.4 Junction: an SPA fallback on `http.static`, so a launcher passes config instead of wrapping `Bun.serve`

### Phase 2 — `fli release:portable`

Goal: any scaffolded app, one command, the folder above.
Done when: `example/` builds one and a drive runs it in `ubuntu:24.04`.

- [ ] 2.1 Rule Q1–Q4
- [ ] 2.2 Derive the bundled specifier list from the app's imports
- [ ] 2.3 Names from `junction.config.js`'s `app.name`, not `thod`
- [ ] 2.4 Chromium fetched from Chrome for Testing, pinned, cached
- [ ] 2.5 Bind `127.0.0.1`; a config file for SMTP and friends
- [ ] 2.6 `install.sh` + XDG entry; `uninstall`

### Phase 3 — a drive

Goal: it stays working.
Done when: `verify:portable` runs in CI.

- [ ] 3.1 `verify:portable`: build, stream into `ubuntu:24.04`, owner, login, report, worker report, PDF

## Open questions

- **Q1 — A folder or one file.** One file needs wall 1's root-from-process plus a
  generated manifest of services, routes and jobs; the folder needs neither.
- **Q2 — Ship Chromium or require one.** 262 MB on the drive, or
  `apt install chromium`, which is a snap on Ubuntu; `FJS_CHROME` already lets
  either work.
- **Q3 — A browser tab or the `desktop/` shell.** `FJS-D263`'s shell with its API
  started beside it is the same folder plus WebKitGTK and Rust at build time.
- **Q4 — Where the data lives.** Beside the binary (the prototype) or
  `~/.local/share/<app>` with the binary elsewhere.

## Reproduce it

Needs a scaffolded app with `web/dist` built, bun 1.4.4, and a
`chrome-headless-shell-linux64` directory (Playwright's
`~/.cache/ms-playwright/chromium_headless_shell-*` or Chrome for Testing).

```bash
mkdir portable && cd portable                 # outside the app, and NOT under any node_modules parent
ln -s <app>/node_modules node_modules         # bun build resolves the packages from here
# write the four files below; edit bundled.ts to the app's specifiers:
grep -rhoE "from +['\"]@frontierjs/[^'\"]+['\"]" <app>/api/src <app>/api/config | sort -u
(cd <app> && bun run build:web)
bun make-drive.ts <app> ../drive <chrome-headless-shell-linux64 dir>
../drive/thod create-owner owner@example.test 'correct horse battery staple'
../drive/thod open                            # or: PORT=8199 ../drive/thod
```

Build the drive into a directory with no `node_modules` above it, or a missing
stub resolves from the symlink and the test lies. Docker as a snap cannot see
`/tmp`; stream instead: `tar -C <parent> -c drive | docker run --rm -i ubuntu:24.04 bash -c '…'`.

## The prototype, verbatim

### `bundled.ts`

```ts
// Every package the app's own files import, compiled into the binary. The
// stubs under app/node_modules re-export from globalThis.__thodBundled.
import * as auth from '@frontierjs/auth'
import * as caravan from '@frontierjs/caravan'
import * as junction from '@frontierjs/junction'
import * as junctionCommitments from '@frontierjs/junction/commitments'
import * as junctionMail from '@frontierjs/junction/mail'
import * as litestone from '@frontierjs/litestone'
import * as litestoneStorage from '@frontierjs/litestone/storage'
import * as mesaRender from '@frontierjs/mesa/render-component'
import * as mesaRuntime from '@frontierjs/mesa/runtime'
import * as notifications from '@frontierjs/notifications'
import * as printKit from '@frontierjs/print-kit'
import * as datetime from '@frontierjs/toolbelt/datetime'

export const bundled: Record<string, object> = {
  '@frontierjs/auth': auth,
  '@frontierjs/caravan': caravan,
  '@frontierjs/junction': junction,
  '@frontierjs/junction/commitments': junctionCommitments,
  '@frontierjs/junction/mail': junctionMail,
  '@frontierjs/litestone': litestone,
  '@frontierjs/litestone/storage': litestoneStorage,
  '@frontierjs/mesa/render-component': mesaRender,
  '@frontierjs/mesa/runtime': mesaRuntime,
  '@frontierjs/notifications': notifications,
  '@frontierjs/print-kit': printKit,
  '@frontierjs/toolbelt/datetime': datetime,
}

;(globalThis as Record<string, unknown>).__thodBundled = bundled
```

### `worker-boot.ts`

```ts
// First module of every worker: the same packages as the main thread, then the
// worker file the app named.
import './bundled.ts'

const entry = process.env.THOD_WORKER_ENTRY
if (!entry) throw new Error('worker-boot.ts started without THOD_WORKER_ENTRY')
await import(entry)
```

### `launcher.ts`

```ts
// Portable launcher: every package the app imports is compiled in; the app's
// own files sit on disk in ./app beside the binary and are loaded by bun's
// runtime, with @frontierjs/* answered by stubs over the copies inside this binary.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, normalize } from 'node:path'
import { bundled } from './bundled.ts'

void bundled

// A worker is a fresh global, so it starts on worker-boot.ts (compiled in
// beside this file), which fills __thodBundled there and then loads the file
// the app asked for.
const BunWorker = globalThis.Worker
globalThis.Worker = class extends BunWorker {
  constructor(url: string | URL, opts: WorkerOptions & { env?: Record<string, string> } = {}) {
    super('./worker-boot.ts', { ...opts, env: { ...process.env, ...opts.env, THOD_WORKER_ENTRY: String(url) } })
  }
} as typeof Worker

const appDir = process.env.THOD_HOME ?? join(dirname(process.execPath), 'app')
process.chdir(appDir)

// The key every encrypted column and session is signed with. Made on the first
// run and kept beside the database: a new key is every existing row unreadable.
const keyFile = join(appDir, 'db', 'encryption.key')
if (!process.env.ENCRYPTION_KEY) {
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  process.env.ENCRYPTION_KEY = readFileSync(keyFile, 'utf8').trim()
}
// The packages inside the binary were built with NODE_ENV inlined as
// production; the app's own files read it here.
process.env['NODE_ENV'] ??= 'production'

// print-kit refuses to boot with no Chrome, and a stock Ubuntu desktop has only
// Firefox, so the drive carries a headless Chromium beside the binary.
const bundledChrome = join(appDir, '..', 'chrome', 'chrome-headless-shell')
if (!process.env.FJS_CHROME && existsSync(bundledChrome)) process.env.FJS_CHROME = bundledChrome
const port = Number(process.env.PORT ?? 8100)
process.env.PORT = String(port)
process.env.FRONTIER_APP_URL ??= `http://localhost:${port}`

// One origin for the screens and the API, as the SPA expects (it calls /api and
// /ws on its own origin). A built file answers as itself; any other page GET
// that is not the API gets index.html, so a refresh on /admin/items lands.
const web = join(appDir, '..', 'web')
const API = /^\/(api|ws)(\/|$)/
const serve = Bun.serve
Bun.serve = ((opts: Parameters<typeof Bun.serve>[0] & { fetch: (req: Request, server: unknown) => Response | Promise<Response> }) => serve({
  ...opts,
  async fetch(req, server) {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if ((req.method === 'GET' || req.method === 'HEAD') && !API.test(path)) {
      const file = normalize(join(web, path))
      if (file.startsWith(web + '/') && !file.endsWith('/') && (await Bun.file(file).exists())) return new Response(Bun.file(file))
      if (req.headers.get('accept')?.includes('text/html')) return new Response(Bun.file(join(web, 'index.html')))
    }
    return opts.fetch.call(server, req, server)
  },
})) as typeof Bun.serve
// `thod create-owner <email> <password> [name]` makes the one account; sign-up
// is closed (core/auth.ts), so a fresh drive has no other way in.
if (process.argv[2] === 'create-owner') {
  const [email, password, name = 'Owner'] = process.argv.slice(3)
  if (!email || !password) { console.error('usage: thod create-owner <email> <password> [name]'); process.exit(2) }
  const { auth } = await import(join(appDir, 'api/src/core/auth.ts'))
  await auth.createUser({ email, password, name, role: 'admin' })
  console.log(`owner ${email} created`)
  process.exit(0)
}

await import(join(appDir, 'api/index.ts'))

// `thod open` is what the launcher icon runs: the server, then a browser on it.
if (process.argv[2] === 'open') Bun.spawn(['xdg-open', `http://localhost:${port}/`], { stdout: 'ignore', stderr: 'ignore' })
```

### `make-drive.ts`

```ts
// Stage the thumb-drive folder: the compiled launcher, the app's own files, and
// stub packages under app/node_modules that re-export the compiled-in copies.
// Usage: bun make-drive.ts <project> <out> [chrome-headless-shell dir]
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const [project, out, chrome] = process.argv.slice(2)
const src = readFileSync(join(import.meta.dir, 'bundled.ts'), 'utf8')
const specs = [...src.matchAll(/import \* as \w+ from '(@frontierjs\/[^']+)'/g)].map(m => m[1])

rmSync(out, { recursive: true, force: true })
const app = join(out, 'app')
mkdirSync(join(app, 'db'), { recursive: true })
cpSync(join(project, 'api'), join(app, 'api'), { recursive: true, filter: p => !/\/api\/(test|scripts)(\/|$)/.test(p) })
cpSync(join(project, 'db/schema.lite'), join(app, 'db/schema.lite'))
cpSync(join(project, 'web/dist/client'), join(out, 'web'), { recursive: true })
if (chrome) cpSync(chrome, join(out, 'chrome'), { recursive: true })

// Every file a package exports that is not code — a schema fragment, a
// stylesheet — is copied as-is, under the package's own exports map.
const byPkg = new Map<string, Record<string, string>>()
for (const spec of specs) {
  const [scope, name, ...rest] = spec.split('/')
  const pkg = `${scope}/${name}`, sub = rest.length ? './' + rest.join('/') : '.'
  const mod = await import(spec)
  const keys = Object.keys(mod).filter(k => k !== 'default')
  const file = (sub === '.' ? 'index' : rest.join('__')) + '.js'
  const body = `const m = globalThis.__thodBundled[${JSON.stringify(spec)}]\n` +
    (keys.length ? `export const { ${keys.join(', ')} } = m\n` : '') +
    ('default' in mod ? 'export default m.default\n' : '')
  mkdirSync(join(app, 'node_modules', pkg), { recursive: true })
  writeFileSync(join(app, 'node_modules', pkg, file), body)
  byPkg.set(pkg, { ...(byPkg.get(pkg) ?? {}), [sub]: './' + file })
}
for (const [pkg, exportsMap] of byPkg) {
  const real = JSON.parse(readFileSync(join(project, 'node_modules', pkg, 'package.json'), 'utf8'))
  for (const [sub, target] of Object.entries(real.exports ?? {})) {
    const t = typeof target === 'string' ? target : (target as Record<string, string>).default
    if (!t || /\.[mc]?[jt]s$/.test(t) || sub in exportsMap) continue
    if (t.includes('*')) {
      const dir = t.slice(0, t.indexOf('*'))
      cpSync(join(project, 'node_modules', pkg, dir), join(app, 'node_modules', pkg, dir), { recursive: true, filter: p => !/\.[mc]?[jt]s$/.test(p) })
    } else {
      mkdirSync(dirname(join(app, 'node_modules', pkg, t)), { recursive: true })
      cpSync(join(project, 'node_modules', pkg, t), join(app, 'node_modules', pkg, t))
      // A compiled binary's resolver does not follow a renaming exports entry
      // (bun 1.4.4): it looks for the subpath itself, so the file is there too.
      cpSync(join(project, 'node_modules', pkg, t), join(app, 'node_modules', pkg, sub))
    }
    exportsMap[sub] = t
  }
  writeFileSync(join(app, 'node_modules', pkg, 'package.json'),
    JSON.stringify({ name: pkg, type: 'module', exports: exportsMap }, null, 2) + '\n')
}

// Mesa's renderer compiles a print template to a module that imports the
// runtime by the renderer's own sibling path — inside the binary that is
// /$bunfs/root/runtime.js, so an entry by that name re-exports the one copy.
const runtime = await import('@frontierjs/mesa/runtime')
writeFileSync(join(import.meta.dir, 'runtime.js'),
  `const m = globalThis.__thodBundled['@frontierjs/mesa/runtime']\nexport const { ${Object.keys(runtime).filter(k => k !== 'default').join(', ')} } = m\n`)

const build = Bun.spawnSync(['bun', 'build', '--compile', '--target=bun-linux-x64', '--define', 'process.env.NODE_ENV="production"',
  join(import.meta.dir, 'launcher.ts'), join(import.meta.dir, 'worker-boot.ts'), join(import.meta.dir, 'runtime.js'), '--outfile', join(out, 'thod')], { stdout: 'inherit', stderr: 'inherit' })
process.exit(build.exitCode ?? 1)
```

### `smoke.sh` — thod's own endpoints; swap them for the app's

```bash
#!/usr/bin/env bash
# Boot a drive build, sign in, and exercise the parts most likely to break.
# Usage: smoke.sh <drive dir>
set -u
D=$1; export ENCRYPTION_KEY=${ENCRYPTION_KEY:-$(openssl rand -hex 32)}
rm -rf "$D/app/db/"*.db* "$D/app/storage"; cd /
"$D/thod" create-owner owner@thod.test 'correct horse battery staple' >/dev/null 2>&1 || echo "create-owner failed"
PORT=8199 "$D/thod" > "$D/../run.log" 2>&1 & PID=$!
for i in $(seq 40); do curl -s -o /dev/null localhost:8199/api/health && break; sleep 0.25; done
T=$(curl -s localhost:8199/api/auth/login -H 'content-type: application/json' -d '{"email":"owner@thod.test","password":"correct horse battery staple"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
H="authorization: Bearer $T"; J='content-type: application/json'
say() { printf '%-22s %s\n' "$1" "$(cut -c1-160)"; }
curl -s localhost:8199/api/reports -H "$H" -H "$J" -H 'x-service-method: run' -d '{"report":"trial-balance"}' | say "fixed report"
ID=$(curl -s localhost:8199/api/reports -H "$H" -H "$J" -d '{"name":"Parts","group":"Stock","sql":"select partNumber, listPrice from item where listPrice >= @min","params":[{"name":"min","type":"number","default":0}],"columns":[]}' | sed -E 's/.*"id":([0-9]+).*/\1/')
curl -s localhost:8199/api/reports/$ID -H "$H" -H "$J" -H 'x-service-method: run' -d '{}' | say "custom report (worker)"
curl -s -o "$D/../smoke.pdf" -w '%{http_code} %{content_type}' localhost:8199/api/reports/trial-balance/pdf -H "$H" | say "report pdf"
kill $PID; wait $PID 2>/dev/null
```

## See also

- `offline-first-and-release.md` — the vision this is one artifact kind of; its
  "no `bun build --compile` path in `fli`" still holds
- `overview.md` 2.3 — Release story (`depot`): artifact kinds, single binary first
- `no-port-app.md` — the other never-deployed kinds: vendor-hosted, browser-only
- `app-cli.md` — the one surface `fli` already compiles (`FJS-D397`)
- `FJS-D263` — `desktop/`, the native shell Q3 would put this inside
