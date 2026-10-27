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
| Host, both kinds (§ Two kinds) built by the one `make-drive.ts` | `smoke.sh` passes on each: fixed report, custom report (worker), PDF |
| `ubuntu:24.04`, non-root, bun 1.4.4 only, plain bundle, no Chromium, `printer()` off | `create-owner`, login, SPA page, deep link, asset, fixed report, custom report (worker) all pass, `mode: production` |
| `ubuntu:24.04`, non-root, the installable kind (§ The installable kind), `verify-installer.sh` | refused with no bun; bun from its own installer found off PATH in `~/.bun/bin`; refused with no Chrome; after Google Chrome's `.deb`: install, menu entry, login, deep link, fixed and worker reports, PDF (20 KB), listening on 127.0.0.1 only, a second `open` answered in 360 ms; the upgrade kept the data, uninstall kept it, a reinstall logged straight in, `--purge` removed it |

The container got only the shared libraries a stock Ubuntu desktop already has
(NSS, ATK-bridge, GBM, X11 family, ALSA, DejaVu/Liberation fonts) — those are
what the bundled Chromium links against; the binary itself needs only libc.
For the last row, the drive's copy of `app.ts` had its `app.configure(printer())`
line commented out to stand in for an app without print-kit; print-kit refuses
to boot with no Chrome (wall 7).

**Size.** The first container drive is 379 MB on disk. Where it goes:

| Drive | Raw | `zip -9` | `tar.xz -9` |
| --- | --- | --- | --- |
| compiled, with Chromium | 379 MB | — | — |
| compiled, no Chromium | 119 MB | 55 MB | 39 MB |
| plain bundle for an installed bun, no Chromium | 8.8 MB | 2.6 MB | 1.1 MB |
| for scale: `bun build --compile` of one `console.log` | 109 MB | 52 MB | — |

**The compiled binary is Bun.** Of its 115 MB, 109 MB is the runtime any compiled
program carries; the app and every `@frontierjs` package are about 6 MB. Leaving
print-kit out saves its Chromium (262 MB) and almost nothing in the binary, so
about 52 MB zipped is the floor for the compiled kind. The plain bundle has no
such floor: `launcher.js` and `worker-boot.js` each carry the same 3 MB of
packages, so one file serving both would roughly halve it.
`--splitting` shares them (1.5 MB gzipped, measured) but was not run after the
worker fix in wall 5.

## How the prototype works

```
drive/
  thod          bun build --compile: launcher + every @frontierjs package the app imports
                (--plain: a sh script running launcher.js, worker-boot.js, runtime.js beside it)
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

### Two kinds from the same files

`make-drive.ts` builds the **compiled** kind by default: `bun build --compile`,
Bun inside, nothing required on the target. With `--plain` it builds the same
three entries with `bun build --target=bun` into JS files beside `app/`, and
`thod` becomes `exec bun …/launcher.js "$@"`: the target needs bun, and the drive
loses the 109 MB runtime. The launcher tells them apart by
`import.meta.dir.startsWith('/$bunfs')` — compiled, the drive is
`dirname(execPath)` and the worker boot is the compiled entry `./worker-boot.ts`;
plain, `execPath` is the installed bun, so the drive is the launcher's own folder
and the worker boot is `worker-boot.js` beside it. The stubs, the `runtime.js`
entry and the `NODE_ENV` define are needed by both (walls 4 and 6); only wall 3
is compile-only.

### The installable kind

`make-installer.sh` wraps the plain kind as a **2.5 MB zip that carries neither
bun nor Chrome and requires both**:

```
thod/
  install.sh  README.txt
  payload/    the plain drive, plus uninstall.sh and BUN_VERSION
```

`sh install.sh` needs no sudo and writes nothing outside `~/.local`:

- **It refuses by name, with the command that fixes it**, when there is no bun
  (on PATH, or in `~/.bun/bin` where bun's own installer puts it and where a
  desktop entry's PATH never looks), when bun is another minor than
  `BUN_VERSION`, and when there is no Chrome (the four names mesa's `findChrome`
  tries, in its order, or `$FJS_CHROME`, written to `thod.env` when it is a path).
- It copies `payload/` to `~/.local/share/thod`, links `~/.local/bin/thod`, and
  writes `~/.local/share/applications/thod.desktop` running `thod open`.
- A first install makes the owner account: prompted, or `THOD_OWNER_EMAIL` and
  `THOD_OWNER_PASSWORD` unattended.
- **Run again it upgrades**: stops the running copy, carries `app/db/*.db*`,
  `encryption.key`, `app/storage` and `thod.env` into the new copy, and swaps
  it in. `uninstall.sh` keeps the same files; `--purge` deletes them.

The launcher gained what a desktop needs. It listens on `127.0.0.1` (`THOD_HOST`
widens it). It reads `thod.env` beside it into the environment, the real
environment winning; that happens after the bundled packages have loaded, so a
package that reads a variable at import misses it. `open` finds a server already
up and only opens the browser, and prints the address when there is no
`xdg-open`. The plain kind refuses a bun of another minor (`THOD_ANY_BUN=1` runs
it anyway). `thod stop` is the wrapper's `pkill -f <dir>/launcher.js`.

**Found by the run:** a fresh user has no `~/.local/share`, so the first copy
failed; `install.sh` makes it. **Not run:** a real desktop session (the menu
entry, `xdg-open`); snap Chromium, which is what `apt install chromium` gives on
Ubuntu and whose confinement may disagree with a profile under `/tmp`; Ubuntu
20.04 with this kind; the interactive owner prompt.

**The living copy is `fjs-prototypes/thod/deploy/portable/`**: `bun run
build:portable` writes `dist/thod-linux.zip`, and
`sh deploy/portable/verify-installer.sh dist/thod-linux.zip` runs the container
test above.

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
   Any bundle has it, not only a binary: the plain kind with `runtime.js` removed
   fails on `<drive>/runtime.js`.
5. **A `Worker` is a fresh global**, so the report sandbox's
   `sandbox.worker.ts` found no `__thodBundled`. Workaround: the launcher wraps
   `globalThis.Worker` to start every worker on a bundled `worker-boot.ts`
   that fills the global and then imports the requested file
   (`THOD_WORKER_ENTRY`). **The boot must hold early messages.** A message posted
   while the requested file is still loading reaches no `onmessage` and is
   dropped without an error; the plain kind loads slowly enough that the sandbox's
   first run was always lost and timed out at 20 s, and the compiled kind only
   happened to win the race. `worker-boot.ts` queues messages until the file has
   set its handler, then hands them over.
6. **`bun build` inlines `process.env.NODE_ENV` as `"development"`** into
   bundled code whatever the environment says, compiled or plain, minified or
   not. Workaround:
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
  same entry for a checkout. Prototyped: § The installable kind.
- **Bind `127.0.0.1`.** `0.0.0.0` on a desktop is every machine on the network.
  Prototyped, `THOD_HOST` to widen it.
- **A config file instead of `.env`**: SMTP and the rest, read by the launcher.
  Prototyped as `thod.env`, read too late for a package that reads at import.
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
- [x] 0.6 The plain kind for an installed bun (`--plain`), and the worker's early-message race it exposed
- [x] 0.7 The installable kind: `install.sh`, upgrade, uninstall, no bun or Chrome inside (`thod/deploy/portable/`)

**Done 2026-10-27.** Every wall had a workaround outside the packages; walls 3, 4,
6 and the print-kit hang are worth fixing on their own. The plain kind came the
same day: 2.6 MB zipped against 55 MB, the same smoke passing, at the cost of
bun on the target (Q5).

### Phase 1 — upstream the fixes the workarounds stand in for

Goal: the prototype loses its hacks one by one.
Done when: `make-drive.ts` has no literal-subpath copy and no `runtime.js` entry.

- [ ] 1.1 print-kit refuses a PDF by name when Chromium cannot launch, instead of hanging (`FJS-3541`)
  - The cause is mesa's `openChrome`: its wait for the DevTools port ignores the process exiting.
- [ ] 1.2 mesa: the runtime module a compiled template imports is nameable (`FJS-3542`)
- [ ] 1.3 Bun: minimal repro of wall 3 filed upstream (`FJS-3544`)
- [ ] 1.4 Junction: an SPA fallback on `http.static`, so a launcher passes config instead of wrapping `Bun.serve` (`FJS-3543`)
- [ ] 1.5 `NODE_ENV` defined at compile time by every FJS compile, `cli:build` included (`FJS-3545`)

### Phase 2 — `fli release:portable`

Goal: any scaffolded app, one command, the folder above.
Done when: `example/` builds one and a drive runs it in `ubuntu:24.04`.

- [ ] 2.1 Rule Q1–Q5
- [ ] 2.2 Derive the bundled specifier list from the app's imports
- [ ] 2.3 Names from `junction.config.js`'s `app.name`, not `thod`
- [ ] 2.4 Chromium fetched from Chrome for Testing, pinned, cached
- [ ] 2.5 Bind `127.0.0.1`; a config file for SMTP and friends
  - Prototyped in thod's launcher; the config file loads after the bundled packages, too late for one that reads at import.
- [ ] 2.6 `install.sh` + XDG entry; `uninstall`
  - Prototyped in `thod/deploy/portable/installer/`; written for thod's names, untested on a real desktop.
- [ ] 2.7 The plain kind refuses to start on a bun outside the range it was built and tested on, by name
  - Prototyped at both ends: `install.sh` and the launcher refuse another minor than the build's.

### Phase 3 — a drive

Goal: it stays working.
Done when: `verify:portable` runs in CI.

- [ ] 3.1 `verify:portable`: build, stream into `ubuntu:24.04`, owner, login, report, worker report, PDF — for each kind Q5 keeps

## Open questions

- **Q1 — A folder or one file.** One file needs wall 1's root-from-process plus a
  generated manifest of services, routes and jobs; the folder needs neither.
- **Q2 — Ship Chromium or require one.** 262 MB on the drive, or
  `apt install chromium`, which is a snap on Ubuntu; `FJS_CHROME` already lets
  either work. The installable kind requires one and refuses by name at install;
  Google Chrome's `.deb` is tested there, snap Chromium is not.
- **Q3 — A browser tab or the `desktop/` shell.** `FJS-D263`'s shell with its API
  started beside it is the same folder plus WebKitGTK and Rust at build time.
- **Q4 — Where the data lives.** Beside the binary (the prototype) or
  `~/.local/share/<app>` with the binary elsewhere.
- **Q5 — Bun inside, or bun required.** The compiled kind is 55 MB zipped and
  needs nothing on the target; the plain kind is 2.6 MB and needs bun. Installing
  bun is `curl -fsSL https://bun.sh/install | bash`, which needs the internet,
  or bun's own release zip carried on the drive, which gives back most of the
  saving. The plain kind also ties the drive to a bun version it was not built
  inside (2.7); only 1.4.4 was run. Both kinds, one flag apart, is a third
  answer: plain for a machine that has bun, compiled for one that does not.
  Either way print-kit's Chromium is the larger half until Q2 is ruled.

## Reproduce it

**From thod**, where every file below lives in `deploy/portable/`:
`bun run build:portable`, then `sh deploy/portable/verify-installer.sh
dist/thod-linux.zip` (Docker, and internet for bun and Chrome). For another app,
copy that folder, set `bundled.ts` to the app's specifiers (the `grep` below) and
replace the names `thod`, `__thodBundled`, `THOD_*`, and `smoke.sh`'s endpoints.

**From nothing**, outside any app: needs a scaffolded app with `web/dist` built, bun 1.4.4, and a
`chrome-headless-shell-linux64` directory (Playwright's
`~/.cache/ms-playwright/chromium_headless_shell-*` or Chrome for Testing).

```bash
mkdir portable && cd portable                 # outside the app, and NOT under any node_modules parent
ln -s <app>/node_modules node_modules         # bun build resolves the packages from here
# write the files below; edit bundled.ts to the app's specifiers:
grep -rhoE "from +['\"]@frontierjs/[^'\"]+['\"]" <app>/api/src <app>/api/config | sort -u
(cd <app> && bun run build:web)
bun make-drive.ts <app> ../drive <chrome-headless-shell-linux64 dir>
# or the plain kind for an installed bun:  bun make-drive.ts <app> ../drive <chrome dir> --plain
../drive/thod create-owner owner@example.test 'correct horse battery staple'
../drive/thod open                            # or: PORT=8199 ../drive/thod
```

Build the drive into a directory with no `node_modules` above it, or a missing
stub resolves from the symlink and the test lies. Docker as a snap cannot see
`/tmp`; stream instead: `tar -C <parent> -c drive | docker run --rm -i ubuntu:24.04 bash -c '…'`,
or stage under `~/.cache` and mount that. For the plain kind, mount the host's
bun read-only at `/usr/local/bin/bun` and nothing else. A curl without
`accept: text/html` gets 405 on a page path, by design: the fallback answers
browsers only.

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

// A message posted while the app's worker file is still loading reaches no
// handler and is dropped; hold them and hand them over once it has set one.
declare var self: Worker
const early: MessageEvent[] = []
self.onmessage = ev => { early.push(ev) }
await import(entry)
for (const ev of early) self.onmessage?.(ev)
```

### `launcher.ts`

```ts
// Portable launcher: every package the app imports is bundled in; the app's
// own files sit on disk in ./app beside it and are loaded by bun's runtime,
// with @frontierjs/* answered by stubs over the bundled copies. Built either as
// a compiled binary (bun inside) or a plain bundle run by an installed bun.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, normalize } from 'node:path'
import { bundled } from './bundled.ts'

void bundled

// Compiled, every module sits under /$bunfs/root and the drive is the binary's
// folder; as a plain bundle, execPath is the installed bun and the drive is
// this file's folder.
const compiled = import.meta.dir.startsWith('/$bunfs')
const drive = compiled ? dirname(process.execPath) : import.meta.dir

// A plain bundle runs on whatever bun the machine has. One of another minor
// than it was built on is refused by name rather than failing somewhere inside;
// THOD_ANY_BUN=1 runs it anyway.
declare const THOD_BUILT_BUN: string
const builtMinor = THOD_BUILT_BUN.split('.').slice(0, 2).join('.')
if (!compiled && !Bun.version.startsWith(builtMinor + '.') && process.env.THOD_ANY_BUN !== '1') {
  console.error(`thod was built and tested on bun ${THOD_BUILT_BUN}; this is bun ${Bun.version}. Install bun ${builtMinor}.x, or set THOD_ANY_BUN=1 to try anyway.`)
  process.exit(1)
}

// thod.env beside the app holds what a deploy's environment would: SMTP, a
// Chrome somewhere unusual (FJS_CHROME), a port. The real environment wins.
const envFile = join(drive, 'thod.env')
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
}

// A worker is a fresh global, so it starts on worker-boot (bundled beside this
// file), which fills __thodBundled there and then loads the file the app asked for.
const BunWorker = globalThis.Worker
globalThis.Worker = class extends BunWorker {
  constructor(url: string | URL, opts: WorkerOptions & { env?: Record<string, string> } = {}) {
    super(compiled ? './worker-boot.ts' : join(drive, 'worker-boot.js'), { ...opts, env: { ...process.env, ...opts.env, THOD_WORKER_ENTRY: String(url) } })
  }
} as typeof Worker

const appDir = process.env.THOD_HOME ?? join(drive, 'app')
process.chdir(appDir)

// The key every encrypted column and session is signed with. Made on the first
// run and kept beside the database: a new key is every existing row unreadable.
const keyFile = join(appDir, 'db', 'encryption.key')
if (!process.env.ENCRYPTION_KEY) {
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  process.env.ENCRYPTION_KEY = readFileSync(keyFile, 'utf8').trim()
}
// The bundled packages were built with NODE_ENV inlined as production; the
// app's own files read it here.
process.env['NODE_ENV'] ??= 'production'

// print-kit refuses to boot with no Chrome, and a stock Ubuntu desktop has only
// Firefox, so the drive carries a headless Chromium beside the binary.
const bundledChrome = join(appDir, '..', 'chrome', 'chrome-headless-shell')
if (!process.env.FJS_CHROME && existsSync(bundledChrome)) process.env.FJS_CHROME = bundledChrome
const port = Number(process.env.PORT ?? 8100)
process.env.PORT = String(port)
process.env.FRONTIER_APP_URL ??= `http://localhost:${port}`
const url = `http://localhost:${port}/`
const openBrowser = async () => {
  console.log(`thod: ${url}`)
  try { await Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' }).exited } catch { /* no desktop: the line above is the way in */ }
}

// `thod open` is what the launcher icon runs. A second click finds the server
// already up and only opens the browser.
if (process.argv[2] === 'open' && await fetch(url + 'api/health').then(r => r.ok, () => false)) {
  await openBrowser()
  process.exit(0)
}

// One origin for the screens and the API, as the SPA expects (it calls /api and
// /ws on its own origin). A built file answers as itself; any other page GET
// that is not the API gets index.html, so a refresh on /admin/items lands.
// It listens on this machine only (THOD_HOST to widen it): on a desktop,
// 0.0.0.0 is every machine on the network.
const web = join(appDir, '..', 'web')
const API = /^\/(api|ws)(\/|$)/
const serve = Bun.serve
Bun.serve = ((opts: Parameters<typeof Bun.serve>[0] & { fetch: (req: Request, server: unknown) => Response | Promise<Response> }) => serve({
  ...opts,
  hostname: process.env.THOD_HOST ?? '127.0.0.1',
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

if (process.argv[2] === 'open') void openBrowser()
```

### `make-drive.ts`

```ts
// Stage the thumb-drive folder: the launcher with every package bundled in, the
// app's own files, and stub packages under app/node_modules that re-export the
// bundled copies. --plain writes a JS bundle for an installed bun instead of a
// compiled binary: about 2.6 MB zipped rather than 55.
// Usage: bun make-drive.ts <project> <out> [chrome-headless-shell dir] [--plain]
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const plain = process.argv.includes('--plain')
const [project, out, chrome] = process.argv.slice(2).filter(a => a !== '--plain')
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

const entries = ['launcher.ts', 'worker-boot.ts', 'runtime.js'].map(f => join(import.meta.dir, f))
const define = ['--define', 'process.env.NODE_ENV="production"', '--define', `THOD_BUILT_BUN="${Bun.version}"`]
const build = Bun.spawnSync(plain
  ? ['bun', 'build', '--target=bun', '--minify', ...define, ...entries, '--outdir', out]
  : ['bun', 'build', '--compile', '--target=bun-linux-x64', ...define, ...entries, '--outfile', join(out, 'thod')], { stdout: 'inherit', stderr: 'inherit' })
if (plain) {
  cpSync(join(import.meta.dir, 'thod.sh'), join(out, 'thod'))
  writeFileSync(join(out, 'BUN_VERSION'), Bun.version + '\n')
}
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

### `thod.sh` — the drive's `thod` in the plain kind

```sh
#!/bin/sh
# thod — runs the app on this machine's bun. A desktop entry starts without
# ~/.bashrc, so bun's own install folder is looked in as well as PATH.
HERE=$(dirname "$(readlink -f "$0")")
case "$1" in
  stop) pkill -f "$HERE/launcher.js" && echo "thod stopped" || echo "thod was not running"; exit 0 ;;
  help|-h|--help) echo "usage: thod [open | stop | create-owner <email> <password> [name]]   (no argument: run the server)"; exit 0 ;;
esac
BUN=$(command -v bun || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; })
if [ -z "$BUN" ]; then echo "thod needs bun: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; fi
exec "$BUN" "$HERE/launcher.js" "$@"
```

### `make-installer.sh`

```sh
#!/bin/sh
# The installable zip: the plain kind (no bun, no Chrome inside) with install.sh.
# Usage: sh make-installer.sh <project> <out.zip>
set -eu
HERE=$(dirname "$(readlink -f "$0")")
PROJECT=$(readlink -f "$1"); OUT=$(readlink -f "$(dirname "$2")")/$(basename "$2")
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
(cd "$PROJECT" && bun run build:web >/dev/null)
(cd "$HERE" && bun make-drive.ts "$PROJECT" "$STAGE/thod/payload" --plain >/dev/null)
cp "$HERE/installer/install.sh" "$HERE/installer/README.txt" "$STAGE/thod/"
cp "$HERE/installer/uninstall.sh" "$STAGE/thod/payload/"
chmod +x "$STAGE/thod/install.sh" "$STAGE/thod/payload/uninstall.sh" "$STAGE/thod/payload/thod"
rm -f "$OUT"; (cd "$STAGE" && zip -qr9 "$OUT" thod)
ls -l "$OUT" | awk '{printf "%s  %.1f MB\n", $9, $5/1048576}'
```

### `installer/install.sh`

```sh
#!/bin/sh
# Install thod for this user: no sudo, nothing outside ~/.local.
#   sh install.sh          install, or upgrade keeping the data
# Needs bun and Chrome or Chromium already on the machine; refuses by name if not.
# Unattended: THOD_OWNER_EMAIL and THOD_OWNER_PASSWORD make the owner account.
set -eu
SRC=$(dirname "$(readlink -f "$0")")/payload
DEST=${THOD_INSTALL_DIR:-$HOME/.local/share/thod}
BIN=$HOME/.local/bin
APPS=$HOME/.local/share/applications
say() { printf '%s\n' "$*"; }
die() { printf 'thod: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this build is for Linux"
[ -d "$SRC" ] || die "no payload/ beside install.sh; unzip the whole folder first"

# bun: on PATH, or where bun's installer puts it.
BUN=$(command -v bun || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; } || true)
[ -n "$BUN" ] || die "bun is not installed. Install it with:
    curl -fsSL https://bun.sh/install | bash
then run this again."
WANT=$(cat "$SRC/BUN_VERSION")
HAVE=$("$BUN" --version)
case "$HAVE" in "${WANT%.*}".*) ;; *) die "this build was tested on bun $WANT and this machine has $HAVE. Install bun ${WANT%.*}.x:
    curl -fsSL https://bun.sh/install | bash -s bun-v$WANT" ;; esac

# Chrome prints the PDFs; the app refuses to start without one. The same names
# the printer looks for, in the same order, unless FJS_CHROME names one.
CHROME=${FJS_CHROME:-}
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME=$c; break; fi
  done
fi
[ -n "$CHROME" ] || die "no Chrome or Chromium on this machine; thod prints its documents with it. Install one:
    Google Chrome: https://www.google.com/chrome/  (the .deb, then: sudo apt install ./google-chrome-stable_current_amd64.deb)
    or Chromium:   sudo snap install chromium
then run this again. One somewhere else: FJS_CHROME=/path/to/chrome sh install.sh"

# An upgrade: stop the running copy, keep the data and settings, replace the rest.
UPGRADE=no
if [ -d "$DEST" ]; then
  UPGRADE=yes
  "$DEST/thod" stop >/dev/null 2>&1 || true
fi
NEW="$DEST.new.$$"
mkdir -p "$(dirname "$DEST")"
rm -rf "$NEW"; cp -r "$SRC" "$NEW"
if [ "$UPGRADE" = yes ]; then
  for f in "$DEST"/app/db/*.db "$DEST"/app/db/*.db-wal "$DEST"/app/db/*.db-shm "$DEST"/app/db/encryption.key; do
    [ -e "$f" ] && mv "$f" "$NEW/app/db/"
  done
  [ -d "$DEST/app/storage" ] && mv "$DEST/app/storage" "$NEW/app/storage"
  [ -f "$DEST/thod.env" ] && mv "$DEST/thod.env" "$NEW/thod.env"
  rm -rf "$DEST"
fi
mv "$NEW" "$DEST"
case "$CHROME" in */*) grep -q '^FJS_CHROME=' "$DEST/thod.env" 2>/dev/null || echo "FJS_CHROME=$CHROME" >> "$DEST/thod.env" ;; esac

mkdir -p "$BIN" "$APPS"
ln -sf "$DEST/thod" "$BIN/thod"
cat > "$APPS/thod.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=thod
Comment=Orders, inventory and documents
Exec="$DEST/thod" open
Icon=$DEST/web/icon.svg
Terminal=false
Categories=Office;
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

# The one account. Sign-up is closed, so a first install makes it here.
if [ "$UPGRADE" = no ]; then
  EMAIL=${THOD_OWNER_EMAIL:-}; PASSWORD=${THOD_OWNER_PASSWORD:-}
  if [ -z "$EMAIL" ] && [ -t 0 ]; then
    say "Create the owner account."
    printf 'Email: '; read -r EMAIL
    printf 'Password: '; stty -echo; read -r PASSWORD; stty echo; printf '\n'
  fi
  if [ -n "$EMAIL" ] && [ -n "$PASSWORD" ]; then
    "$DEST/thod" create-owner "$EMAIL" "$PASSWORD" || die "the owner account was not created; run: thod create-owner <email> <password>"
  else
    say "No owner account yet. Make one with: thod create-owner <email> <password>"
  fi
fi

say ""
say "thod is installed in $DEST ($([ "$UPGRADE" = yes ] && echo "upgraded, data kept" || echo "new"))."
say "Open it from the applications menu, or run: thod open"
case ":$PATH:" in *":$BIN:"*) ;; *) say "($BIN is not on PATH yet; it is after you next log in, or run $DEST/thod open)" ;; esac
say "Back up $DEST/app/db (the databases and encryption.key, together) and $DEST/app/storage."
```

### `installer/uninstall.sh` — copied into `payload/`

```sh
#!/bin/sh
# Remove thod for this user. The data stays unless --purge is given.
set -eu
DEST=$(dirname "$(readlink -f "$0")")
"$DEST/thod" stop >/dev/null 2>&1 || true
rm -f "$HOME/.local/share/applications/thod.desktop"
[ "$(readlink -f "$HOME/.local/bin/thod" 2>/dev/null)" = "$DEST/thod" ] && rm -f "$HOME/.local/bin/thod"
if [ "${1:-}" = --purge ]; then
  rm -rf "$DEST"; echo "thod and its data are removed."
else
  find "$DEST" -mindepth 1 -maxdepth 1 ! -name app ! -name thod.env -exec rm -rf {} +
  find "$DEST/app" -mindepth 1 -maxdepth 1 ! -name db ! -name storage -exec rm -rf {} +
  find "$DEST/app/db" -mindepth 1 -maxdepth 1 ! -name '*.db' ! -name '*.db-wal' ! -name '*.db-shm' ! -name encryption.key -exec rm -rf {} +
  echo "thod is removed; its data is kept in $DEST (sh uninstall.sh --purge to delete it too)."
fi
```

### `installer/README.txt`

```text
thod — install on Linux (Ubuntu 20.04 or later, x86-64)

Needs, already on the machine:
  bun 1.4      curl -fsSL https://bun.sh/install | bash
  Chrome or Chromium, to print documents (the app will not start without one)

Install, or upgrade keeping your data:
  sh install.sh

Then open "thod" from the applications menu, or run: thod open
It runs at http://localhost:8100 on this machine only.

  thod stop                 stop the server
  ~/.local/share/thod/thod.env   settings (PORT=, SMTP, FJS_CHROME=); restart to apply
  sh ~/.local/share/thod/uninstall.sh [--purge]

Back up ~/.local/share/thod/app/db and app/storage together: the
databases are unreadable without the encryption.key beside them.
```

### `verify-installer.sh`

```sh
#!/bin/sh
# Install the zip on a clean ubuntu:24.04 as a normal user and run
# installer-test.sh's steps: refused with no bun, bun from its own installer
# (off PATH), refused with no Chrome, Google Chrome's .deb, install, every
# feature, upgrade keeping data, uninstall, reinstall, purge.
# Usage: sh deploy/portable/verify-installer.sh dist/thod-linux.zip
set -eu
HERE=$(dirname "$(readlink -f "$0")")
# Docker as a snap cannot see /tmp, so the mount is staged under ~/.cache.
M=$HOME/.cache/thod-verify-installer; rm -rf "$M"; mkdir -p "$M"; trap 'rm -rf "$M"' EXIT
cp "$1" "$M/thod-linux.zip"; cp "$HERE/installer-test.sh" "$M/"
docker run --rm -v "$M:/media/z:ro" ubuntu:24.04 bash -c '
apt-get -qq update >/dev/null && apt-get -qq install -y curl unzip ca-certificates procps >/dev/null 2>&1
useradd -m -s /bin/bash pat
r() { echo "===== step $1"; su pat -c "bash /media/z/installer-test.sh $1" 2>&1; }
r 1; r 2
echo "===== root: installing Google Chrome"
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get -qq install -y /tmp/chrome.deb >/dev/null 2>&1; google-chrome --version
r 3; r 4; r 5'
```

### `installer-test.sh` — thod's own endpoints, like `smoke.sh`

```bash
# Steps run inside the container by verify-installer.sh, as the user pat.
# Usage (in the container): bash installer-test.sh <1-5>
step=$1; P='correct horse battery staple'
api() { curl -s "localhost:8100$1" -H "authorization: Bearer $T" -H content-type:application/json "${@:2}"; }
login() { T=$(curl -s localhost:8100/api/auth/login -H content-type:application/json -d "{\"email\":\"o@t.test\",\"password\":\"$P\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/'); echo "login: token ${#T} chars"; }
up() { (~/.local/bin/thod open > ~/run.log 2>&1 &); for i in $(seq 60); do curl -s -o /dev/null localhost:8100/api/health && break; sleep 0.25; done; curl -s -o /dev/null -w "health %{http_code}\n" localhost:8100/api/health; }
case $step in
1) cd ~ && unzip -q /media/z/thod-linux.zip && sh thod/install.sh; echo "exit $?" ;;
2) curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null 2>&1; ls ~/.bun/bin/bun; command -v bun || echo "bun not on PATH"; sh ~/thod/install.sh; echo "exit $?" ;;
3) THOD_OWNER_EMAIL=o@t.test THOD_OWNER_PASSWORD="$P" sh ~/thod/install.sh; echo "exit $?"
   ls ~/.local/share/applications/; grep Exec ~/.local/share/applications/thod.desktop
   up; grep -o '"mode":"[a-z]*"' ~/run.log | head -1
   awk 'NR>1 && $4=="0A" && $2 ~ /:1FA4$/ {print "listening on", $2}' /proc/net/tcp
   curl -s -H accept:text/html localhost:8100/admin/items | grep -o '<title>[^<]*'
   login; api /api/reports -H x-service-method:run -d '{"report":"trial-balance"}' | cut -c1-50; echo
   api /api/reports -d '{"name":"Kept","group":"S","sql":"select partNumber from item","params":[],"columns":[]}' | cut -c1-40; echo
   api /api/reports/1 -H x-service-method:run -d '{}' | cut -c1-50; echo
   api /api/reports/trial-balance/pdf -o ~/t.pdf -w "pdf %{http_code} %{size_download} bytes "; head -c 8 ~/t.pdf; echo
   s=$(date +%s%N); ~/.local/bin/thod open; echo "second open exit $? in $(( ($(date +%s%N)-s)/1000000 )) ms" ;;
4) sh ~/thod/install.sh; echo "exit $?"; sleep 0.5; curl -s -o /dev/null -w "after upgrade, old server: %{http_code}\n" localhost:8100/api/health
   up; login; api /api/reports/1 -H x-service-method:run -d '{}' | cut -c1-50; echo ;;
5) ~/.local/bin/thod stop; sh ~/.local/share/thod/uninstall.sh; echo "apps: $(ls ~/.local/share/applications/) bin: $(ls ~/.local/bin/)"; echo "kept: $(ls ~/.local/share/thod) / $(ls ~/.local/share/thod/app) / $(ls ~/.local/share/thod/app/db)"
   sh ~/thod/install.sh | tail -3; up; login; ~/.local/bin/thod stop
   sh ~/.local/share/thod/uninstall.sh --purge; echo "share now: $(ls ~/.local/share/)" ;;
esac
```

## See also

- `offline-first-and-release.md` — the vision this is one artifact kind of; its
  "no `bun build --compile` path in `fli`" still holds
- `overview.md` 2.3 — Release story (`depot`): artifact kinds, single binary first
- `no-port-app.md` — the other never-deployed kinds: vendor-hosted, browser-only
- `app-cli.md` — the one surface `fli` already compiles (`FJS-D397`)
- `FJS-D263` — `desktop/`, the native shell Q3 would put this inside
