---
id: app-console
status: proposed
dated: 2026-10-26
---

# Idea — A prompt inside the booted app: `rails c` for the API realm, on the laptop and on the box

**Status: PROPOSED. Nothing in § 3 or after is built.** Dated 2026-10-26. Do not
cite this file as behavior — see `VERIFYING.md`. § 1 was read off the tree on
that date and 0.1 was run against yuma.

**The question:** when production is wrong, what loads the app and lets an
operator call a service as somebody, or as the app itself, from a prompt — and
how does that prompt reach a deployed container with no `fli` on the box?

---

## Trigger

The owner, on yuma, asked whether `fli` was on the box and whether `fli api:repl`
would do. It would not: `api:repl` is an HTTP client, and signs in as somebody
the way a browser does. `bun repl` in the container loads nothing. The gap is a
console that is the app, with its gate in front — `artisan tinker` with a
standing.

---

## 1. What exists

**Most of this is built.** The Data half is a command, the API half is a one-shot,
and the box is one `docker exec` away.

| Piece | Where | Does | Lacks |
| --- | --- | --- | --- |
| `fli db:repl` | `litestone repl` (`packages/litestone/src/tools/repl.js`) | `db` at a standing (`--as`, `--level`, `--gate`, `--tenant`), `sys` = `asSystem()`, `-e` one-liner, JSON on stdout | no app: no service, no hook, no envelope; `--gate` is a path the operator must know |
| `fli app:call` | `junction call` (`packages/junction/tools/call.ts`) over `core/call-as.ts` | boots the app in-process, one `<service>.<method>` as somebody, graded as a request is (`FJS-D1426`) | one call, then exit; no `sys` |
| `fli api:repl` | `junction repl` (`tools/repl.ts`) | HTTP against a running app | a client, not the app |
| devtools `:call` `:data` `:ask` | `fli gui` panes | as somebody, inside the running app | refused outside development (`FJS-D1426`) |
| `fli deploy:run "<cmd>"` | `docker exec -it <container>` over ssh | any command inside the API container, tty passed through | always `-it`: with no tty on stdin docker refuses (`cannot attach stdin`), so a one-liner from a script cannot ride it |

**The boot a tool makes claims nothing.** `loadApp` runs `applyConfigFile()` and
`_startOnce()` — plugins, hooks, routes — and skips the phases that need a port
and the one that starts work (`tools/app-module.ts` § build). A prompt left open
for an hour ticks no cron and claims no job the serving process is owed.

**The image carries the tools.** Junction's `files` ships `tools/`, litestone's
ships `src/`, and the image copies `api/` and `db/` (`packages/basecamp/deploy/Dockerfile`).
Proved on yuma 2026-10-26: `bunx litestone repl` resolved from the container's
`node_modules`, read the schema and reached `--as`.

`db:repl.md` § *What it is not, yet* names this paper: a console over services
"needs the app booted rather than the schema read", and `asSystem()` "is not
attributed to the operator here", a question to answer once for the repl and
for support mode.

---

## 2. Prior art

- **Rails `c`, Laravel `tinker`, Django `shell`** — a second process that boots
  the app and opens a prompt. God-mode by construction, because authorization
  lives in their controller layer. The console is the first tool reached for
  when production is wrong; each ships it into production on purpose.
- **Phoenix `iex -S mix`** and `--remsh` — attach to the running node, so
  broadcasts reach clients. `FJS-D1426` chose that shape for `:call` because
  the pane needed `:live` to see the write. An attach is a wire protocol the
  app would have to grow; this paper does not need `:live`.
- **Laravel `tinker` in production** prints no warning and `rails c` prints the
  environment in the prompt. Both leave the write unattributed in any log.

---

## 3. The proposal

One tool, in junction, that boots the app the way `call` does and keeps it
booted under a prompt:

```
$ fli app:repl --as alice@shop.test --tenant flagship

  Standing: alice@shop.test(4) USER · flagship

alice(4) > await call('orders.find', { status: 'paid', $limit: 5 })
alice(4) > await call('orders.patch', 12, { note: 'late' })
  Forbidden (403): "orders.patch" requires level 5, user has level 4
alice(4) > as('ops@shop.test')
ops(5)   > await sys(() => app.service('orders').patch(12, { note: 'late' }))
```

The names in scope, and who owns each:

| Name | Is | Owner |
| --- | --- | --- |
| `app` | the booted `App` | `tools/app-module.ts` `loadApp` |
| `call(method, ...args)` | one method at the session standing, the request's hooks, gate and envelope | `core/call-as.ts` `callAs` (`FJS-D1426`: the one call path) |
| `as(who)` | switch the session standing; `as()` is nobody | `call-as.ts` `actAs`, over its private `standingOf` |
| `sys(fn)`, `sys.<model>.<method>()` | run `fn`, or one client method, as the app's own principal, every gate off — the second is `db:repl`'s `sys` | `app.runAs(null, fn)` |
| `db` | the data client at the session standing | `actAs` + `app.withDb`, as `rowsAs` opens it (`FJS-D1427`) |

Nothing new grades anything. Gate, tenancy and the principal lookup come from
the booted app, which is why the prompt takes no `--gate`: `db:repl` needs the
flag only because it reads the schema and not the app (Q5).

`-e '<expr>'` evaluates once and exits, with `db:repl`'s contract: the answer as
JSON on stdout, the standing and a refusal on stderr, exit 1 on a throw.

**On the box** it is the same tool through `deploy:run`, which already passes
a tty: `fli deploy:repl --as <who>` spawns `junction call --app <module>` in the
container. No `fli` on the server, and nothing the container does not already
hold.

---

## 4. Plan

### Phase 0 — Prove the reach, no code

Goal: know what yuma answers today, before a line is written.
Done when: both commands answer from the container and each step's found-line
says what it lacked.

- [x] 0.1 litestone's repl in the container.
  ```
  fli deploy:run "bunx litestone repl --schema db/schema.lite --as dev@knight.works --gate api/src/core/gate.ts#basecampGateLevel"
  ```
  - 2026-10-26, first run: tty passed, the CLI resolved, the schema read, and
    `--gate api/gate.ts` failed — that is the example's path; Basecamp's
    resolver is `api/src/core/gate.ts#basecampGateLevel` (`api/src/core/db.ts:110`).
    A gate path the operator has to know is Q5's reason.
  - 2026-10-26, second run, as vlad@kobami.com, over `ssh yuma docker exec`
    with no tty: `--eval 'db.workspace.count()'` printed `1`, standing
    `vlad@kobami.com(7) SYSADMIN` graded by the corrected path. Two lacks:
    `deploy:run` refuses without a tty (§ 1), and the bare CLI takes `--eval`
    — `-e` is only `fli db:repl`'s alias, and litestone ignored it in silence
    and opened the prompt.
- [x] 0.2 `junction call` in the container.
  ```
  fli deploy:run "bunx junction call --app api/src/app.ts workspaces.find --as dev@knight.works"
  ```
  Proves the app boots against `/db` under the container's env, with the
  production `DATABASE_URL`. `bunx` is fine here and only here: the image has
  the install, so it resolves locally rather than fetching a stranger's
  `junction` (`app-entry.js` § callArgv).
  - 2026-10-26, as vlad@kobami.com, same ssh path: exit 0, the `list` envelope
    on stdout with the one workspace, the standing on stderr, `Shutdown
    complete` within half a second. The boot logged `schedules restored
    count 0` and `Loaded 20 job handlers`: the work phase stayed off, but a
    Basecamp schedule restore runs at boot, and with a nonzero count Phase 1
    must show it arms nothing.
- [x] 0.3 Record Q1–Q5 in `DECISIONS.md`, one ruling each; Q3's ruling amends
  `db:repl.md` § *What it is not, yet* in the same commit.
  - 2026-10-26: `FJS-D1532`–`FJS-D1536`. `decision-rules` added three
    clauses: the prompt opens only on a TTY or with `-e` (D1532); the operator
    rides support mode's `operatorId` seam with its own `operatorType` (D1534);
    a write prints that open screens miss it (D1535). Owed: a `call-argv` row,
    a prod-`sys`-without-`--force` row, an `actorId` drive.

### Phase 1 — The prompt, in junction

Goal: `junction call --app <m>` with no method opens the prompt of § 3.
Done when: from `example/api`, `bun ../../packages/junction/tools/cli.ts call --app src/app.ts -e 'call("products.find", { $limit: 1 })' --as alex@shop.test --tenant flagship`
prints the list on stdout and the standing on stderr, and the same as nobody
on a gated method prints a refusal and exits 1. (`ops@acme.test` is a
Customer, not a User, and no service answers `count`.)

- [x] 1.1 `tools/call.ts` with no `<service>.<method>` word opens the prompt;
  the one-shot path is untouched. The prompt is readline, lifted from
  litestone's `repl.js` (history file, `.help`, a completer) — junction may
  import litestone's helpers and not the reverse (Invariant 1), which is why
  the tool lives here.
  - 2026-10-26: litestone's `startRepl`/`evalOnce` take `binds`, the names an
    expression reads (`db:repl` passes `{ db, sys }`; the `db`/`sys` options
    are gone), `names` for `.help`, which lists the binds and nothing else, a
    `history` file, `commandsFrom`, and a `standing` that may be a function
    read before each prompt (for `as()` at 1.2). Exported, typed, as
    `@frontierjs/litestone/repl`; four rows in `litestone/test/repl.test.ts`.
    Junction refuses in a sentence when litestone, an optional peer, is
    absent.
    Junction opens it with `app` alone in scope, history in
    `~/.junction_call_history`. Under a pty as `alex@shop.test --tenant
    flagship`: `.standing`, `app.services.list().length` → 46, `.help`,
    `.exit` → `Shutdown complete`, exit 0. No tty: the old refusal, exit 1.
    The prompt line is `standingOf`'s whole string with the user's id; 1.3
    shortens it.
- [x] 1.2 The five names of § 3 in scope. `call` and `as` are `callAs`; `sys`
  is `app.runAs(null, fn)`; `db` is the client `rowsAs` opens. Add nothing
  beside `callAs` (Invariant 4).
  - 2026-10-26: nothing new exported from `call-as.ts` — `standingOf` stays
    private and `actAs` carries it. The session is `{ as, tenant }`,
    re-resolved on every `call` and `db` call; `as()` validates before it
    switches. A refusal throws as `<name> (<status>)` with `status` and `data`
    on the error, so `-e` will exit 1 on it. `db` and `sys.<model>` are
    proxies that open the client per method, inside `actAs` or `runAs(null)`
    + `withDb`, because a held client answers at whatever standing is
    ambient; inside `sys()` `db` is still the session's. `sys` is also
    callable, so `db:repl`'s `sys.order.count()` reads the same here, and
    accessors complete. Under a pty as `alex@shop.test --tenant flagship`:
    `db.product.count()` → 13, `sys.order.count()` → 20; after `as()`,
    `orders.find` → `Unauthorized (401)`, `db.order.count()` →
    `AccessDeniedError`, `sys.order.count()` → 20; an unknown `as()` is
    refused and the standing kept. `decision-rules` ran after the code; its
    four amendments are in. Owed at 1.4: an `-e 'db.order.count()'` row as
    nobody exiting 1, and an unknown-`as()` row.
- [x] 1.3 `-e` with `db:repl`'s contract, and the prompt line carries the
  standing. A `sys` write under `NODE_ENV=production` asks for `--force` (Q2).
  - 2026-10-26: `--eval`, `-e` for short, runs litestone's `evalOnce` over the
    five binds inside `quietly`; the answer is written after `stopApp`, so
    stdout holds it alone. `-e` or `--force` beside a method word is refused.
    The line is `[PRODUCTION · ]<as|nobody>[ · <tenant>]` through a new
    `prompt` option on `startRepl`; `.standing` and the opening line print
    `standingOf`'s whole. `evalOnce` took `commandsFrom`, so junction's `-e`
    no longer names `db/repl.js`. `--force` is session-wide, `deploy:retire`'s
    shape rather than `resetPasswords`' per-line one. Unforced in production,
    `sys` runs only `<model>.<verb>()` with a verb outside `WRITE_VERBS`, now
    exported from `src/core/litestone.ts`, the list `read: true` refuses by;
    `sys(fn)` is refused whole, since a rollback cannot unsend queued mail.
    `decision-rules` ran after the code and found `sys.$transaction(…)` past a
    verb denylist; the guard now admits the two-segment shape alone. It guards
    a slip: `app.runAs(null, …)` walks past it, as the comment says. From
    `example/api`: `products.find` as alex → JSON that parses, exit 0;
    `db.order.count()` and `orders.find` as nobody → `AccessDeniedError`,
    `Unauthorized (401)`, exit 1, stdout empty; an unknown `as()` → exit 1.
    Under `NODE_ENV=production`: `sys.order.count()` → 20; `sys.order.create`,
    `sys.$transaction`, `sys(fn)` → `Refused`, exit 1; with `--force` a
    `deleteMany` matching no row → `{ count: 0 }`. A pty shows
    `PRODUCTION · alex@shop.test · flagship >`, then `· nobody ·` after
    `as()`. Owed at 1.4 besides 1.2's rows: `sys.order.create` and
    `sys.$transaction` refused under production, and one `--force` row.
- [x] 1.4 The `-e` path is tested beside `call`'s existing test, and the test
  parses stdout as JSON (Invariant 15). No new drive file while this is
  experimental; the drive row comes at 3.1.
  - 2026-10-26: a `junction call -e` block of six rows in
    `junction/test/call-tool.test.ts`, over the same on-disk app, which gained
    a `Ledger` at `@@gate(5)` — members 5, the system principal 7, nobody 0 —
    because Note's row policy filters nobody to `0` rather than refusing, and
    grades the app's own principal the same way. Paired: `db.note.count()` 2
    as ann, 0 as nobody; `db.ledger.count()` 1 as ann, `AccessDenied` exit 1 as
    nobody; `as('bo@x.test')` then `whoami` → `{ id: '2' }`, an unknown `as()`
    exit 1. Under `NODE_ENV=production`: `sys.ledger.count()` → 1 unforced;
    `sys.ledger.create`, `sys.$transaction`, `sys(fn)` exit 1 naming `--force`;
    with `--force` a no-match `deleteMany` → `{ count: 0 }`. With the guard
    forced off the production row goes red. Junction 3334/0, typecheck clean.

### Phase 2 — The two `fli` wrappers

Goal: the prompt from the laptop, and from the laptop into the box.
Done when: `fli app:repl` opens on `example`, and `fli deploy:repl --as dev@knight.works` opens on yuma.

- [x] 2.1 `fli app:repl` beside `app:call`; both build argv with `callArgv`
  (`packages/cli/core/app-entry.js`), so WHICH app and FROM WHERE stays one
  answer.
  - 2026-10-26: `commands/app/repl.md`; `callArgv` took `code` and `force`,
    passed as `--eval` and `--force`, and one row in `call-argv.test.js`. From
    `example/` through `bin/fli.js`: `products.find` as alex → JSON, exit 0;
    `db.order.count()` as nobody → `AccessDeniedError`, exit 1; under
    production `sys.order.create` → `Refused` naming `--force`, exit 1, and
    with it a no-match `deleteMany` → `{ count: 0 }`. Under a pty the prompt
    opens as `alex@shop.test · flagship >`, `db.product.count()` → 13,
    `.exit` → 0.
- [x] 2.2 `fli deploy:repl [--as] [--tenant] [--production|--stage]` is
  `deploy:run` with the argv of 2.1, `-t` dropped under `-e` (0.1), resolved
  inside the container: the module `callArgv` names — `--app` as a container
  path, else the local snapshot header relative to the app root, else the
  layout. No deploy-block key.
  - 2026-10-26: `commands/deploy/repl.md`. No deploy-block key: `callArgv`
    took `inContainer`, so the module is `app:call`'s answer, not a second
    one; only the path travels. Junction there is `bunx --no-install
    @frontierjs/junction` — `decision-rules` found bare `bunx junction` would
    fetch npm's unrelated `junction` into the production container. `ttyCommand` took `pty: false`, so `-e`
    runs `ssh` without `-t` and `docker exec` without `-it`, stdin ignored.
    One `call-argv` row. On yuma both paths reach the container and exit with
    its junction's status, and that junction predates Phase 1: `-e` →
    `Unknown flag --eval`, the prompt → `Name a method`, exit 1. Open until a
    Basecamp deploy carries the new junction.
  - 2026-10-27, after the owner's Basecamp deploy: `-e 'db.workspace.count()' --as
    vlad@kobami.com` printed `1` and shut down clean; the bare command opened
    `PRODUCTION · vlad@kobami.com >` with tab completion over `db.` and `sys.`.

- [x] 2.3 A `sys` write from either prompt files the operator as the trail's
  actor (`FJS-D1534`), through support mode's `operatorId`/`operatorType` seam.
  The operator is whoever is at the keyboard, never the `--as` standing — the
  owner amended the ruling on 2026-10-26 — and `deploy:repl` hands the box's
  login into the container.
  - 2026-10-26: junction's `RequestMeta` took `operator: { id, type }`, set by
    `app.runAs(null, { operator })` alone and read by `installLogContext`
    after `attestedBy`; `reenterAs` keeps it. Litestone's `buildLogEntry`
    hands its provider `{ isSystem }`, and `db:repl`'s closure answers the
    operator only then. Both take `replOperator()` from
    `@frontierjs/litestone/repl`: `$USER`, else the passwd name, typed `repl`.
    `deploy:repl` runs `docker exec -e USER`. Rows, each paired with a write
    that must not file the operator: three in `call-tool.test.ts` (sys →
    `op-test`/`repl`; `db` as ann → `1`/`user`; sys under `--as ann` →
    `op-test`), red on the first and third with `operator` dropped from
    `asApp`; two in `attested-by.test.ts`; one in `litestone/test/repl.test.ts`
    through the real CLI. Not run on yuma: it rides 2.2's deploy.
  - 2026-10-27, on yuma after the deploy: `sys.featureFlag.create` was refused,
    `requires level 4, user has level 0`. The `sys` client was the one
    `runAs(null)` scopes, graded as `createApp({ system })`, and Basecamp
    declares none; the example fixture does, which is why the rows held.
    `sys.<model>` now takes `asSystem()` inside `asApp`, as `db:repl`'s does,
    and the operator still reaches the trail. A fourth row, the fixture with
    no `system`, is red with the old client on the same message yuma gave.
    `sys(fn)` cannot take `asSystem()`, since a service builds its own client:
    `FJS-3517`. Yuma's proof waits on one more Basecamp deploy.
  - 2026-10-27: `FJS-3517` closed by Basecamp declaring `createApp({ system })`
    (owner chose B). `sys(fn)` now runs as SYSADMIN: `servers.find` under
    `--tenant` answers through it, and is refused with the declaration out.
  - 2026-10-27, on yuma after the second deploy, `deploy:repl --as
    vlad@kobami.com --force`: `sys.featureFlag.create` then `.delete` filed
    trail rows 523 and 524, each `actorId root`, `actorType repl`,
    `subjectId basecamp`. The operator is the ssh login, never the `--as`.

### Phase 3 — Docs, drive, ruling

Goal: the next reader finds it where they look first.
Done when: `fli done` is clean and `fli proves` names the drive.

- [x] 3.1 `db:repl.md` § *What it is not, yet* points here; `docs/deploy.md`
  gets the box line; `DRIVES.md` gets the row: as a member a row, as nobody
  a refusal, under `sys` the row with the operator as actor (Q3).
  - 2026-10-26: the `db:repl.md` pointer and the `docs/deploy.md` line are
    in. The drive row was blocked on `FJS-D1534`, built at 2.3; the row is
    owed, and no drive script exists for it yet.
  - 2026-10-27: `example`: `verify:repl`, five rows, green in 5s. With the
    operator dropped from `asApp`, both `sys` rows go red and file
    `system`/`service`. The fifth row answers the yuma question: `sys.remove()`
    keeps a tombstone, `delete()` is hard for every principal. `DRIVES.md`
    has the drive row and the *which drive proves* row.
- [x] 3.2 Rulings from 0.3 cited from each file they live in.
  - 2026-10-27: D1532–D1534 already were. D1535 and D1536 added to
    `tools/call.ts`'s header, `app:repl.md` and `deploy:repl.md`.

---

## 5. Open questions

- **Q1 — What is it called?** **Answered** B — `FJS-D1532`. The owner agreed to `app:console` in session
  (2026-10-26), and the register refuses it: `FJS-D1389` ruled one noun for one
  console, and that noun is `fli gui`'s screens. The sibling is `db:repl`.
  - **A** — `fli app:repl` → a new `junction` subcommand. `junction repl` is
    taken by the HTTP client, so the new one needs a third name or the HTTP
    one is renamed.
  - **B** — `fli app:repl` → `junction call --app <m>` with no method, which
    opens the prompt. No new subcommand, no new noun; `app:call` and
    `app:repl` are the one-shot and the prompt over the one tool, as
    `callArgv` already builds both.
  - **Recommend B** — zero names added; the prompt IS calls kept open, and the
    tool file already holds the boot and the printing.
- **Q2 — Does it open in production?** **Answered** A — `FJS-D1533`.
  - **A** — open; `--as` graded by the app's own resolver; a `sys` WRITE under
    `NODE_ENV=production` asks for `--force`, as `db:repl`'s `resetPasswords`
    and `deploy:retire` do.
  - **B** — refuse `--as` in production as `FJS-D1426` does for devtools.
  - **Recommend A** — `FJS-D1426`'s refusal is for a network surface behind a
    key; `docker exec` over ssh is the operator's own shell. Refusing it means
    a one-off script with nothing in front. § IV *ergonomics vs. strictness*:
    strict only where a mistake destroys, hence `--force` on the prod write
    alone.
- **Q3 — Who is the actor on a `sys` write?** **Answered** A, amended to the machine user alone — `FJS-D1534`. Today `audit-log.js` `actorTypeOf` answers `system` when
  `ctx.isSystem`, for the repl and for `db:repl` alike. Support mode shipped
  with the operator as `actorId` and the subject filed separately
  (`DECISIONS.md` § Actor).
  - **A** — the operator who ran the prompt is the actor (`--as`, else the
    machine user), `system` only when there is no operator; ruled once for
    `db:repl`'s `sys` and this prompt.
  - **B** — `system`, as today.
  - **Recommend A** — the trail must be able to tell a console write from the
    app's own (what must stay true: a `sys` write from a prompt lands with an
    actor; a drive asserts `actorId` on the row).
- **Q4 — Second boot or attach to the running process?** **Answered** A — `FJS-D1535`.
  - **A** — second boot, what `call` does: `_startOnce()`, no port, no work
    phase. Announcements miss the serving process's sockets, which an ops
    prompt does not need.
  - **B** — attach, Phoenix's `--remsh`: a new wire protocol the app grows.
  - **Recommend A.**
- **Q5 — Where does the gate come from?** **Answered** — `FJS-D1536`: the booted
  app, no `--gate` flag. `db:repl` takes the flag because it reads the schema;
  0.1 showed the path differs per app and a wrong one grades "approximately",
  which `db:repl.md` calls worse than no console.

---

## See also

- `IDEAS/one-console.md` — the screens; `FJS-D1426`–`FJS-D1428` put `:call`,
  `:data` and `:ask` inside the running app as somebody.
- `packages/cli/commands/db/repl.md` — the Data-realm half, and the two
  sentences this paper answers.
- `IDEAS/compliance-from-the-seed.md` — support mode's actor question, Q3's twin.
