# Guide — moving a stressor app onto the current framework tree

**For:** whoever (person or agent) brings the next app in `fjs-prototypes/`
up to date after a run of core changes, until `fli dev` boots it and `bun
run check` is green again.

Written from the ela upgrade on 2026-10-19. Two kinds of content here:

- **The method** (§§ 1–9): the order things have to happen in, and how to
  find the breakage. This holds for any upgrade.
- **The renames** (§ 10): what changed between ela's last sync (~2026-10-13)
  and `91f792c1`. They go stale. An app last synced earlier has more of them,
  and one synced later has fewer. Treat the tables as a checklist to confirm,
  not a script to run blind.

The rules every stressor already follows still apply: a framework defect is
fixed in frontierjs or filed with `fli file`, never worked around in the
app. A reference app stays read-only.

---

## 0. Before touching anything

1. **Find what a boot reaches outside the machine.** Read the app's
   `CLAUDE.md` and `api/src/core/env.ts` for any variable whose default is a
   live system. In ela, `SA_URL` defaulted to the real Service Autopilot, and
   a cron polls it every five minutes. **Pin every one of them to a
   stand-in in the app's `.env` before the first boot.** `.env` is
   gitignored, and `fli dev` starts the API.
2. **Start from a clean tree** (`git status`) so the upgrade is one diff.
3. **Take a test baseline at HEAD:** `bun test api/test 2>&1 | tail -5`.
   ela skipped this and had to work out afterwards which reds were already
   there (they were in `PLAN.md`'s status line). With a baseline, "new
   failures" is a diff and not an investigation.

## 1. Scaffold a fresh reference and diff against it

The fastest way to see what the scaffold writes now:

```bash
cd <scratch dir>
fli new fresh --source local <the app's original flags> --yes
```

The app's flags are in its `PLAN.md` § Phase 0 (ela: `--full --widgets
--auth`). Then diff the files the scaffold owns:

```bash
F=<scratch>/fresh
jq .scripts $F/package.json                     # script NAMES matter (§ 2)
for f in web/config/vite.config.js web/config/sierra.config.js \
         widgets/config/vite.config.js api/config/junction.config.js \
         api/src/app.ts api/src/core/auth.ts api/src/jobs/retention.job.ts; do
  echo "== $f"; diff $F/$f $f
done
```

`fresh/api/src/app.ts` and `core/auth.ts` are the clearest statement of the
current plugin idiom (§ 10). Keep the app's own wiring, and take the
framework's shape.

## 2. Make `fli dev` compose

`fli dev` starts each surface itself, labeled (`api │`, `web │`) and on the
app's own dev slot, **only when `dev` is a list of surface scripts it knows
by name** (`packages/cli/core/ports.js` `SURFACE_PORTS`). The names are now:

| surface | script name(s) |
| --- | --- |
| api | `api` |
| web | `web` |
| widgets | `dev:widgets` or `widgets` |
| site | `dev:site` or `site` |
| desktop | `dev:desktop` or `desktop` |

`dev:api` and `dev:web` were dropped on purpose (`8c794933`, 2026-10-17).
Every app scaffolded before then has them, and `fli dev` then quietly runs
`bun run dev` unlabeled. Rename them, and update every mention: README,
PLAN, `.env.example`, comments, `db/seed.ts`. A grep for `dev:api\|dev:web`
finds them.

Match the rest of the scaffold's lines while you're in there:
- vite scripts take `--configLoader native`
- `web/config/vite.config.js` gets `envDir: '..'`, so a `VITE_` variable in
  the root `.env` reaches the client
- the proxy is keyed `[sierraConfig.junction.apiPrefix]`, not a literal
  `'/api'`

**How to tell it worked:** a real `fli dev` prints one `READY <app> · slot
N` summary with a line per surface. A dev that falls through prints raw
interleaved output instead.

## 3. Schema first

Every other `fli check` rule reads the schema. While litestone refuses to
parse it, those rules read it as text, and the API won't boot at all.

```bash
fli check --only schema-runs,package-model-drift
```

- **`schema-runs`** names the first refusal. Fix it and run again, since
  the next one hides behind it.
- **`package-model-drift`** lists columns a package's code now writes that
  the app's copied model lacks (ela: `User.kind`, `Notification.deliveryKey`).
  Copy each one exactly as the package's `db/*.lite` declares it, with its
  enum, comment and any `@@unique`. A drift that was deliberate stays in
  `check-baseline.json`.
- **Tenancy warnings** on framework-imported models (ela: `OutboxMessage`)
  are answered the way the auth models already are:
  `extend model X { @@tenant(none) }`.

Then migrate. **Read the migration before applying it:**

```bash
fli db:migrate core_upgrade --create-only
sed -n '/^-- Changes:/,/^$/p' db/migrations/main/*_core_upgrade.sql | less
```

Expect much more than your own edits. The framework's catch-up rides along:
ela's carried an `AUTOINCREMENT` rebuild of 48 tables (FJS-D887), auth's new
`Verification.secret`/`registrant` and `Credential.linked`, and `_search`
reindexes. Each rebuild is guarded by a row count, so a lost row fails the
migration instead of committing it. Migrations sit in one folder per
database (`db/migrations/main/`, `audit/`, …), and one run writes a file
into each folder that changed.

Back up, then apply. `fli db:migrate` has no `--backup` flag, though
litestone's warning suggests one:

```bash
B=db/backups/$(date +%F)_core_upgrade; mkdir -p $B
for f in db/*.db; do sqlite3 $f ".backup $B/$(basename $f)"; done
fli db:migrate --apply-only
bun run db:types
fli db:migrate probe --create-only   # must say "no migration needed"
```

Apply to the dev databases only. Production copies (`*.prod.db`) are the
owner's decision; say in PLAN that they were not migrated.

## 4. Fix `.env` drift

A local `.env` predates whatever moved since. Compare it with `.env.example`
and with `api/src/core/env.ts`'s defaults. ela's `AUDIT_PATH` still named
the old JSONL directory after the audit trail had moved to SQLite
(`./db/audit.db`), and `migrate create` failed with `unable to open database
'audit'`. Fix `.env.example` in the same pass.

## 5. Collect all the breakage before fixing any

Three sources, because each sees what the others can't:

| source | sees | doesn't see |
| --- | --- | --- |
| `fli check` | kit props, class collisions, export-map subpaths, model drift | named imports, runtime |
| `fli typecheck` | `.ts` in api/, db/, tests | `.mesa`, browser `.js` |
| `bun run build:web` / the vite log | anything that fails to resolve or compile in the browser bundle | the API |

Group the big ones before reading them:

```bash
fli check > /tmp/check.log 2>&1; grep -E "^\s*[✗⚠] " /tmp/check.log    # rules
grep -oE '^\s+<[A-Za-z]+ [a-zA-Z:-]+>' /tmp/check.log | sort | uniq -c | sort -rn   # kit-prop-unknown by component+prop
fli typecheck 2>&1 | grep -oE "error TS[0-9]+: .{0,120}" | sort | uniq -c | sort -rn
```

Until **FJS-3329** closes, `import-subpath-exported` misses an import that
matches a wildcard export key but whose file is gone: `stores/toastStore.js`
and the removed `DropdownLabel.mesa` both passed it. Start the web dev
server or run `build:web` to catch those. You don't need the API for that.

## 6. Split the work

Once the schema is migrated, what's left falls into two disjoint
directories, and they run well in parallel:

- **api/** (and the `db/*.ts` scripts): plugin renames, jobs, tests.
- **web/ + widgets/**: kit props, imports, class collisions.

The lead keeps everything shared: `db/schema.lite`, migrations,
`package.json`, `.env`, PLAN.md and the frontierjs register. Each agent's
brief should carry the safety rule from § 0 word for word. The web agent
must not start the API at all. ela's two agents took ~9 and ~32 minutes.

## 7. Tests

Separate the reds into three piles against the § 0 baseline:

1. **a rename not yet followed:** fix it
2. **a framework defect:** file it; leave the test red and name the row in PLAN
3. **already red at HEAD:** leave it; say so

The test-side patterns from ela are in § 10.

## 8. Verify for real

```bash
bun run sa:standin &              # or whatever the app's stand-ins are
fli dev                           # READY summary, all surfaces
curl -s localhost:<be>/api/health                    # every db "ok"
curl -s -o /dev/null -w "%{http_code}\n" localhost:<fe>/api/health   # through the web proxy
bun run check                     # fli check, lint, typecheck, tests
```

The slot ports come from the READY line (ela: slot 8, so 8008/8108/8208).
Don't assume 8000/8100: another app may hold them, and only `fli dev`
moves to a free slot. Then drive the pages behind login with the
`drive-browser` skill, especially anything a rename changed structurally
(the dropdown groups in ela).

Don't `pkill -f "fli dev"` from an agent shell. The pattern matches the
shell's own command line and kills it. Stop by port, or by the pid you
started.

## 9. Close out

- File every framework gap the hour it's found (`fli find`, then `fli file`,
  from inside frontierjs). ela filed FJS-3326–3329.
- Leave scaffold changes that alter behaviour for the owner instead of
  adopting them silently. In ela: reset/verify links as `#token=`
  fragments (the web reset page must read the fragment) and auth's
  `onCredentialChanged` notice.
- Add a dated section to PLAN.md and a lead clause in its `status:`. Say
  what was migrated and what wasn't (prod copies, data left in an old
  store), what's red and why, and what's owed to the owner.

---

## 10. The renames, as of `91f792c1`

### Schema

| was | now |
| --- | --- |
| `@allow('write', …)`, `@@allow('read', …)` | `@allow(write, …)`, `@@allow(read, …)`: the operation bare |
| `@@gate("4.4.4.5")` | `@@gate(4.4.4.5)` |
| `database audit { … driver trail }` (JSONL directory) | `import "@frontierjs/litestone/references/AuditTrail.lite"`, `database audit { path env("AUDIT_PATH", "./db/audit.db") retention 90d model AuditTrail }`. A JSONL model ran no `@@gate` and no tenancy. Old trail data isn't carried over |
| User copied from auth | add `enum UserKind { user bot peer }` and `kind UserKind @default(user) @system @immutable` |
| Notification copied from notifications | add `deliveryKey String?` and `@@unique([userId, type, deliveryKey], nullsDistinct: true)`; the package's `contextId` is now `String?` |

### API wiring (`api/src/app.ts`, `core/auth.ts`)

| was | now |
| --- | --- |
| `createApp({ … })` probing for files | `createApp({ root: import.meta.url, … })`. With no root, **nothing** is read from disk: no services, routes, jobs, notifications or config |
| `services: { dir }`, `caravan: { jobsDir }` in `junction.config.js` | removed; boot refuses them. Found from the root |
| `createAuthPlugin(auth, opts)` | `import { auth as authRoutes } from '@frontierjs/auth'`, then `authRoutes({ auth, ...opts })` |
| `services: { level: (s) => getLevel({ ...s, id: s.userId }) }` | `services: { level: getLevel }`: the plugin now hands over `id` beside `userId` |
| the `authCleanup` plugin in app.ts | gone; `authPlugin`'s `work()` runs the sweep |
| `createCaravan()` | `caravan()` |
| `mailerPlugin(m)` | `mail({ mailer: m })` from `@frontierjs/junction/mail` |
| `notificationsPlugin({ db, notifications: <dir>, transports })` | `notifications({ db, transports })`; the folder comes from the root |
| `mcpPlugin({...})` | `mcp({...})` |
| `app.get(...)` / mounted raw routes | file routes under `api/src/routes/`, where the path is the URL (`messages/[id]/recording.ts` exports `GET`). Boot refuses a file there that exports no method, so helpers go in `_x.ts` beside it (FJS-2895) |
| `if (app.mail)` / `typeof app.notify !== 'function'` | `if ('mail' in app)`: reading an unconfigured slot (`mail`, `notify`, `conduit`, `jobs`) now **throws** |

### Jobs

```ts
// was
export default defineJob('sa-poll', async (ctx) => { … }, { cron: '*/5 * * * *' })
// now
export default defineJob({ name: 'sa-poll', cron: '*/5 * * * *', handler: async (ctx) => { … } })
```

In `api/src/jobs/` the file name is the job's name. Keep `name:` anyway: a
job outside `jobs/` (ela's `providers/3cx/jobs.ts`) or one a test registers
directly needs it. `ctx` is typed once the object form is used.

### Tests

| was | now |
| --- | --- |
| `createApp({ …, autoload: services })` | `createApp({ …, root: appRoot() })`. A root also makes caravan schedule every cron job in `jobs/` and loads route files that import the app's own db, so ela's `api/test/root.ts` builds a temp root linking only `services/` and `notifications/`. Copy it. (A way to turn that off isn't filed yet; see ela PLAN.) |
| `app.notify = spy` | throws: plugins own their slots non-writable. ela's `api/test/slots.ts` `setSlot(app, 'notify', spy)`; `undefined` releases the slot |
| a custom method by GET (`matches`) | by POST |
| `$limit` above 100 | ≤ 100 |

### Web (`.mesa`)

| was | now |
| --- | --- |
| `<Button variant="ghost\|outlined\|link\|raised">` | `treatment="…"` |
| `<Button variant="danger">` (a tone) | `tone="danger"` |
| `variant={c ? 'primary' : 'outlined'}` | `treatment={c ? '' : 'outlined'}`: `''` is the filled default |
| `variant={c ? 'warning' : 'outlined'}` | `tone={c ? 'warning' : ''} treatment={c ? '' : 'outlined'}` |
| `<CopyButton variant>` | `treatment` |
| `<EmptyState description="…">` | the text as children |
| `<ConfirmationPopover description>` | `message` |
| `@frontierjs/ui/stores/toastStore.js` | `@frontierjs/ui/stores/toastStore`: `./stores/*` appends `.js` |
| `@frontierjs/mesa/runtime.js` | `@frontierjs/mesa/runtime` |
| `DropdownLabel` above its rows | `<DropdownGroup heading="…">` **wrapping** the rows; separators stay outside |
| a local `.meter`, `.lane`, `.facts`, `.list-row`, `.grid` in a `<style>` | `css-class-collision`: use the kit's own where it fits, otherwise rename. Reaching the kit's class on purpose is `.parent :global(.facts)` |

ela's numbers, for scale: 445 Button props across 172 files, 22 jobs, 7 raw
routes, 22 `@allow`s, one 2,533-line migration, 277 files changed in all.
