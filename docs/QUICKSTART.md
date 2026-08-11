# Quickstart — a new app, from empty directory to a deployed server

This is the one path through FrontierJS: scaffold an app, run it, add a model of
your own, build it, put it on a server. It is written as a sequence you can type,
and every command in it was run against a clean scaffold on the way to writing it.

**What is verified and what is not.** Everything up to and including
§6 *Build* was executed end to end — a real browser signed in, added a row and
read it back off the screen. §7 *Deploy* was exercised as far as a machine allows
without a server to deploy to: `deploy:doctor` and `fli deploy --dry` were run
and their output is quoted; the SSH steps are documented from the pipeline, not
from a live deployment. Where that distinction matters the text says so.

The framework is pre-alpha. Only some packages are on npm — see the root
[README](../README.md) §Publishing status — so the reliable way to run current
code is a clone of this repo, which is what §1 assumes.

---

## 1. Create the app

```bash
fli new my-app
cd my-app
```

The command is `fli new`, and its alias is also `new`. There is no `fli create`.

`fli new` composes the generators you would otherwise run by hand: it writes the
tree, installs auth, generates two keys, pushes the schema, scaffolds the example
slice and the deploy files, and runs `bun install`.
`--yes` accepts every prompt; `--no-git` skips the initial commit.

Two flags are worth knowing before you type it:

| Flag | Why |
| --- | --- |
| `--source local` | Installs `@frontierjs/*` as symlinks to `packages/` in this repo, so edits to the framework are live in your app. This is the default when you are inside the workspace. `--source npm` installs the published versions — use it once before you publish anything, because a symlink hides packaging bugs. |
| `--template api-only` | No `web/`. Everything in §5 still applies; §4 does not. |

### What landed

```
db/schema.lite            the seed — models, and the access rules on them
api/
  index.ts                app.start()
  config/junction.config.js
  src/app.ts              the construction site: every plugin, in order
  src/core/{db,env,auth,hooks}.ts
  src/services/*.service.ts       autoloaded at boot
web/
  index.html              loads /src/main.js
  config/{vite,sierra}.config.js
  src/main.js             boots the router + client, mounts App
  src/App.mesa            <RouterView />
  src/routes/             the file tree IS the route table
  src/resources/          one Resource per model
deploy/Dockerfile
frontier.config.js        the deploy block
.env                      generated, with real keys in it
```

`.env` is generated with a real `ENCRYPTION_KEY` and `AUTH_SECRET` already in it —
you do not need to copy `.env.example` or run `openssl`. It is gitignored, so a
second machine needs its own, and **the encryption key must be the same one that
wrote the data**: `@encrypted` columns written under one key cannot be read under
another.

---

## 2. Run it

Two processes: the API and the web dev server.

```bash
bun run dev          # both, in parallel
# or, in two terminals:
bun run dev:api      # :8100
bun run dev:web      # :8000
```

The web server proxies `/api`, `/auth`, `/session`, `/health` and `/ws` to the
API, so the browser only ever talks to one origin. If your API is not on
`localhost:8100`, set `API_URL` for the web process. `WEB_PORT` moves the web
side.

Those two numbers are derived, not picked: the FJS port scheme is
`env*1000 + category*100 + project*10 + service`, so dev (8) / frontend (0) /
project 0 is 8000 and dev / backend (1) / project 0 is 8100. The registry of
project ids is `packages/cli/core/ports.js`, and every app in the framework
repo sits on its own slot so two of them can run at once.

**Check the port before you start.** The web server is declared `strictPort`, so
a collision fails loudly with the number in it rather than hopping to the next
free port in silence — which is how a test ends up driving somebody else's app.
If something already owns 8000 (it is a popular default), set `WEB_PORT`, or
start the app through `fli` and let the port broker place it — the config reads
`FLI_PORT_FE` / `FLI_PORT_BE` when they are set.

**A dev server serves the code it started with.** A `.mesa` module is transformed
once and cached for the life of the process. Editing the compiler, or anything
else inside `@frontierjs/*`, invalidates nothing — restart the server that will
be tested. Your own app files hot-reload normally.

---

## 3. Prove it is alive

```bash
curl localhost:8100/health
# {"status":"ok","app":"my-app","version":"1.0.0","uptime":7,"checks":{},"ts":"…"}

curl -X POST localhost:8100/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"hunter22!","name":"You"}'
# {"token":"…","user":{"userId":"…","role":"user",…}}
```

Keep that token. `/auth/login` returns the same shape.

Open <http://localhost:8000/>. The home page prints `Junction: connecting…` until
you are signed in, and that is correct rather than broken: the WebSocket is only
opened once a token exists in `localStorage`, so an anonymous visitor talks HTTP.
After signing in it reads `connected ✓`.

The scaffold's `/users/` screen lists auth's own `model User`, and it is the
first place you can read a gate off a real screen. Auth declares
`@@gate("4.4.4.5")` — read, create, update, delete. Reading needs a signed-in
user, so a stranger gets 401 and you get the list; a signed-in caller may edit a
profile; deleting a person needs ADMINISTRATOR. Registration is unaffected by any
of it, because everything `@frontierjs/auth` writes goes through `asSystem()`,
which sits above the ladder. The three models holding credential material —
`Credential`, `Session`, `Verification` — stay at `8`, which nothing in a request
can reach.

**A gate is per model, not per row.** `update` at USER means any signed-in caller
may write any user row — "only their own" is a `@@allow('update', id ==
auth().id)`, a policy, and auth does not declare one. The two answer different
questions and fail in different registers: a gate refuses with a message naming
the model and the level, a policy compiles into the WHERE clause and quietly
returns nothing. An app that exposes `User` through a service owes itself the
policy.

---

## 4. Add a model of your own

This is the loop you will repeat for the rest of the project.

```bash
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:push
```

Six files, one command: the stanza in `db/schema.lite`, the service, the
resource, and three routes (`/notes/`, `/notes/create/`, `/notes/[id]/`).
`fli db:push` diffs the schema against the live database and applies it — no
migration file, which is what you want in development. **Restart the API** so it
re-reads the schema.

Then:

```bash
TOKEN=…                                    # from §3
curl -X POST localhost:8100/api/notes \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"First note","body":"from the quickstart","done":false}'
```

and open <http://localhost:8000/notes/>. The row is on the screen.

### What you got without writing it

Look at the stanza the scaffold appended:

```litestone
model Note {
  id        Int       @id
  title     String
  body      String
  done      Boolean
  createdAt DateTime  @default(now())
  updatedAt DateTime  @default(now()) @updatedAt

  @@gate("0.4.4.6")
}
```

That last line is four answers — read, create, update, delete — on a 0–7 ladder,
and it is the only place they are written down. Both ends read it:

```bash
curl localhost:8100/api/notes                      # 200 — read is 0, anyone
curl -X POST localhost:8100/api/notes -d '{…}'     # 401 — create is 4, needs a user
curl -X POST localhost:8100/api/notes -H "Authorization: Bearer $TOKEN" \
     -d '{"body":"no title"}'                      # 400 — title is required
```

Nobody wrote that 401, that 400, the pagination envelope, or the field list the
form renders. They are derived from the model. The full chain is
`db/schema.lite` → JSON Schema → the service's validation and the browser's
`make()` → the route's form. Change the schema and every one of them moves.

**Two rules worth internalising now.** Model names are PascalCase and singular,
always — `model Note` gives you the service `notes` and the accessor `db.note`,
and three separate resolvers depend on those three agreeing. And access is
declared in the schema, never in a hook: `@@gate`, `@@allow`, `@encrypted` and
`@guarded` are enforced at the data boundary, so they hold for a background job
and a raw query as well as for an HTTP request.

---

## 5. Where to write what

| You want to | Edit |
| --- | --- |
| Add a field, a model, an access rule | `db/schema.lite`, then `fli db:push` |
| Add behaviour to a service | `api/src/services/<name>.service.ts` — hooks, or a custom action |
| Register a plugin | `api/src/app.ts`, top to bottom, in order |
| Add a page | `web/src/routes/` — the file tree is the route table |
| Bind a page to data | `web/src/resources/` — one Resource per model |
| Change how anything looks | Nothing here defines a colour. Use `@frontierjs/css`: a tone (`danger`) and a treatment (`outlined`) |

A service context has `auth`, `client`, `route`, `locals`, `query` and
`directives`. It has **no `ctx.params`** — that belongs to raw routes only, and
reaching for it is the commonest way to write a role check that silently passes
for everyone. The request-scoped database client is `ctx.locals.db`.

---

## 6. Build

```bash
bun run build
```

Vite builds `web/` into `dist/client/`, and Sierra's post-build writes
`robots.txt`, a sitemap and speculation rules. The API needs no build step — Bun
runs the TypeScript.

**Look at the built `index.html` before you ship it.** Vite injects the script
tag at the first match for the body tag and does not skip comments, so a body tag
mentioned inside an HTML comment swallows the injected tags: the build succeeds,
the file looks right, and the page loads no JavaScript at all. This has happened
twice in this repo. Never write the body tag inside a comment.

---

## 7. Deploy

The deploy is Docker over SSH with an nginx front, driven by the `deploy` block
in `frontier.config.js`. `fli new` scaffolds that block, `deploy/Dockerfile` and
`.dockerignore` with placeholder values.

### 7.1 Fill in the target

```js
// frontier.config.js
deploy: {
  server: 'deploy@your-server.com',   // ← yours
  path:   '/apps/my-app',
  api:    { health: '/health' },
}
```

The health path is load-bearing: the pipeline polls it after the container comes
up and **rolls back automatically when it does not answer 200**. The scaffolded
`api/src/app.ts` already registers it via `healthPlugin()`.

### 7.2 Ask what is missing

```bash
fli deploy:doctor
```

It checks the config, the Dockerfile, the health and `/ws` routes, `.env.example`,
and git. Output on a clean scaffold whose only unfinished business is the
placeholder server:

```
✓ Dockerfile at deploy/Dockerfile
✓ /health route in api source
✓ /ws route in api source
✓ .env.example reference exists (envCheck active)
✓ branch: main
⚠ upstream tracking — branch has no upstream set
```

The deploy pulls via git on the server, so the repository must exist, be
committed, and have an upstream. `--remote` adds the checks that need to reach
the machine.

### 7.3 Prepare the server, once

```bash
fli deploy:setup
```

Checks the target for everything a deploy needs and walks through installing what
is missing, writes the nginx config, and creates the directory structure under
`<path>`.

Then put the secrets on the server. They are not deployed with the code:

```bash
fli env:set --remote ENCRYPTION_KEY=… DATABASE_URL=… PORT=… APP_URL=… NODE_ENV=production
# or push the local file:
fli env:pull --from ssh --server dev --path /apps/my-app/.env.production
```

**`ENCRYPTION_KEY` must be the key the data was written with.** A new key on the
server does not fail at boot — it fails on the first read of an `@encrypted`
column.

### 7.4 Deploy

```bash
fli deploy --dry          # print every command, run none
fli deploy                # dev, or the branch's environment
fli deploy --production
```

Ten steps, in order: `preflight` (SSH, the deploy lock, Litestream detection),
`env-check`, `pull`, `build-web`, `build-api`, `backup` (a hot backup of the
database before anything changes), `swap`, `health`, `release-web` (an atomic
symlink swap and an nginx reload), `cleanup`. The environment comes from
`--production` / `--stage`, else from the git branch.

**Migrations run inside the new container's entrypoint**, before it serves
traffic. A migration that fails exits the container non-zero, the health poll
fails, and the previous container is restored — so a bad migration is a failed
deploy rather than a half-migrated live app.

Run `--dry` first. It prints each SSH command it would run, and the env check is
real even in a dry run — on a fresh server it names exactly which keys are
missing before anything is built:

```
✗ Env check: 5 key(s) missing from /apps/my-app/.env.production
⚠   ENCRYPTION_KEY  DATABASE_URL  PORT  APP_URL  NODE_ENV
```

### 7.5 Afterwards

```bash
fli deploy:status      # what is running, which release
fli deploy:logs        # container logs
fli deploy:rollback    # back to the previous release
fli deploy:local       # build and run the production image on this machine
```

`deploy:local` is the honest rehearsal — it runs the same image the server would,
and catches a Dockerfile that only works on your laptop's file layout.

---

## What this guide does not cover

Real-time channels beyond the connection itself, background jobs
(`@frontierjs/caravan`), outbound mail (`@frontierjs/conduit`), notifications,
prerendered public sites (Sierra's `static` target), and multi-tenancy. Each has
a package README, and [`example/`](../example/) exercises all of them in one app
with six drives you can run.

## Where to go next

- [`example/`](../example/) — the kitchen sink: one shop-ops app across all three
  realms, with real auth, a gate ladder and an order state machine. The place to
  see a finished version of what you just built.
- [`ARCHITECT.md`](../ARCHITECT.md) — the mental model and its vocabulary.
- [`packages/litestone/docs/`](../packages/litestone/docs/) — the schema language
  in full: relations, transitions, policies, migrations.
- [`packages/junction/README.md`](../packages/junction/README.md) — services,
  hooks, actions, channels.
- [`packages/css/guide/`](../packages/css/guide/) — the design system's 53-page
  reference. Start at *Pick a term*.
