# Changes — @frontierjs/cli

## 2026-09-05 — `tutor:fleet` releases something, and finds two reasons it could not

Half B. The lesson stopped at *a command from the control plane ran on this
machine*, which is the smaller half: a **release** is the thing a control plane
exists for. Step 7 gives the app a git source — a repository made on disk, since
`POST /deploy` hands `source.repo` to `git clone` and a path is a legal git URL
— creates a Deployment, and waits for the pipeline that basecamp dispatches to
its own queue.

**The assertion is the digest, and then the agreement.** `Deployment.builtImage`
has to carry a `sha256:` the MACHINE reported (a stub answers `null`, which is
why it is asked), a container has to be running here under the app's name, and
the two have to be the same bytes. A release that cannot say which bytes are
serving has not been shown to have released anything. `BASECAMP_STUB_OUTPOST` is
never set.

**Two defects, both of which made a real release impossible, and neither of
which any suite could see** — basecamp's own drive injects a fake docker:
[`FJS-919`](../../ISSUES.md#fjs-919), outpost addressing a locally built image
as `name@<image-id>`, which docker reads as a pull; and
[`FJS-920`](../../ISSUES.md#fjs-920), basecamp omitting `app_id` from `/deploy`,
so the container was named for the deployment while every other route addressed
the app.

Two environment facts are stops rather than failures, the shape step 1 already
uses for a missing basecamp: no docker at all, and a workspace the DAEMON cannot
read — a private `/tmp` makes `docker build` answer *unable to prepare context*
about a directory that is plainly there, and the lesson says which flag fixes it
rather than reporting a broken release.

## 2026-09-05 — `fli notifications:install`, and the resolver three commands got wrong

`--with notifications` added the dependency and stopped, so every app that took
it copied `model Notification` out of `node_modules` by hand or found out at the
first `app.notify()` that `notification` is not a table in this schema. Now that
the package ships the model ([`FJS-910`](../../ISSUES.md#fjs-910)) there is
something to install, and `fli notifications:install` appends it, retargets
`@@db(main)` under `--db`, pushes, and prints the wiring — the mailer first,
because the plugin refuses the wrong order at startup. `fli new --with
notifications` runs it; an app that adds the package later runs it itself, which
is the case that had no answer at all.

**Appended rather than imported**, and the command says why: `OutboxMessage` is
machinery an app never writes, so `fli outbox:install` imports it by name;
`Notification` is the app's, and `userId`'s type follows the app's own user key.

**Found by writing it — the fourth copy of a function only one copy of which was
right** ([`FJS-918`](../../ISSUES.md#fjs-918)). `fli outbox:install` and `fli
backfill:install` resolved with `createRequire(<app>/package.json).resolve(spec)`,
which `fli auth:install`'s header already documents as unsound: bun answers it
out of its GLOBAL INSTALL CACHE. Measured here, in an app with no `node_modules`
at all — the old form answers `~/.bun/install/cache/@frontierjs/auth@1.0.3/db/user.lite`
and `shippedFile` answers null. `core/app-schema.js` owns the question now, all
three commands call it, and the reasoning lives on the function instead of in
one command's header where the other two could not read it.

## 2026-09-05 — Two ways a workspace tool answered for a tree it had not read

`fli register:check` graded a register it could not parse. The readers are keyed
to the `FJS-` prefix, so a project keeping its registers under another one parses
to nothing — and every rule below is asked of the records that parsed, which
makes a file none of them came from a file all of them pass: an `ACME-1` table
was answered `0 open · ✓ every register agrees with itself`. `readRegisters`
reports `unparsed` now, and `unparsed-record` is an error naming the line. The
refusal already there separated *no register at this root* from *an empty one*;
this separates an empty one from an unreadable one, which is the state an
adopting project starts in. Counted, never parsed — a record minted out of a line
the reader rejected is a guess at the thing the report exists to name
(`FJS-916`).

`fli ws:map` rendered the static port assignments into whatever workspace it was
run from, so a page titled after somebody else's monorepo carried `example` at
8010 and `basecamp` at 8020 as that project's own. The table is a source file of
one workspace: the section now renders only where that file is in the tree being
mapped, and is omitted the way every other absent source already is. `ws:atlas`
reads the same model through `model.ports?.rows` and matches by card key, so it
never showed the wrong numbers — which is why the leak survived on the page
nobody diffs (`FJS-917`).


## 2026-09-05 — The backup step names no cause of its own

`05-backup` printed *the container must carry db/schema.lite* under a failure
the container disproves: the schema is plainly there, and the command that read
it is the one that reported (`FJS-574`, `FJS-232` cited wrongly). `litestone
backup` prints which database it could not copy and why, immediately above, and
it is the only thing that knows — so the step points at that rather than
restating a diagnosis that outlives every change to the reasons. The by-hand
line is now the command that actually ran, not `--help`.


## 2026-09-05 — `fli ps` answers the question its name asks

It read `~/.fli/sessions.lock` and nothing else, so it printed *No active
sessions* while a port was genuinely held. Every tool in the reserved
8500–8509 block is that shape — `fli db:studio` binds 8502 as a literal and
claims no session — and so is any app somebody started by hand, which is most
of them. The one command for *what is using my ports* was blind to the case that
sends people looking in the wrong place.

It now reports two things: **what is holding a port**, from probing every port
the schema can name and decoding each hit back into *env · category · project*
with the process named; and **what the broker handed out**, as before.
`--sessions` is the old output alone, `--json` returns `{busy, sessions}`.

`knownPorts()` is the reserved block plus each assigned project across every
category and env at slot 0 — not the 3,000 numbers the formula can produce,
because a port nothing would ever hand out is not this schema's to report on.

**One `lsof` rather than 250 socket probes.** The first cut probed each port with
`isPortInUse` and took 4.4s, which is not a status command; `listeningPorts()`
takes one `lsof -nP -iTCP -sTCP:LISTEN`, runs in 1.16s, and hands back the pid in
the same call so there is no second pass. It returns `null` rather than an empty
map where lsof cannot be run, because *nothing is listening* and *nobody asked*
have to be told apart — the second falls back to the socket probe. Output is
sorted by port so two runs can be diffed by eye.

`pidsOnPort` and `describeProcess` moved out of `commands/utils/killnode.md` into
`core/ports.js`, which `fli kill` now imports. Two implementations of *what is
holding this port* is how the command that kills it and the command that lists
it come to disagree about the same number.

## 2026-09-05 — two rules that disagreed about one column

`@frontierjs/notifications` began shipping its model
([`FJS-910`](../../ISSUES.md#fjs-910)), which put `package-model-drift` in front
of a case it had never seen: an app that has taken `polymorphic-subject`'s
advice. That rule asks an app to constrain a bare `String` discriminator, and a
package cannot ship the constraint because it cannot know the app's set — so the
constrained column then read as drift, and `example` was the first app to be
told off for doing the recommended thing. A bare scalar the app tightens into an
enum or a declared set is not drift now. **Nullability is**: `String?` → `String`
refuses a write the package legitimately makes, which is exactly what the rule
is for, and so is a different scalar or a dropped attribute — three controls,
because a fix that accepted every difference would look like one that worked.

`package-model-drift`'s advice also stopped being auth-shaped. It said *import
the model instead*, which is right for `Credential` and wrong for the two models
a package means an app to COPY — advice that fails when taken, one tier down
from `proof-target`'s argument. It names both shapes now.

## 2026-09-05 — `deploy:local` builds from any directory, and the journal cycle can reach the resume

`FJS-544` and `FJS-595`, re-probed against a real daemon.

`docker build` was given an ABSOLUTE context and a RELATIVE `-f`, with `context.exec` carrying
no `cwd`, so it inherited the process's. Docker resolves `-f` against the caller's cwd, so the
build worked only when somebody happened to be standing in the app root and failed everywhere
else with `resolve : lstat deploy: no such file or directory`.

What made it read as something else: the existence check three screens above resolves the same
path absolute, so the check passed and the build failed — which looks exactly like *the
Dockerfile was written and docker cannot read it*. Measured, the absolute form builds from
anywhere to the identical digest, so the fix cannot change the image. The `--dry` line printed
a different command from the one that runs, and now prints the same one.

`04-build-api` keeps its relative `-f` deliberately: it runs on the target with an explicit
`cwd` and a relative context, where the two agree. Grading both call sites the same way is how
a correct one gets *fixed* into a broken one, so that is an assertion of its own now.

**And the pipeline could not reach its own sharpest test.** `deployJournalCycle` — the only
thing in the repo that runs `fli deploy` at all — refused at step 2 of 12, because
`01b-env-check` found `AUDIT_PATH` missing from `.env.production`. The key list was written by
hand beside a comment saying it was named there on purpose, and it drifted the moment the
scaffold gained that key: the tutor's copy of the same recipe was updated, this one was not.
The check stays on — a deploy that skips it is not this pipeline — but the cycle now READS the
declared keys out of the app's own `.env.example`, so the list it seeds and the list the check
compares cannot disagree. Only the values that must be real are still written by hand, and a
key already set keeps what it has.

With that cleared the cycle runs all twelve assertions with zero findings, including *the rerun
continued the same transition rather than opening a second* — which is `FJS-595`, fixed on
2026-08-29 by `readLiveTransition` and left open in the register for a week because nothing
could run far enough to see it.

## 2026-09-05 — the debt an inherited schema comes with, and the rule that could not see it

`tutor:adopt` ended with the app serving a legacy row and said nothing about
what happens next, which for an adopted app is always the same thing: rules the
app was not written against. `check-baseline.json` existed, `--adopt` and
`--update` existed, and no lesson mentioned either.

Step 6 is the one finding the adopted app has, and the lesson does NOT fix it.
`ActivityLog.subject_type` holds the name of whatever a row is about, and that
set grows with every model the app gains — which is the case the rule's own
message names as legitimate. So it is debt, kept deliberately, and the step is
about keeping it without letting it grow: `--adopt` records it, a second pair
fails the check naming the number it was allowed, `--update` is offered the same
rise and refuses it, and taking the model out again leaves the ceiling at one.
Five assertions, all measured before they were written — including that the
finding **still prints** under a baseline, because a baseline that silenced it
would be the wrong mechanism.

`--adopt` and `--update` are two verbs because they are two decisions, and the
lesson says so where the difference is visible rather than in a flag
description.

**And the panel had to learn the same word** ([`FJS-913`](../../ISSUES.md#fjs-913)).
`fli gui`'s check panel counted raw findings, so the app this lesson leaves —
green by its own `bun run check`, carrying one recorded finding — was reported as
broken by the surface beside it. `/api/check` reads the baseline per scope now
and answers `ok`, `baseline` and a `within` on every finding; `tutor:tools`
grades the verdict rather than the count. It surfaced because the course re-runs
lesson 2 after the last lesson, which is the only place the two orders meet.

**A third substring guard, in the step above.** `05-serve` appended the adopted
models unless the schema already said `model Order` — so a second run against a
DIFFERENT legacy database adopted nothing while every assertion above it passed.
It keys on the block's own marker now and REPLACES it, which is what made the
new step's finding appear on a re-run at all.

**Found by writing it: `polymorphic-subject` was blind to snake_case**
([`FJS-912`](../../ISSUES.md#fjs-912)). It matched a camelCase pair only, so the
legacy `activity_log(subject_type, subject_id)` the lesson adds — the shape a
Rails polymorphic association has, and what `litestone introspect --no-camel`
emits — was not a pair as far as the rule was concerned. The population the rule
exists for was the one it could not see, and the tutorial's own step is what
surfaced it: the check that should have reported the new table reported nothing.
Both spellings now, with the id looked up in the SAME one, and the mixed pair is
the control that keeps the fix from over-reaching.

## 2026-09-05 — a lesson for the thing an app has to SAY

`@frontierjs/notifications` had no tutorial coverage of any kind, and neither
did the mail path under it: `app.notify`, `defineNotification` and `IMail`
appear in no lesson. `tutor:notify` is eight steps and twenty assertions, and it
sits after `tutor:jobs` — the two are the same argument from different ends, and
the last thing this one asserts points back at the other.

The four beats are chosen for what a reader cannot find out by reading:

**One send, two transports.** A single `app.notify(...)` writes a row through
`asSystem()` and renders an email, and the row's `type` is `NoteAdded` — a
string that appears nowhere in the file that produced it, because the FILE names
the notification. Asserted as the row's type, not as a row count.

**Renaming the file renames the type, silently.** `type` is a column, and every
row already written keeps the name it was written under. The lesson renames the
file, sends again, and reads a database that now has two names for one thing —
then states `type:` and watches the loader report the divergence in its own
words. Nothing warns about the rename itself, which is the point: it cannot tell
a deliberate one from a typo.

**A transport with no formatter refuses before anything is delivered**, so a
two-transport notification cannot half-land. The assertion is an ABSENCE
measured against a count taken a moment earlier — no row, no mail — paired with
the identical request once the transport is taken out again, because a refusal
with no control beside it is also what a broken app does. And the response
carries `data: { committed: true }`: the note the hook fired on was written
before the hook ran and is still there, which is the argument for putting work
that can fail in a job.

**An app can be asked what it can send with nothing sent** — `app.notifications`,
a claim, read through a route the lesson writes.

The mailer is written in the lesson rather than installed, nine lines, appending
JSONL: `IMail` is one method, and mail a lesson cannot read back is not an
assertion. Swapping it for `createSmtpMailer` changes nothing that sends.

**Found by running it.** The step that states `type:` guarded on
`src.includes('type:')`, and the file's own header comment says *the file names
the type: NoteAdded* — so the guard read as already-done, the edit never
happened, and the failure surfaced two assertions later as the loader being
blamed. Same shape as the `editSchema` substring bug the course run found: a
guard that asks a whole file whether it contains a string is asking the wrong
question. It matches the statement now.

**And found by the course**, which is the half a lesson run alone cannot see:
the model the lesson writes tripped `fli check`'s `polymorphic-subject` —
`contextType` says what `contextId` points at, and with no foreign key nothing
refuses a value naming nothing. It surfaced two lessons later as `tutor:tools`
failing its *the check panel is clean* assertion, blaming a panel that was
telling the truth. The lesson constrains the one column that can be and says
why; `@frontierjs/notifications`' README now says the same, since the model it
hands out is the one every app copies ([`FJS-910`](../../ISSUES.md#fjs-910)).

The insert renumbers `site` through `adopt` — the heading in each lesson, the
`Lesson N done` line in each finish step, and the next-lesson pointer out of
`tutor:jobs` — which `fli check`'s `tutor-order` and `tutor-lesson-named` grade,
so a missed one is an error rather than a stale sentence.

## 2026-09-04 — the tutorial is taken as a course, and four things only that could find

Every lesson ran in a workspace of its own, and the documented way to take the
tutorial is `--workspace ~/somewhere`, kept, twelve lessons in order — which
nothing ran. The `tutor` phase now does both: each lesson alone under `--tmp`
(does it work from a clean start), then the whole course in ONE workspace, then a
replay and a `--restart` over the app the twelve left behind.

**Four failures on its first run, and every one of them was invisible to the
isolated runs.**

**A lesson destroyed the workspace's `.env`.** `tutor:deploy` wrote the
CONTAINER's environment over the app's own — a freshly minted `ENCRYPTION_KEY`,
`DATABASE_URL=/db/app.db` (a path inside a mounted volume, not on this machine)
and `NODE_ENV=production`. Fine while that lesson was the only thing in the
workspace; in a course it makes every later `fli db:*` open a database at the
filesystem root, changes what the app will do, and makes every `@encrypted`
value an earlier lesson wrote unreadable. The container's environment is written
beside the workspace now, which is where `05-origin` copies it from, and the key
is KEPT where there is one.

**`fli tutor:adopt` was broken for every user.** Its second step opened the
legacy database with `await import('bun:sqlite')`, and `fli` runs on NODE — its
own shebang. It worked in CI because CI invokes `bun fli.js`, and failed for
anybody who typed `fli`, with an ESM loader error naming a protocol rather than
the lesson. `probe.sqliteExec` is the write half of `probe.sqliteRow`, through
the same `bun -e` subprocess, so both directions are runner-independent.

**A deploy after `fli db:push` refuses, correctly, and nothing said so.** Lesson
1 builds its model with push, which writes tables and no migration file — push's
own output says exactly that — and a deploy replays FILES, so the container died
with *the migration history does not build the schema this app declares*. The
lesson catches the history up where the app was already there, with
`db:migrate --create-only` and `db:baseline`, and says why.

**Two lessons had assertions keyed on a gate a later lesson raises.**
`tutor:test` wrote a test that read back through `env.db` — a stranger — and
hard-coded *Note reads at STRANGER(0)*; both are true of a scaffolded app and
false three lessons on. The read goes through `env.system` now, for the same
reason the factory writes through it, and the level is READ OUT OF THE SCHEMA
rather than written down, which is what the lesson is arguing for in the first
place.

**`editSchema`'s *already done* test was a substring search over the whole
file.** It asked whether the TARGET text appeared anywhere before deciding there
was nothing to do — so the moment another model carried `@@gate("0.4.4.6")`,
which `tutor:adopt` gives the models it adopts, it returned `already` and edited
nothing. Two lessons steer on that call, and both then read their verdicts
backwards. *Already done* is a question about `from`, not about `to`: absent
`from` with `to` present is still `already`, which is the case the guard was
written for.

**`tutor:change` left the app's schema ahead of its database.** Every step there
edits `db/schema.lite` and nothing writes a table, so `priority` was declared and
not built — and the next thing to write a Note through the API, three lessons
later, was refused with `table note has no column named priority` by a page that
has nothing to do with that lesson. It applies the expand at the end now, which
is what the verdict it just printed says to do; and its baseline step normalises
the column out first, so a second run in one workspace does not compare against
its own result.

**A scaffolded app's audit trail was written inside the container.**
`fli check`'s `log-db-unbound` fires on every app the scaffold writes as soon as
`make:deploy` gives it a deploy block: `database audit` had a LITERAL path, so
the deploy cannot point it at the mounted volume and the next swap takes the
trail with the rows in it. Nothing fails while it is wrong. The scaffold writes
`path env("AUDIT_PATH", "./db/audit/")` now, `.env`, `.env.example` and
`defineEnv` carry the variable, and the generated Dockerfile says to bind it
beside `DATABASE_URL`.

`tutor:adopt`'s last assertion also went stale in the good direction:
[`FJS-761`](../../ISSUES.md) landed, so the camelCase reading is clean under
`--strict` and `@map` is applied. The beat now asserts the two halves that have
to be true together — it passes `--strict`, AND it records the rename — because
a reading that camelCased a column and forgot to say so would also exit 0 and
would name a column that is not there.

## 2026-09-04 — the register reads newest first, and now says so

`DECISIONS.md` ran newest-first in seven sections of nine and stated it nowhere,
so the other two had drifted: the original ascending run sat at the foot with
every later ruling prepended above it, 24 adjacent pairs out of order across 182
rulings. The convention is in the file's preamble now, together with the fact
that makes it necessary — **ids are not in date order and never were**, since an
id is issued when a question is filed and the ruling can answer it weeks later,
so the date on the heading is the only ordering fact a reader has.

The sections were sorted by date, descending and stable. The reorder was proved
rather than eyeballed: the multiset of lines, the byte count and the set of
ruling ids are each identical before and after, so nothing but position moved.

`ruling-order` is the rule that keeps it, a **warning** rather than an error
because the register does not contradict itself here and a ruling deliberately
placed beside the one it amends is a legitimate reason to sit out of order that
no rule can see. Reported against the later ruling, which is the one that moves
up, and reset at every section boundary — sections are subject areas and have no
order between them, which is its second negative control.

Two smaller ones alongside. The format example at the top of the file used
`FJS-D40`, a real id, so a grep for that ruling found two hits; it is `FJS-D00`
now. And § Open closed on a hand-written count of the rows waiting in
`ISSUES.md`, which was three short — deleted rather than corrected, since
nothing regenerates it.

## 2026-09-04 — a ruling that is in force says nothing

`PHILOSOPHY.md` §VII required a status word on every ruling. Nothing enforced it
and no ruling carried one, so the rule sat at the tier that governs every other
document and graded nothing. Implementing it as written meant stamping
`accepted` on 180 of 182 headings — a restatement of the file's own name, and
one that would leave the ruling which has stopped being true reading exactly
like the 179 around it (`FJS-D196`, which amends §VII in the same commit).

**Absence means in force.** `RULING_STATUS` is `superseded-by`, `amended-by` and
`withdrawn`, written under the heading and nowhere further down, because a
register is read by scanning headings and a retirement announced in paragraph
nine is one the reader has already walked past. `proposed` is not in the set: an
undecided question lives in `ISSUES.md` § Needs a decision, so it has no referent
in `DECISIONS.md`.

**A retirement names what replaced it**, a ruling or the issue that moved it —
`FJS-690` narrowed what `FJS-D74` ruled and closed with no ruling id, and forcing
one into existence for every such fix is ceremony. The citation is graded like
any other, so a status naming an id no register holds is `unknown-ref`.

The `ruling-status` rule reports the two ways a written status can be useless: a
word outside the set, and a retirement naming nothing. `withdrawn` is exempt from
the second because nothing replacing it is the content. Absence is not graded at
all, which is the half that matters — a rule firing on it would print 180
findings and be removed within a week.

**Six rulings were believed retired in prose and four were.** Each was verified
against the amending ruling and the code before anything was marked, and two of
the six did not survive: `FJS-D64` refuses an `afterCommit` PHASE and never the
method, so `ctx.afterCommit` existing is not a contradiction; and the ruling
thought to have amended `FJS-D132` rules an adjacent question, while the one that
really amends it is `FJS-D135`, which `VISION.md` §17 already records. `FJS-D62`
supersedes a ruling that was never committed, so it now says so rather than
citing something no reader can find.

## 2026-09-04 — a check that could only pass

`fli register:check` answered `0 open · 0 rulings · ✓ every register agrees
with itself` from any directory holding no register — which is every package in
this workspace, and the root `CLAUDE.md` tells everyone to cd into a package
before running anything. From the repo root the same command reported 70 open
and 180 rulings (`FJS-768`).

**The tolerance was deliberate and the hole was underneath it.** `readRegisters`
treats a missing register as absent rather than fatal, because a consuming app
has no `IDEAS/` and inventing one is worse than reporting none. What it could
not say is the difference between a register that is empty and a register that
is not at this root: both are three empty lists. It now reports `sources` — the
register files the root actually holds, asked of the tree rather than inferred
from what parsed — and `runRegisterCheck` refuses a root holding none of them,
naming the directory and what it looked for.

**The refusal is in the engine rather than in each caller**, because a caller
that has to remember to ask is the same hole one layer up. The two callers are
the command and `scripts/ci.mjs`; CI passes the repo root, so CI was the only
invocation that was ever honest.

Asserted as a pair: a project keeping only `ISSUES.md` is graded on it and
passes, a directory with none is refused. A check that rejected a thin register
would be as wrong as one that passed an empty directory, and from the refused
side the two look identical. The report now names what it read, so a small count
reads as a small register.

**`cross-register-id` is the second hole, and it is the one the first fix could
not see.** `duplicate-id` keys on `kind:id`, so a `FJS-D##` appearing once as
the question in `ISSUES.md` and once as the ruling in `DECISIONS.md` is exempt —
an exemption that assumes the pair are the same subject. `FJS-D183` was the
encryption envelope in one file and the transaction scope in the other, and every
rule passed it (`FJS-D195`). The new rule reports an open decision question whose
id already names a ruling, without trying to tell the two causes apart: either
the ruling answers this row and nothing closed it, or it answers something else
and the id was issued twice. Both are wrong, the fixes differ, and only a person
can say which it is — so the message names both. Its negative control is an open
question with no ruling of its own, which is the ordinary state of every
unanswered one.

## 2026-09-04 — `fli tutor:ui`, and a page the cli can open

Lesson 3, and the first thing in the tutorial that renders anything. Eleven
lessons taught Data, API and Deployment by asking the running world, and the UI
realm — three packages — had one step in lesson 1: a person finished the course
having never seen a form.

**The lesson's spine is a before and an after.** It opens `/notes/create/` in
Chrome and asserts the generated form — one control per writable column, the
control each TYPE implies (asserted as a map, because three controls of the
wrong kind is the same number as three of the right kind), and nothing for
`id`, `createdAt` or `updatedAt`, which reach the client read-only. Then it adds
**one attribute to one column** of `db/schema.lite`, touches no `.mesa` file,
and reloads: `minlength="3"` and `maxlength="80"` are on a real `<input>`. The
same empty submit that was a legal write before the attribute is now refused in
the browser — and the assertion is not that a message appeared but that **the
row count over HTTP did not move**, because an error message is renderable by a
page that also wrote the row. Last step types into the three boxes and reads
the row out of the DATABASE, then checks the list page draws it.

**`core/browser.js` is a page driver, and it is small on purpose.** Mesa's
`test/browser/drive.mjs` is a spec RUNNER and is not published (`files:` is
`src` and `mesa-vite`), so an app that installed the framework has no harness at
any path — and what a probe needs is one question and one answer. Launch,
navigate, `eval`, close, plus the page's own exceptions collected, because a
component that throws while rendering still leaves a partial tree and every
assertion about what IS on the page walks past it. `probe.pageEval` and
`probe.pageClean` are the two probes over it, and both take an already-open page:
a lesson that launched Chrome per assertion would be five browsers.

Three traps it encodes. `--remote-debugging-port=0` with the URL read off
stderr, since a fixed 9222 is the developer's own Chrome and attaching would
drive their real profile. A temp profile swept on exit and on a signal. And a
single silent retry when an evaluate lands in a navigation — a form flow
navigates by design, and that failure is about the CONTEXT rather than the page,
which reads to a caller as the assertion being wrong.

**`$FJS_CHROME` is authoritative rather than preferred**: somebody who names a
binary names it for a reason, so a variable pointing at nothing answers null and
the lesson stops naming the variable, instead of silently running a different
browser. No Chrome at all is a `stop` and not a failure — a fact about the
machine — and CI skips the lesson by name with `FJS_CI_REQUIRE_CHROME=1` to make
that fatal.

## 2026-09-04 — the tutorial's order is graded against itself

`fli tutor` is a course, and a course is an ORDER. That order was written in
three places that could disagree: `index.md`'s LESSONS array, each lesson's own
`## Lesson N —` heading, and each lesson's finish step naming the next one to
run. Nothing held them together, and inserting a lesson at position 2 cost
twenty hand edits across eleven files.

`core/tutorial.js` reads the course — the reader/renderer split `proofs.js` and
`preflight.js` already make — and two rules grade it, split the way the proof
table is and for the same reason. **`tutor-order`** is an error: naming a lesson
that has no command file, a heading whose number is not the index position, a
pointer at the wrong lesson, a non-final lesson that names none, or a final one
that points onward. There is no reading of any of those that is correct — a
wrong heading misleads and a wrong pointer is advice that fails when it is
taken. **`tutor-lesson-named`** is a warning: a lesson the index does not list,
a `steps:` directory that is not there, a `_steps-*` nobody claims. A lesson
reached another way can be deliberate.

**It found a real dead end on its first run.** `tutor:fleet` named no next
lesson, so a person following the pointers stopped at 10 of 11 — and the
*where to go from here* block was on lesson 10 rather than on the last one,
along with a reference to "the journal in lesson 3" that had meant `tutor:deploy`
before the renumber. All three fixed.

## 2026-09-04 — `skill-pointer`, and skills in the document corpus

The root `CLAUDE.md` moved three of its sections behind `.claude/skills/` and
kept a name for each. A skill loads by that name, so a renamed directory leaves
the pointer reading as it did with nothing behind it — `proof-target`'s failure
one document up — and nothing graded it. `skill-pointer` resolves every name
CLAUDE.md gives, in prose and in the realm table's Skill column, to a `SKILL.md`
whose frontmatter `name:` agrees, because the Skill tool registers under the
frontmatter and not the directory.

`docCorpus` now walks `.claude/skills`, so the ids, paths and Invariant numbers a
skill cites are graded by the same rules as any document, and `SKILL.md` is
map-tier for `doc-map-narration`. Before this a skill could cite a retired id or
a renumbered Invariant with the `registers` phase green.

## 2026-09-04 — `fli tutor:tools`, and a scaffold that stops warning about itself

Lesson 2, on the four surfaces whose whole job is to report on an app: `fli gui`
(8500), `fli db:studio` (8502), junction's `devtools()` console (8503) and `fli
project:view` (8501). Twenty assertions, ~5s warm, and it is the only thing in
the repo that starts any of them and then asks them something.

**The GUI is the front door and the lesson says so** — it is the one surface that
knows about the other three, lists everything startable in the project, probes
which of them is up, and runs `fli check` without anybody remembering the
command. Its liveness assertion is graded by AGREEMENT rather than by `up`: the
port comes out of the ports table, so the GUI knows where the API is supposed to
be before the app has ever started, and running the API elsewhere makes `down`
the correct answer. The lesson probes that same port itself and requires the two
verdicts to match, which is false for a page reporting whatever it was told last
— in either direction, and at any port, which is what lets CI run it off the
assigned slot.

The other three each carry the failure they exist for. The studio is asserted on
the FILE and the ROW together, because either alone is satisfiable by a studio
pointed at the wrong database — an empty one has a path and a stale one has
rows. The console is asserted on a PAIR, one call allowed and one refused,
because a feed that reported everything as fine and one that reported everything
as broken look identical from a single call. The viewer is asserted on the chain
and on the environment panel, after writing the `surface.snapshot.md` it reads —
services are read off that snapshot and never scanned for, because a hook chain
resolves at construction.

**Every tool is shown reporting a FAULT as well as a clean state**, which is the
same rule the refusal pair follows: a dashboard saying *nothing wrong* is
indistinguishable from one that cannot say anything. The GUI's check panel is
handed a `.mesa` in `src/resources/` holding only markup — neither PascalCase
singular nor carrying a `<script module>`, so it breaks two named rules at once
— and the file is removed and the panel asked again. The studio's drift panel is
asked before an edit, after one, and after the revert; the edit is a COMMENT, so
nothing about the database moves and what is being shown is the real thing
behind *I added a column and the app cannot see it* — the running process is on
the schema it read at boot.

`--no-open` is threaded through `fli db:studio` (the flag was accepted and
answered *flag not defined — ignoring*), and `startServer` in the tutor's module
learned an `argv` form, since a tool is run against an app rather than from
inside it and there is no package script to name.

**Found by running it**: every app `fli new` writes carried a `fli check` warning
about itself. The generated `api/src/core/db.ts` passed its schema PATH under
`createClient({ schema })`, which litestone reads as a path and `schema-in-memory`
reports on the key — all a source reader can see. The two keys are not synonyms:
a schema STRING has no directory, so a relative `import` in it resolves against
nothing and is dropped. Now `path:`, which is the spelling litestone's own error
message asks for, and a fresh scaffold reports no findings.

## 2026-09-04 — a build context docker cannot read, refused where it is decidable

A deploy failed with `open Dockerfile: no such file or directory` about a file
the shell reads in the same directory in the same script. The filed cause was a
dot-prefixed directory anywhere in `path`. It is not: one tree copied to eight
paths and built on docker 29.6.1 shows `~/vis/.deep/app` building and
`/tmp/vis/app` failing, and what separates them is that docker here is the
SNAP, whose `home` interface grants everything under the user's home except a
hidden directory directly under it, and nothing outside home at all.

The two readings disagree in both directions, which is why the string rule was
the wrong remedy — it passes `/tmp/build`, which fails, and refuses
`/srv/.apps/myapp`, which builds on the docker.com packages. And the machine
that decides is the builder, which under a declared `deploy.builder` is not this
laptop.

So `04-build-api` asks it, before the vendor and the upload: `docker build
--check` resolves and parses the dockerfile and builds nothing. Graded on the
error text rather than the exit status, because `--check` also exits non-zero
for a lint warning and an older docker refuses the flag in different words. One
cause has two sentences depending on how far the read got, so what is graded is
*docker says no such file* about a path the shell has just read.

`deploy:doctor` was named in the finding and is not the owner: it never contacts
a machine.

## 2026-09-04 — `fli tutor:adopt`, the door for a database you already have

Lesson 10. Six steps, ~3s, and the only lesson that does not begin with
`fli new` writing your models: it begins with a SQLite database made by raw SQL,
with plural `snake_case` tables and rows already in it.

It reads that database into a schema, and the half worth the lesson is the
second output — every construct the reading could not carry, graded `changed`,
`lost` or `noted`, with `--strict` failing on `changed` alone. Then it checks
the reading against itself: build a database from the schema, read THAT, and
require the same text. That property catches what a substring assertion cannot
— a default whose quotes double on every pass, a predicate that nests deeper
each time — and it is run against the learner's own database rather than
described.

The payoff is `GET /api/orders` answering the row written in step 2 by raw SQL,
through a schema read out of the database that held it, with nothing migrated:
adopting is not a schema change.

Its last assertion is a **refusal**. `migrate baseline` is how you eventually
say *this database already holds what these migrations build*, and it compares
before it records — here it declines, naming the two lines the reading did not
get to the letter. One is cosmetic (`INTEGER PRIMARY KEY` is nullable as
declared) and one is not (`@default(now())` writes ISO-8601 where the column has
been writing SQLite's own format), which is what the first hour after an import
is for.

Writing it found four defects in `litestone introspect` and two in the scaffold.
`fli new --no-auth` printed `fli keygen aes --name ENCRYPTION_KEY --env` as the
next step — and keygen defaults to **base64** while litestone parses that
variable as **hex**, so following the instruction gave a key that decodes to
zero bytes and an app that still would not start. Advice that fails when taken
is worse than none; the hint says `--format hex` now.

## 2026-09-04 — an option `context.exec` does not have

`FJS-537`. 1755 + 39 pass. Typecheck clean.

`config.exec` spread its options straight into `execSync`, where an
unrecognised key changes nothing — the child writes to the terminal under the
default `stdio: 'inherit'` and the call answers `null`. It is refused by name
now, the way `createClient` refuses an unknown option: a typo in an options bag
is a statement the author just made, and forwarding it makes the mistake
indistinguishable from the default. The message names every unknown key, and
for `capture` it names the pipe it was reaching for.

**Writing the corpus guard found a second live instance, which is why one is
worth writing.** `allowFailure: true` is passed by `deploy/doctor.md` and
`deploy/_module.md` and was never implemented either, so `execSync` threw on the
non-zero exit and `config.exec` rethrew: `fli deploy:doctor` died with a stack
trace exactly when its migration check should have said *fail*. Measured both
ways against a scratch app whose `db/migrations/` does not build its schema.
The same call site read `probe?.exitCode ?? probe?.code`, neither of which
`execSync` puts anywhere, so on the path that did not throw the code read `0`
and the check could only ever pass.

`allowFailure` is implemented: the thrown error IS the answer, `status` the exit
code and `stdout`/`stderr` what the child wrote, so a caller reads the same two
keys on both paths. A signal still stops everything — Ctrl+C is not a probe
result.

The corpus half is the one with teeth. Commands are markdown, so a compile is
not a run; every `exec({…})` in every shipped command is read and its keys
graded. It needed rewriting mid-flight: a line scanner passed when
`capture: true` was put back on a ONE-LINE call, which is the shape that started
this, so it is a character scan over key position that skips strings and
template literals.

## 2026-09-03 — `fli tutor:test`, and something that grades the checks

Lesson 8. Six steps, ~20s, no server and no browser — every assertion is a real
database built from the app's own schema.

Its subject is the thing that is unusual here: most of what you would write
tests for has already been **declared**, and a declaration can be executed. Four
calls run every gate at every declared level for read, create, update and
delete; every `@guarded` / `@encrypted` / `@secret` column, read back; every
validator, either side of its boundary; every `@@allow` / `@@deny`, against rows
on both sides of its predicate. No fixtures, no assertions to author.

Then the step that grades those: `litestone mutate` breaks the schema on purpose
and runs the checks derived from the ORIGINAL against a database built from the
mutant. A survivor is a hole and it names itself — on a scaffolded app, 40
mutants, 70% killed, and the twelve survivors printed with their kinds.

Two things it teaches that a reader would otherwise meet as a bug.

**A factory writes through a real client, so it is graded.** `Note` creates at
USER(4) and a factory with no principal is a stranger, so `.asSystem()` is not a
shortcut — a fixture belongs below the boundary, or a gate that refuses the
caller refuses the arrangement too.

**`actingAs` is handed a session, not a row.** The scaffolded resolver grades on
`isAdmin` and the table has `role`; `sessionFields` is what turns one into the
other, and it runs at sign-in rather than when a test hands a row over. So
`actingAs(adminRow)` grades 4, and a test asserting a refusal there passes for
entirely the wrong reason. The lesson writes both spellings and asserts they
differ.

`tutor:fleet` becomes lesson 9. `probe.command` is new — an argv, its exit code
AND what it printed, because `bun test` with no test files exits 0 and
`litestone mutate` exits 0 whatever the score.

Found while writing it: `tutor:jobs` anchored its edit on the literal
`app.configure(channels())`, which the scaffold no longer writes.

## 2026-09-03 — a scaffolded app gets the auth that is installed

`fli new` links and installs BEFORE it composes its sub-commands, and
`auth:install` reads `user.lite` out of the app's own `node_modules` rather than
asking the resolver for it.

Every scaffolded app was running an auth schema nobody had installed. The
appended `model User` came from `@frontierjs/auth@1.0.3` in
`~/.bun/install/cache/` — `accountId Int?` where the tree says `String?`, and no
`@@auth`, which leaves every claim in every policy ungraded: a misspelling then
compiles to NULL, read as *nobody* by the SQL half and *everybody* by the JS
half (`FJS-759`, `FJS-666`).

Three defects, each hiding the next:

**The order.** `auth:install` ran before the link and the install, so the app had
no `node_modules` when the model was read — `FJS-741` one step earlier in the
same command.

**Bun resolves out of its cache.** `fli` runs on bun, and bun's
`require.resolve` falls back to the global install cache when an app has no
`node_modules`. The *is it installed* test therefore passed against a package
that was not, answering whatever version the machine happened to have downloaded
once. Nothing said a word.

**Bun memoises a resolution for the life of the process**, so re-resolving after
`auth:install`'s own `bun install` returned the same cached answer — which is
why checking the directory and resolving anyway is not a fix.

`resolveFromApp` now reads the `exports` map from
`node_modules/@frontierjs/auth/package.json` and joins the target itself. A
`link:`ed package is a symlink there and is read through it, so the question is
*installed here* rather than *resolvable from here*.

`fli tutor:access` loses the step that was adding `@@auth` by hand.

## 2026-09-03 — a scaffolded app joins its own channels

`fli new` writes **`api/src/core/channels.ts`** and wires it into `api/src/app.ts`.

Before this the scaffold declared `channel:` on every generated service,
configured the `channels()` plugin, and joined no connection to anything — so
every write announced into an empty set. Both halves of that are silent: a
publish to a channel nobody joined succeeds and reaches nobody, with no error
and no log, and the symptom is a screen that never updates. The generated
README pointed at `api/src/core/channels.ts` for the fix, which the scaffold did
not write (`FJS-752`).

**It joins every channel a service declares**, read off `app.services` at
connection time rather than from a list kept by hand — `fli scaffold` writes
`channel:` into each service it generates, and a second copy of those names goes
stale on the first new model. Only the string form: a function `channel:`
computes its target per publish, so there is no name to join ahead of time.

Joining everything declared is the right default only because joining is no
longer a GRANT. A broadcast is not a `SELECT`, so an `@@allow` cannot reach one;
junction grades and shapes every frame per recipient at the Data boundary
(`FJS-631`). The generated comment says that. The one it replaced told the
author to work around behavior junction has not had for a release — and the same
stale sentence was on `publishToChannels` in junction's own source, corrected
there too.

`fli tutor:live` taught the gap on purpose and now teaches the mechanism: step 4
asserts the frame arriving out of the box and names the two files that make it,
and step 5 is its negative control — the callback taken back out, the same
publish from the same caller reaching nobody, and the file restored on every
path out including a refused probe.

## 2026-09-03 — the tutorial waits for you

**The default is a walk-through.** Every step now prints its prose, says what it
is about to do, and waits:

```
  Start the two servers and prove they answer — ready? (Y/n) ›
```

Before this a lesson ran eleven steps to completion while you were still reading
step two, which is a transcript rather than a lesson. `--yes` runs a whole
lesson without stopping — what CI passes, and what a second run through material
you have already read wants. `--step N` does not ask either: naming one step is
already the answer to *which one*.

The question is the step's own `description:`, so it is about that step rather
than a generic *continue?*, and there is no second place for it to go stale.

Three things it took to be correct rather than merely present.

**One reader per lesson, not one per question.** A piped stdin is DRAINED by the
first reader, so a second one waits on a stream that has already ended — a
`printf 'y\ny\n' | fli tutor:change` hung after step 1. It is created in
`openTutor` and closed by the finish step, which runs on the success path and on
a refusal; the decline path closes it itself, because a `stop` skips that step.

**A declined step is not recorded.** Nothing throws when you answer `n`, so the
runner hands the recorder `succeeded` — after which the resume skips the one
step you stopped at. The row is dropped instead: absent is what a step that has
not run looks like, and `resumeDecision` already answers that correctly.

**`context.log`, not `log`.** The bare binding exists inside a step body and not
in the namespace module, so the decline path threw `log.info is not a function`
over the sentence explaining how to resume.

Answering `n` is a `stop` and not an `abort` (`FJS-589`): it exits 0, stops the
servers this run started, and prints where the app is and the command that picks
up from there.

## 2026-09-03 — Four more lessons, and the surface nothing had ever run

`FJS-752`, `FJS-757`, `FJS-758`. The tutorial is eight lessons now: **live**,
**jobs**, **site** and **change** join app, access, deploy and fleet, and the
order is the arc rather than the order they were written — build, secure, then
real-time, background work, the public half, the deploy, the schema change after
it, and the fleet.

**`tutor:live` (8 steps)** — a write reaching a second client, and who it does
not reach. It meets the silence first: the service announces, the publish
succeeds, and nothing arrives, because a channel is a set of connections and
nothing has joined it. One file later the same publish lands. Then two sockets
against one publish — signed in and anonymous — before and after the read gate
goes up, which is the pair the lesson exists for. A refusal on its own proves
nothing: a grader that delivered to nobody would satisfy it.

**`tutor:jobs` (6 steps)** — a queue that is a SQLite file, a job named by its
own filename, and a dispatch from an `after` hook. The assertion is the
**order**: the response is read before the work is done, and the row changes
afterwards. A test that checked only the final state would pass with the work
done inside the request.

**`tutor:site` (8 steps)** — one HTML file per page with the data already in it,
and a build that **refuses** to emit a page whose `load()` read something gated.
You watch the refusal and then the `publishes:` line that gets past it. The last
step changes a row and reads the file again: still the old value, which is what
prerendered means.

**`tutor:change` (6 steps)** — month two. An optional column is an **expand**; a
required one is a **contract** that comes back with the three-deploy split and
the column that has to be backfilled; and a raised gate touches no column and is
a contract too, marked `narrows`. No server, no Docker.

`probe.httpText` (a body as text) and `probe.eventually` (any probe, until it
holds) are new, and `openSocket`/`bothSockets`/`fliJson`/`addNoteField` are the
lessons' shared halves.

### What writing them found

**`FJS-752` — a scaffolded app's real-time is wired everywhere and delivered
nowhere.** Every generated service declares `channel:`, `fli new` configures
`channels()`, and nothing ever calls `app.channel(name).join(conn)` — so every
write announces into an empty set, with no error and no log. The generated
README points at `api/src/core/channels.ts`, which the scaffold does not write.
Beside it, the generated service's own comment was **stale in the dangerous
direction**: it said `@@allow` is not re-checked per subscriber and told the
author to work around that, which was `FJS-631` and is closed. The comment now
says what is true — nothing is delivered until a connection joins, and joining
is a subscription rather than a permission. `tutor:live` teaches the gap
deliberately; that is not a substitute for closing it.

**`FJS-758` — every file `fli make:site` generated was broken, and nothing had
ever executed one.** Four defects, found in order: `fli site:build` ran `bunx
vite` (node) while the scripts the same generator writes say `bun --bun` with the
reason in a comment beside them; both commands `cd` into the surface, so bun
auto-loads `.env` from the wrong directory and a client with a required variable
refuses to load at all; `site/src/main.js` imported `mount` from the compiler,
a virtual id that does not exist and a component path that does not exist, and
passed `mount()` an id where it takes a node; and the scaffolded client passed
`schema: './db/schema.lite'`, resolved against the process — so the site build
opened a **new, empty database** under `site/db/` and prerendered every page with
no rows in it, exit 0, which is `FJS-449` exactly. All four fixed. The class has
no fix: `scaffold-build.mjs` builds `web/` and nothing runs a generated `site/`.

**`FJS-757` — `release:check --from <path>` drops the baseline's imports.** A
baseline copied anywhere but beside the schema loses every imported model and the
comparison reports the imported package as newly added — three fabricated
contract findings on a scaffolded app. `FJS-670` one layer up, in the command
whose whole job is to classify a difference.

Also fixed on the way: the `after`-hook envelope. `ctx.result` inside the
pipeline is `{ kind, object, data }`, so `ctx.result.id` is `undefined` with no
error — the job was queued with an empty payload and the patch was refused as a
bulk write. `resultData(ctx.result)` is the unwrapper junction exports for it,
and the lesson says so where somebody meets it.

## 2026-09-03 — Mesa, in the lesson and in the app it scaffolds

**`tutor:app` gains a ninth step and the scaffold gains a front page.** The
tutorial taught the seed, the API and the database, and said nothing about the
language every screen it generated is written in. Two halves, on purpose:

**The lesson** — `09-mesa` — states the five things that carry almost all of
Mesa (state is a variable, a `$:` line re-runs when what it read changes, blocks
are markup, styles are scoped to the file, everything the runtime offers is on
`$`), then writes a component with a prop, a derived value and an `{#if}`,
imports it into the home page, and **asks the dev server for the compiled
module**. That is the assertion, and the only one available without a browser: a
file that compiles is a fact about the compiler, not about the file.

`?import` on that URL is load-bearing and cost a run to find. Vite decides
whether to transform by EXTENSION, and `.mesa` is not one it knows — so the
bare path is served as a static file and answers **200 with the source**, which
reads exactly like a component that compiled to itself. The query is what Vite
appends when a module imports a file it cannot recognize. A file that does not
compile answers 500 carrying the compiler's own sentence, which is why
`probe.httpText` reports a status separately from a missing needle.

**The app** — `fli new`'s `web/src/routes/index.mesa` is now a running tour of
the same five points rather than three lines and a health check. A counter for
state, an input for `bind:` and `$:`, an `{#each}` over the three realms, and a
link to the repository with the two documentation directories named. Every
point does the thing it describes, which is the only form of this that cannot
go stale silently: the page has to compile to render at all.

`probe.httpText` is new — the body as text, for the things that are not JSON.

**A third authoring trap for literate commands**, found by writing the step: a
`.mesa` sample cannot be shown whole in prose. `matchScriptBlock` takes the
first line-leading `<script>` in the file and everything down to the **last**
closing tag, so a sample carrying one is hoisted to module scope and executed as
JavaScript — the step failed with `plenty is not defined`, naming a variable
that only exists inside the example. The two halves are shown apart, and the
step says why.

## 2026-09-03 — `fli tutor:fleet`, and a column nothing writes

`FJS-743`. Lesson 4 of four, and the tutorial is complete.

**Lesson 4 is the other release story.** Lesson 3 is you holding the key,
deploying one app to one machine with `fli deploy`. This one is a control
plane: basecamp holds the fleet as rows, an Outpost is the process a machine
runs so the control plane has hands on it, and nobody types a deploy — somebody
clicks one, and a job sends a signed command to a machine that agreed to take
orders. Seven steps, twenty-nine assertions, **3.1s in CI** — no Docker and no
network, because the heartbeat reads `/proc` and the Outpost's disk report is
allowed to fail.

It starts a real control plane on a database of its own, sets it up, creates the
machine as a row, starts a **real Outpost** against it, and then sends a command
that really runs here. The last one is the lesson: four rows have to exist
before there is anywhere to send it (`Project → Environment → App → AppServer`,
then `Job`), and the assertion is a **nonce minted in this process a second
earlier**, read back out of the `job_run` row the control plane wrote. A canned
answer, a stubbed executor or a command that never left the control plane all
fail it. The negative control was run by hand: with the Outpost stopped, the
same trigger fails `ConnectionRefused`.

**What the lesson teaches that no row can say** is what *reachable* means. The
heartbeat moves `status` to `online` and fills `lastHeartbeatAt`, and neither of
those is what anything outbound consults: the address becomes a Conduit target
called `outpost:<id>`, and `resolveExecutor` asks the registry. **Online and
unreachable is a real state**, and the two are different failures.

Which is how `FJS-743` was found. `Server.outpostUrl` is declared, migrated, and
named by the executor's own refusal — and written by nothing. The heartbeat
carries the address and registers the target with it, then omits the column from
the update three lines above. Measured: the row read `online` with a version, a
health block and a timestamp, and `outpostUrl: null`, while the registry held
the real address. Nothing reads the column either, so it is dead on both ends —
and an operator reading a null there finds it agreeing with a sentence that is
false.

**Basecamp is `private: true`, so the lesson stops rather than fails** for
anybody who installed from npm: step 1 looks for the two packages beside the CLI
and exits 0 with a sentence and a clone command. Proven by running the CLI out
of a copy with no siblings.

Two smaller things it forced. `startServer` takes a `logs` directory, because a
lesson that runs basecamp out of the checkout must not write its log beside
somebody's source. And both of basecamp's databases are redirected, not one:
the audit trail is a second `database` block with a relative path, so it follows
the process CWD, and setting only `DATABASE_URL` writes the lesson's rows into
the developer's own trail — which is `FJS-633`'s stated fix, applied to a third
drive.

`bun run ci`'s `tutor` phase runs all four lessons now; fleet takes 7120 and
7180, basecamp's and outpost's own test-tier slots.

**And the phase's first full run found an environment fact rather than a
defect.** `tutor:deploy` under `--tmp` failed at `docker build` with
*`lstat deploy: no such file or directory`* about a directory that is plainly
there — this shell's `/tmp` is private to it, which is exactly the class
`scaffold-build.mjs` already names for the `deploy` phase, down to the regex.
With `FJS_CI_WORKDIR=$HOME/fjs-ci-work` the lesson is green at 71 assertions.
`daemonBlindHint` is exported now and the tutor phase's failure says the same
sentence, because two paragraphs about a private `/tmp` is how the second one
ends up not mentioning the variable that fixes it.

## 2026-09-03 — `fli tutor:deploy`, and the deploy pipeline did nothing under node

`FJS-738`, `FJS-741`. Lesson 3 of four.

**Lesson 3 deploys to this machine and takes it back.** A deploy target may be
`localhost`, so the ten steps are the real pipeline — a real journal on disk, a
real image, a real swap, a real health poll, a real revert. Point the app at a
machine, write the release baseline (without it every change grades as a
contract and the revert would be refused, correctly), clone the app into a
`server/` directory as its own origin, deploy, change a line and deploy again,
then **revert, and revert the revert**. Eighteen assertions; the ones that
matter are against the image id the container is on, because a pipeline that
reported success while leaving the old container up passes everything else.

**And it found the largest defect of the day.** `execSync(cmd, { input, stdio:
'inherit' })` **ignores `input` on node** and honors it on bun. Every command a
deploy sends travels on stdin to `sh -s`, and `core/machine.js` defaulted to
`stdio: 'inherit'` — so under node the `mkdir` that makes room for the journal
runner, the container swap, the lock release and the nginx write all reported
success and **did nothing** (`FJS-738`). Measured: `fli deploy:unlock --force`
printed `Dropped …` with the lock still on disk. `bin/fli.js` is
`#!/usr/bin/env node`, so that is what a global install gets; CI never saw it
because the deploy phase runs `bun <fli>` explicitly. Fixed as
`stdio: ['pipe', 'inherit', 'inherit']`. The suite runs under bun, where the bug
does not reproduce, so the shape is asserted first — stdin piped, stdout and
stderr not — and then the real `createMachine` is run under `node` and asked
whether the script actually ran. All three fail against the old default; the
file's existing executed tests missed it because every one of them passed
`stdio: 'pipe'` explicitly.

**Behind it, an app that developed against one auth and deployed another**
(`FJS-741`). `fli auth:install` ran a bare `bun add @frontierjs/auth`, so a
`--source local` scaffold had six `link:` siblings and auth from the registry —
while `deploy:vendor` packed the workspace copy into the image. The container's
`db:migrate` refused with a diff showing the tree's `Verification.id` as a uuid
and the installed one as an `Int`. The spec is read off the app's own manifest
now.

The `tutor` phase gained lesson 3 on port 7103, skipped by name without a
daemon, with the deploy phase's `FJS_CI_REQUIRE_DOCKER=1` escalation. The deploy
transition cycle was re-run after the `machine.js` change and is still 12 of 12.

## 2026-09-03 — `fli tutor:access`, and the tutorial is a CI phase

`FJS-736`, `FJS-737`. Lesson 2 of four, and `bun run ci`'s thirteenth phase.

**Lesson 2 changes one line of `db/schema.lite` at a time and shows the answer
to the same HTTP request changing.** Nine steps: two callers (an ordinary
account through the API, an administrator through the CLI — `role` is
`@allow('write', auth().isAdmin)`, so the first admin cannot come from the API,
and that asymmetry is the lesson arriving early); the gate as it already is; the
read level raised from `0` to `4`, after which the request that answered 200 a
moment ago answers 401; a row policy, where two accounts get 200 from one list
endpoint and one of them cannot see the row; a field policy, where both callers
send `done: true` and only one of the two rows carries it; and `fli test:access`,
read back to check it agrees with the schema. **Every refusal is asked twice** —
once by a caller who should be refused and once by an otherwise identical caller
who should not — because a rule that refused everybody looks the same from the
refused side. ~18s from an empty directory.

Every answer in it was measured against a real scaffold before a word was
written. Two came back different from what the plan assumed: raising a read gate
answers **401**, not 403; and a field `@allow('write')` on a required column with
no default is a **500** from SQLite rather than a refusal at the boundary, which
is why the lesson adds `@default(false)` and says why.

**The `tutor` phase** runs both lessons `--tmp --yes` on test-tier ports
(7100/7000). It is the phase for the document that had no compiler behind it:
`docs/QUICKSTART.md` §7 exited 0 on every command it named and had never put an
app on a server. What it catches is a command renamed out from under a step, a
scaffold whose default gate moved, an answer the framework changed — none of
which any suite here can see. No Docker, no network. A port already held is a
named SKIP rather than a finding, because refusing a busy port is the lessons'
own rule; `knownTutorFailures` ratchets like the rest.

**`fli auth:*` had rotted through five layers** (`FJS-736`) and lesson 2 is what
found it, because it needs `auth:create-user` to make an administrator. Each
layer hid the next: a free `loadEnv`, then a `createClient` signature litestone
stopped having, then `sys.users` where the accessor is `db.user`, then
`context.exec({ capture: true })` — not an option, so the default `inherit`
stood and **`auth:create-user` created the account and reported failure** — then
`take:` where litestone names it `limit:`. Two files in this tree already carry
a comment saying `capture: true` is not real. All five parse; nothing had run
them against an app since litestone's API moved, and `tutor:access` is that
caller now.

**And `@@auth` was missing from the User model auth ships** (`FJS-737`), so
every scaffolded app graded its policy claims against nothing and printed
litestone's warning about it on every boot. A misspelled claim there is a
lockout on read and an open door on create. The lesson teaches the line rather
than assuming it.

## 2026-09-03 — `fli tutor:app` runs end to end

`FJS-735`. Lesson 1 of four, and the first one that can be run.

Six steps landed on top of the three that existed: start both servers and prove
they answer, register an account and keep the token, scaffold a model, push it
into the database and restart the API through it, write a row and read it back
out of `db/app.db`, build, and stop what was started. `fli tutor:app --tmp --yes`
is **green end to end in about 7 seconds** with a warm bun cache, and re-running
it replays every finished step into a no-op.

**Three things a running server forced.** A process is the one thing a journal
cannot hold — the row says `succeeded` and the port is dead — so `makeRecorder`
takes `ephemeral`, a list of steps that are recorded and never replayed;
`04-run` and `10-finish` are named there. Whatever a run starts, that run stops:
`openTutor` traps `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`, because `--step N`
never reaches the teardown step and a Ctrl-C reaches nothing at all — without it
a lesson leaves the dev server that its own step 1 then refuses on, and blames
the person for it. And a step that talks to the API asks for it (`ensureApi`)
rather than assuming: `needs()` covers a missing FACT and cannot cover a missing
process, which is what made `--step 8` report an expired token.

**`fli new`'s refusals exited 0** — nine of ten, `log.error` then a bare
`return`, where the ruled refusal is `context.config.abort` (`FJS-589`).
`--restart` is what surfaced it: the scaffold refused, `context.exec` saw
success, and the step's file probes then passed against the previous run's
files. That reaches past this repo — `npm create frontier` forwards to this
command.

Smaller, all measured rather than assumed: the ports are `--api-port` /
`--web-port` and every printed URL comes from them, since a machine with a busy
8000 could not run the lesson at all; `httpJson` returns the PARSED body beside
the truncated `detail`, because a caller reading a token back out of a 400-character
diagnosis fails on a correct response that is longer than the cut; `writeJournal`
answers `null` for a workspace that has been swept, which is the order the
teardown step and the runner actually run in; `needs()` maps each missing fact to
its own step; and step 3's gate sample is `4.4.4.5`, which is what a scaffolded
`User` carries — the `0.4.4.6` it claimed is the scaffolded `Note`'s, three
steps later, and asserting both is now the point of the pair.

## 2026-09-03 — five commands that could not run, and the check that found them

`FJS-730`, `FJS-731`, `FJS-732`. Design record: `IDEAS/scope-checking.md`.

`FJS-726` was a free identifier, so the obvious next question was how many more
there are. A prototype answers it: parse the compiled unit the RUNTIME builds —
namespace module script prepended — and resolve every identifier against real
lexical scopes. Over **237 command units** it found **four live defects on a
green tree**, and a fifth stacked behind the first.

**Four `fli auth:*` commands and `make:schema` threw on a free name.**
`loadEnv({ path: envPath })` is a `core/utils.js` export, not a global and not a
zx global, so `auth:list-users`, `auth:create-user`, `auth:revoke-sessions` and
`auth:rotate-key` all died at the line that reads `.env` — and the call was
redundant besides, since `bootstrap.js` loads the project's `.env` with override
before any command runs. `make:schema` did the same with `resolve`, inside an
`await import(…).catch(…)` where the throw is evaluating the argument and the
catch never sees it; the binding it imported was unused.

**`fli db:schema` could not load at all.** The `db` namespace module imports
`existsSync` and `resolve`, and the command imported both again — one module, so
a duplicate declaration and a `SyntaxError`. A `_module.md` helper reaching for
a binding by importing it breaks every command in that namespace that imports
the same name, which is why `requireAuthInstalled` now says `fs.readFileSync`.

**And behind the first, a signature that had moved.** All four auth commands
generate `createClient('<path>', { encryption: { key } })`; litestone takes one
object, `createClient({ path, encryptionKey })`, which `auth:install`'s own
generated `db.ts` already writes correctly. Two defects stacked in one command is
this class's normal shape — `FJS-726` hid `FJS-727` exactly the same way —
because code nothing has ever run accumulates faults in layers and only the
outermost is visible.

Two things the prototype measured rather than assumed. A flat *declared anywhere
in the module* set **misses `deployConf`**, since it is a parameter of three
sibling functions in the same file, so this class needs real scope chains or it
needs nothing. And resolving a step's namespace from its own frontmatter title
rather than its orchestrator's reports **27 free names instead of 0** — the unit
is the join, not the file.

Nothing is committed but the fixes and the write-up: the checker itself is
`IDEAS/scope-checking.md` 0.10, and its one open decision is a parser dependency.
The tree now answers 0 free identifiers and 0 parse failures over 237 units,
which is what would let a rule go in at zero rather than at a baseline.

## 2026-09-03 — the deploy pipeline could not deploy, and a scaffolded app could not start

`FJS-726`, `FJS-727`, `FJS-725`. 1648 pass (35 new).

**`swapContainer` named a variable in no scope it could see.** `dockerLogArgs(deployConf)`
was a free identifier — the function's options are
`{ host, container, image, apiPort, dbPath, envFile, build, log }` and neither
caller passed it, though both had it in their own scope. The throw lands while
building the `docker run` line, which is AFTER `docker rename <c> <c>_replaced`
and `docker stop`: measured against the pre-fix source, two commands are already
on the machine, so a deploy took the running app down and never put anything up.
`_steps-revert/03-swap` calls the same function, so the way back was broken the
same way.

Three things kept it invisible, and they compose. The parse sweep parses and
does not resolve scopes, which is `FJS-269`'s class one layer along; both callers
read correctly on their own, because each has its own `deployConf`; and
`deployJournalCycle` is the only thing in the repo that runs `fli deploy` at all.
It was failing here, which is why every assertion past this line — the journal,
the resume, the revert — had never run.

`deployConf` is an explicit option now, like every other value the function
takes. The eight new tests drive the real function through an injected
`context.exec` and assert what the failure destroyed: that a `docker run` line is
produced at all, the rename → stop → run ORDER, the log driver reaching the
command, and that `logs: false` still starts a container. The capture reads
`input` rather than `command`, because the script travels on stdin to `sh -s` and
a test watching the command line sees nothing but `sh -s`.

**Behind it, every scaffolded app refused to start.** `fli new` writes
`cors: { origins: ['*'], credentials: true }`, and junction refuses that pair at
CONSTRUCTION (`FJS-689`) — so `runStartPhases` throws, the container exits 1, the
health poll fails and the deploy rolls back reporting *health check failed* about
an app the framework declined to run. Two layers of never-executed code, the
second invisible while the first threw earlier in the same step. A scaffolded app
authenticates with a bearer token and never needed a credentialed request.

**And a step's `printPlan()` rendered the orchestrator's prose.** `stepContext`
is spread from the orchestrator's, so `filePath` and `printPlan` named `index.md`
inside every step. Rebound in `runOneStep`, with a fixture and four tests
captured off stdout — the prose renderer writes to the terminal directly, so no
event assertion could have seen it.

**New, and the reason all three were found:** `core/prompt.js` (one prompt engine
over a TTY and a pipe, `--yes` never opening stdin), `core/probe.js` (the
assertions a tutorial step ends with — http, ports, files, sqlite, docker — every
one answering rather than throwing, so a refusal goes through `context.config
.abort` and the teardown still runs), and `core/tutor.js` (a lesson's workspace,
its resume journal, and `pointAtLocalServer`, which `scripts/scaffold-build.mjs`
now imports rather than keeping its own copy of).

## 2026-09-02 — `-d` is `--dry`

`FJS-653`. 1566 pass (7 new).

`fli db:import -d` ran the real import against production.

`run()` parses with `boolean: ['help', 'h', 'dry', 'd']`, so minimist emits a
value for every one of those names whether or not it was typed: `-d` arrives as
`{ d: true, dry: false }`. `getConfig`'s short-char promotion reads a DEFINED
long name as *the long name was given* and drops the short one, so `flag.dry`
stayed false and all five steps executed their `context.exec`. `--dry` was never
affected, which is why nothing here could see it.

Fixed at the parse rather than at the promotion — treating `false` as unset in
`getConfig` would make `--no-dry -d` mean two things. `dropUntypedBooleans`
compares minimist's output against the argv actually typed and deletes the
defaults nobody asked for; the promotion keeps its one meaning. It lives beside
`defaultFlags` in `runtime.js`, which is where the flag vocabulary already is.

**Two more were underneath, in the command.** `if (!server) { log.error(…);
return }` is a bare return, and a bare return does not stop `_steps/` — the run
went on to build `ssh undefined "…"` and `rm -f undefined/development.db*` with
the guard already printed. It sets `context.config.abort` now. A refusal raised
before any step has run also blamed `01-prepare`, which never ran; `refusedBy`
starts at *the command* when the body has already refused. And three steps
logged `Downloaded backup` / `Local DB restored from backup` under `--dry` — a
success line for something that did not happen.

## 2026-09-02 — a register row is graded against its own table's header

`FJS-647`. 1594 pass (2 new).

`register:check` could not see a row that disagreed with the table it was in,
and it went wrong in both directions at once.

**Narrower.** `registers.js` infers a row's shape from its CELL COUNT, so a
four-cell row in a six-column table fell to the decision-shaped branch and was
handed a status nobody wrote. Four closed rows sat in § S3 that way, invisible
to `closed-in-open`, and two rows that are still OPEN sat in § Closed where
every count read them as done.

**Wider.** Markdown drops every cell past the header's width — measured with a
renderer rather than reasoned from the spec. For § Closed that cell is *How*, so
137 rows displayed no citations at all while the links sat in the file.

`row-shape` grades the count against `headWidth`, read off the header rather
than written into the rule. The first probe was the DATE column and it was
wrong: it fired on a cell reading *last tuesday*, which is a bad value in the
right column and belongs to `malformed-date` — one mistake reported twice,
pointing at the wrong fix. Every real case disagreed on width as well, so width
alone is both sufficient and exact. 181 findings against the pre-fix file out of
git, 0 after.

## 2026-09-01 — the API's snapshots are read out of `api/`

`readApiSurface` looks for `surface.snapshot.md` in **`api/` first and the app
root second** (`commands/project/_module.md`). `project:view` and `project:map`
are the callers; both are unchanged.

**A snapshot belongs in the surface it describes.** `db/` holds the Data
realm's four, `web/` and `site/` hold their route tables, and everything in
`surface.snapshot.md` — the services, the mounted routes, the hook chain, the
plugins — is a fact about `api/`. The four that junction writes were the only
ones sitting at the app root, and `example` has moved them.

**The app root stays a candidate rather than being dropped.** The file is
written by a command an app already runs, so an app that has not moved it is
not broken; and an app whose API is not in `api/` is a shape this cannot rule
out. First hit wins, and an app holding BOTH reads the one beside its API —
two copies of one surface is itself the defect `scripts/ci-allowances.json`
records, where a root-generated copy disagreed with the real one by six routes.

The hint names both places it looked, because *no snapshot* and *a snapshot
somewhere else* read identically otherwise.

## 2026-09-01 — the derived JSON Schema has one home, and it is not committed

`db/schema.json` moves to **`db/.json/schema.json`**, is gitignored, and has one
owner: `core/derived-paths.js`.

**It was a committed artefact that nothing gated.** It carries no `generated
by:` header and is not named `*.snapshot.*`, so the CI snapshots phase never
looked at it — while `db/jsonschema.snapshot.md` sitting beside it holds the
same information in the form that IS rechecked. A second copy that everything
can outdate and nothing grades. It happened to be current when this was
written, which is the only reason it had not already gone wrong.

**Four commands touched the path and each held its own literal**: `db:push`
regenerates it after applying a change, `db:jsonschema` writes it on demand,
`validate` regenerates it AND reads it back, and `project:view` tests whether it
is there. `validate` is the one where a divergence is worst — it would have
regenerated one file and validated another, which is a clean pass over a schema
nobody looked at.

**`litestone jsonschema` now creates its output directory.** `--out` is treated
as a directory only when that directory already EXISTS, so `--out <db>/.json`
writes a file literally named `.json` on a fresh clone, and a nested path fails
with ENOENT naming the FILE rather than the missing parent. The path is stated
as `…/.json/schema.json` for that reason and `mkdirSync` covers the rest.

The dot-directory is this repo's existing mark for a derived thing that is not
committed — the same one `api/src/emails/.preview/` wears.

## 2026-08-31 — `schema-in-memory` — the app runs models the committed artefacts cannot see

`FJS-626` — the half the entry below opened and could not take. That one taught
`fli check` and `fli admin:generate` to MERGE what a package ships, which is the
right answer for a CLI reading an app from outside. It cannot help litestone's
own four artefacts, because those are generated FROM the schema and an app that
assembles one in memory has no file for them to read. So this closes it from the
other end: the app puts the models in the file, and a rule catches the next app
that does not.

193 checks tests pass; `fli check` clean on `example`, one fewer finding on
`basecamp` after the test-file control.

Every schema tool takes a PATH. An app that appends a package's shipped fragment
to its schema text at boot runs models no tool can read, and `access.snapshot.md`,
`release.snapshot.md`, `ddl.snapshot.sql` and `jsonschema.snapshot.md` then all
describe a schema that is not the one serving. Measured on `example`: 39 models
ran, 32 were in each artefact, and the seven missing were the identity model and
the credential store.

**The cost is the deploy gate.** `release:check` compares release surfaces, so a
contract on `Session` was in neither and graded EXPAND — the deploy read as
reversible. The `snapshots` phase passed the whole time, because it re-runs the
same command from the same directory and gets the same incomplete answer.

**It carries no list of fragment-exporting function names**, and two rejected
drafts are why that matters. The first compared each dependency's shipped models
against the ones the schema file reaches, and reported junction's `BackfillRun` —
a feature `example` does not use, and a dependency imported for `createApp` says
nothing about whether its models are wanted. The second fired on basecamp's
`db/test/schema.test.ts`, where an inline schema is simply how a test is written.
What survives is the call itself: `createClient`/`createTenantRegistry` handed a
`schema:` string while `db/schema.lite` exists. Both rejected shapes are controls
in the suite, beside a comment mentioning the hazard — this rule's own prose
describes what it matches on, so it reads through `readCode`.

`tests/checks.test.js` § `schema-in-memory` (6) · [checks.js](core/checks.js)

## 2026-08-31 — the schema a tool reads is not the schema an app runs

1549 + 35 tests, 0 fail. Closes [`FJS-625`](../../ISSUES.md#fjs-625); opens
[`FJS-626`](../../ISSUES.md#fjs-626) for the half that cannot take this fix.

**An app's seed is not `db/schema.lite`.** It is that file, plus fragments a
package ships and the app appends in memory (`authSchemaFragments()`,
`outboxSchemaFragment()`), plus `extend model` in files of its own. Every tool
here read the first and called it the answer, so the models none of them could
see were exactly `User`, `Session` and `Credential` — the identity layer.

Two readers, failing in opposite directions, which is why neither had been
noticed. **`fli check`'s `service-model` failed closed**: a correct
`users.service.ts` stating `model: 'User'` was reported as naming a model that
does not exist. A rule that fires on a correct app is a rule people baseline.
**`fli admin:generate` failed open** and had since it was written: it generated
a complete admin panel with no Users screen in it, silently.

`core/app-schema.js` is the one owner now — `appSchemaModels`, `appServices`,
`serviceForModel` — read by both, for the reason two implementations of one rule
are always the wrong number. A dependency's `.lite` files are found through its
own `exports` map and never a guessed path, which is the rule
`package-model-drift` already followed and the one litestone's own resolver
follows.

**The cost is stated rather than hidden**: a service naming a package model the
app never actually assembled now resolves instead of being reported. That is
the fail-open direction the rule exists to close, and it is accepted because the
alternative is a false error on the documented in-memory install — the shape
both apps in this repo use.

### What running the generator found

`FJS-372` says no test in this repo executes a generator. `example`'s new
`verify:users` drive does, and then opens the pages in a browser. Three defects
in the first ninety minutes, none of which a reading would have caught:

**A service name is a FILENAME and was being derived.** junction autoloads the
directory, so `shipping-methods.service.ts` answers on `/shipping-methods` —
and `servicePlural('ShippingMethod')` is `shippingMethods`. Five of `example`'s
generated screens called a URL the app does not serve: a 404 with the page
rendering normally around it. The services directory is read now; the
derivation is the fallback for a model that has none.

**A model with no service was generated and then warned about**, which is the
wrong half — the route rendered and `load()` failed. Nothing is written for one
now. Filtering it out of the TARGETS alone was not enough, and that is the part
worth remembering: the layout and the dashboard are built from the full model
list on purpose, so that a `--model` run does not drop the sections an earlier
run added. The nav went on linking two sections that had never been generated —
the panel advertising a screen that 404s, the same defect one layer up.

**The export name took the service string.** `export const shipping-methods =
createResource(…)` does not parse. Kebab could not reach the export before this
change, so it is a defect this change introduced and the first end-to-end run
caught — which is the argument for the drive in one line.

**Also settled: `@@gate(8+)` models are skipped by name.** Reading the whole
seed means seeing a package's machinery. `asSystem()` itself grades 8, so a page
over `Credential` would ask forever, and would be an editor for password hashes
if it did not. What separates machinery from domain is the gate, and the gate is
in the schema — so the rule reads it rather than carrying a list of names.

## 2026-08-31 — a log nobody can read back

1549 + 35 tests, 0 fail. Closes [`FJS-622`](../../ISSUES.md#fjs-622) and
[`FJS-623`](../../ISSUES.md#fjs-623).

**The vhost `deploy:setup` writes declared no `access_log`.** A server block
without one falls back to nginx's machine-wide default, which is a working
config, a green `nginx -t` and a serving site — the only symptom is that the
file cannot be read back, because nothing in a line says which app took the
request. On a box with two apps, which is the normal case for a fleet machine,
neither one's traffic is attributable.

The path now carries the app id, and **the directory is load-bearing**:
`/var/log/nginx/*.log` is the glob the packaged logrotate rule already rotates,
so the files are bounded by a rule that is on the machine rather than by one we
would have to write. Anywhere else and this would have been
[`FJS-616`](../../ISSUES.md#fjs-616) one layer up while looking like a fix.
`combined` is stated rather than defaulted because it is the format an analyser
reads unasked; a custom `log_format` cannot be declared here at all, being
http-level only.

Found designing `IDEAS/traffic-analysis.md` against CapRover's GoAccess
integration, which needs exactly the per-app log this was not writing — so the
gap was a precondition rather than a phase, and went in ahead of the design.

**A test waited for a file to exist when it needed the pid inside it.**
`children.test.js` spawns a shell that writes its pid with `echo $$ > f`;
`echo` creates the file before it writes, so `existsSync` is the wrong signal
and an empty read parses as `0`. It fired on the full suite and passed in
isolation — the signature that reads as somebody else's change breaking it —
and only the success path removed the file, so `/tmp` held nine of them
including a **0-byte one**: the failure state on disk, waiting for a run whose
pid recycled onto the same number. Now waits for a parseable pid and clears the
path before the spawn as well as after.

## 2026-08-29 — a refusal is not a success

1531 + 35 tests, 0 fail; `deployJournalCycle` 12/12. Closes
[`FJS-589`](../../ISSUES.md#fjs-589).

A step refuses by setting `context.config.abort` and returning. Every later step
then self-skipped and the command exited **0** — so seven of the deploy
pipeline's nine refusal sites reported success, `deploy:revert`'s six named
refusals among them, which are the whole safety argument of the Release realm.

**`abort` fails the command; `stop` is the deliberate early exit that
succeeded.** Both skip every later step and they differ only in the verdict.
Fail closed, so the next refusal somebody writes is loud without being told to
be — `--plan` is the one shape that had to say otherwise, in three places.

Asked on BOTH return paths. A command with steps runs the orchestrator then the
loop; one without steps returns `config.run` directly, and `deploy:logs`,
`:status`, `:run` and `:unlock` are that shape.

The throw is `quiet`: the refusal has already printed its reason and the ways
out, so `bin/fli.js` prints one line naming the step and nothing else.

**`runOnAbort` now means run on a REFUSAL.** A cleanup step undoes a half-done
run, and a deliberate stop did not start one — `fli deploy --plan` printed its
plan and then reached `09-cleanup`, which opens a connection to the target to
release a lock nothing took. Measured: five minutes hanging, now two seconds
and exit 0.

Doctor's trailing abort was deleted rather than converted. It protected nothing:
doctor declares no `steps:` and is not `index.md`, so no step folder is ever
discovered for it.

## 2026-08-30 — `--resume` adopts the transition it finds

`fli deploy --resume` took the lock over and then deployed from the beginning,
because the transition it was continuing could not be found. `readAttempts` keys
on `releaseId`; a Release id is content-addressed on the image digest; and a
**local image ID is not a content address** — measured, one Dockerfile over one
unchanged file gives `1f021e1eccf8` cached and `a9c17ea37ed9` with `--no-cache`.
So an interrupted deploy rebuilt, minted a different Release from identical
bytes, matched nothing, and opened a second transition. Every resume did this,
and the machinery underneath it — `resumeDecision` skipping a succeeded step,
`restoreStepNote` replaying the image `04-build-api` recorded so `06-swap` can
start it — was unreachable in the one case it exists for (`FJS-595`).

`readLiveTransition` asks the question a resume means: **what is open here**.
Scoped to one app, one environment, and to the kinds that can be continued, so a
revert in flight is not picked up by a deploy. It answers the transition AND its
Release, because adopting one without the other resumes the old transition
against the bytes this run just built.

**Only under the flag.** An ordinary deploy still keys on the Release, because
there *different bytes are a different Release* is the right question — the
lookup was not wrong, it was being asked in the one place it does not fit.

Two documents were carrying the reasoning that made this a bug and both are
corrected: `04c-journal.md` said Docker's cache produces the same digest twice
for an unchanged tree, and this package's `CLAUDE.md` still described the older
design where a Release carried no digest at all and concluded that *resume works
BECAUSE the id does not depend on a rebuild being reproducible*. That sentence
was right about the mechanism and had stopped being true of the code.

Found by clearing `FJS-544`, whose private-`/tmp` failure had masked the whole
journal cycle since it was written — so `deployJournalCycle`, the only thing in
the repo that runs `fli deploy`, had never reached this.

## 2026-08-30 — the Release realm gets a surface

`core/release-view.js` and two routes put the pivot on `fli gui`'s front page,
beside *what proves this change* and *checks*. Until now the whole realm was
terminal: you learned that a change crosses the pivot by typing `release:check`,
which is a thing people type once something is already wrong. Its first run
reported this repository's own tree as **contract** — twenty findings, all of
them real — which nothing anybody looks at had been saying.

**Two halves, and the split is the design.** The verdict per app READS THE TREE,
so it loads with the page: free, offline, no side effect. What is SERVING
reaches a machine over ssh, so it is a button and never a poll — a panel that
ssh'd while a page loaded would be the monitoring agent this realm refuses. They
are separate functions behind separate routes so the distinction cannot erode
into a `setInterval`.

**Nothing here re-derives a verdict.** `classifyPivot` is litestone's and the
revert refusals are `core/revert.js`'s; both are reached by running the command
that owns them and reading what it printed. A second implementation is how the
GUI ends up disagreeing with the terminal about whether a deploy can be undone,
which is the one disagreement that costs a database.

Three things it cost to get right, each caught by running it rather than reading
it:

- **The refusal was thrown away.** The first version used `execFileSync` and
  kept stderr only from the catch — but a deploy command that refuses exits 0
  ([`FJS-589`](../../ISSUES.md#fjs-589)), so the success path handed the panel an
  empty string and it reported *the journal answered nothing* about a command
  that had said exactly what was wrong. `spawnSync`, both streams, every path.
- **`.select` is defined by nothing.** The panel was written with it; the class
  is `.field`. That is `FJS-545`'s shape one layer up — markup that looks styled
  and is not — and it is invisible to any assertion about what the page SAYS.
  `tests/browser/specs/release.spec.mjs` probes computed style against a bare
  element, with a negative control that fails if the probe stops catching
  `select` and `stack-sm`.
- **A count in a badge is a Pill.** `badges.css` says so at the top and notes
  that the failure is silent, which it was.

The first attempt at that class check walked `document.styleSheets`; `cssRules`
throws for the served stylesheet, so it reported every class in the page as
undefined — `.badge` included, one assertion above the one measuring `.badge` as
styled. A check that fails on correct markup is worse than no check.

## 2026-08-30 — one deploy is one build, on both sides of the wire

`03-build-web` stamps `VITE_FJS_BUILD=<commit>` so vite inlines it into the
bundle, and `06-swap` passes `FJS_BUILD=<commit>` into the container so the API
states the same value. A browser can then tell it is running the previous
deploy's code ([`FJS-D160`](../../DECISIONS.md#fjs-d160)).

The env goes in the SCRIPT rather than the exec options — the script is piped to
the target's shell, so an env option would set the operator's — and the commit is
asserted to be a sha before it is interpolated into a command line, because
Invariant 8's reasoning applies to a shell exactly as it does to SQL.

`deployJournalCycle` gained a twelfth assertion, and it is the only thing that can
make this claim: two packages have to agree, the cli decides the value and
junction states it, so it asks a DEPLOYED container what it answers and compares
that against the commit the deploy built.

## 2026-08-30 — the binding block stops being vacuous, and a refusal that reports success

**`bindingsHash` covers a DECLARATION, and now says so.** `deploy.bindings` and
`deploy.secrets` feed the Release id and their values are applied by nothing —
`fli` writes no `.env` on a target, the operator owns that file, and the
container is started with `--env-file` against it. `formatRelease` prints
`(declared)`, `release:mint`'s term table says *as declared*, and
`core/release.js` carries the reason. Half of [`FJS-585`](../../ISSUES.md#fjs-585);
the values half is still open and is two different features.

**The keys are now graded against the target.** `01b-env-check` reads the
declared binding and secret KEYS alongside `.env.example`, reports which source
named a missing one, and a declared block turns the check on by itself. That is
what stops the declaration being a statement nothing checks — the values stay the
operator's, and the keys become a per-target assertion in a file that is
reviewed. `bindingSet` is asked rather than the two objects re-merged here,
because per-target-beats-app-wide is its rule.

**And it found [`FJS-589`](../../ISSUES.md#fjs-589), which is larger than what it
was looking for.** `runtime.js` re-throws a step's ERROR, so a step that throws
fails the command — but a step that refuses by setting `context.config.abort` and
returning only makes the later steps self-skip, and the command exits **0**.
Seven of the pipeline's nine refusal sites do it that way, `fli deploy:revert`'s
six named refusals among them: the whole safety argument of the Release realm,
each one telling a script the revert succeeded. Filed rather than fixed — a
blanket *abort ⇒ non-zero* is wrong (`--plan` prints a plan and stops, which is
success), so 34 abort sites each need the *refused* / *stopped on purpose* call
made, and it should fail closed.

`deployJournalCycle` gained an eleventh assertion, and it is the first thing here
to run a step that refuses without throwing — which is why nothing had seen this.
It asserts the pipeline STOPPED and the refusal named the key and its source,
and gains `status !== 0` when 589 closes.

## 2026-08-29 — a failed health check shows the container's own words

`healthOrRestore` printed the URL it polled and a hint about `apiPrefix`, then
rolled back. That hint is right when a running app serves health at a path the
deploy block does not name, and **wrong in every case where the app never came
up at all** — a missing attachment binding, a bad encryption key, a port already
taken. In those the app had already said exactly what was wrong, clearly, in its
own output, and the operator saw none of it: the sentence was in `docker logs`,
where nobody looks at 3am because nothing said to.

`showContainerTail` tails 40 lines on a failed health check, labeled as the
app's own words. Tailed rather than dumped: an app that started and is merely
unwell has written thousands of lines, and burying the one that matters is the
same failure one layer along. A stopped container still answers, which is the
case that matters most — it is the one that exited. It never throws; this runs on
a path that is already failing.

It is called from `healthOrRestore`, so the REVERT path gets it too — a revert
whose health check fails is a target with no working release on it, which is the
worst moment to be told only that a URL did not answer.

**`deployJournalCycle` gained a tenth assertion**, and it is the one that proves
phase 2 of `IDEAS/release-transitions.md` end to end: an app declaring an
attachment nothing binds, deployed for real, must fail the deploy, carry the
app's own refusal naming the service into the operator's terminal, and leave the
release that was serving still serving. All three at once, which no unit test on
either side can reach ([`FJS-D158`](../../DECISIONS.md#fjs-d158)).

## 2026-08-29 — `polymorphic-subject`: the one thing an open pair can still be told

`(subjectType, subjectId)` is the ruled answer for a target set that is open —
no foreign key, no cascade, no `include`, and the target deliberately not an
input to the access-control compiler (`IDEAS/polymorphic-relations.md`). None of
that changes.

**What changed is that the discriminator was carrying no rule at all.**
`subjectType String` accepts a value naming nothing, forever, and nothing
objects — not a migration, not a seed, not `asSystem()`. The fix is not a
feature: an `enum` there emits a table CHECK, which holds where every other
constraint holds, and reaches the browser as a set `controlFor` renders as a
picker instead of a text box. `@@check("col IN (…)")` is the same enforcement
where the values are not identifiers. The rule asks for one of the two.

**A warning, because the exemption is real and it is named.** A set that grows
with every model — an audit trail keyed by the service that wrote the row — must
stay a String, since an enum there refuses the first row a new service writes.
`check-baseline.json` is how an app says it means it, and basecamp's now does.

**The evidence it is worth asking at all comes from the corpus.** Across seven
published schemas ERPNext is the only source that DECLARES which kind each of
its polymorphic fields is: 17 closed, 61 open. Reading the 61 is the finding —
`party_type` is declared CLOSED twice (Customer, Supplier, Employee) and left
open sixteen times in the same codebase, and `invoice_type`, `voucher_type`,
`reference_type` and `document_type` all do the same. **Openness in the data is
mostly an author not bothering rather than a domain requirement**, which is why
the default here is to ask.

Its first run reported five sites across this repo's two apps and every one was
real, including two a hand grep had missed (`Server.providerKind + providerId`,
`AuditEvent.actorType + actorId`). Four are enums now and the fifth is the
baseline entry.

Shape detection is a line scan here rather than litestone's
`src/import/polymorphic.js`, which finds the same pairs to ask a different
question — *which of the three answers did you mean* — and importing it would
make an engine that must run in a client app with only `@frontierjs/cli`
installed depend on a framework package to answer a question about text.

`tests/checks.test.js` grows a correctly-declared pair in its CLEAN tree, so the
rule RUNS there rather than skipping — the discipline that file already applies
to `transition-methods`, `capability-ladder` and `service-as-system`.

## 2026-08-29 — the split's middle step is checkable

`fli release:check` refuses a contract on a required column and hands back
*expand → backfill → contract*. The middle line used to read *fill `x` for the
rows that predate it* — a sentence between two commands.

`litestone release` now puts the FACT on the finding (`needsBackfill: { model,
field }`) and stops there, because which mechanism fills a column is a question
about the running application and litestone sits below the package that answers
it. `fli release:check` reads the app's own source for a `defineBackfill` naming
that model and field, and prints either where it is declared or the stub to
write:

```
The middle step — every column that needs a value before its contract can pass:

  ✗  Order.shippedAt — no defineBackfill names this column
```

Read as SOURCE rather than by a directory convention, the way the thirteen
source-reading `fli check` rules already work: a rule keyed on a path reports a
correct app as missing one. `core/backfills.js` counts braces rather than
matching them with a regex — a `fill` is a function body and holds braces and
quotes of its own, so `defineBackfill\({([^}]*)}` stops inside it and the
`field` after it is never seen.

**What no command here can answer is whether it has RUN**, because that is a row
in the deployed database and this has no target. It says so, and names
`app.backfills.status()`.

`fli backfill:install` is the sibling of `outbox:install`: it imports
`@frontierjs/junction/backfill.lite` by name rather than copying it, pushes the
schema, and prints the declaration and the two lines to configure.

## 2026-08-29 — the deploy lock says who holds it and how far they got

1456 tests, 0 fail. `FJS-573` closed, ruled as [`FJS-D156`](../../DECISIONS.md#fjs-d156).

Two records of a run in flight, and in the one case the whole Release design
exists for they disagreed. The journal knew a killed deploy had left a `running`
transition and `resumeDecision` graded exactly how to continue it; `.deploy.lock`
refused the run that would. The only way through was to delete a file by hand,
and the message telling an operator to do that named a pid.

**The pid was a lie by construction and that is what settled the design.** The
lock script wrote `$$`, expanded by the `sh -s` that ran it — a shell that exits
the instant the file is written. It cannot be fixed by recording a better one:
`fli` runs on the operator's machine and reaches the target one command at a
time, so there is **no process on the target to point at**, and no probe can be
built on one. `deploy:status` did not even parse its own format — it split
`<pid>:<iso>:<target>` on `:` and had been reading the hour as the timestamp for
its whole life.

So the lock records what is true: the run, who started it, when, and **which step
it is inside**. That last one is the fact that makes the duration beside it mean
something — four minutes in `04-build-api` is a build, four minutes in `06-swap`
is a run that died. It comes from a `beforeStep` announcement in the step runner,
which is the only place it can: the build is the longest thing a deploy does and
it runs BEFORE the journal opens (`04c-journal`), and a timer cannot serve it
either, because `execSync` blocks the loop for the whole of a step.

Neither register judges liveness, because that is a fact about a process this
machine cannot see. The refusal reports and names both ways out, and they are not
the same choice:

```
Deploy already in progress on deploy@box
  held by sam deploying production, started 9m ago
  in step 06-swap — 7m in it

  If that run is dead:
    fli deploy --resume    continue it — the journal knows how far it got
    fli deploy:unlock      drop the lock and start over
```

`--resume` takes the lock over; `deploy:unlock` drops it and settles nothing, so
a transition the dead run left open stays resumable. A resume was always safe
without a liveness probe — a succeeded step replays into a no-op, a step is
claimed compare-and-set, and different bytes are a different Release and
therefore a new transition. The lock was only ever what made it unreachable.

**A freshness check on `--resume` was built and then removed, and the reason
generalises.** *A lock whose step moved seconds ago is a live run* looks sound and
is not: the recorded time is when a step STARTED, and nothing records one ending
or a pulse inside it — so a fresh timestamp is equally consistent with a run three
seconds into a five-minute build and with a run killed three seconds into it. It
was measured that way round, by the cycle: the crash it exists for leaves exactly
that lock. A sound version needs a heartbeat within a step, which `execSync`
forecloses. **Nothing was lost by removing it**, because the fact is already on
screen — *in step 06-swap — 3s in it* — where a person can weigh it and the
machine does not pretend to.

**A TTL was considered and refused.** It is the shape the field uses and the one
caravan uses one layer down (`FJS-294`), but the heartbeat can only tick per
step, and a step is minutes long — so the TTL would have to exceed the longest
build, putting an operator whose deploy was killed in a fifteen-minute wait to
reach a feature that is already safe to reach immediately.

`core/lock.js` is one format, one parser, four scripts and three readers, where
`deploy`, `deploy:status` and `deploy:doctor` each used to `cat` the file and read
it their own way. The format it replaced still parses and says it is legacy. Two
things are proved by execution rather than compared as strings: `set -C` genuinely
refuses a second writer, where the `[ -f ]` guard it replaces was two operations
with a window between them; and a refresh carrying another run's id does not
clobber. The `sh -n` guard over the deploy pipeline gained a second source, because
these scripts left its text corpus by moving into a module — which is the shape of
a check going quiet.

`deployJournalCycle` used to `rm` the lock itself to reach the resume it was
testing. It now asserts the refusal names the step the lock is holding and offers
`--resume`, and resumes with it.

Two other things the run turned up. `daemonBlindHint` is now one owner for *the
daemon cannot see our work directory* — it matched the classic builder's wording
only, so under BuildKit the same environment failed the journal cycle looking
exactly like a broken Dockerfile. And `tests/lock.test.js` was written and not
run: it is in the `test` script now, which is the rule `fli check`'s
`test-files-run` already publishes and the reason it exists.

## 2026-08-29 — a dev surface has a name

1430 tests + 99 browser assertions, 0 fail. `IDEAS/control-surface.md` §10.6,
`IDEAS/overview.md` 5.19.

`example.localhost` rather than `localhost:8010`, and it is worth having only
because the derivation was already here: `core/ports.js` knows that project 1 is
`example` and that 8010 is its frontend, so a name is a RENDERING of the table
that already owns the numbers. The frontend takes the bare label and every other
surface is a subdomain of it — which is what makes the cookie property real,
since `example.localhost` and `api.example.localhost` are a parent and a child
where `:8010` and `:8110` are one origin sharing one jar. Tools live under
`fli.localhost`, so no app can shadow `studio`.

`fli proxy` is the half that is not free, and two measurements shaped it.

**It is a TCP proxy and not an http one.** The first cut piped an http request
upstream and handled `upgrade` by piping sockets. It works under node and is
silently broken under bun, which is what `fli` runs on: bun's `node:http` emits
`upgrade`, hands over a socket that reports `writable: true`, and nothing
written to it ever reaches the client — measured, with the upstream seeing the
handshake and the browser waiting forever. Junction's live layer and vite's HMR
are both sockets, so that is a page that loads and then silently stops updating.
At the TCP layer there is nothing to be compatible about: read the first head,
pick the target from its Host, pipe bytes.

**Nothing is rewritten.** The Host was going to be swapped to `localhost:<port>`
for vite's DNS-rebinding guard, until the guard was read: it allows
`hostname.endsWith('.localhost')` in both the 5.x and 8.x this workspace
resolves. Which matters, because junction READS the host — `resolve subdomain`
tenancy is nothing else — so rewriting would have made every tenant one tenant
to appease a check that was never going to fire.

**One bound, stated rather than hidden.** The target is picked from the first
request on a CONNECTION and kept, because routing per request means parsing
every request on a keep-alive socket. No real client reaches it: a Host is
derived from the URL, and a browser pools per origin, so two names are two
connections. Asserted as its own case.

**Strictly additive.** Every number keeps working, a tile's `open` is still the
port, and the name is shown as text beside it. `fli check`'s **`dev-host-unique`**
(error) refuses two packages whose names reduce to one label — `strictPort`'s
failure one layer up, and silent in the same way: the page works, and it is the
wrong app.

Proven end to end against the live `example` web on 8010 and its real vite HMR
socket, which answered 101 through the proxy.


## 2026-08-29 — the Release names the artefact

1406 tests, 0 fail. `IDEAS/deploy-plane.md` §2.3f, the half that was owed.

**The Release id had no digest in it**, because the journal opened before the
build: a transition cannot be minted around bytes that do not exist yet. So two
deploys of different source minted the same id, and `fli deploy:revert` looked
its target's image up by that id, got the newest transition carrying it — the one
serving — restored the bytes it was reverting from, and reported success.

`01c-journal` is `04c-journal`. The transition opens after the artefact exists,
which is the ordering the whole row turns on. What it costs is that a build
failure now records nothing, and that is the right answer rather than the price:
no artefact, no Release, nothing transitioned. The steps ahead of the journal are
marked done when it opens — `_steps-revert/02-decide` already did this for the
two ahead of it — and their notes come with them, because `04-build-api` records
which bytes it built and a revert reads that to find a startable image.

`fli deploy --plan` says its own Release id is **provisional**, since it builds
nothing and the digest is a term of that id.

### `deploy.builder` — built once, shipped by content

A machine, resolved like every other side, defaulting to the api target — so an
app that declares none behaves exactly as it did. Declared, the image is built
there and shipped with `docker save | docker load`, which preserves the image ID.
No registry: the record keeps three distribution strategies open and makes none
of them the definition, and this is the one that needs no infrastructure.

Not built here by default, deliberately: `fli` is a laptop CLI, and building
locally trades server drift for developer-machine drift, which is worse. The
builder is a declared machine with an identity.

### What running it found: the WAL was in the image

An unchanged redeploy kept minting a NEW Release, which under the new ordering
means the bytes really did move. They did: the container writes `db/app.db-wal`
into the mounted volume, the volume is inside the build context, and the
scaffold's `.dockerignore` said `db/*.db` — which never matched a sidecar. So
**every deploy after the first copied the running app's write-ahead log into the
image**, and moved the digest with it.

`02b-build-check` exists to catch exactly this and was blind to it: `isStateFile`
graded `.db-wal` as state and `CONTEXT_FIND` looked for `*.db` and not the
sidecars — two lists for one fact, with the finder's own comment claiming it was
*the same list spelled for `find`*. The finder is built from the list now, and a
test asserts every extension the classifier grades is one the finder looks for.
The scaffold writes the `**/` forms basecamp already had (`FJS-555`).

### The proof

`deployJournalCycle` gained the assertion this row is about — **an unchanged
redeploy mints the same Release** — which was trivially true while every Release
was identical and means something now. Its resume assertion changed with the
ordering: what a resume IS, is one transition continued rather than a second
opened, so that is what it counts.

## 2026-08-29 — the rules, and the machine, where somebody looks

1396 tests + 99 browser assertions, 0 fail. `IDEAS/control-surface.md` §10.5.

`fli check` is the arch-test surface and `fli doctor` asks whether this machine
can run fli at all. Neither was anywhere a person looks, which for a set of
rules that are silent when broken is most of the value gone. One panel on the
front page now carries both, kept as two questions: a missing `sqlite3` is not
an architecture finding, and a model named in the plural is not something `apt`
can fix.

**`core/doctor.js` is new, because that engine did not exist.** It was a hundred
lines inside `commands/fli/doctor.md`, interleaved with the `echo`s that printed
it, so the only way to ask was to run the command and read a terminal — and the
front page, the second caller, could not ask at all. The command is now the
rendering of it and gained `--json`; `has`, `env` and `home` are injected, for
the reason `@frontierjs/outpost` injects its docker runner, so a missing
`docker` and a present one are both a test.

**Both are asked in process**, never spawned and never parsed out of `--json`:
`core/checks.js` is the same engine `scripts/ci.mjs` runs, so there is one
answer to each question.

**A clean project says so.** The proves panel above hides on a clean tree
because *nothing changed* is noise; *this project passes its own rules* is not,
and hiding it makes `clean` and `never ran` the same screen.

**The machine goes first when it has something to say**, graded on whether it
STOPS fli rather than on whether something is absent — `blocked` counts system
and config only, because a missing `CLOUDFLARE_TOKEN` blocks `cloudflare:` and
nothing else, and counting it makes almost every machine read as broken.

One thing the paper did not predict: `runChecks` is synchronous and one scope is
~half a second, so five in a row froze this server — the state poll missed,
every badge on the page emptied, and a start button did nothing for a second and
a half. A yield between scopes does not make it faster; it makes the server
answerable while it runs. The browser drive found it, and two assertions that
had been passing on timing were rewritten to ask for the poll they depend on.


## 2026-08-29 — answering is not working

1375 tests + 82 browser assertions, 0 fail. `IDEAS/control-surface.md` §10.4.

The state badge is a socket that opened, which is equally true of a Junction app
whose database probe is failing and of a process that bound the port and wedged.
`GET /api/health/:id` asks the thing on that port what it says about itself, and
a third badge carries the answer: *healthy*, or *1 check failing* with the check
NAMED and its error printed on a click.

**The fli server fetches it, not the page.** The page is on 8500 and the app on
8110, so a browser fetch is cross-origin — an app whose CORS does not name this
origin answers a network error indistinguishable from the app being down, which
is the opposite of what this is for.

**The path is probed and the answer says which one worked.** `apiPrefix` moves
every route an app registers, `/health` included, so where it lives is a fact
about the app's config rather than about its port. Probe, or be told — never
derive, which is Invariant 3's rule for the same class of question.

**A row that answers nothing shows nothing.** A Vite dev server is up and has no
opinion about its own readiness; rendering that red would leave every web
surface on this page permanently wrong, which is how a signal gets ignored. A
200 of something else is not a health answer either — without the shape test an
index page reads as a healthy API.

Polled at a fifth of the state rate, and the verdict is dropped the moment the
port stops answering: a row that goes down and comes back is a NEW process, and
without that the badge shows the previous one's failing check for up to fifteen
seconds. Both of those were mutation-checked twice — the first pair of
assertions passed against both mutations, because each was written against a row
that was DOWN and hidden one branch earlier.


## 2026-08-29 — the deploy pipeline runs, and nine of its ten shell commands were broken

1398 tests, 0 fail (+115), plus `deployJournalCycle` in CI: deploy → deploy →
crash → resume → revert, against a real machine with a real Docker daemon.

**Nothing had ever executed `fli deploy`.** The `deploy` CI phase runs
`fli deploy:local`, which is a different command — it builds an image and runs
it, and never touches `_steps-docker/`, the journal, the swap, the health poll
or the revert. The journal's own unit tests drive the real runner against real
SQLite, so the runner was proven and the pipeline around it was not. Phase 1
shipped ~1250 green tests over a path that had run zero times.

It had run zero times because it needs a server. So the first move was to give
*run a command on that machine* one owner, and let the machine be this one.

### `core/machine.js` — the script travels on stdin

Twenty-eight call sites across twelve step files each spelled
`ssh ${host} "${cmd}"` by hand. `context.exec` is `execSync`, which is
`/bin/sh -c`, so every one of those scripts was parsed TWICE — once here and
once there. Measured against the health check that shipped:

```
ssh HOST "for i in $(seq 1 10); do; STATUS=$(curl -s -w "%{http_code}" …
```

`$(seq 1 10)` ran on the operator's machine and arrived as literal text.
`$(curl …)` also ran locally, polling the operator's own `localhost:3000`. The
nested `"` closed the outer quote. `"$STATUS"` expanded here to empty, so the
target received `[  = 200 ]`.

**Nine of the ten multi-line commands in the pipeline were shell syntax errors
on the target**, for a second reason on top: `.replace(/\n\s*/g, '; ')` turns
`then` into `then;` and `do` into `do;`, and sh refuses both. The deploy lock,
the container rename, the stop, the health poll, the restore, the cleanup, the
rollback and both revert steps were all in that set — `sh -n` on the exact text
each one sends, which is what `tests/deploy-scripts.test.js` now runs over every
script the pipeline can produce.

A tenth was worse than a syntax error: `deploy:setup` wrote its nginx config
through a heredoc nested inside ssh's double quotes, so the local shell ate
every `$host`, `$remote_addr` and `$proxy_add_x_forwarded_for` on the way past.
The file that landed said `proxy_set_header Host ;`.

A script is never interpolated and never joined now. It goes to `sh -s` on
stdin, where no shell but the target's own ever reads it.

**`localhost` is a transport, not a simulation.** Same script, same `sh -s`,
minus the ssh prefix — the real docker commands against the real daemon.
`deploy.transport` overrides the inference for anybody testing their own sshd.
`tty` and `pipe` are separate verbs because stdin can only carry one thing and
`docker exec -it` and the journal runner each need it for something else.

### What running it found

**`fli deploy:revert` restored the bytes it was reverting FROM**, and reported
success. Under build-on-target the Release id carries no digest, so two deploys
of different source mint the same id — and looking the image up by release id
answers whichever transition is newest, which is the one serving. Revert targets
the previous *transition* now, and a seventh refusal (`same-bytes`, no override)
catches the rest. What is running is asked of the machine rather than the
journal: a revert transition has no build step, so after one revert the journal
cannot say.

**A resumed deploy started `undefined`.** A replayed step contributes nothing to
the run, and one of those contributions is load-bearing — `04-build-api` records
which bytes it built and `06-swap` starts them. The step row carries the note;
the projection the resume reads did not select `output`.

**A revert could not itself be reverted.** `imageFromSteps` matched the step by
name, and a revert has no `04-build-api`. It reads any step that recorded an
image now, last one wins, and `_steps-revert/03-swap` records what it started.

**`fli deploy --plan` could not grade `01c-journal`** — the journal step itself.
Its predicate reads `context.flag.dry` and the plan's synthetic context carried
only `config`, so it threw. Reported honestly (*it will RUN*) rather than
silently, which is why it was findable at all.

A failure now names the script and the machine. `execSync` says
`Command failed: sh -s`, which names every script this module runs and
distinguishes none of them — and that string is what the journal recorded, so a
failed step could not be attributed afterwards.

### Also

The deploy lock has one definition, shared by deploy and revert: two copies that
drifted on the file name or the format would each hold a lock the other could
not read. `context.exec` takes `describe`, so `--dry` prints the script rather
than `ssh host sh -s` twelve times.

Filed rather than fixed: `FJS-573` (a crashed deploy strands its lock, and the
pid in it is the pid of the shell that wrote it) and `FJS-574` (every deploy of
a freshly scaffolded app fails its backup, and blames the container).

## 2026-08-29 — the dashboard answers *does it pass*, not only *is it running*

1282 tests + 64 browser assertions, 0 fail. `IDEAS/control-surface.md` §10.2.

The child table held an exit code and sixty lines of output and threw both away
— `stopRow` deleted the entry and `startRow` overwrote it — so every drive and
every suite read `unknown` forever. Honest about whether it is running, and no
answer at all to the question somebody actually has about a drive.

A row now carries a second badge: `passed · 4.2s · 2m ago`, `failed (1)`,
`stopped`, with the kept tail behind a click. **Two badges, one fact each** — a
single one saying `exited 0` had to choose between *is it running* and *did it
pass*, and chose the one that disappears.

**`stopped` is not `failed`.** A SIGTERM looks identical whoever sent it, so the
stop is marked BEFORE the signal and the exit handler reads it. Without that the
page tells somebody their drive broke when they are the one who stopped it.

**The words are the page's and the facts are the table's.** `children.js` keeps
when, how long, what it exited with, and whether the stop was asked for; the
page chooses the vocabulary, because it differs by kind — a suite that exits 0
passed, and a dev server that exits 0 on its own did something nobody has a word
for.

**In memory, session-scoped, and the badge says *here*.** Persisting would claim
a verdict about a tree that has moved on since, and it would still know nothing
about the runs somebody did in a terminal — so a row nobody has pressed shows
nothing rather than *never passed*.

`outputOf` falls back to the finished run's tail, which is the whole of why a
run is kept: sixty lines saying why a drive failed are worth nothing if they are
dropped the moment it does.


## 2026-08-29 — one button starts the whole thing

1269 tests + 51 browser assertions, 0 fail. `IDEAS/control-surface.md` §10.1.

`verify:live` needs `db:seed`, then `api` and `web` — three rows pressed in
order, with the order living in prose and in the drive's own exit 1. The drive
row now carries its preamble, shows it before anything is pressed, and one
button walks it.

**Read, rather than declared or asked.** §7 weighed a declaration beside the
script (rejected: a third copy that drifts) against `verify:live --preflight`
(preferred: one owner). What shipped is neither and it dominates the first on
the first's own argument — `core/preflight.js` reads `CLAUDE.md`'s *Start first*
column, which adds no copy at all because it is the copy people already
maintain. Same move `proofs.js` made on the table beside it. What it does not
close is drift against the drive's own check; what it does close is a renamed
script, which is the half that bites, and `fli check`'s **`drive-preamble`**
(error) grades every step against the directory that would have to run it.

**The order is the content and grouping is dropped.** The cell is ordered prose
— *`db:seed`, then `api` + `web`* — and `+` means *these may run at once*.
Running them in sequence instead loses only concurrency nobody asked for, and
two rows say `api` + `build:site` where the second genuinely needs the first, so
a parser that honored the `+` would race them.

**The sequence is on the page, not on the server.** Each step lights up as it
goes, so *the API is still coming up* and *the API failed to start* are
different things to look at — and the server stays a set of verbs, which is what
keeps a start an ID and never a command. A step already answering is **skipped**,
which is what makes this the only start button a drive needs.

Two things fell out of it. `tasks()` read the workspace root's `package.json`
alone, so `db:seed` and `build:site` — what most drives begin with — **were not
rows at all**, and the one thing a start button may be handed did not exist for
them; it now reads the workspace and its apps, with a script already claimed by
a surface or a drive left to that kind, so one script is one row. And the walk
refuses a step the table names that its directory does not declare, by name:
without that it POSTs a null id and the person reads `no runnable called null`.


## 2026-08-29 — the dashboard answers *what proves this change*

1235 tests + 35 browser assertions, 0 fail. `IDEAS/proof-map.md` step 4, which
is `IDEAS/control-surface.md` §10.3.

`GET /api/proves` and a panel above the tiles. Every answer resolved to a
runnable row renders as the same start button the tile below it carries, which
is the whole reason the map ends up on this page rather than staying a printout.
A target that resolved to something else says which — a script to copy, a file
to read, or `gone`, the finding `proof-target` exists for, on screen where
somebody is about to take the advice.

**Three decisions, none of them in the paper.**

**The endpoint takes no parameter.** `fli proves --from <ref>` takes a ref
because the person typing it chose it; a ref arriving over HTTP is
caller-supplied text on a git command line. So the panel is the working tree,
`execFileSync` with a fixed argv, and there is nothing to validate because there
is nothing to send.

**It is not polled.** A port's state goes stale while nobody is typing and a
diff cannot, so this is read once per dashboard load and on a button — and the
button re-runs git, because a refresh answering a cached read is a broken
refresh.

**A clean tree hides the panel; an uncovered change does not.** *Nothing
changed* on every page load is a panel people learn to skip. *These files
changed and no row covers them* is the one thing this panel reports that nothing
else does.

Also: git answers paths from the repository root, which is the project root only
when the two are the same directory. A project one level down was matching
against paths carrying a prefix its own table never writes — nothing, or worse,
the wrong row. The endpoint rebases onto the project, and `tests/server.test.js`
runs that branch by default, because its `projectRoot` is `packages/cli`.


## 2026-08-29 — `fli proves` — the change-to-drive table becomes something that runs

1231 tests, 0 fail. `IDEAS/proof-map.md`, steps 1–3.

`CLAUDE.md` § *Which drive proves a change* is thirty-six rows of the most
expensive knowledge in this repository — each paid for once, usually by a defect
that got through — and it was prose. Nothing read it at the moment somebody had
just changed sierra's router, and nothing checked it, so a row naming a drive
that has been renamed was indistinguishable from a row that is right.

`core/proofs.js` resolves both columns. `run` becomes runnable ids, graded `row`
(pressable) · `script` (a real script that is not a row — `sierra`'s
`test:widgets`) · `file` (a test file, with NO command, because the runner
differs per package and guessing `bun test` for a vitest package is worse than
silence) · `unknown`. `changed` becomes a matcher over a diff, graded `path` ·
`area` · `symbol` · `package`, and **the tier travels with the answer** so a
weak match reads as a weak one.

**The `area` tier is what made it usable.** Four rows name sierra, so a package
match answered *run everything*; the narrowing was already in the rows —
`sierra prerender/islands/static-safety` against `src/build/prerender.js` — so
it is read rather than declared. On a 139-file tree that moved 13 package
matches to 1 path, 3 area and 6 symbol.

**Two rules grade the table itself, and this is the half that paid first.**
`proof-target` (error) — a row naming a drive that is gone. `proof-drive-named`
(warn) — a drive no row names. The first run: zero unresolvable targets, and
**seven drives of twenty-eight that no row named**, `verify:catalogue` and
`verify:tenants` among them, so nobody changing a `File` column or tenancy was
being told to run either. Six rows were written to close them.

**It is not a build graph and must not become one.** `nx affected` and Tilt
derive what to rebuild from what imports what; half these rows are not import
edges at all, and the moment edges are inferred, the rows that are statements
about what a drive can SEE become exceptions to a mechanism rather than the
content.

**`findApps` moved to `core/runnables.js`**, where the other tree readers live —
it had to, because the rules now read the runnable list and two modules importing
each other is a cycle. `checks.js` re-exports it. And `repo-map.js` reads the
proof table through the new parser rather than its own copy: the rendered model
is identical, asserted against the old implementation over the same tree.

**Two small things found while wiring the command.** `context.wsRoot()` is
ASYNC, and an unawaited one reaches `execSync` as a cwd — which fails with a
message about a type, three steps from the cause. And a command's `<script>`
must not import `resolve`: the compiled shim imports `zx/globals`, so it is
already in scope and the redeclaration is a parse error at run time.

## 2026-08-26 — `fli deploy:revert`, and phase 1 of the Release realm is complete

Phase 1f. It reads the journal, restores the pair (Release, Generation), and
refuses by name when it cannot. `core/revert.js` holds the decisions; the swap is
journaled as a `kind: 'revert'` transition of its own.

**The refusals are the feature, and there are six.** The design record predicted
two. A rollback that puts the previous image back and says nothing is what every
other tool ships, and it is wrong in exactly the situations somebody reaches for
it:

    pivot          a deploy since then crossed it            --past-pivot
    retention      it stopped being a target, with the date  --past-retention
    bindings       restores the code and NOT the config      --onto-current-bindings
    no-image       nothing recorded which bytes it ran       no override
    in-flight      a transition is still open                no override
    nothing-prior  this is the first release                 no override

**All of them are reported, never just the first.** An operator deciding whether
to force needs the whole picture; a checker that stops at the first makes them
discover the rest one flag at a time, mid-incident. The three with no flag say so
on the line — *not a judgement call* — rather than leaving it to be found.

**`bindings` is a refusal rather than a fix**, and that is the one the record
under-specified. Serving state is the pair, and `fli` writes no `.env` on a
target — the operator owns that file. So once the generation has moved a revert
genuinely cannot restore the pair; it can only put old code onto today's
configuration, which is the documented Fly failure the generation counter exists
to refuse. `--onto-current-bindings` is the operator saying a different sentence
on purpose, and the journal records which sentence happened.

**`revert` and `rollback` are both kept.** `deploy:rollback` puts the previous
image back with no journal and no questions, and works on a target that has never
deployed through one. `deploy:revert` restores the pair. The second never
silently becomes the first: with no journal it says so and names the other
command, because that degrade is precisely the behavior this phase exists to
replace.

**Two extractions, for one reason.** `swapContainer` and `healthOrRestore` moved
into `deploy/_module.md` and now have two callers each. The going-back path is
the one nobody exercises until the day it matters, so `_steps-revert` calls the
same functions `_steps-docker` does rather than a copy that would be discovered
to have drifted at the worst possible moment.

**The build output is JSON now.** A revert finds its image in the `04-build-api`
output of the transition that put that release into service — the consequence 1e
predicted, since the digest is not a term of the Release under build-on-target. A
row an older `fli` wrote as prose is reported as unreadable rather than scraped: a
revert that ran the wrong bytes is the worst outcome available here.

38 tests. What is still owed is the same debt 1e left — the `deploy` CI phase
gaining deploy → deploy → kill → rerun → revert, which is the stated proof for
both steps.

## 2026-08-29 — `fli dev` refused on ports it was never going to bind

The preflight asked `appPorts()`, which answers **every surface directory that
exists** (Invariant 3). What `fli dev` then runs is the app's own `dev` script.
Those are the same set in a scaffolded app — `fli new` composes every surface
into one `dev`, so the question never comes up — and they are not the same set
in any app in this repo. `example` has five surfaces and a `dev` of
`bun run api & bun run web & wait`.

So a storefront left running on 8610 refused `fli dev` with:

```
  Port already in use:

    8610  site  (bun run dev:site)
```

naming a port nothing the command was about to start would have taken. The
refusal is unactionable in the worst way: it is *correct* that something is on
8610, and stopping it changes nothing about whether `bun run dev` can run.

`devPorts()` is the fix, and it is a second function rather than a change to the
first, because both questions are real: `runnables.js` wants the catalogue, and
the preflight wants what this command binds. It narrows `appPorts()` to the
surfaces the `dev` script actually runs, resolved transitively through its
`bun run` targets.

Anchored on `run`, never on a bare token that happens to name a script — `cd web
&& vite` holds a `web` that is a directory, and an app whose web surface script
is also `web` would match it and reintroduce the bug. A surface matches on
**either** spelling (`api` or `dev:api`), not just the one `appPorts` chose to
print, since an app may declare both and run the other.

**A `dev` that runs no other script is not narrowed**, and that is deliberate:
`fli new` writes `dev` as the surface command itself when there is one surface,
so there is nothing to walk and every surface the app has is one it starts.
Narrowing to nothing there would skip the only check worth making.

Nine cases in `tests/ports.test.js`, including the cycle, the indirection, and
the `cd web` false positive. `FJS-568`.

## 2026-08-26 — the deploy journal executes

Phase 1e of `IDEAS/release-transitions.md`. 1d built the rows and printed them;
these write them, on the target, as the deploy runs. `core/journal.js` and
`core/journal-runner.mjs`, opened by `_steps-docker/01c-journal`, settled by
`09-cleanup`, read by `fli deploy:journal`.

**No new dependency, and measuring the target is what settled it.** This step was
expected to force `packages/cli` to depend on litestone. A deploy target has
docker, nginx, git, **bun**, rsync and sqlite3 — `deploy:setup` installs them —
and `02-pull` leaves a git checkout with **no `node_modules`**, because the build
happens inside Docker. So litestone cannot be imported there. It does not need to
be: the schema stays `db/deploy.lite`, its DDL is now a committed snapshot
(`litestone ddl --schema deploy.lite`), and what ships is that file plus a runner
whose only import is `bun:sqlite`. The `snapshots` CI phase found the new DDL and
began checking it with no CI edit at all.

**The brain is local and the runner is dumb.** Every statement and every verdict
is a pure function in `core/journal.js`; the shipped file binds parameters and
returns rows and decides nothing — the same split `@frontierjs/outpost` makes
with `createDocker({ run })`, and for the same reason. It is also what lets the
suite drive the REAL runner against a temp database rather than asserting SQL as
strings against the author's memory of SQLite.

**Eleven step files became journal rows without being edited.** The hook is on
the step RUNNER: `core/runtime.js` calls `config.journal?.beforeStep/afterStep`
around every step of any command that installs one, and knows nothing about
deploys. A twelfth step is journaled for free.

Three things it decided:

**The recorded Release carries no digest, and must not.** The id is
content-addressed on the digest and these bytes do not exist until step 04 —
minting around one that arrives later would change the id halfway through the
transition it names, so a resume would compute a different id and open a second
row. What step 04 built is that step's output instead. The consequence is worth
stating plainly: resume works BECAUSE the id does not depend on a rebuild being
reproducible, which a build on the target cannot promise. That is a sharper
argument for `2.3f`'s second half than the roadmap made.

**`serving` is the last transition that SUCCEEDED**, not the last transition. A
failed deploy leaves the previous release up. `09-cleanup` settles on both paths
for the mirror reason — an aborted deploy leaves `failed`, not a `running` row
the next run reads as a crash worth resuming.

**`attempt` is answered** — the term `--plan` could only mark provisional.
Counted off the rows by COLUMNS, because the number is inside the id, so asking
by id could only find the attempt you already guessed.

Refusals rather than reconciliation throughout: a journal belonging to another
app or another host, a format written by a newer `fli`, and a precondition that
moved between planning and running each stop the deploy by name. The two answers
came from two intents and picking one is a guess about which person was right.

45 tests, 19 of them against a real SQLite file through the shipped runner.

## 2026-08-29 — `fli check` grades a doc against what the package ships

Two repo-scope rules, `docs-index` and `roadmap-shipped`, both warnings. The
register rules already cover a register that contradicts itself; nothing covered
a page that is merely out of date, which is the same silence one layer over and
is what actually cost a session a day.

**What it cost.** `packages/litestone/docs/roadmap.md` carried *Exact numbers —
`@scale(n)`, then `@money`* under **High priority**, opening *there is no
fixed-point numeric type*, four days after `FJS-D142` ruled and built it.
`docs/README.md` described that roadmap as *what's coming: `@scale`/`@money`*.
And `exact-numbers.md` — the page that answers the question — was linked from
nothing. Three signposts on the path a reader takes, all wrong. A session read
them, concluded `.lite` could not express money, and filed a defect against the
ruling (`FJS-560`). Two more roadmap entries were stale the same way (`@type`,
and half of `@slug`) and two more pages were unindexed (`json-types.md`,
`traits.md`).

**`docs-index`** — every `.md` beside a `docs/README.md` must be LINKED from it,
not merely mentioned: the failure is a page nothing navigates to, and prose
citing a filename does not. A `docs/` with no index is skipped until it holds
four pages, because a directory of one file is not lying to anyone.

**`roadmap-shipped`** — a roadmap section whose fenced sample uses an attribute
`catalog.snapshot.md` already carries. It asks the generated catalogue rather
than carrying a list, for the reason the rule exists: a list here would rot the
way the roadmap did. Scoped to fenced code, because a paragraph may legitimately
cite a shipped attribute in an argument while a sample demonstrating one is
proposing it. Two quieteners, both derived rather than declared — **scaffolding
comes out of the file itself** (an attribute in two sections' samples is holding
them up rather than being their subject, which is `@id` in every `model` block,
and without it the `Embedding` and `LatLng` entries both fired on it), and a
heading carrying `~~`, `SHIPS` or `SHIPPED` has already answered, since an entry
may legitimately propose the unbuilt HALF of something that ships.

Both were run against the tree before the docs were fixed and fire on exactly
the three stale sections; after, the file is silent and a restored section still
fires. `docs-index`'s other finding was real: `packages/basecamp/docs` held four
pages and no index.

## 2026-08-28 — a generated create page and a generated edit page stop carrying a form each

1144 tests, 0 fail. `FJS-559`.

The Resource's markup half is the model's default form (Invariant 18,
`FJS-D112`), and `core/resource-template.js` has emitted one since it existed —
its own header tells a create page it can be `<Model />` and nothing else. It
could not be. The wrapper was `<Form ...><slot /></Form>` with **no button
anywhere**, so that page put five controls on screen and no way to send them,
and a page reaching for `<Model><Button slot="actions">` did not fix it: that
names a slot on the wrapper, which forwarded none, so the button was swallowed
in silence. Measured in a browser, both shapes, before anything changed.

Meanwhile `core/crud-templates.js` — written first — went on emitting its own
`<Form {resource}>` on the create page **and** on the edit page. That is the
form written twice in the two files most likely to drift, inside the module that
exists because those two commands had already drifted once.

**The wrapper now carries the button row**, because a form with no submit is not
a form. What a PAGE knows is the wording, where Cancel goes and where a save
lands, so those are props — `submitLabel`, `cancelHref`, `oncancel`, `submitId`,
plus `record` and `method`. Everything else rides `$attributes` onto `<Form>`,
which is where `ondone`, `onerror`, `showError`, `class` and `style` are
declared. A page needing an entirely different row — the edit page, which puts
Delete beside Save — passes an `actions` snippet, forwarded explicitly, because
`<Form>` checks the `actions` prop before its own slot.

**Both pages render `<Model />`.** The create page states `method="create"` and
where to go afterwards; the edit page states nothing but its button row. Neither
names a field, and now neither names a form.

Proven by scaffolding the real generator output into `example` and opening both
pages in Chrome: create renders five schema-derived controls with *Create
Product* and a Cancel link, edit renders the same five over a loaded record with
Save and Delete. Two tests in `make-resource.test.js` replaced — the old pair
pinned `auto={!$slots.default}` and `<slot />`, the mechanism that produced the
buttonless form.

## 2026-08-27 — `project:view` says whether the app it maps is running

1112 tests + 21 browser assertions, 0 fail. `IDEAS/control-surface.md` step 6,
which completes the paper's build list.

The viewer is read off FILES, so it drew a complete chain of responsibility for
an app that is not started and looked identical either way. It carries a live
badge now — the app's surfaces and their state, polled, with the ports in the
title because a person reading that map is about to go and open one.

**Answered by the command's own server, not fetched from the app.** A browser
reaching `localhost:8110/api/health` from the viewer's origin is a cross-origin
request the app has no reason to allow, and a CORS failure would read as *the
app is down*.

**One owner for the probe.** `probeState(rows, { childOf })` moved into
`core/runnables.js` and both servers call it — the GUI's `/api/state` and
`project:view`'s `/state` — so there is one answer to *is it answering* rather
than two that can disagree. It takes rows rather than a root, and the child
lookup is passed in, because `project:view` starts nothing and must not import
a table of processes to ask whether an app is up.

**The badge is the app's own surfaces and not the tooling block.** `fli gui`
being up is not a fact about the app this page maps, and putting it in the badge
would make the badge mean two things.

**The tools group needed no work, which was the point.** It has been derived
from `ports.js` § GLOBAL since the inventory shipped, and the test says so the
only way that claim can be made: a slot added to that object becomes a tile with
nothing edited in `runnables.js`, answering `start: null` because no command
declares that port. `FJS-557` stays open and is visible on the page — studio's
tile has no start command because its command defaults to 5001 while the schema
reserves 8502.

**`tests/pview-state.test.js` boots the real command**, because the thing under
test is the WIRING — that the route exists, that it resolves `runnables.js` from
`fliRoot`, and that its shape is the one the badge reads. Each of those is fine
in isolation and can still be absent from the command file. It spawns, so it is
careful with what this week taught: a test-tier port, a bounded wait, and a kill
of the process GROUP.

## 2026-08-27 — the dashboard starts a row, and refuses to stop one it did not start

1107 tests + 21 browser assertions, 0 fail. `IDEAS/control-surface.md` step 5.

`core/children.js` is the table: `POST /api/start/:id`, `POST /api/stop/:id`,
`GET /api/output/:id`, and a kill on the way out.

**The caller sends an ID and never a command.** What runs comes from the
inventory, which comes from a file in the tree — so a request can choose among
the project's own declared commands and cannot name one of its own. Every row
carries `argv` rather than a string to be re-split, so there is no shell and no
parser between the file and the spawn; two runners are allowed, `bun` and `fli`,
and `fli` is rewritten to this package's own `bin/fli.js` because a globally
installed one of a different vintage driving this tree is the drift a pin
removes. Anything else is refused BY NAME with the line to type, which is the
honest answer for a snapshot generator: those resolve through their own package,
they are one-shot, and `fli test:snapshots` already runs the set.

**The stop refusal is the design.** This server stops what it started and says
so about anything else — *started elsewhere* on the row, and a 409 naming why
from the route. A page that offered otherwise is a button that kills a process
somebody else is depending on.

**A child is its own process group, and that is not a detail.** Every command
here is a launcher — `bun run api` is bun running a script that spawns the app —
so signaling the pid kills the wrapper and leaves what it started running. It
was measured the expensive way: the first cut of the HTTP test started the first
`bun` task it found, which in this package is `bun run test`, and the suite ran
itself; stopping it reported success and left a tree of suites forking until
they were killed by hand. For a server the same shape is quieter and worse —
stop answers 200 and the port keeps answering. `detached: true` and a `-pid`
kill, with a fallback to the child alone for a spawn that has no group.

**A child that dies is remembered as exited**, with the code and the last 60
lines, because a row that goes back to *not running* reads as never having
started — a server that dies two seconds after you press start is exactly the
silent failure this surface exists to reduce.

**Two things the work found and fixed.** Snapshot rows were joining `dir` to a
`file` that is already a path from the root, so every snapshot id and source
named `example/db/example/db/access.snapshot.md` — a path that resolves to
nothing, which reads as a snapshot that has gone missing. The fixture-based test
could not see it, because a fixture tree has no snapshots and no packages; there
is a real-tree case now. And the browser drive's own assertions were twice about
the ENVIRONMENT rather than the rule — *no open links are offered* and *the gui
tool reads as down* both failed on a machine with things running on it. They
assert the rule now.

## 2026-08-27 — the GUI's front page is a dashboard of what can run

1089 tests + a browser drive, 0 fail. `IDEAS/control-surface.md` steps 3 and 4.

`fli gui`'s front page was an empty state saying *select a command*. It is now
the answer to the question this whole paper is about — what can I start here,
and what is already up — because the complaint is that there are too many things
to keep track of and a fifth server on a fifth port would make it one worse.

**Two endpoints with two lifetimes.** `GET /api/runnables` is the inventory, a
tree walk cached on the same TTL the command registry already uses; `GET
/api/state` is the probe, polled every three seconds while the page is on
screen. They are apart because only one of them misleads when stale: a stale
inventory shows a row that has been renamed, a stale state shows a server that
is down as up. A poll rather than SSE, because there is no event to push — a
port somebody else bound is a question somebody has to ask — and the tick is
printed, since a reading with no time on it cannot be told from a live one.

**Four states and `unknown` is one of them.** A row with no port cannot be
probed, and *nothing here can tell* is a different sentence from *not running*;
collapsing them makes every drive and every suite read as stopped.
`claimed-dead` is a lock claim over a port nothing answers, which is the failure
the lock file already exists for.

**The page shows and opens; it does not start.** A row hands over the command to
type. Starting one is a separate step with a process table behind it, and an
open link is offered only where a row is answering — a link to a port nothing is
listening on is a browser error page wearing this page's name.

**It composes the design system rather than styling itself** — `.surface`,
`.rows divided`, `.list-row`, `.row-actions`, `.badge`, read out of
`@frontierjs/css`'s `vocabulary.json` and its `anatomy` block rather than
guessed, since a class nothing defines is markup that looks styled and is not.

**`bun run test:browser` is this package's first browser drive**, over mesa's
CDP harness by relative path, the way `@frontierjs/ui`'s drive reads it. Ten
assertions, two mutation-checked. The page had never been rendered by anything —
`tests/server.test.js` covered the API under it — and a dashboard is the worst
thing to leave that way, because a row that renders as nothing looks exactly
like a project with nothing in it. **Its first run corrected an assertion rather
than the page**: *no open links are offered* expected zero and found two, which
were `example`'s api and web genuinely running on this machine. It asserts the
RULE now — open is offered exactly where a row is answering — which is the half
that survives a developer having things up.

## 2026-08-27 — `core/runnables.js` — what can run in this project, one flat list

1083 tests, 0 fail. The inventory half of `IDEAS/control-surface.md`, step 1.

92 rows on this workspace — 9 surfaces, 4 tools, 28 drives, 21 suites, 6 tasks,
24 snapshots — each `{ kind, id, name, dir, start, port, open, needs, source }`.
`source` is not decoration: it is `repo-map.js`'s own rule made checkable, so a
wrong row is traceable to the file that produced it rather than to this module.

**It is a factoring and the proof is byte equality.** `SKIP`, `safeRead`,
`isDir`, `readJson`, `appDirs`, the drive scan and the command reader moved here
and `repo-map.js` imports them — 5 insertions against 67 deletions — and the
rendered map is byte-identical to the one the old file produced over the same
tree. Two answers to *where could an app be* is how one of them starts missing a
directory nobody notices.

**Which command starts a reserved tool is derived, not listed** — a command's
own `port` flag default matched against `ports.js` § GLOBAL. A hand-written
name→command table would be the one list in the module that could go stale, and
the derivation has a second virtue: a slot no command claims answers `null`
rather than a plausible guess. Junction's devtools is honestly one of those (an
APP configures it), and studio is the other — its command defaults to 5001 while
the schema reserves 8502, which is `FJS-557`, found by this.

**The command tree is read from a ROOT rather than through the registry**, which
resolves its directories off `global.fliRoot`. A module that may run before
install cannot depend on a global somebody else set.

Two things are deliberately not rows and the reasons are in the header: commands
(the GUI's sidebar already answers them off the registry, and a second list of
the same 236 things is what this module exists against) and CI phases
(`scripts/ci.mjs` has no per-phase flag, so a phase tile could only ever run all
twelve — the runnable is `bun run ci`, which is a task).

## 2026-08-27 — a tsconfig for the surfaces the app actually has

`appTsconfig` wrote `paths: { '@/*': ['./web/src/*'] }` and included
`api/**/*` and `web/**/*`, whatever else the scaffold had been asked for. A
`fli new --site` or `--widgets` app got an `@` pointing at a `web/` it does not
have and a tsconfig that did not include the code it does.

It takes every surface flag now and lists them in a fixed order, first match
wins. That is exact for an app with one UI surface and a **guess** for an app
with two, and the guess is stated rather than hidden: `@` is the surface's own
`src/` because Sierra resolves it per Vite root, and tsc has one program and no
notion of a root. It costs nothing — `checkJs` is off and tsc cannot read a
`.mesa` at all — and the alternative is a tsconfig per surface, four programs to
check what is one app.

## css-token-undefined — a styled value names a token the stylesheets define

The thirty-second rule, and the first one about CSS. A `var(--x)` naming a token
nothing declares is invalid at computed-value time, so the browser drops the
**declaration** rather than the value — `gap: var(--space-4)` is no gap, not a
wrong one. Nothing reports it: the stylesheet is in the bundle, every selector
matches, and a browser drive asserts what a page says. `example/site/` shipped
its entire public storefront with no gap, border or radius anywhere while
`verify:site` stayed green at 39/39 (`FJS-545`).

The token table is read off the app's own dependencies — any package whose
`exports` names a `.css` — for `package-model-drift`'s reason: the answer is a
property of what is installed, and a list written into the rule goes stale the
first time a package adds a rung, while an app on a design system this file has
never heard of would be graded against one it does not have.

**Only the bare form is a finding.** `var(--knob, var(--color-primary))` is an
author saying the token may be absent, and is what a component's own knob looks
like from outside; nothing is dropped, so nothing is reported. That single line
is what separates the defect from the idiom, and it is why the rule can be an
error rather than a warning.

## 2026-08-26 — `--plan`: the journal rows, printed instead of inserted

Phase 1d of `IDEAS/release-transitions.md`. `fli deploy:plan` and `fli deploy
--plan` build the rows `db/deploy.lite` would receive — one `Transition` and one
`TransitionStep` per step — and print them. Nothing is written, no server is
reached, and it exits 0 whatever the pivot says: a plan is a document, so there
is nothing for it to refuse.

It is the same object either way. The model carries the plan on the transition
itself, so the document a person read and the record a deploy wrote cannot be
two things that disagree — `core/plan.js` builds them and 1e will insert what 1d
prints.

**The steps are read, not listed.** They come from `_steps-docker/` with the
runner's own filter and sort, and each `skip:` predicate is evaluated the way the
runner evaluates it — including its fail-open direction, so a predicate that
throws is reported as *it will RUN* rather than silently removed from the plan. A
step added to the pipeline appears here with nobody editing the command. A
skipped step is shown rather than dropped: an operator needs *the backup did not
run* to be visible, and the ordinals have to stay stable so a resumed transition
can find where it stopped even after a `skip:` has changed its answer.

**The transition id, and the one term a plan cannot answer.**

    deploy:shop:production:none:a1b2c3d4e5f6:1:1
     kind  app  environment  from  to  generation  attempt

`from → to` is what lets a crashed deploy resume — rerunning computes the same id
and finds the same row — while keeping R1→R2 and R2→R1 apart. `generation` is
there because a rotated secret is a new intent, not a replay. `attempt` is the
journal's count of prior transitions for that pair, and **a plan has no journal
to count**, so it says `1` and labels the id provisional. The case it exists for
is deploy R2 → revert to R1 → deploy R2 again: every other term is identical to
the first attempt, so without a counter the third operation resumes a transition
already marked `succeeded` and leaves R1 serving. Surfacing that before 1e writes
a row under it is what `--plan` is for.

Also here: the duplicate-prefix warning now matches `\d+[a-z]*` rather than
`\d+`, so `01b-env-check` beside `01-preflight` is no longer reported. A lettered
step is the deliberate way to insert one without renumbering the rest, and a
warning that fires on every correct use is how everyone learns to ignore it.

46 tests, pure.

## 2026-08-26 — the build check: can this image be promoted, or only deployed?

Phase 1c of `IDEAS/release-transitions.md`, and the half `core/image.js` left
open. That module made a deploy able to say WHICH bytes it ran. This is whether
those bytes mean anything in a second environment — invariant 1 of the Release
design: one artefact moves from staging to production unchanged, and only its
bindings differ.

A build that bakes configuration into the image breaks that silently. The result
still builds, still starts, still answers health, and still reports a digest. It
is simply a different digest per environment, and nothing says so. Measured, on
two contexts identical except for a `.env.production`:

    stage       sha256:dfa9655f267c02…    DIFFERENT — configuration is in the digest
    production  sha256:32ab9ba5e266f8…

and the negative control, the same two trees with `.env*` ignored:

    stage       sha256:fa3ecac547cb08…    IDENTICAL — one artefact serves both
    production  sha256:fa3ecac547cb08…

`core/build-check.js` grades four things: a value file the build copies, an `ENV`
line holding a value the environment is meant to supply, a build `ARG` naming a
credential (measured: one `--build-arg` left the value in two `docker history`
lines), and an unpinned base image. The base is graded twice — no tag or
`:latest` refuses, a version tag warns — because `oven/bun:1` is what this
package's own `make:deploy` writes, and a check that refuses its own scaffold is
a default whose first use is red.

**The first version of the context rule was wrong, and measuring is what caught
it.** Grading a file as baked the moment a context COPY reached it refused every
multi-stage build in this repo: two trees whose `.env` differed, copied wholesale
into a build stage whose runtime stage takes only `dist/`, produce a
byte-IDENTICAL final image. The question is therefore not *did a COPY reach it*
but *does it reach the FINAL image*, which is a walk across stages —
`COPY --from=build /app /app` ships what `COPY --from=build /app/site/dist ./dist`
does not, and both forms are here. The intermediate case is a warning rather than
silence, because the value does sit in a layer on the build host, readable with
`docker build --target build`. The trace was then graded against the daemon on
four shapes and two files at two depths: 8 of 8 agreed, and those eight are the
fixtures in `tests/build-check.test.js`.

**It is not a `fli check` rule**, which is what the design record proposed. That
surface reads the app's own tree, and the file most likely to be baked is the one
deliberately in no repository: `.env.production` sits at the deploy root, which
IS the build context. So `_steps-docker/02b-build-check` reads the server, after
`02-pull` — before the pull the server's Dockerfile is the previous release's —
and refuses. `deploy:local` reports instead, because that command answers *does
this build and start at all*; `deploy:doctor` asks without deploying anything.
`deploy.api.buildCheck = false` opts out, beside the `envCheck` already there.

It found a live one on its first run. Docker's `*` does not cross a separator, so
basecamp's `db/*.db` excluded `db/basecamp.db` and admitted `db/db/basecamp.db` —
and `db/db/` is precisely what a relative `database { path }` resolved against the
wrong working directory creates (`FJS-449`), git-ignored and therefore in no
diff. `COPY db ./db` then `COPY --from=build /app /app` put it in the image.
Pattern fixed, `FJS-555` filed for the rest.

The suite is pure — no daemon, no network, no fixtures on disk — because a check
that needs Docker is a check that stops running. 66 tests.

## 2026-08-26 — `service-as-system` reads all of `services/`, not just `*.service.*`

A filename filter made two real sites invisible. A helper module beside a service
runs in the same call scope and carries the identical hazard — basecamp's
`api-keys/scopes.ts` reaches for the app-level client from inside a hook, and
`jobs/job-schedule.ts` does it at boot — and neither is a `*.service.ts`, so the
rule had never looked at them.

The DIRECTORY is the principled boundary rather than the filename: anything under
`services/` runs inside a call, and a job handler lives in `jobs/`, is not inside
one, and is exactly where the app-level client is the right reach. Both newly
visible sites turn out to be correct and now carry named allowances saying why,
which is the point — an invisible site is not a decision anybody made.


## 2026-08-26 — `fli check`: `capability-ladder`

A model that declares `@@capabilities` and still grades its writes by ladder. The grid
and the gate are ANDed with the gate as the floor (`FJS-D146`), so a write level above
the read level is the ladder answering what the grid was declared to answer — and both
have to pass, so every grant is silently narrowed. The shape it catches is a model
moved onto capabilities with its old gate left in place: a billing clerk holding
`Invoice.create` refused because creates want ADMINISTRATOR(5), which reads as *not
senior enough* about somebody deliberately granted the capability.

**It reads both gate spellings.** Matching only `@@gate("2.5.5.6")` would have made
the rule silent on every schema that writes its levels by name — which is the form
`example` and `basecamp` both use, so it would have been dead exactly where it
matters. `write:` widens to create/update/delete and `all:` to every position, the
same way the parser treats them.

A warning rather than an error — two authorities in front of one operation is
legitimate where the ladder guards something the grid does not model, and a text scan
cannot tell that from a leftover. `@@gate("2")` flat at the read floor is the usual
answer. The clean fixture now declares the grid with a flat gate so the rule RUNS there
rather than skipping.


## 2026-08-26 — digest, not tag: a deploy can say which bytes it ran

`2.3f`'s first step (`IDEAS/deploy-plane.md`). The pipeline builds on the target
and names the result `${appId}:${shortSha}` from the SHA of that server's own
checkout, so **two servers at one commit hold two images with the same name and
different bytes**, a rebuild after a dependency change produces a third, and
nothing compared them. The failure shape was the worst available: stage and
production reporting one version while running different code.

**Docker has two digests and they do not reach equally far**, which is the whole
substance of `core/image.js`. `RepoDigests` is the registry digest and means the
same bytes anywhere, but exists only once an image has been pushed or pulled;
`Id` is the config hash and always exists, and identifies bytes on **one host**.
A build-on-target pipeline has no registry, so `Id` is what there is — and
reporting it as though it were the other is how the problem comes back wearing a
fix. So the scope is in the sentence: *these bytes on this host; no registry to
compare across*. Same line `@frontierjs/outpost` draws about building on the
target — an answer that is true while there is one machine and stops being true
at the second.

**Step 04 asks the image what it is and step 06 runs that**, falling back to the
tag only when nothing could be read and saying so when it does. **Rollback got
the sharper end**: it listed images by `Repository:Tag` and took the second row,
so it rolled back to a NAME — and two tags can point at one image, from a
rebuild that produced identical layers or a moved tag. The list carries `{{.ID}}`
now, the container is addressed by it, and a rollback whose target is the same
image is refused by name: *both tags name the SAME image — this rollback would
change nothing*.

`imageIdentity` answers `null` rather than guessing, because the entire point is
that two things which look alike are not.

## 2026-08-26 — `fli release:mint`: a Release is computed, and nothing is deployed

Phase 1b of `IDEAS/release-transitions.md`. `core/release.js` computes a Release
from four terms — the image digest, a hash over the resolved bindings, a hash of
the committed release surface, and litestone's pivot verdict — and the id is the
hash of those and of nothing else.

**That the id is a pure function is the whole point, not a property of the
step.** Two mints of an unchanged tree answer the same id, proved against
basecamp: `2997a04e6063` twice. *Build once, promote a digest* is only a sentence
you can say if the thing being promoted has a name that does not depend on who
computed it.

**The environment is deliberately NOT in the id.** One artefact promotes from
staging to production unchanged and only its bindings differ, so the environment
is on the row and the bindings are in the hash. If that ever flips, promotion
becomes a rebuild — which is why it is a test rather than a comment.

**The schema term is the committed `release.snapshot.md`, hashed rather than
re-derived.** It is exactly what `fli release:check` classifies and what the
`snapshots` CI phase already fails a stale one of, so re-deriving it here would
be a second answer to *what is the data boundary of this release* that could
disagree with the first.

**Bindings are declared in the deploy block, values and secret REFERENCES kept
apart** — `deploy.bindings` and `deploy.secrets`, per-target beating app-wide. Two
keys rather than one bag because the rule is not a convention to remember: a
value is in the repository and a reference points at something that is not. An
unpinned reference is refused by name, because a secret is resolved when a
process starts and `latest` means two instances of one immutable Release hold
two different values.

The digest is usually absent and says so rather than showing a tag: `fli deploy`
builds on the target, so `${app}:${sha}` names different bytes on different
hosts. `2.3f` supplies it.

Writing it turned up `FJS-537` — `context.exec({ capture: true })` is not an
option, so four auth commands parse an empty string and print `Failed` directly
beneath the output they meant to read. `release:mint` reached for the same
option because four neighbors use it, which is how a wrong idiom spreads.

## 2026-08-26 — `register:check` catches a register that stopped counting, and `detail-read-dead` names its own limit

**`closed-in-open`.** A row carrying `status: closed` while still sitting in an
open severity table is counted as open by everything that reads the register —
its own tally, `ws:map`, `ws:atlas`, and whoever is choosing what to work on.
Sixteen had accumulated in this repo, one of them the only S1 (fixed two days
earlier). `closed` is in `ISSUE_STATUS` because the READER synthesises it for
every row under § Closed, which is exactly what made it silently legal as a
hand-written cell where it means the opposite.

Its own rule rather than an `unknown-status`, because the remedy is not *you
wrote a bad word*: the row is correct and it is in the wrong place. It is the
direction `ISSUES.md`'s own Conventions section already names — *the register
also goes stale in the closing direction, which nothing here was watching for*.

**`detail-read-dead` now says when its advice applies.** It told every reader of
`service.get(id)` to watch the row instead, unconditionally. A store node holds
one shape and a push REPLACES it, so that is only correct where the detail row IS
the row: four of basecamp's composed reads (`include:`, a `withWidgets()`, an
adapter ping that answers no row at all) lose their children at the first
announcement, silently. Measured — adopting it on `apps/[id]` took that app's
drive from 302/302 to two failures. The message names the condition and says the
reload-on-push those screens hand-roll is a fair exception.


## 2026-08-26 — `db/deploy.lite`: what a Release is, before anything deploys one

The first step of the Release realm's phase 1 (`IDEAS/release-transitions.md`),
and it writes nothing and deploys nothing. Five models — `Journal`, `Release`,
`BindingSet`, `Transition`, `TransitionStep` — carrying every field including
the ones nothing fills yet: `audienceKey`, `retentionUntil`, `formatVersion`.
That is the sequencing rule the record is built on, *state shape early,
behavior late*, and the reason is that a recorded-state migration is the
expensive kind of change while an unused column is free.

**It is opened, not installed**, which is the whole of how it differs from
`junction/db/outbox.lite`. That one is pasted into an app's schema and carries
`@@db(main)`; this one is handed to `createClient({ schema, db })` with `db`
naming `deploy.db` on the target, so there is no `database` block to reference
and the same line fails to parse. Found by running it, not by reading — and it
is now asserted, because nothing in the fragment says *no `@@db` here*.

**The journal is its own client rather than a second `database` block on the
app's, and both grounds were measured.** `$locks` stores in main only, so under
a second block the deploy lock lands in the app's database while `deploy.db`
gets no `_locks` table at all — the lock cannot sit with the record it protects.
And `$backup` sweeps every declared SQLite database, which is the copy
`05-backup` takes before every deploy, so restoring it would erase the journal
recording the deploy that authorized the restore. Both are asserted as a
negative control, so the rejection fails loudly if litestone ever moves either.

Two things came out of writing it. Lock contention **throws** rather than
answering falsy — `LockNotAcquiredError`, 409, `retryable`, naming the holder,
which is already the *refuse by name* shape `fli revert` wants. And the CHECK
family turned out to be half-built (`FJS-534`): field-level `@check` works, so
`Journal`'s single-row rule IS declared — `@check("id = 'journal'")` plus the
primary key, two constraints saying one rule — while model-level `@@check`,
which would say it in one line, does not exist.

## 2026-08-26 — `detail-read-dead`: a row a screen KEEPS is watched, not fetched once

`service.get(id)` answers a plain object. It is the raw proxy by design — the
same escape hatch `service.find()` is — and nothing can reach a plain object:
not a WS push, not a write from another tab, not a job. So a screen that assigns
one to state it keeps is stale from the moment somebody else writes that row,
and it looks right the whole time, because a screen usually re-reads after its
own actions and never after anyone else's. That was every detail screen in this
repo (`FJS-518`), and `resource.record(id)` is the answer (`FJS-D138`).

**The heuristic is a bare assignment**, and the negative controls are what make
it usable. `order = await …` in a Mesa script is an outer `let`: state the
component keeps. `const row = await …` is a local — a label, a check, something
handed straight on — and flagging those is how a rule gets turned off. A
comparison is not an assignment at all. `X.service.get(…)` is the whole test for
*is this a resource*: `.service` exists on nothing else and every resource has
`record()`, so there is no binding to trace and an imported resource is judged
like one made in the file.

It follows a wrapped ternary back up to three lines, because
`x = cond ? await …get(id) : null` is what every one of these screens actually
writes and matching only the line the call sits on missed them.

**A warning, and it fails open** — a screen may legitimately keep a row nothing
will ever write again. **No `--fix`**: the change is a subscribe, a release and
a lifetime, and a half-applied one is a green check over a leak.

Its first run reported **sixteen**, every one inspected and real: one in
`example` and fifteen in `basecamp`, including three dashboard widgets and the
fleet screens where the row genuinely moves mid-deploy. The screen already
converted to `record()` is silent, which is the rule's own negative control.
Seven cases in `tests/checks.test.js`, and `CLEAN` grew a legitimate one-shot
read so the rule RUNS over the clean tree rather than only ever skipping.

# Changes

## 2026-08-26 — `service-as-system`, the 29th rule

`asSystem()` keeps the tenant it is standing in now (`FJS-519`), which makes
*which client you elevate* decide whether the answer is scoped at all:
`ctx.locals.db.asSystem()` crosses the gate and every policy and stays in the
caller's tenant, `app.data.asSystem()` has no principal, so no claim, so every
tenant — with a 200.

**The app-level client cannot be named positively.** It is `app.claim(<any
name>, db)`; basecamp calls it `app.data` and another app will call it something
else. So the rule tests the other direction — a receiver that is not the
request's client — which is also where the fix is. A cast does not hide it:
three of basecamp's sites are `(app.data as any).asSystem()`, read backwards
through the parens.

**A warning rather than an error**, because an unscoped system client is exactly
right for a cross-tenant admin tier. What is wrong is reaching for it by habit
inside a request, where the symptom is silent.

**It runs only under `strategy row`.** With no `tenancy` block there is no claim
to lose, and under `strategy database` one client IS one file, so a system
context cannot physically reach a second tenant — `example` is that case and is
skipped by name rather than reported at.

Writing it found the trap `fli check` blanks comments for, one file over:
basecamp's own schema explains the feature in a doc comment — *declared once in
the `tenancy { }` block below* — and an unblanked match reads that empty pair as
the declaration and skips the entire app. Seven tests. The clean fixture now
declares row tenancy so the rule RUNS there rather than skipping, which is what
the suite's own *nothing was skipped* assertion is for.

Fourteen findings on basecamp, entered as named allowances: eleven files
deferred to `FJS-519` part 2, and the hub's, which does not expire.

## 2026-08-25 — `transition-methods`, the 28th rule

A named move is written in two places that never meet — `@@transitions` in the
seed, and the code that makes the move — and both directions fail quietly
(`FJS-502`). The rule reads the schema and the whole of `api/`.

**A declared move nothing drives** is the silent half. Not an error: the machine
is still enforced, and an aspirational pipeline is a legitimate thing to have.
It reads as a feature nobody got round to, which is why it is a warning that
names the move rather than a failure. **A `transition()` naming no declared
move** is the other half, and it throws `TransitionNotFoundError` (400) the
first time somebody asks for it.

**Reachable means either spelling, and that is the whole of the accuracy.**
`transition(id, 'cancel')` and `update({ data: { status: 'cancelled' } })` are
the same move. The name-only version was written first and measured: it reports
eleven of basecamp's nineteen moves and is wrong about eight. Asking for either
reports three, and all three are real — `Deployment.push -> pushing`,
`release -> deploying` and `rollback -> rolled_back @gate(5)` are declared, the
pipeline goes pending → building → success, and three screens carry a tone for a
state that cannot occur. `example` is clean.

The two spellings are not symmetrical, and writing a test the wrong way round is
what found it: `transition()` resolves a move NAME, so `transition(id, 'closed')`
throws where `update({ status: 'closed' })` works — unless the move is unnamed,
since `pending -> paid` names itself after its target.

Ten tests. `Lead` in the checks fixture now carries a machine, because a rule
that only ever skips is what that file exists to catch.

## 2026-08-25 — `make:extension` derives its port, and writes its own ignore

Found scaffolding `example`'s `extension/` surface (`FJS-280`).

**The dev port was the literal 8400.** That is dev/ext/project-0 — right for a
fresh scaffold and wrong for every app that has a number, so two apps' extensions
could not have their dev servers up at once and jetty's reload push would reach
whichever bound first. It is derived now, from `projectIdFor` + `port('ext')`,
which is what `make:widget` beside it already did.

**The surface writes its own `.gitignore`.** `dist/` is the loaded-unpacked
artefact and `.jetty-cache/` is where the build puts the entries it generates
from what it discovered; without this every app commits a compiler's scratch
directory. Written as the surface's own file rather than merged into the app's,
because a merge has to decide what to do with a rule already there and this
cannot be wrong.


## 2026-08-24 — `package-model-drift`, and it found three things on its first run

`FJS-483`. 848 tests, 0 fail (+7). The twenty-seventh `fli check` rule, and the
first to read a DEPENDENCY's source rather than the app's.

A package that ships `.lite` reaches an app two ways and they are not the same:
some files are imported, and some are appended into the app's own schema to be
grown. `@frontierjs/auth` ships one of each — `User` is the model an app adds
columns to, `Credential` is not. So *the app declares a model a package also
declares* fires on every correct install, and the issue was filed concluding a
package needed a new way to say which file is which.

**It does not.** What is decidable is a column THE PACKAGE DECLARES, declared
differently here. Adding a column is what an app is for; adding `@@tenant(none)`
or a policy is the app's business too; changing the package's own column is the
class that costs something, and it is silent by construction — the package's code
goes on writing to a column whose declaration it no longer recognises. No
manifest key, no language change, no parser: a line scan over a file in
`node_modules`, reached through that package's own `exports` map.

A **warning**, not an error, and both declarations are printed — a deviation can
be right, and the reader is the one who can tell. `check-baseline.json` is how an
app accepts one it has argued for.

**Its first run on basecamp found three and closed all three**, one of them in
the package rather than the app: `User.emailVerified` and `User.role` had lost
`@allow('write', auth().isAdmin)`, on a model gating update at USER(4) for *your
own row* — latent, since basecamp exposes no `users` service, and real the day a
profile screen writes through one. The third was `accountId`, where AUTH was
wrong: it shipped `Int?`, and every id that package declares is a uuid, so the
column could not hold one and the only app that reached for it had to change the
type. It ships `String?` now.

Mutation-checked both directions — never comparing, and comparing the app's
columns instead of the package's (the false-positive shape) — each turns the
suite red.


## 2026-08-24 — `test-files-run` asks for an importer, not an extension

`FJS-482`. The rule flagged a `*.test.*` file no script names, and looked past
everything else in the directory. jetty's HMR coverage was two `.mjs` harnesses
sitting in `test/` that no script ran and that could not have run — they
resolved mesa by an absolute path from another machine — and they were the only
cover for the seam `FJS-481` broke.

Widening it to every runnable extension immediately broke the case the rule
already had: *a harness beside the tests is support code, not an unrun test*.
Which is correct, and names the real signal — **support code is IMPORTED**. So a
non-`.test.` file is an orphan only when nothing runs it AND nothing beside it
imports it. Unimported and unrun is indistinguishable from dead.

That case's fixture left its stub unreferenced, so it did not model what its own
name claimed; it imports it now, and a second case covers the dead-harness shape
directly.

## 2026-08-24 — two checks that caught this package

847 tests, 86 of them new — 13 of which had been sitting on disk unrun.

**`test-files-run`** (repo scope) — a hand-listed `test` script graded against
the `*.test.*` files beside it. It found `packages/cli`'s own: **`tests/pipe.test.js`
and `tests/generated-mesa.test.js` were run by nothing**, and the first of those
is the file `CHANGES.md` cites as reproducing `FJS-379`. A test written to pin a
fix, never once executed, in a suite that was green every time. Both pass; both
are in the script now.

Only where the script NAMES files — `vitest`, `jest`, `node --test` and a `bun
test` pointed at a directory all walk it themselves and cannot forget one, which
is the argument for that shape rather than for this rule. A `:watch` script is
not read (it is the bare runner by nature, and reading it would make every
hand-listing package look like it discovers), and only `*.test.*` counts: a stub
or a client beside the tests is support code, named by whatever imports it.

**`tests/docs.test.js` + `core/doc-commands.js`** — every `` `fli <command>` ``
named in a reference doc must resolve against the registry. `IDEAS/` is not
graded, because an idea paper names commands that deliberately do not exist;
neither are the registers or CHANGES, which are argument and history. What is
graded is what tells you to run something: a README, a CLAUDE.md, a command file
naming a sibling.

Four real finds, and the sharpest was not in a doc: **the message an EMPTY
WORKSPACE prints told you to run `fli ws-init` and `fli ws-add`**, and the
aliases are `ws:init` and `ws:add`. The one moment the tool speaks to somebody
who has nothing set up, it named two commands that do not exist — in
`workspace/status.md`, `workspace/list.md`, and `workspace/add.md`'s own
`examples:`, which `--help` prints. `@frontierjs/notifications`' README told you
to run `fli add notifications`, which has never existed; its install section now
says to add the model it shows you.

Three resolution rules and the second two are why this is not a set lookup: a
NAMESPACE (`fli make`) is a writer naming the family, and a BUILT-IN (`fli list`)
is answered by `bin/fli.js` and has no command file — read from
`NO_PROJECT_NEEDED` rather than restated, so the next one is not a false positive
nobody can explain. Two allowances, each a named entry with a reason, and a stale
one fails the test.

Writing it cost one defect of its own, worth stating: a lookahead that refuses
only `:` **backtracks**, so `` `fli root:` `` — a log LABEL in a template
literal — was reported as a missing command called `roo`.

## 2026-08-24 — eleven rules that read the app's own source, `--fix`, and the ratchet

823 tests, 62 of them new. `IDEAS/diagnostics.md`'s live-hazard catalogue
starts executing, and it executes **inside `fli check`** rather than in a new
command — ruled `FJS-D133`, because `fli doctor` already exists and means *can
this machine run fli*, and a scaffolded app's `bun run check` already calls the
other one.

Everything the idea listed as *what would have to be built* was already here —
ids, two severities, `--list`, `--json` with a non-zero exit, an allowance that
is a named entry with a reason. What was missing was the rules.

- **`raw-route-param`** — `app.get('/orders/:id')` registers `:id` as a literal
  segment, so the route answers that path as typed and 404s on every real
  request. The finding carries the rewrite.
- **`ctx-params`** — there is no `ctx.params` in Junction. It reads `undefined`,
  so a role check written on it passes for every caller.
- **`set-auth-discarded`** — `db.$setAuth(user)` as a statement scopes nothing:
  the writes after it go through the unscoped client and every row policy
  compares against a null principal. Only a whole statement is judged, so
  `const scoped = …` and `db.$setAuth(u).order.create(…)` are untouched, and a
  call spanning two lines is left alone rather than guessed at.
- **`call-header-declared`** — a header set with `setCallHeader` in `web/` and
  absent from `api/`'s `http.callHeaders` works over HTTP and is dropped the
  moment the socket connects. **Cross-surface, which is why nothing else can see
  it**: both halves are correct in the file they are written in. Neither side is
  a literal in a real app, so single-valued constants are resolved across the
  app; a declaration naming something this cannot read is a **skip that says so**
  rather than an absent declaration.
- **`service-model`** — a service resolves its model by name, and a miss is not
  an error: `getTable` throws, but the two things that grade a caller fail OPEN.
  So a `model:` naming nothing in the schema is reported, and so is a
  `createBaseService` whose service name derives to no model — which is every
  hyphenated name, since `db.<accessor>` is the model name with a lower first
  letter and `product-variant` is not `productVariant`. A service with no
  `model:` and no CRUD base is judged on nothing: a service over no model is a
  whole kind of service.

Four more, added the same day, ask across the realms:

- **`resource-model-miss`** — `createResource('product-variants')` resolving to
  nothing falls back to a bare `make()`: no validation, no labels, no field
  rules, and a screen that still renders. It is `service-model`'s question asked
  from the UI realm, so the two share **one resolver** rather than one regex
  each. Reported only where a model plainly EXISTS under the name — a resource
  over no model is a whole kind of resource.
- **`service-module-db`** — the module client inside a service carries no
  principal: `auth()` is null, every row policy matches nothing (an empty list
  with a 200) and a write belongs to nobody in the audit trail. Only where `db`
  is an IMPORT, since `const db = ctx.locals.db` cannot coexist with one;
  `db.asSystem()` says which client it means and is not reported.
- **`scheduler-dispatch`** — `FJS-D36`: a timer that dispatches into the queue
  buys a clock with none of the queue's durability while looking like it has
  one, and it runs in every replica. The callback is read WHOLE (`spanFrom`),
  because a dispatch is three lines below the timer in every real app.
- **`gate-unreachable`** — a `@@gate` at ADMINISTRATOR(5) or above where nothing
  can grade a caller past 4: the shipped resolver reads
  `isAdmin`/`isOwner`/`isSystemAdmin` and **never interprets a role string**, so
  an app with a `role` column, no standing booleans and no `getLevel` of its own
  has declared an operation nobody but `asSystem()` can perform. A warning, not
  an error — the app is more closed than it meant to be, and the symptom is a
  403 reading as *not an admin yet* rather than as *no caller ever will be*. `8`
  and `9` are excluded by name: the identity models ship that way.

**Three more were killed by measuring them.** `@encrypted` on a `Json` column
round-trips correctly (`Int`, `Float` and an array throw at the write, loudly);
a directive key in a `find()` filter is a 400 from `autoFilter` naming the key;
and a model service with no `channel:` is the ruled, intended state. Each was a
row in `IDEAS/diagnostics.md` written before the fix or before the ruling — **a
hazard paragraph is a lead, not a spec.**

**`fli check --fix` applies the ones that are a whole fix.** A finding may carry
`edit: { start, end, was, replacement }` — byte offsets into the file it names —
and `applyFixes` writes, because *how a file gets changed on disk* is one answer
and not one per rule. **The offsets are into the real source although rules read
`readCode`**, which is what blanking comments to spaces rather than deleting them
buys: every position survives.

Three rules carry one. `:id` → `{id}` is a spelling; the two model rules have
already worked out the exact name the call is missing, so the edit is
`model: 'ProductVariant'` written into the options object **the way that object
is already written** — `{}` takes no comma, one opened on its own line takes a
line indented like its neighbor. A canonical form would reformat somebody's
file to add a missing key, which is how a `--fix` gets a reputation.

**The other six deliberately carry none, and `set-auth-discarded` is the
argument**: wrapping the call in `const scoped =` would silence the rule and
leave every write below it going through the unscoped client — the bug, with a
green check over it. A fix that makes a check pass without fixing the failure is
worse than no fix.

Edits apply back to front (two on one line was the case that decides it), `was`
is re-verified so a file that moved since the check is refused by name rather
than written at a stale offset, overlapping spans are refused rather than
resolved, and what was applied is **re-checked from disk** rather than
subtracted from the list in memory. Finding the call site cost a defect on the
way in: `indexOf('createBaseService')` lands on the IMPORT, and searching forward
from there finds the `(` of the arrow function beside it, so the fix came out
empty and the line number pointed at the import.

**Two more ask whether the BUILD-time proof is switched on.** Sierra proves a
prerendered page at build time — reads tapped around the route's companion and
graded against `@@gate`, fail-closed (`FJS-081`) — and no text rule can replace
that, because the question is what a `load()` actually read. What text can see is
whether that proof is running at all, and both of these were measured by calling
`checkRoute` rather than read off the source:

- **`static-publish-db`** — a `target: 'static'` surface whose Sierra config
  wires no `db:`. The tap needs that client; with none the build can observe
  nothing, so every route with a companion is refused until it declares
  `publishes:` — and the message the build prints tells the author to write
  `publishes: 0`. Do that per route and the build goes green having proved
  nothing, permanently. Only for a surface that actually loads data: a site with
  no `.meta.js` reads nothing and wants no client.
- **`static-publishes-0`** — `publishes: N` is the level a page may publish at
  and the default is 0, so declaring 0 raises nothing. Measured: it changes
  exactly two outcomes, and both are refusals becoming passes — a route the
  build could not OBSERVE, and a read of a name the schema does not describe.
  The one declaration that reads like a bar and works like an off switch. A
  declared LEVEL is the mechanism working and is not reported, and the key is
  read from a page's own frontmatter and nowhere else, because that is where
  the build reads it.

**`check-baseline.json` is how an app adopts the rules**, and it is Invariant
14's ratchet applied to a second kind of count — one number per rule id, absent
= 0 = clean, `scripts/typecheck-baselines.json` the precedent and the semantics
deliberately identical. **The file's presence is the declaration**, so an app's
own `bun run check` gets it with no flag to remember.

**It grandfathers nothing: the findings still print, and what the file changes is
the exit code.** Debt you cannot see is debt nobody pays, and a rule set that
goes red the day it is installed gets removed rather than obeyed.

Two verbs, because one flag that both locks in a fix and records a regression is
how a ceiling rises with nobody deciding to raise it. `--update` takes
improvements and **cannot** raise; `--adopt` writes what is there, raising
included, and reads in a diff like the decision it is. Both write and then
**re-grade from the file**, the rule `--fix` already follows — a run that records
a baseline and then fails against the numbers it just wrote is reporting a state
that no longer exists.

**A rule that did not RUN is not a rule that improved**, and that is the one
place the shape had to differ from typecheck's. A rule with nothing to look at
reports 0 findings, which is exactly what a fixed one reports, so a skipped
rule's ceiling is carried forward and said out loud rather than ratcheted to
nothing — otherwise deleting a surface for an afternoon locks in a baseline no
later run can meet. Same doctrine as `skipped` in the summary, one layer along. A
ceiling for a rule that no longer exists is reported the way a stale allowance
is, and a zero is never written, since it says what an absent key says.

**A baseline is not an allowance and both have to exist.** `allow` says *this one
is fine, and here is why* — keyed by rule AND path, carrying a reason. A baseline
says *there are this many and there will never be more*. Adoption needs the
second; a permanent exception needs the first.

**The membership test widens by its INPUT only.** A rule still earns its place by
being silent when broken; it may now read a line of the app's own JavaScript
rather than only the file tree. Text, never an AST — this runs on node with no
build. **Comments are blanked first** (to spaces, so line numbers survive),
because this repo's own `api/` files describe every one of these hazards in the
words the rules match, and a check that fires on the paragraph explaining the
hazard is one people turn off. The blanking is **quote-aware**, which is not
fussiness: a regex sweep blanks from the `//` in `'http://localhost:8010'` to
the end of the line, so a `callHeaders:` sitting after a CORS origin disappears
and the rule reading it reports a correctly-declared header as undeclared.
Blanking too much is how a source rule cries wolf.

`core/checks.js` gains its **first import**: `@frontierjs/toolbelt/inflect`, the
substrate package. *What is the singular of this service name* has one owner
(Invariant 2) and a sixth answer here would grade an app by an inflection the app
does not run — `people` → `person` is the case that decides it.

Clean over `example`, `basecamp` and `packages/sierra/example` — 21, 20 and 20
rules apiece — with every new rule RUNNING over each rather than skipping.
`without(prefix)` in the test file replaces the destructuring two trees used to
strip a directory: a test that lists the files it removes breaks the day CLEAN
grows one, and it breaks by asserting the wrong thing rather than by failing.

## 2026-08-23 — a reader that quits first, and a secret with nothing to sign

760 tests. **`fli list | head -3` no longer dies printing its own stack**
(`FJS-379`). One `error` listener on stdout and stderr at the entry point,
exiting quietly on EPIPE — not a guard per write, since every read-only listing
has the same shape. Measured both ways in a scratch directory: 980 bytes and two
`Unhandled 'error' event` traces before, 0 bytes after, every run. It survived
because merging stderr into the same pipe hides it completely — the trace goes
into the pipe that just closed — so it is only visible the way a person actually
types it, which is what `tests/pipe.test.js` reproduces.

**`fli auth:install` no longer generates an `AUTH_SECRET`** (`FJS-360`), and the
reason is in the file where the generation used to be: a session issued by
`@frontierjs/auth` is a ROW — a random UUID stored on `Session`, verified by
lookup — so nothing is signed and there is nothing for a signing secret to sign.
An API key is hashed with `ENCRYPTION_KEY`. A second secret with no reader is
worse than no secret: it gets rotated, nothing breaks, and everybody learns that
rotating is safe. Gone from the generation, the `.env.example` line, the env
declaration and `fli new`'s. Sessions becoming stateless tokens is what would
bring it back.

## 2026-08-23 — `site/` is a surface, and `site:` belongs to it

760 tests, 34 of them new, 0 fail.

`FJS-451`, ruled as `FJS-D127`. Invariant 3 listed four surfaces and a public
prerendered site was none of them, so this repo's own example built one inside
`web/` — a second config in `web/config/`, a second `routesDir` under `web/src/`,
an `outDir` of `dist/public`. Every layer agreed: no rule could see it, no port
slot existed for it, no command could make one.

**The axis that decides it is output.** One Vite root is one `dist/`, and Vite
empties `outDir` by default, so `bun run build` deleted the site. Order-dependent
and silent, and indistinguishable from a stale build.

- **`core/site-surface.js`** — the one owner of the shape, called by `fli new
  --site` / `--template site-only` and by `fli make:site`, the same rule
  `widget-surface.js` and `extension-surface.js` follow. It writes an
  `index.html` and a `src/main.js`, because `target: 'static'` is the SPA's Vite
  config plus a prerender pass: dev is client-routed and the build is files.
- **`fli site:{dev,build,serve}`** — the surface's three commands. The build is
  plain `vite build`; there is nothing for a sierra subcommand to add.
- **`core/ports.js`** — `siteDev` (6) and `siteServe` (7), mirroring the widget
  pair. A surface both written against and served as its own origin needs two
  numbers, and the served half is not the SPA's second server.
- **`core/checks.js`** — `app-layout` reports a `target: 'static'` config found
  inside another surface, read from the config's own text. It is the one folded
  surface that reads as reasonable while it is written, which is why a rule has
  to be what notices.

**The ksite commands moved to `ksite:*`.** Six of them held `site:` — `clone`,
`fetch`, `setup`, `update`, `serve`, `deploy` — and they drive a separate
static-site toolchain that has nothing to do with FrontierJS. Short aliases are
unchanged (`fli clone`, `fli fetch`); the bare `fli serve` is gone, because two
things now serve a directory called `site/`.

## 2026-08-23 — a widget surface gets its own app's ports

`FJS-445`. `fli make:widget` wrote **8200** and **8300** into every app it
scaffolded a surface into — the Vite port, the host page's `<script src>`,
`deploy/serve.js` and the Dockerfile's `EXPOSE`. Those are dev/widgetDev and
dev/widgetServe for **project 0**, right for a fresh scaffold and wrong for
every app that has a number: `core/ports.js` is the schema and the numbers are
derived, not chosen.

Two apps in one workspace both got 8200. `strictPort` makes that a refusal
rather than a silent hop, so the failure was a second widget server that would
not start, naming a port nobody had chosen. Both are now derived from
`projectIdFor` + `port()` and threaded through every generated file and the
epilogue the command prints — `example` scaffolds at 8210/8310.

## 2026-08-22 — the doctor reads the Dockerfile it was given

726 tests, 10 of them new, 0 fail.

`deploy:doctor` required `db:migrate` and `start` in the app's manifest because
that is what `fli make:deploy` writes into the CMD — and never read the
Dockerfile the app actually configured. `basecamp` migrates at boot inside
`app.ts`, on purpose, so it has no `db:migrate` and the doctor reported a hard
failure against a container that starts correctly (`FJS-417`).

`dockerfileScripts(src)` in `core/utils.js` is the derivation: every
`bun run <script>` on a CMD or ENTRYPOINT line, exec form and shell form
including a `&&` chain. Only those two instructions — a `RUN bun run build` has
already succeeded by the time an image exists, and requiring its script at
deploy time would fail an image that is sitting there working.

In `core/` rather than in the markdown because a regex whose only proof is one
run of the command is not proved. One of the ten tests reads basecamp's real
Dockerfile.


## 2026-08-22 — surface-config, the twelfth rule

716 tests, 6 of them new, 0 fail.

Invariant 3 says configuration lives in `config/`, and nothing checked it. This
is the silent-when-broken class the engine exists for: a loader treats an absent
config file as an optional miss — correctly — so a surface with no `config/` at
all boots on framework defaults looking configured. `basecamp` read `api/config`
for its whole life without that directory existing (`FJS-415`).

Three findings in descending sharpness: a config file BESIDE a `config/`, where
one of the two is read and nobody can tell which; a config file at the surface
root with no `config/`, read by nothing; and the bare absence.

The absence is a finding rather than "this surface declares nothing on purpose",
because the framework resolves that path whether or not the app meant it to —
junction's default `configPath` is `api/config` unconditionally. An app that
genuinely wants the defaults says so in a one-line file, which is the difference
between a decision and an accident.

A surface with no source in it is skipped rather than scolded: a directory
somebody made is not a surface yet, and a rule that scolds every fixture is a
rule people turn off.

Both check fixtures gained an `api/config/junction.config.js`, which is the
right answer to a rule firing on the tree that defines *clean*.


## 2026-08-22 — `fli dev` refuses a port that is already answering

`core/db-preflight.js` had told you when a database was empty since it was
written. Nothing told you when a port was taken, and that is the failure with
teeth: the two dev runners fail differently and badly — `bun --watch` prints
EADDRINUSE and **keeps watching**, so the process stays alive and whatever is
waiting on it waits forever, and vite exits on `strictPort` only after somebody
has already been confused once. The worst version is a stale server from an
earlier run: it still owns the port AND still holds the old database open,
including one that has been deleted, since an unlinked SQLite file lives on
while a handle does. The new server never starts, every request is answered by
the ghost, and `db:reset` looks like it did nothing.

`appPorts(appRoot)` in `core/ports.js` derives it. **Which ports come from the
SURFACES that exist** — `web/`, `api/`, `widgets/`, `extension/` (Invariant 3) —
so a list kept per app cannot go stale the day somebody adds one, and a surface
the app does not have is never refused on. `FLI_PORT_FE`/`FLI_PORT_BE` win where
the broker set them.

**It names a script the app actually declares.** Two conventions are live and
both are correct — the apps in this repo call a surface's script by its own name
(`api`, `web`) and `fli new` writes `dev:api`/`dev:web` because there they are
composed into one `dev` — so the refusal reads the manifest rather than
assuming. Telling somebody to stop `bun run api` in an app whose script is
`dev:api` wastes the next minute of their day.

`packages/basecamp/scripts/preflight.mjs` is gone: it was this check, hand-held,
with the two ports written out as literals.

The port check refuses and the database check still warns, because they are
different kinds of fact — an empty database is the correct state for a first
run.

## 2026-08-22 — `make:resource` emits the form, and a generator is executed by a test at last (`FJS-D114`, `FJS-372`)

The command wrote a module script and stopped, so `FJS-D112`'s markup half was
permitted and never generated — the state a convention dies in. It writes the
default form now: `<Form resource={…} {record} ondone={onsaved} auto={!$slots.default}>`
with a `<slot />` inside it, so a create page is `<Model />`, an edit page is
`<Model record={row} />`, and a page wanting a different form still passes
children and still wins.

`auto` is stated rather than left to `<Form>` because the wrapper ALWAYS hands it
a slot: unstated, the component answers *did I receive children* about the
resource file instead of about the page, and generation is off in every app that
ran the command.

**And what a Resource IS became one module.** Three commands wrote one —
`make:resource`, `web:resource`, `make:scaffold` — each with its own copy, already
drifted in their comments, which is the harmless half of the drift that ends with
two of them emitting a different file. `core/resource-template.js` is the owner
now, the same shape `core/crud-templates.js` already is for a generated CRUD page
(Invariant 4).

`tests/make-resource.test.js` runs the command for real into a temp app and grades
what it wrote with `runChecks` — the same engine `fli check` gives a client app,
which is the assertion that matters here because the failure class is the
framework generating what the framework refuses. It runs `web:resource` as well and compares
what the two emit with the names swapped out, so *they are one module* is proven
by execution rather than by reading both files. It is the first test in this
package to execute a generator at all — and while adding it, `tests/config.test.js`
turned out to be listed in no test script either: eight assertions that had never
run. Both are in `package.json` now. Opening the generated file in the kit's
browser drive found `FJS-400`, a defect in `<Form>` that no app in this repo could
reach and every app running this command would have.

## 2026-08-21 — fli reports the version it actually is (0.1.3)

The list banner carried a literal `v0.1.0` (`core/bootstrap.js`), so every build
published since 0.1.0 told a stranger it was 0.1.0 — and `fli --version` fell
through to the usage screen, because minimist leaves `_` empty and the
no-command short-circuit ran first. Those are the two places somebody who
installed the package off npm looks before filing a bug, and both lied.

- **`fliVersion(root)`** in `core/utils.js` reads the installed `package.json`,
  memoised **per root** rather than once — the argument exists so a caller
  holding its own path can ask, and a single cached answer would hand it this
  package's version for someone else's directory.
- **Four readers**: `fli --version`, `-v`, the bare `fli` usage header, and the
  `fli list` banner. `/api/meta` already read `pkg.version`; its two `'0.1.0'`
  fallbacks are `null` now, because a fabricated version is worse than an absent
  one.
- `tests/version.test.js` spawns the real binary for every surface and asserts
  against `package.json`, so the next bump cannot re-open this.

**The usage screen is paste-safe too.** Its two annotated examples marked what a
command produces with a `->`, on lines that look exactly like something to
select and paste — and a paste hands `fli` three junk argv entries. The marker
is `#` now, which the shell reads as a comment, and `tests/help.test.js` asserts
no arrow reaches the usage screen, the listing or a namespace page. Found the
way these are always found: a reader pasted an arrow-annotated install line and
npm went looking for a package named after the arrow.

## 2026-08-19 — the admin uses the app's own Resources (`FJS-364`)

`fli admin:generate` wrote one `web/src/resources/admin.mesa` holding every
model. That is N Resources in a file named for no model, which `fli check`
refuses twice (`resource-file-name`, `resource-one-per-file`) — but the rule was
the smaller half. It also declared `createResource('users')` beside an app that
already had `resources/User.mesa`: **two stores over one service**, each with its
own socket subscription, so a write through the admin left the app's list stale
and the app's write left the admin's, with nothing anywhere saying why.

Both close together:

- **The index moved into the layout.** `admin/_module.mesa`'s `<script module>`
  exports `models`; the dashboard imports it from there. A layout is already the
  surface's own module, and module exports are importable by any other module
  (Mesa VISION §11, rule 30) — which is all the pages ever needed from
  `admin.mesa`.
- **The admin imports the app's Resource per model**, and writes one only where
  none exists, from `fli make:resource`'s own template. **Never overwritten,
  `--force` included** — force is about the generated pages, which are
  disposable, and a Resource is not one of those.
- **Both halves of an existing Resource are read, not guessed.** The export name,
  because `Person.mesa` exports `people` and no plural rule applied to `Person`
  finds it; and the service string, without which the irregular generated
  `/admin/persons/` over a service named `people` — the data worked while the
  URL, the route folder and the `make:service` hint were wrong together. That
  second one was found by running the command, not by reading it.
- A Resource file exporting no `createResource` is **named and its model
  skipped**, rather than generating a page whose import resolves to `undefined`
  and dies at first render with no mention of the file.

Verified on a three-model fixture with a hand-written `User.mesa`, an irregular
`Person.mesa` and a missing `Widget`: the hand-written file is byte-identical
after `--force`, only `Widget.mesa` is written, and `fli check` reports nothing
where it previously reported two errors.

## 2026-08-19 — a generated CRUD page is built on the kit, and there is one of it

`fli make:scaffold` and `fli admin:generate` each wrote a list, a create form
and an edit page, and until now each carried its own copy of the same ~180
lines: an `Object.entries(resource.fields)` loop deciding control-per-type, a
`pickers` block resolving a related service through a hand-rolled English
pluraliser, an `errors` array, a `saving` flag, and a `<style>` block of hex
colors. They had already drifted — one filtered `id` by name, the other asked
the resource for its idField, and only one rendered a picker at all.

`core/crud-templates.js` is now the one owner of what a generated page looks
like, and the pages are built on `@frontierjs/ui`: **`<Form {resource} />` with
no children IS the form.** Every writable column in schema order, each with the
control its type implies, picker rows fetched from the related service, the
coerce/blank-strip/validate pass before the request, and a rejection mapped back
under the field that caused it — all of it in the kit or in the resource,
stated once. A generated create page is ~25 lines and names no field, no type
and no enum member; the list still names its columns, because which of twenty
belong in a table is a judgement and that file is where to make it.

Two knobs cover what admin needs and scaffold does not: columns derived off the
schema at runtime (an admin covers every model and cannot name them) and a
per-row delete, plus the gate affordances. `related()` is gone from the
generated admin resources file — the picker asks the resource, which resolves
the related service through Sierra's registry, so a scaffolded app no longer
ships a second pluraliser.

**`@frontierjs/ui` is now part of what an app is given** (`core/app-config.js`,
and `fli new`'s web half). A generated page imports the kit; an app without it
gets pages that cannot resolve their own imports, which is what the first run
of `scripts/scaffold-build.mjs` said in as many words.

**`fli new` no longer keeps two lists of the same packages.** `neededPkgs` — the
list `--source local` runs `bun link` over — is read off the manifest
`makePackageJson` produced rather than restated beside it. Adding the kit to one
and not the other broke every local-source scaffold at install, and the error
surfaced three commands later, in `deploy:vendor`, naming every package at once.

Proven by `node scripts/scaffold-build.mjs --deploy`: scaffolded, installed from
tarballs, built, `bun run check` green, a model scaffolded in and built again,
and both container sources built, started and answered health. The register step
still fails on `FJS-345`, which is about a scaffold having no migrations and
predates this.

## 2026-08-19 — a resource file carries its model's default form (`FJS-D112`)

Invariant 18 said a resource file has no markup. It does now, and the markup is
the model's default form — the data half stays in `<script module>`, which is
the half `resource-script` still enforces. The check's markup finding is gone
and the test that asserted it is replaced by one asserting the opposite: a
module script, an instance `<script>` and a `<Form>` beside them is a clean
resource.

The five command templates that stated the old rule in a header comment were
updated with it — `make:resource`, `web:resource`, `make:model`,
`make:scaffold`, `admin:generate`. What they do NOT yet do is emit the form,
which is permitted rather than generated; that and the named-query question are
named in the ruling and not started.

## 2026-08-19 — a resource file is named for its model, in all five scaffolds (`FJS-363`)

Invariant 19 names a resource file for its MODEL and its export for its SERVICE.
`make:resource` and `web:resource` built the path as `service + '.mesa'` and
`make:model --resource` as `${plural}.mesa`, so `fli make:resource Order` wrote
`orders.mesa` — which the next `fli check` called an error, with this package on
both sides of the disagreement.

The consumer half was wrong with it. `make:route --resource` and
`web:route --resource` generated a page importing `resources/${service}.mesa`, a
file the fixed commands never write, and the *does this resource exist yet*
probe beside it looked for `${service}.js` — the wrong name **and** the wrong
extension, so that warning fired on every run including the correct one.

Only `make:scaffold` had it right, which is why CI was green: the `scaffold`
phase runs `fli scaffold` and reaches none of the other five. Each fixed site
now carries the split as a comment, because the generated import line legitimately
spells the two differently either side of `from` — `import { orders } from
'../../resources/Order.mesa'`. `fli validate`'s worked example was stale the
same way and is corrected.

Not fixed, filed as [FJS-364](../../ISSUES.md#fjs-364): `admin:generate` writes
one `resources/admin.mesa` holding every model, which fails `resource-file-name`
and `resource-one-per-file`. That is a shape question, not a spelling — three
ways out and none obviously right.

## 2026-08-19 — the scaffold had two auth files and ran the wrong one (`FJS-357`, `FJS-358`)

`fli new` writes `api/src/core/auth.ts` and imports it from `api/src/app.ts`.
It then composes `auth:install`, which wrote `api/src/auth.ts` — a second
`createLitestoneAuth` over a second `createClient` on the same SQLite file,
imported by nothing — and printed next-steps naming `api/src/server.ts`, which
exists in no app this scaffold writes, telling the reader to call
`createApp({ auth })` again. `auth:install` recognises the wired layout now and
scaffolds nothing into it.

**The dead file was the more complete one, and that is where the defect lived.**
`core/db.ts` grades the gate on `isAdmin`, and its own comment says the
projection is made where the session is built. `core/auth.ts` declared no
`sessionFields`, and the `User` model ships a role STRING that auth stores and
never interprets — so `isAdmin` reached no session and nothing could grade above
USER(4). Measured on a fresh scaffold with `role='admin'`:

- `DELETE /users/:id` → `403 requires level 5, user has level 4`, at a level no
  caller could reach
- `PATCH` of another person's row → **404**, because
  `@@allow('update', … || auth().isAdmin)` matched nothing and a row policy
  hides rather than refuses
- `PATCH {role:'admin'}` → **200 with the field silently stripped**

Three of `schema.lite`'s own rules, dead, for one missing line. It is there now,
and the same probe passes for an admin and still refuses a plain user on all
three. `authCleanup` is started from `app.ts` rather than constructed in a file
nothing imports, and `AUTH_SECRET` is declared in `core/env.ts` rather than
generated into `.env` and named nowhere.

Declaring it **required** is what found `FJS-360`: every containerised deploy
then refused to boot, correctly, over a value that no code in
`@frontierjs/auth` or junction reads — auth signs with `encryptionKey`, and the
only other mention anywhere is `defineEnv`'s soft-warning table, which knows the
name so it can grade length and placeholders. It is declared optional.


## 2026-08-19 — what `fli new` leaves behind, read as a stranger would (`FJS-353`, `FJS-354`, `FJS-355`)

699 tests, 0 fail.

Four things a scaffold did that a first-time reader would take as the framework
being broken, all found by running `create-frontier` and following its own
instructions.

**`fli keygen --env` printed the key it had just written.** So `fli new --auth`
put a real `ENCRYPTION_KEY` and a real `AUTH_SECRET` in terminal scrollback, and
in the log of every CI job that composes the command. The bare form is meant to
be piped, so the echo survives where nothing else carries the key; `--env` and
`--copy` have already delivered it, and `--print` is the way back. `auth:install`
also stopped printing a second success line over keygen's own, and now declares
each name it generated in `.env.example` — a key written only to `.env` is a key
the next clone has no name for.

**The summary told everyone to `cp .env.example .env`** — over the `.env`
`auth:install` had just filled with both generated keys. An instruction that
breaks the app it finished building. It is printed only when there is no `.env`.

**`cli/src/routes` was created by the directory step and then refused by
`fli:init`**, which exists to fill it. The warning scrolled past, `✓ created`
printed anyway, and the FLI surface shipped as an empty folder.

**The home page read `status.connected`**, which is the socket, and the client
opens one only once it holds a token — so a visitor who had not signed in read
`connecting…` for ever. It asks `/api/health` now, and says separately that the
socket opens at sign-in.


## 2026-08-19 — `project:view` is a page rather than a React bundle, and it stopped inventing data

FJSChain was React 18 from a CDN — two `<script crossorigin>` tags, 486 inline
`style:{}` objects, a 30-key color palette, hand-compiled from an `FJSChain.jsx`
that is **in no checkout**. So the committed artefact could not be regenerated,
and the page could not render at all without the network, which nothing else
here needs.

It is plain HTML and JavaScript in `@frontierjs/css` now, ~1100 lines against
1571, and the terms carry it: Shell, Topbar, Screen, Pane, Card, Tile, Item,
Facts, Table, Badge, Pill, Code, Tabs, Alert, Empty, Disclosure. The diagram is
the only thing left in a `<style>` block, because a chain drawn as a grid is a
picture and not a component. A realm is a **tone** — `primary`, `info`,
`secondary`, the three that claim no status, so `success` and `danger` still
mean what they say beside them.

**The diagram is a flow and it has to look like one.** The first pass drew the
twenty nodes as three rows of cards and left the direction to two captions,
which is not a chain — it is a list that happens to be in order. The arrows are
back and they are CSS rather than glyphs, so they stretch with the gap and take
the ink color: a rule with a head on it between nodes, pointing right along the
outgoing lane, left along the incoming one, down the two spines. Consecutive
nodes of one realm sit in a tinted **band**, which is what makes four API nodes
read as one stretch of the chain; the bands line up with the realm cards
beneath them, which the page this replaced did not manage. And the four elbows
are carried over unchanged, because they are the shape of the thing: a request
enters at the UI end of the bottom lane, turns at the data end, and its result
comes back along the top.

A package tag is a **control** now — outlined in the realm's tone above the node
it joins, and clicking it opens that package's detail. In the first pass they
were badges inside the node, which meant a `<button>` inside a `<button>`, a
name wider than its node painting over the neighbor, and a detail panel nothing
could reach.

**The bigger half is what it no longer says.** Six of its twelve panels were
hardcoded fiction about a shop called acme-crm — `port: 3000`, `acme_crm_token`,
`./db/acme-crm.db`, a `contacts` service — rendered beside real data with
nothing marking which was which. Two of them (`routes`, `fli`) read from
constants that were `[]`, so they had rendered nothing at all since the day they
were compiled. Every panel now declares its `source`: **project** is read off
the tree, **reference** describes FrontierJS and says so in an Alert at the top
of its own tab. The fictional settings are deleted outright.

What the surface snapshot can answer, it now answers. `routes` and `plugins` are
real (they were static and empty); a hook-point detail shows the chains that
actually run at that point **and names the file it read them from**; `channels`
lists the services that declare one, where every service used to be given three
invented events. The issue list checks things the data supports — a missing
`gateAuth`, an ungated model, a required secret that is not set, a service no
resource binds to — replacing a check for an `authenticate` hook this framework
does not have, which flagged every service in every project.

The injected env-health panel is gone with it: `PANEL_JS` existed because the
page was a compiled bundle nobody could edit, so a second hand-styled UI was
stapled on at serve time. Env is a panel like the others now, one-click secret
fix included. The injection survives for `--legacy` only.

**`--legacy` serves the React page from `web/viewer/legacy.html`**, so the two
can be read side by side. It is the only thing in this package that still needs
the network.

Four things found by building it, three of them in how `@frontierjs/css`
composes.

**A View outranks a Stack.** `.view` states `display: block` in the components
layer and `.stack` states `display: flex` in the earlier layout layer, so
`class="view stack gap-lg"` lays out as a block with the gap doing nothing — and
every heading in a panel sat hard against the table above it. The same collision
`.pane` documents, and it had also flattened the Web GUI's documentation drawer.
The Stack goes on a child.

**`.tabs > .view` is a direct-child selector**, so wrapping the panels in a box
of their own took away the air between the strip and the first panel. The strip
and the views are siblings.

**A tone does not reach anything inside the element carrying it.** `--bg-mix` is
element-scoped, so all three realms drew in one color until the tone went on
the heading control too, and every elbow drew in the Data realm's color until
its rail derived the tone into an ordinary custom property first — which is the
move `form-core.css` already makes to get a tone onto a checkbox. Twice in one
page is what makes it worth writing down.

And **Chrome leaves a flex scroll container's bottom padding out of
`scrollHeight`**, which made the last band of the Screen unreachable at any
scroll position: the final row of the schema list could not be scrolled to. A
trailing `::after` is in the flow and is counted.


## 2026-08-19 — the Web GUI is written in the styling language everything else here is

`fli gui` was 840 lines of hand-written CSS with its own token names, its own
three themes and eight literal hexes in a hand-rolled highlighter, next to
`ws:map` and `ws:atlas`, which are written in `@frontierjs/css` (Invariant 13).
Two styling worlds one command apart, and a third spelling of *theme*: the GUI
wrote `data-theme` on `<html>`, the package defines `.theme-*`, and Sierra
settled the question in `FJS-308`.

It is a term now, all the way down: **Shell, Topbar, Sidebar, Screen, Bar,
Card, Field, Item, Badge, Pill, Kbd, Empty, Disclosure, Dialog, Drawer, Code**.
What is left in a `<style>` block is what the vocabulary has no word for — the
console a command streams into, the split it shares with the form, and the
density a command tree needs that a Sidebar does not assume. **No color is
written in the page at all**: an output level is a tone (`text-danger`,
`text-success`), which is what makes the light themes work — the old
console's `#d8d8d8` was invisible on anything but its own ground.

Three things fell out rather than being ported. Every fold is a `<details
class="disclosure">` and every panel a real `<dialog>`, so open/closed, Escape,
the backdrop and the focus trap are the browser's — that is four handlers and
two `.open` classes gone. The theme is a class on `<html>`, applied by a script
above the stylesheet so there is no flash, and the picker offers all ten of the
package's themes instead of three of its own. And the highlighter is
`@frontierjs/toolbelt/glow`, whose output is marked with the ELEMENT that means
each token and which `@frontierjs/css` already themes — so the GUI dropped its
tokenizer and its palette together.

**`core/assets.js` is the one owner of what a browser gets from a sibling
package**, and it answers two questions that are not the same one:
`styleBundle(root)` is the styling language as the tree at `root` holds it —
for a page ABOUT that tree, where a stylesheet from anywhere else describes
nothing (`FJS-256`) — and `ownStyleBundle()` is the copy this `fli` was
installed with, which is what the GUI wants, because the GUI is not about a
tree. `repo-map.js` reads the first; the server serves the second at
`/fli.css`, with the published bundle as a redirect for an install that cannot
read the package at all. Both are now dependencies of the CLI.


## 2026-08-19 — a stack from a command names the `.md` and the line its author wrote

A command is markdown, compiled to a module, written to a temp shim and
imported, so every frame from a command body named a file nobody wrote and which
is deleted on exit. The `//# sourceURL` pragma that covered this made it worse:
it relabels the PATH and leaves the LINE alone, so Node reported `boom.md:15`
for a throw on line 9 of an **11-line file** — authoritative-looking and
impossible — and Bun ignored the pragma outright. Bun ignores an inline source
map and a linked `.map` as well. Four measurements, no runtime answer.

So fli maps the frames itself, and the map turned out to be **one integer**.
`transformMarkdown` never dropped prose — it turns it into `//` comments, line
for line — so the body was already aligned; the only thing that broke alignment
was `stripScriptBlocks` cutting its block out, which shifted everything below it
and made a command with a `<script>` in the middle need two offsets. It leaves
the block's own height behind in blank lines now, and one offset covers the file.

`compileCliWithMap` returns `genLine - mdLine` beside the code. `core/stack.js`
is the one owner of the rewrite: a string pass over `err.stack` and its `cause`
chain, not an `Error.prepareStackTrace` hook — that hook is global and V8-shaped,
and taking it means re-implementing the default formatting for every frame that
is not ours, on two runtimes that format differently, to fix the handful that
are. The pragma is deleted; the body is no longer indented into `run()` either,
so columns are the author's too.

**The test runs the command through `bin/fli.js` under node and under bun.**
Every unit-level expectation the pragma set was satisfied for its whole life — a
pragma was emitted, it named the right file — so only executing it could tell
(`FJS-066`).

## 2026-08-19 — the deploy image says why `--production` can fail on a package it never runs

`bun install --production` skips INSTALLING devDependencies and still RESOLVES
them, so a dev-only package the image would never execute can fail the build
outright — an unpublished one 404s there with the app otherwise perfect. That
cost the `deploy` phase's `npm` branch every run until `@frontierjs/config`
reached npm, and the reason lived only in the issue register.

It is a comment on the `RUN` line in `commands/make/deploy.md` now, beside the
`--frozen-lockfile` note it interacts with: pruning the devDependencies from the
vendored manifest was tried and rejected, because a manifest that no longer
matches the lockfile beside it fails `--frozen-lockfile` on the line above
(`FJS-267`).

`utils:qrcode` is deleted in the entry below.

## 2026-08-18 — `package-root-md` reports the floor, and one function owns the frontmatter fence

Two things, both the same shape: a rule that could only see one side of what it
was written to check.

**`package-root-md` checked the ceiling and not the floor.** It built the set of
four allowed names and reported what was NOT in it, which catches a fifth file at
a package root and can never catch a missing fourth. Seven packages were short a
standard file with the check green over all of them. The asymmetry is defensible
for the fifth — the rule cannot tell a stray design note from the next thing
everyone needs at the root, which is why it warns and names it — but a missing
one needs no judgement, because the four are named in the invariant.

The finding points at the ABSENT FILE rather than at the package directory. An
allowance is keyed by path, so pointing both halves at the directory would mean
excusing `packages/css` its `AGENTS.md` also excused it every file it lacks.
It reports the eight it was written to find: `PROJECT_STATE.md` in `conduit`,
`jetty`, `sierra`, `testing`, `toolbelt` and `frontierjs-vscode`, and
`CHANGES.md` in `css` and `frontierjs-vscode` (`FJS-309`).

**Five call sites carried the frontmatter fence by hand**, as
`/^---[\s\S]*?---\s*/`, which ends the block at the first `---` anywhere —
mid-line included. A `description: use --- as a divider` left the rest of the
frontmatter, and its own closing fence, sitting in the body. The meta parser's
regex was the stricter of the two and read the same file correctly, so the two
halves disagreed about where the file began.

`splitFrontmatter` returns `{ meta, body }` from one match and `stripFrontmatter`
is the body half; `compileCli`, `extractSegments`, `extractScriptBlock`, the
command registry, the prose renderer and the GUI's step reader all ask it. The
fence is `---` alone on its line, opening and closing.

**`utils:qrcode` is deleted.** It imported `qrcode` dynamically and reported the
absence by name, but nothing installed it and nothing could: the advice it gave
was `bun add qrcode` in the user's project, which is not where the command
resolves from. The choice was a dependency on the CLI for one novelty command or
a command that never worked, and neither was worth it. `utils` keeps eleven.

`mod.prose` was in the same pile and is not a defect — `loadModuleFile` builds it
and `fli <namespace> --verbose` renders it. Struck from the row rather than
fixed (`FJS-066`).

## 2026-08-18 — `context.fli` is the one way a command invokes fli

Six command files shelled out to a bare `fli`. That is a GLOBAL install, and
fixing `project/new.md`'s `runFli` alone moved the wall rather than removing it:
the next runner failed inside `auth:install` on
`fli keygen aes --name ENCRYPTION_KEY --env`, which is the step the key comes
from — so the push that follows had no key and the app still came out with no
`User` model.

`context.fli` is the running cli, quoted and ready to prefix a shell command,
built once in `core/runtime.js` from `global.fliRoot` and `process.execPath`.
All six sites use it: `auth/install.md` ×2, `api/model.md`, `api/service.md`,
`make/schema.md`, `completion/install.md`.

Beside it, `auth:install` no longer treats an empty `node_modules` as a failure.
The schema push needs the litestone BINARY, which exists only after
`bun install` — `fli new --no-install` and `npm create frontier` both arrive
before that. It says so and carries on; the schema itself is already written.

Proven the only way that means anything: `fli new --auth` with a clean
environment and no `fli` anywhere on PATH now exits 0 with `model User` in the
schema and `users.service.ts` generated.


## 2026-08-18 — `fli outbox:install` could not be loaded at all

Two unescaped backticks inside `wiringHint`'s template literal — the line
`// Then, in a service that declares \`transactional:\`` — closed the template
and reopened it, so the file compiled to JavaScript that does not parse:
`SyntaxError: Unexpected identifier 'transactional'`. The command was
unrunnable from the day it was written.

Invariant 15 is why this was caught at all: `tests/compiler.test.js` parses the
output of every one of the 201 command files rather than trusting a clean
compile. The suite had been failing on it and nothing here runs the suites in
the pre-push tier, so it took a CI runner to say so (`FJS-009`).


## 2026-08-18 — three ways `fli new --auth` could not work outside this machine (`FJS-343`)

**`runFli` shelled out to a bare `fli`.** That is a GLOBAL install: it exists on
the machine of anyone who has run `bun add -g` and on no CI runner, in no
container, and for nobody who arrived through `npm create frontier`. There it was
`/bin/sh: 1: fli: not found`, so `fli:init` and `auth:install` never ran. It
invokes the running cli now, through `global.fliRoot`.

**`auth:install`'s failure was caught, warned about and stepped over**, so the
scaffold printed `✓ created` over an app with no `User` model — one that
installs, builds, boots, answers health and 500s on the first register with
`"user" is not a table in this schema`. Fatal now. `make:scaffold User` beside it
stays a warning: the example slice is optional and auth is not.

**And with the tree's own cli finally running, the push failed every time.** The
scaffold writes `.env` with a bare `ENCRYPTION_KEY=`, so bun puts an empty string
on the process environment at startup and a child that already has the name set
will not take `.env`'s value for it. Step 6 existed to fix that by assigning
`process.env.ENCRYPTION_KEY` before the push — and **under Bun an assignment to
`process.env` does not reach a child at all**: `child_process` hands over the
environment the process STARTED with, where node would pass the mutation on.
Bun is the only runtime `fli` runs on, so that fix had been a no-op since it was
written. The values are passed as `env:` on the exec now.

None of it was visible here, because a global `fli` answered every call.


## 2026-08-18 — `fli new --auth` no longer reports success when auth was never installed

`auth:install` is what puts the `User` model and the three credential models
into `db/schema.lite`. Its failure was caught, logged as a warning and stepped
over, so `fli new --auth` went on to print `✓ <name> created` over an app where
`--auth` had not happened.

That app installs, builds, boots and answers health. It fails on the first thing
anyone does: `POST /api/auth/register` → 500, `"user" is not a table in this
schema`, thrown from `createUser` at the Data boundary. Three services instead
of four, and nothing anywhere saying why.

It had never been seen here, because `auth:install` has never failed on this
machine. It failed on a CI runner, on both package sources at once, and the
`deploy` phase's new register-and-login smoke is what caught it (`FJS-252`,
`FJS-009`) — the health answer that ran before it was green.

The failure is fatal now and says what it cost. `make:scaffold User` beside it
stays a warning: the example slice is genuinely optional, and auth is not.


## 2026-08-17 — `body-tag-in-comment` stops crying wolf (`FJS-329`)

The rule flagged any `<body` inside any comment. The hazard is narrower and
exact: Vite injects the built `<script>` at the FIRST textual match and does not
skip comments, so a mention matters only when it comes BEFORE the real tag —
below it, Vite has already matched. `packages/css/guide/index.html` documents its
own markup nine lines under a real `<body>`, and has no Vite build at all, and
was an error.

`core/checks.js` is the same engine `fli check` gives a client app, so an
over-fire ships to every app on the next release — and a check nobody trusts is
the failure this engine exists to prevent. It now finds the first `<body` in the
file and reports only if that one is inside a comment. A file whose ONLY body tag
is commented still fails, because that is the same case. The finding points at
the mention rather than at the comment enclosing it: the mention is the token to
delete.

**The other half is where it was found.** The `structure` CI phase runs
`runChecks` over the four apps, so nothing checks this repo's own tree, and two
errors had been sitting under a bare `fli check` at the root. The second was
real: `packages/mesa/mesa-bench/vite.config.js` had no `strictPort`, so a bench
run can be served beside the one it is being compared against. Fixed rather than
allowed.

Four cases in `tests/checks.test.js` — above, below, only, and a closing tag,
which is not the injection point and never was.

## 2026-08-17 — `fli outbox:install` (`FJS-D35`)

Appends `import "@frontierjs/junction/outbox.lite"` to the app's `db/schema.lite`
and pushes the schema, then prints the two lines that wire the relay.

Nothing is copied, which is the difference from `fli auth:install`: auth writes
out `model User` because the app owns it and adds columns to it. Every model
here is machinery an app reads when something did not arrive and writes never,
so there is nothing to hand over and a package upgrade reaches an installed app.
`--db` becomes `into <db>` on the import line, which is also why there is no
`@@db(main)` string rewrite here — the nearest `into` already beats it.

Refuses by name on a schema that already declares or imports the model, on a
`--db` naming a block the schema does not declare (`main` is checked like any
other — exempting it is what let auth inject models naming a database nobody
had), and on a junction that does not ship `db/outbox.lite`.

## 2026-08-16 — a scaffolded app generates its own types (`FJS-018`)

`fli new` writes a `db:types` script, and it writes TWO commands because they are
two audiences: `--audience system` into `db/schema.d.ts` for the API, which holds
a system client and legitimately sees `@guarded` and `@secret` columns, and
`--audience client --augment junction` into `web/src/db.d.ts` for the browser,
which never does. One file for both would tell browser code a column exists that
every response strips.

`--augment junction` is the half that crosses the wire — it registers the rows
with the browser client, so `client.service('leads')` is typed from the seed
rather than from a hand-written shape beside it. Only on the web file: the
augmentation names `@frontierjs/junction/client`, and an api-only app has no
browser to type.

## 2026-08-16 — the generated pages carry their own stylesheet

`fli ws:atlas` linked `@frontierjs/css` from unpkg, so the one page that
describes the workspace did not render from a `file://` path without the
network, and a published Artifact could not render it at all — CSP refuses the
external request outright. `FJS-256`, closed.

**The link broke outright before it was replaced.** The range was DERIVED from
the workspace's own copy on the reasoning that an exact pin 404s, because the
local version routinely runs ahead of the published one. A caret does not fix
that below 1.0, it hides it: `^0.16` means `>=0.16.0 <0.17.0`, so the day css
went 0.15 → 0.16 in the tree the page named a version the registry has never
had. Measured: `@^0.16` 404, no range 302. A derived range can name a version
that has never existed, which is strictly worse than none.

**The stylesheet is now built from committed source on every run.**
`src/index.css` is 48 `@import … layer(name)` lines and an `@layer a, b, c;`
declaration; each import becomes an `@layer name { … }` block and the
declaration is carried over first and verbatim, which is the shape `bun build`
already gives the package's own bundle. Three things decided along the way:

- **Not `dist/`**, which is that file already. It is gitignored and built on
  demand, so inlining-when-present and linking-when-absent would make the output
  depend on whether somebody had run `bun run build` — and these pages are
  committed snapshots the `snapshots` phase regenerates and diffs. The tree's
  `dist/` at the time held a two-day-old `frontier.css` and no
  `frontier.min.css` at all.
- **Every import must resolve or the bundle is refused**, and that is stated as
  *all of them* rather than as a floor. The first version used a count, which a
  four-import fixture fails and a truncated forty-eight-import tree passes. A
  partial bundle is the worst outcome available: it renders, looks nearly right,
  and is missing whichever layer went absent.
- **Comments are stripped by a quote-aware pass.** They are ~60% of that
  package's source. `content: "/*"` is legal CSS, and a stripper that is right by
  luck is one nobody can safely edit.

The CDN link survives as the fallback for a tree that cannot read the package at
all, and carries no range.

Verified by loading the generated page in headless Chrome with no stylesheet
request in it: `body` at the field theme's ground, `--surface` resolving, `.btn`
taking its padding off the space ladder. Four new tests. Two existing ones sliced
"the local CSS" at the first `<style>` in the page and now name it by id —
`<style id="atlas">` — because the page carries two, and one of those tests had
started passing vacuously against an empty slice.

## 2026-08-15 — `fli test:access --from <ref>` — the permission diff

`--from` and `--strict` pass through to `litestone access`, which with a
baseline answers *what did this branch do to who may do what* instead of writing
the snapshot: gates, row policies, field-level `@allow`, `@guarded` /
`@encrypted` / `@secret` and transition gates, graded `widens` / `narrows` /
`undecidable`. `--strict` exits 1 on a widening and on no baseline at all.

`scripts/ci.mjs` gains an `access` phase that runs it per app against the base
ref. **It reports and never fails**, which is the one deliberate exception to
that runner's rule that a check either passes or fails: a branch that widens
access is usually a branch doing its job, and a red on every feature branch
trains everyone to skip the phase. The gate belongs on the branch that deploys.

## 2026-08-15 — `extension/` is a surface too, and `fli` builds it

The same ruling as `widgets/`, one surface over: a browser extension is a
sub-project at the app root, and further from the SPA than a widget is. Its
config emits a *manifest*; `--browser chrome|firefox|both` makes one source two
builds; the artefact is loaded unpacked into a profile rather than served, so
there is no URL for a drive; and the release is a signed upload to two web stores
under a review measured in days.

`core/extension-surface.js` is its one owner — `fli make:extension` and `fli new
--extension` — and `fli extension:{dev,build,audit}` wrap jetty's own `jetty-*`
binaries with `--root` at the surface. That is the `fli` integration jetty's
README had listed as not done.

`app-layout` gained the fourth surface and a second misplacement probe:
`src/harbor/` inside `web/` or `api/`, which is jetty's service worker and cannot
mean anything else. `--template extension-only` joins `widgets-only` as a
surface-only project, both resolved from one `surfaceOnly` branch rather than two.

**It found a defect in jetty on the way**: the Mesa compiler lookup probed two
fixed directories and never walked up, so in this exact layout — one install at
the app root — every `.mesa` in an extension silently became stub mode and the
build failed with a parse error inside the component. Fixed there, with the
fixture's dock converted to real Mesa so the path is exercised at all.

Verified end to end: a scaffolded `extension-only` project builds for both
browsers, and `fli check` is clean on it.

## 2026-08-15 — `widgets/` is a surface the CLI knows about

`fli make:widget <Name>` creates a widget, and creates the surface the first
time. `core/widget-surface.js` is the one owner of its shape — `fli new
--widgets` and `fli new --template widgets-only` call the same function, so the
app a scaffold wrote is the app the second widget extends. `context.paths` gains
`widgets`, `widgetEmbeds` and `widgetTests`, and `fli widgets:{dev,build,serve}`
run from the surface root the way `web:*` runs from `web/`.

**Two rules, both silent when broken.** `app-layout` learned that a surface is a
directory at the app root, and that WHICH surfaces an app has is the app's
business: api-only, web-only and widgets-only are all whole projects, so the
rule stopped demanding all three and started reporting a surface in the wrong
place — widgets under `web/src/Embeds/` inherit the SPA's build, port and
release, and the first symptom is a widget shipping when the app does. The new
`widget-entry-name` covers Invariant 19 next door: a widget's name is also the
custom element a stranger's page writes, so `booking.mesa` reaches HTML as
`<booking>`, which no browser upgrades — and a directory in `src/Embeds/` with
no `index.mesa` builds nothing at all, which is correct for a widget's shared
parts and wrong for one somebody is midway through writing.

The clean-app fixture in `tests/checks.test.js` now carries the third surface,
because a rule that only ever skips is what that file exists to catch.

## 2026-08-15 — `auth:install` imports auth's models instead of copying them (FJS-265)

The command wrote `db/auth.lite` into the app. It appends one line now:

```
import "@frontierjs/auth/schema.lite"
```

`Credential`, `Session` and `Verification` stay in the package, so `bun update`
reaches them — which is the whole reason the specifier is a package rather than a
path. `User` is still written out as text, because it is the app's: it grows
columns and relations point at it.

`--db` becomes `into <db>` on that import line rather than a rewrite of a copied
file, so the `@@db` swap this file still restates now only has to reach `User`.

The already-installed test accepts all three layouts that have shipped — imported
by name, copied to `db/auth.lite` and imported, and all four models pasted into
`schema.lite` — because missing any of them injects over an app that already has
auth.

## 2026-08-15 — what a scaffolded app is given, and a `fli check` that runs

`IDEAS/overview.md` 5.13. The generated `package.json` and config files are the
framework's real opinion about tooling and far more people will read them than
will ever read this repo, so they moved out of a 1400-line command into
`core/app-config.js`, one module with the reasoning attached and a test per
default.

**Everything extensible is a dependency now.** `tsconfig.json` and `biome.json`
are one line of `extends` over `@frontierjs/config`; the app keeps only `paths`
and `include`, which are the parts about its own layout. A copied config is
frozen at the moment it was written. `.editorconfig` is the exception and a
mechanical one — EditorConfig has no extends — so it is a hand copy byte-pinned
by a test on both sides.

**The app gets a gate and a workflow.** `bun run check` is `fli check`, then
lint, then typecheck; `.github/workflows/ci.yml` calls that and nothing else,
the same rule this repo holds itself to. `--no-ci` opts out. `@frontierjs/cli`
is a devDependency rather than a global assumed on PATH, since three of the four
scripts call `fli` and a global one of a different vintage generating files for
this app's framework version is the drift a pin removes.

**`fli check` had never run** (`FJS-269`). `commands/fli/check.md` used `resolve`
with no import and there is no `fli/_module.md` to supply one, so every
invocation since it shipped died with `resolve is not defined` — in this repo and
in a client app alike. The parse sweep cannot see it: it compiles each command
**without** its namespace module, so a free identifier parses clean. CI stayed
green because its `structure` phase imports `core/checks.js` directly, so the
engine worked and only the door was broken. Found by putting the command into a
scaffolded app's gate and running it.

**`fli typecheck` is new, and it is not a convenience.** Every `@frontierjs`
package ships TypeScript source, so `tsc --noEmit` in an app follows those
imports and checks the framework: measured on a fresh scaffold, 61 diagnostics
inside `node_modules` and none of the app's own. `core/typecheck.js` reports the
ones that belong to the project and counts the rest; `scripts/typecheck.mjs` is
its other caller and keeps only the baseline ratchet, which is this repo's alone.

**`scripts/scaffold-build.mjs` now runs `bun run check` inside the app it
builds.** An opinion that is red on a freshly scaffolded app is worse than none,
and three things are only reachable there: `fli check` from an installed cli,
Biome against a config resolved out of `node_modules`, and the typecheck against
packages that ship `.ts`. It found a missing `parseInt` radix in the scaffold's
own vite template on the first run.

## 2026-08-15 — `auth:install` reads auth's schema instead of restating it (FJS-038)

The hand copy of the four auth models is gone. Two walls had kept it here, not
one: `fli` is global, so `@frontierjs/auth` is not installed beside it — and
**`fli` runs on node** while `packages/auth/schema.ts` is TypeScript, so even
resolved it could not be imported. Auth ships `db/user.lite` and `db/auth.lite`
now, and reading bytes gets past both walls.

The command installs the package if the app lacks it — the test is a RESOLVE, so
a declared dependency nobody installed fails the same way — then resolves
`@frontierjs/auth/user.lite` and `/schema.lite` through auth's own `exports`
with `createRequire` off the app's `package.json`, rather than guessing at a path
inside the package.

**It writes two files, split by who owns the model.** `db/auth.lite` gets
`Credential`, `Session` and `Verification`, all `@@gate("8")`; `schema.lite` gets
`import "./auth.lite"` and `model User`, appended. An APPEND, not an insertion —
`import` is legal anywhere at the top level and `parseFile` merges imported
models ahead of local ones regardless, so nothing here has to parse the app's own
file to find a spot in it.

**Re-running it appended a second copy of all four models.** The already-installed
test read `'model users'` — lowercase plural, from before the rename — and the
fragments have emitted `model User` ever since, so it matched nothing. It is
anchored and PascalCase now, and reads `auth.lite` too, so an app installed
BEFORE the split is still recognized rather than injected over.

One rule is still restated here, because it cannot be imported: the `@@db(main)`
swap that makes `--db` work. Auth's own suite lifts this arrow out of the
markdown and runs it against the shipped bytes.

## 2026-08-15 — the project viewers read the API surface instead of guessing at it

`fli project:map` and `fli project:view` derived what a service IS from regexes
over `*.service.ts`, and the problem was not that the regexes were weak. Junction
decides at CONSTRUCTION whether a key is an option or an action — `collectActions`,
read back through `svc.describe()`, Invariant 4 — `svc.pipelines()` resolves the
hook chain, and `apiPrefix` moves every route. **None of that is a fact about how
a file reads**, so the scan could not agree in the general case: an action
assigned from a module-level const takes no visible `ctx`, a `methods:` list
built from a variable is not a literal to match, and a hook added by a plugin or
by `app.hooks()` is in no service file at all. A viewer with no way to be
contradicted then draws a confident wrong picture.

`extractServiceMeta` is deleted. Both commands read the committed
`surface.snapshot.md` — written off a BUILT app by `junction surface`, and failed
by the `snapshots` CI phase when it goes stale — so what the viewer shows is
current or CI is red. **Absent means absent**: no snapshot yields no services and
a warning naming the command, because a fallback scan is how the viewer gets to
be wrong again with nobody told.

What came free, none of which a scan could reach: basecamp reads as
`alerts · model AlertRule` where the scanner saw the accessor, five actions on
that one service, the app-level hooks that run around **every** call, 27 mounted
routes, and the plugins in configure order.

`FJS-037` closes with it — the sixth reserved-key list was the `RESERVED` set
inside that function, re-applying junction's option-or-action rule from outside
junction. The fix was never to share the set; it was to stop asking the question
here.

**`extractResourceMeta` stays, and was rewritten.** A Resource has no committed
artefact — it is constructed in the browser — so the `createResource(...)` call's
literal arguments are the only thing there is. It now reads the CALL rather than
the file: comments stripped first (a `model:` in prose is not a declaration, the
same shape as the body tag written inside a comment), a balanced argument list
rather than `[^)]*`, and hooks read per phase and per method instead of swept for
lowercase identifiers minus a skip list. Diffed against the sweep it replaces on
six shapes and wrong on all six — a second phase or method written on one line
took the whole block with it and answered empty, an inline arrow contributed its
argument name, and `session.stamp` came back as two hooks.

## 2026-08-15 — an app built from local sources ships (FJS-241)

`fli new --source local` writes `link:@frontierjs/junction` and four siblings.
They resolve to a workspace on the machine that made them and to nothing inside
a Docker build, so `bun install` failed once per package and **`fli deploy:local`
could not be run against the scaffold this repo produces by default** — which is
how four defects sat undetected on the deploy path, all of them found by reading.

The fix is not a different spec. A `link:` is what makes an edit to a package
visible with no reinstall, which is the whole point of developing against local
sources; a `file:` tarball in the same place goes stale on the first save and
says nothing about it. So the swap happens at BUILD time. `core/vendor.js` packs
every publishable package sharing a scope with a linked one into
`deploy/generated/vendor/` and writes `app-manifest.json` with the specs pointed
at the tarballs — **`overrides` included**, because the packages depend on each
other and a range left alone resolves from npm and quietly mixes a published
sierra into a local mesa.

**One owner, three callers**, which is the half that matters more than the
mechanism: `fli deploy:vendor` is the command, `deploy:local` and the pipeline's
`04-build-api` run it before they build (the server-side one rsyncs the result,
since a generated directory cannot arrive by `git pull`), and
`packages/basecamp/deploy/build.mjs` — which had the only working implementation
of this — now calls it instead of carrying its own. A scaffolded app and the app
whose purpose is to exercise the tree answering the packaging question
differently is how the two stop being one framework.

**One Dockerfile serves both source modes.** With nothing linked the vendor step
writes a verbatim manifest copy and the lockfile beside it, and the template's
freeze is conditional on that lock being present: a rewritten manifest has none
that matches, and a `file:` spec names its own content, which is the stronger
pin anyway. Making the template conditional instead would put the branch in a
file nobody regenerates when the source mode changes.

`deploy:doctor` fails a Dockerfile that installs from `package.json` while a
`link:`/`workspace:` spec is declared — reading it with comments stripped,
because the template explains `deploy/generated/` in its own header and asking
the whole source passes for a Dockerfile that only talks about it.

Proven by running it: `fli new --source local` → `make:deploy` → `deploy:local`
builds, boots, migrates and answers health. CI's `deploy` phase now runs both
sources, and its `scaffold` phase packs through the same module rather than its
own copy of the rule.

## 2026-08-15 — `fli release:check` — the Release realm arrives as one question

A new `release` namespace with one command in it. `fli release:check` reads
`db/schema.lite` twice — as it is, and as it was at the release you name — and
classifies the deploy between them: **expand**, and it can be taken back;
**contract**, and that deploy is the pivot; **unknown**, which counts as a
contract. It writes `db/release.snapshot.md`, the surface the serving release
binds to, so the diff between two releases is the classified change.

It cost no CI edit, which is the point of the two engines being shared: the
snapshot names `litestone release --schema schema.lite` in its own header, so
`fli test:snapshots` found and rechecked it with nothing added to a list. Run
over `example/` it reports current; run over `basecamp/`'s working tree it
reports **14 contract findings**, one per model that gained the row-level
tenancy predicate — which is correct, and is the first time that change has been
visible as a deploy risk rather than as a schema edit.

`--strict` is the gate for a deploying branch, `--check` the gate for a stale
snapshot, `--from <ref|path>` the question a deploy actually asks. The classifier
itself is litestone's (`src/release.js`); this is the app-facing door onto it.

## 2026-08-14 — the atlas opens on the workspace, not on the deck

The workspace was the 20th plate in a deck of 23, which is where the register
files things against `repo` — and everything a person actually arrives with is a
question about the whole tree rather than about one part. `fli ws:atlas` now
leads with a **hub pane**: six tiles (open · plates · capabilities · runnable ·
gated artefacts · invariants checked), the open register broken by severity as
routes into it, every package carrying anything open ordered **worst first**,
and the eleven root registers each quoted with its own opening claim.

Two things in that are judgements rather than counts and both are stated on the
page. **Ordering is by WEIGHT, not by count** — an S2 outranks a pile of S4s, so
basecamp's 8 rows lead litestone's 21 — and a bar's **length** is that weight
against the worst plate while its segments are the mix and the number is the
count; every bar filling its cell made 21 open read exactly like 2. Under it,
the workspace dossier now carries the WHOLE register — 106 rows, facetted by
severity and by the part they are filed against, each linking the plate that
owns it — plus the deck as one table, which is the comparison 23 separate cards
cannot make: who is published, who carries a typecheck ceiling, who is clean.
A severity is a route (`#/part/repo/S2`), so a count in the hub lands in the
register with the filter already applied.

**Then the hub grew the other two registers.** `ISSUES.md` is what is wrong,
`DECISIONS.md` is what is settled, `IDEAS/` is what is not started — three
states one piece of work moves through, and only the first was on the page.
They are now one row, because *what should I work on* is answered by reading
across them and reading `ISSUES.md` alone is how a defect gets fixed that a
ruling already retired. 106 open · **69 rulings** across nine domains · **93
ranked ideas and 39 papers**, all three whole in the dossier, all three in ⌘K.

Both readers had to learn a convention written for people. A ruling is a date,
an optional `FJS-D##` and a bolded claim leading a paragraph. An idea's Status
column is written four ways in four adjacent rows — `**defect**`, `` `contested`
— see ISSUES.md ``, `~~shipped~~`, `part-shipped` — so it normalises to one word
and keeps the cell whole beside it. A paper introduces itself with its **H1**,
not its opening paragraph: all 39 open on the same `**Status: IDEA. Nothing here
is built.**` boilerplate, so the generic reader had every one of them saying the
same thing.

That made four filter dimensions over one dossier, so the facet machinery is now
**one mechanism**: a control declares its dimension (`data-facet="stat"`), a unit
carries its value (`data-stat`), and a unit carrying nothing for a dimension is
untouched by it — which is what lets narrowing the ideas by status leave the
register beside them alone. A route names its dimension too
(`#/part/repo/stat:defect`), and **splits at the second slash rather than the
last**, because one ruling domain is `Design system (@frontierjs/css)`.

**And a package that documents itself in one README now has a field guide too.**
Litestone writes 35 files under `docs/` and gets 35 cards; junction writes 32
capabilities as `##` sections in one README and got a row of bare chips, which
is not a feature list. They are the same claim filed differently, so they are
dealt the same — each section now carries the first thing it says. Half of
junction's open on a fenced example rather than on prose, which is what an API
README looks like, so the fence's opening line is kept instead: *Response
helpers* says nothing and `ctx.json(data, status?)` says the whole thing. First
thing wins — scanning past prose for a signature finds whatever example is
furthest down the section — and a section opening on a table says neither
rather than reaching. All 32 are in ⌘K now; none was findable before. Beside
them, `src/*` with a file count each answers the structural question the
feature list does not: junction is 14 subsystems, `core` 16 files and `plugins`
15.

Found while looking at it: **`openingClaim` was quoting the wrong sentence.**
It asked for the first bold run anywhere in the file, and the house convention
bolds a claim per SECTION — so `DECISIONS.md` introduced itself as *Outpost*,
`drift-report.md` as *code-wrong*, and `HANDOFF.md` with the last session's
summary out of a blockquote. It reads the opening paragraph now, and the bold
only counts where it leads it. That is the map's reader, so both pages moved.
 — @frontierjs/cli

## 2026-08-14 — no alias is contested, and discovery is sorted

Warning about a contested alias found the larger half of it: **the winner was
whichever command loaded last, and that was `readdirSync` order.** Not the
alphabet — the filesystem's. The same tree resolved `fli new` to `project:new`
on one checkout and to `make:command` on another, which means the CI `scaffold`
and `deploy` phases, `README.md` and `docs/QUICKSTART.md` all called a command
that scaffolds a `.md` file rather than an app, on any machine whose directory
order came out the other way. `find()` sorts its walk now.

Sorted is reproducible, not correct: nothing about `utils` sorting after `ports`
says which command should own `dev`. So all four collisions were resolved by
renaming the side fewer people type:

- **`make:command`'s `new` → `mkcmd`** — the whole family is already `mkroute`,
  `mkmodel`, `mksvc`, `mkschema`, `mkc`. `new` was the odd one out and it was
  standing on `project:new`.
- **`site:audit` → `site:setup`, no alias** — it audits nothing. It removes
  boilerplate pages, writes the domain into `site.md` and `robots.txt`, and
  creates a `stage` branch, once, guarded by `config_ranSetup`. `audit` is
  `npm:audit`, which is an audit.
- **`ports:dev` → `ports:claim`, alias `claim`** — it claims a port session and
  prints the `FLI_PORT_*` vars for you to pass to your own servers. It has never
  started one, and its description said it did. `dev` is `utils:dev`, which runs
  the project's dev script.
- **`deploy:doctor` loses `doctor`** — someone typing `fli doctor` blind is
  asking *is my setup ok*, which is `fli:doctor`. The deploy question is scoped
  and its full name reads as the question.

The `ports:claim` / `utils:dev` split is still one job in two commands — both
run the same database preflight — and merging them is the `fli dev` orchestrator
already on the horizon. Closes `FJS-061`, whose other half was live: `POST
/api/env` called `writeFileSync` without importing it and 500'd on every save.
 — @frontierjs/cli

## 2026-08-14 — `fli db:seed` named a path nothing in this repo produces

It hardcoded `db/seeders/seed.ts` and reported *Seeder not found* for any app
that keeps its seeder anywhere else — which is every app here. There are three
competing conventions and it knew about none of them:

| | |
| --- | --- |
| `fli db:seed` | `db/seeders/seed.ts` |
| `litestone seed` | `cfg.seeder` ?? `./seeders/DatabaseSeeder.js` |
| basecamp | `db/seed.js`, behind a `db:seed` script |
| example | no seeder at all |

`resolveSeeder()` in `commands/db/_module.md` now ASKS the app instead of adding
a fourth guess: `litestone.config.js`'s `seeder:` first, then the `db:seed` /
`seed` script in `package.json`, then a probe of the five known locations, then
an error that names everything it looked for.

**The script is preferred over the path it resolves to**, because a seed script
often does more than run one file — reset first, migrate, set an env var — and
that is what the app author meant by "seed". A script that calls `fli db:seed`
itself is skipped rather than recursed into.

`--force` passes through, which is what re-seeding an app that already has rows
needs; without it litestone's seeder stops on the first `UNIQUE constraint`.

## 2026-08-14 — `fli dev` says when the database is empty, and knows which runner to use

**The failure it exists for:** an app with an empty database boots clean, serves
every route, answers every request correctly, and shows a person a blank screen.
Nothing is broken, so nothing speaks, and the first ten minutes go into looking
for a bug in the app.

`core/db-preflight.js` is the check, and it has two callers — `utils:dev` and
`ports:dev` — because `dev` is an alias on both and which one answers depends on
discovery order. It reports three states and refuses nothing: the database does
not exist, it has no tables (migrations have not run), or every table has zero
rows. `--no-check` skips it.

Three things it gets right that the CLI's own `resolveDb` does not:

- **The path comes from the schema's `database` declaration**, which is what
  litestone opens and which WINS over `createClient({ db })`. `resolveDb`
  assumes `development.db` / `test.db` and would look at a file basecamp has
  never had. `litestone.config.js` is the fallback.
- **`env("DATABASE_URL", "./db/x.db")` yields to the variable** when it is set,
  or the check reports on a file the app is not going to open.
- **Litestone's own `_migrations` table does not count as data.** A freshly
  migrated database has rows in it and nothing else, which is exactly the state
  worth naming.

`node:sqlite` arrived in Node 22.5 and fli's floor is 20.6, so the binding is
optional and its absence costs the row count, not the check — the file-level
signals need nothing. It takes `bun:sqlite` too, because nothing stops `fli`
being run under bun and a node-only import would make the check blind rather
than wrong. The experimental-feature warning is muted across the import; a Node
implementation note has no business on top of `fli dev`.

**And `utils:dev` had been running the wrong runner in every workspace.** It
tested for `bun.lock` beside `package.json` — but a package inside a workspace
has no lockfile of its own, so it reported *npm detected* for every package in
this monorepo and then ran npm. `detectRunner()` walks up.

## 2026-08-14 — two commands can claim one alias, and now it says so

The registry only warned when an alias collided with a command's TITLE, so an
alias-vs-alias collision was silent: four were contested — `doctor`, `new`,
`audit`, `dev` — and the winner was whichever loaded last. `fli dev` ran
`utils:dev` and nothing anywhere said `ports:dev` existed.

It warns now, naming both and saying which one answers. The precedence was left
alone at this point, on the reasoning that `fli new` had always meant
`project:new` by virtue of load order and every doc plus two CI phases call it —
making first-wins would have moved it silently. That reasoning was half right
and the warning is what exposed the other half: **load order was `readdirSync`
order, not the alphabet**, so the resolution was never stable in the first
place. See *no alias is contested, and discovery is sorted* above, which sorts
the walk and renames every contested side.
 — @frontierjs/cli

## 2026-08-14 — three numbers, one crossing

**Two numbers that were already in files and on no page.** A plate now carries
its typecheck ceiling from `scripts/typecheck-baselines.json` — absent is 0 and
0 is *clean*, said rather than left blank — and an app carries the ports the
formula gives it, which is the number wanted immediately before running a drive
and was one table away.

**Where an open row actually points.** Every row's Detail column links its
evidence, and those links are paths into this tree — the one place the register
says WHERE. Counted per file and filed onto the package that owns the path, so a
dossier answers *is anything filed against this file* with the file already
open. Scoped to the card's own home on purpose: half the register links the root
`CLAUDE.md`, and counting those per package would make the busiest rows the
busiest files everywhere. A doc topic whose own file is named by an open row
carries the count on its tile, which is how you find the capability to read
first.

**Invariants against the rules that check them.** The root `CLAUDE.md` numbers
19; `core/checks.js` exports 10 rules and each names the invariant it comes
from — and nothing crossed the two, so *which of these does a machine actually
enforce* was a question you answered by reading both. Crossed on the workspace
plate: **5 of 19 are enforced, 14 are held up by attention**, which is the
finding, not the decoration. Two rules guard a live hazard rather than an
invariant and say so.

⌘K indexes the new nouns too — 518 rows now, including every invariant and every
file an open row names.

## 2026-08-14 — `fli ws:atlas --live`, and the theme goes home

**The theme moved into the package that owns themes.** `theme-field` is now
`@frontierjs/css`'s `themes/field.css`, and the atlas READS it out of the
workspace — or out of `node_modules`, for an app — and inlines it, rather than
carrying a copy. Two copies of a palette drift and the copy is the one nobody
edits. It has to be read at all because the page links the published bundle,
which lags the workspace by a release; absent, the page offers the themes the
bundle does have and defaults to one of those rather than rendering unthemed.
The nine realm accents stay in the page: a category is an app's fact, not a
design system's.

**`--live` is the ungated sibling.** A committed page is byte-compared, so it
can hold neither a clock nor an answer from the network — which rules out the
two things most often wanted about a package. `fli ws:atlas --live` writes
`repo-atlas.live.html`: **no generator line**, a timestamp on the page,
`.gitignore`d, and `--check --live` refused outright rather than quietly
comparing something that cannot match. Per package: last commit and its
subject, commits in 90 days, uncommitted files, and local version against the
registry. That last column is `FJS-252`'s whole class — every id in the open
register is a statement about the tree, so *published is a release behind* is
invisible from inside it. The first run over this workspace found **ten**
packages ahead, including `cli` at 0.1.1 against a published `0.0.0-beta.0`.

## 2026-08-14 — the atlas answers a word, a change, and a glance

Three additions, each closing a gap the page had while looking complete.

**⌘K searches everything.** The deck's box narrowed plates and a dossier's box
narrowed one dossier, which left the thing somebody actually arrives with — a
word — matching nothing. One index over every noun the page holds: 400 rows here
across parts, actions, open rows, documented capabilities, commands, snapshots,
drives, scripts, CI phases and registers. Ranked rather than filtered (a prefix
on the title beats a hit buried in a subtitle), arrow keys and Enter, and every
route it offers is checked by a test to name a dossier the page actually
rendered — a palette that lands nowhere is worse than none, because it is
confidently wrong at the moment somebody is lost. Built at generation time, not
harvested at load: a corpus assembled in the browser can differ from what the
committed file says.

**Every plate says what proves a change to it.** The root `CLAUDE.md` carries a
`Changed → Run` table — *changed the compiler, run the SSR drive AND the
hydration one, they fail apart* — which is the highest-value paragraph in the
file and lives in exactly one place, in prose, read top to bottom by nobody who
needs it. It is parsed and filed onto the plate it names. A row naming three
packages shows on all three; a row that names a package as the drive to RUN
rather than the thing CHANGED does not file it there, which is the mistake the
obvious implementation makes.

**A count says twenty-one, not twenty-one of what.** Each plate carries a heat
strip — one segment per severity, sized by share, in the register's own tones —
so two S2s read as worse than twenty S4s at a glance.

## 2026-08-14 — the atlas is written in the styling language

It was not. The first cut of `fli ws:atlas` carried ~120 hand-rolled rules and
raw hex — a small bespoke design system inside a generator, which is exactly
what Invariant 13 exists to stop. It is now `@frontierjs/css`: Topbar, Card,
Dialog, Table, Facts, Item, Badge, Pill, Field, Chip, and the Layout terms.

**The field-manual look is now a theme, not a stylesheet.** `theme-field` — ink
ground, sand ink, a serif display over a monospace body, square-ish corners —
is a token block and nothing else, which is the discipline `themes/press.css`
sets: what needs a selector of its own names a missing token. It is the atlas's
default and sits in the picker beside the package's nine. One token it wanted
and could not have: heading tracking, which no `--*-letter-spacing` covers, so
the atlas tracks its own display type instead.

Its real home is `packages/css/src/themes/field.css`. It lives in the page while
the stylesheet is a CDN link, because a theme in the workspace is not a theme in
the registry (`FJS-256`).

**Two axes, not one.** A tone says how to READ a thing — `danger` is a defect,
`success` is a phase that passed. A realm says which family it BELONGS to, and
the vocabulary has no word for that, correctly: a category is an app's fact, not
a design system's. So the atlas derives nine realm accents from the seven tone
tokens — `--realm`, mixed in oklab where the tones do not reach, used for the
plate's rule, its motif and its badge and never for body text. No hex, and a
theme moves all nine at once. The two that mix to the same place are eight
realms wearing nine names, which is why `testing` and `cross` are measured
apart rather than assumed apart.

**A tone carries the meaning a color used to.** An S1 defect is `danger`, a
ruling is `info`, a claimed folder is `muted`, a fast CI phase is `success`. No
hex is written for any of them, which is what makes the **nine themes** work —
the topbar carries a picker over `default · dark · midnight · forest · sunset ·
elite · basecamp · notebook · press`, remembered in `localStorage`. A test fails
a color literal in the page's own stylesheet, because that is the rule that
would otherwise erode one convenience at a time.

What is still hand-written is only what the vocabulary has no word for: the
deck's grid, the plate art, the field-manual display face. All of it unlayered —
the bundle declares `@layer`, and unlayered rules beat every layer, so nothing
needs a specificity fight or an `!important` — and every value is a token, so
the themes reach it too.

A dossier is now a real `<dialog>` opened with `showModal()`, so the backdrop,
the focus trap and Escape are the platform's rather than this file's.

**The stylesheet is a CDN link for now, and that is a known cost**: the page no
longer renders offline from a `file://` path, and the range is derived from the
workspace's own copy rather than pinned because the local version runs ahead of
the published one. `FJS-256` holds the fix — inline the 71KB bundle at
generation time, fall back to the link.

## 2026-08-14 — `fli ws:atlas` — two doors, and the surface behind each plate

**Nobody arrives knowing the name of the package that owns their problem.** They
arrive with a realm or with a verb, so the atlas front page now opens with both:
*search by realm*, which filters the deck, and *search by action*, which pools
every runnable thing in the workspace — a command, a script, a drive, a CI
phase, a snapshot generator — and answers *how do I deploy* with all of them at
once. The vocabulary of verbs is curated; the membership is not, so an action
lists what is actually there and one nothing answers to is not offered. All
three doors are routes (`#/part/…`, `#/do/…`, `#/realm/…`), so any of them is a
link somebody can send.

**Every dossier carries its own search.** Litestone's runs to ninety-odd
searchable units, so the sheet gets a box that narrows the rows, topic tiles and
chips inside it and nothing else — and a block whose units have all gone hides
with them, because a heading over nothing reads as *this package has none*,
which is the opposite of an empty result. Opening a dossier clears the box and
focuses it; `/` focuses whichever box is in front, `Esc` clears it and then
closes the sheet.

**And a plate now opens onto what the package does**, which is the question
that made the deck insufficient: `docs/` is one file per capability and the
README's own `##` headings are the second index, so litestone's dossier lists
35 topics and 34 sections, each a link to the document itself. A feature list
this file invented would be wrong within a fortnight; a list of documents
somebody wrote is a list of documents somebody wrote.

## 2026-08-14 — `fli ws:atlas` — the same model, the other question

A plate per part of the workspace, each opening into a dossier: what it depends
on and what depends on it, the issues filed against it, the snapshots it owns
with the command that regenerates each, the drives that prove it, and for `cli`
its command namespaces. Package, app, workspace and claimed folder are four
kinds of plate, because they are four different things: an app is never
published and is where the seams are crossed, and a folder with no
`package.json` is a plan rather than a part.

**Three vocabularies name one noun** — the register files by short name
(`litestone`, `repo`, and `cli/auth` for a defect living in two), the snapshot
walker by path, the drives by directory — so the crossing is done in
`core/repo-atlas.js` and a row filed against two packages shows on both rather
than on neither.

The realm on each plate is parsed out of the root `CLAUDE.md` table rather than
restated, so a package that moves realm moves here; one the table forgets reads
*unfiled* rather than being quietly labeled. `core/repo-map.js` gained the
readers both pages share: that table, the app directories, and the inverse
dependency edge no file states.

It does not replace `fli ws:map`. The map answers *what do I run and where*; the
atlas answers *what is in here and what does it touch*, and a page answering
both would answer neither.

## 2026-08-14 — `fli ws:map` — the map, read rather than written

One page saying what is in a workspace and how to run it: the scripts at the
root, every snapshot with the command that regenerates it and the directory to
run it from, the CI phases in call order, the open register by severity, the
packages with the siblings each depends on, every `verify*` drive, the port
registry, the command tree, and each root markdown file quoted by its own
opening claim.

**Nothing on it is typed twice.** The hand-written version of this page was
wrong within a fortnight, which is the failure the command exists to stop: a row
is either read from a file that would break something else if it were wrong, or
it is not on the page. `core/repo-map.js` holds the readers; the phases come out
of `main()` in `scripts/ci.mjs`, so a phase that moves tier moves here too, and
the description is the phase's own section comment rather than a second copy of
it.

A section whose source is absent is omitted rather than faked — a client app has
no `scripts/ci.mjs` and no `ISSUES.md`.

Output is `repo-map.snapshot.html` at the workspace root, self-contained because
it is usually opened from a `file://` path: no stylesheet, no font, no fetch.
It names its own generator below the doctype (above one is quirks mode), so the
`snapshots` phase rechecks it without being told. Nothing in it varies between
two runs over one tree — no dates, no timings, every list sorted — and because
the page lists every snapshot in the workspace and becomes one, the first
generation writes twice to land on the fixed point.

## 2026-08-14 — `fli test:snapshots` — the gate an app was missing

Six generators shipped this week — `litestone access`, `litestone ddl`,
`litestone jsonschema --snapshot`, `junction surface`, `junction errors`,
`sierra routes` — and the thing that RUNS them lived in `scripts/ci.mjs`. So a
consuming app got every generator and no gate: a framework publishing half a
feature.

`core/snapshots.js` is that half, extracted, with the two callers `core/checks.js`
already has — `fli test:snapshots` over a client app, `scripts/ci.mjs`'s
`snapshots` phase over this repo. It walks for `*.snapshot.*`, reads the
`generated by:` line out of each header, and reruns that command with `--check`
from the file's own directory. Zero dependencies, plain ESM, node or bun,
because `ci.mjs` imports it before anything is installed.

**A header is data and this executes it**, so the binary must be one of
`litestone`/`junction`/`sierra`/`fli` and every argument a plain flag or path;
both are refused by name. A snapshot naming no generator is a FAILURE rather
than a skip — a generated file nothing can recheck is a document wearing a
gate's clothes.

One thing stays in `ci.mjs` on purpose: a snapshot tracked at the base ref and
absent now. That is a question about this repo's history, not about an app, and
discovery alone answers it in green.

## 2026-08-14 — `fli ws:exports` — the published surface, committed

`exports.snapshot.md` at the workspace root: per publishable package, the
top-level entries its tarball actually contains, every `exports` subpath, `bin`,
`main` and `types` target marked with whether that tarball holds it, and the
peer ranges naming a sibling. `--check` byte-compares; the `snapshots` CI phase
reruns it from the header the file carries.

`FJS-251` broke every npm install past 836 green Sierra tests, because an app in
this repo resolves a sibling to `packages/<name>/` and never to a `node_modules`
path. `scaffold` catches that class end to end in about seven seconds; this is
the cheap half — an entry point `files:` does not publish is decidable from the
tarball listing alone.

**The listing is asked of the packer**, `bun pm pack --dry-run` per package,
because npm's `files:` semantics are their own thing (a bare directory name
means everything under it; README, LICENSE and package.json are always in) and a
second implementation would disagree with the publish exactly when it mattered.
**A `*` in an `exports` target is Node's subpath pattern and matches across
`/`** — read as a shell glob, the first run reported `@frontierjs/ui` as
shipping none of its 64 components and `@frontierjs/css` none of its stylesheets.
Top-level entries only, and no versions: a snapshot that moves on every commit or
every release is one nobody reads on the change that mattered.

## 2026-08-14 — the deploy checks ask litestream's version, not the process table

`FJS-243`, the checking half. Three commands ran `pgrep -x litestream` and
reported the answer as *replication is healthy*. It is not the same question.

litestream 0.3.x cannot parse the STRICT tables litestone emits. Pointed at a
litestone database it starts, prints `replicating to:`, and then loops forever
on `malformed database schema … near "STRICT": syntax error` **without ever
exiting** — a live process, an empty replica, and every check here agreeing it
was fine. Demonstrated on this machine, which carries v0.3.4.

`litestreamStatus()` in `deploy/_module.md` is now the one owner, and the three
callers grade it differently on purpose:

- **`01-preflight`** — a warning. Blocking a deploy on the replication tool is
  worse than the state it describes, and an operator mid-incident needs the
  deploy. It cannot be quiet, though: the defect was a check that called this
  healthy.
- **`deploy:status`** — says it plainly, with the version.
- **`deploy:doctor`** — a **failure**. An absent litestream is optional; a
  running one that replicates nothing is a believed backup that does not exist.

A version it cannot read reports UNKNOWN, never fine — assuming is what the old
check did. `LITESTREAM_MIN` is a hand copy of litestone's floor in
`src/tools/replicate.js`: change one, change both. The CLI cannot import it,
because litestream reaches the server as a binary.

**Two regressions from the `FJS-250` narrowing surfaced here, both invisible to
the parse sweep.** A command using a `_module.md` helper compiles whether or not
the module defines it, so only running one says anything:

- **`context.config` was initialized inside the steps runner**, so every command
  in `commands/deploy/` had it by accident. Narrowing the inheritance left
  `deploy:doctor` throwing `undefined is not an object` on
  `context.config.abort = true`. It is per-run scratch and now exists for every
  command — reading your own scratch object should not require being a pipeline.
- **`deploy:rollback` and `deploy:setup` reached their steps by *setting*
  `context.config.stepsDir`**, which only worked because they inherited `_steps/`
  first. Setting stepsDir redirects a steps run; it does not start one. Both now
  declare `steps:` in their frontmatter.

**And steps are compiled with their namespace module now.** They were compiled
with an empty one, so a helper was reachable from the orchestrator and
`is not defined` from the step beside it — which pushes shared logic into
whichever step needs it first and leaves the next to copy it. A step is the
deepest part of a namespace, not a stranger to it.

Verified by driving every deploy command against a fake `ssh` answering as a
server running v0.3.4, v0.5.16, nothing, and an unparseable version — all four
graded correctly at all three sites. Two new scenarios in `tests/zz-steps.test.js`
pin the runtime halves, each checked against a negative control.

## 2026-08-14 — `deploy:local` is a gate: it stops lying, and it can fail

`FJS-250`, found while building CI's `deploy` phase on top of this command.
Three defects, and each one on its own makes the command useless as a check.

**`_steps/` was inherited by every sibling in its directory.** `runtime.js`
attached `<dir>/_steps` to any `.md` beside it, and `commands/deploy/` still
carries the legacy CapRover steps. So `deploy:local` printed its own plan and
then ran them:

```
~ Would build: docker build -t demo:local -f deploy/Dockerfile .
·   [1/3] 01-api
~ ssh undefined "npm run deploy:api --prefix='undefined'"
✓ Deployed to undefined in NaNs
```

The command whose whole purpose is a safe local rehearsal claimed a deployment
that never happened. `deploy:status` and `deploy:logs` did the same.

**Only the directory's index is the orchestrator now.** A non-index command opts
in by naming the folder — `steps: _steps-docker` in its frontmatter — and a
declared folder that does not exist is an error, not a silent skip. Every other
steps folder in the tree (`db/import`, `db/reset`, `npm/release`,
`workspace/publish`) sits beside nothing but an index, so none of them moved.

**Every `deploy:local` failure path exited 0.** `log.error` writes a line and
nothing more; the exit code comes from a thrown error. So a failed health check
printed `✗ Health check failed`, returned, and the shell saw success — which is
the one thing a gate may not do. All four paths throw now.

**And `--port` had never worked.** The argv parser types a value by how it
looks, before the command's declaration is consulted, so `--port 7100` arrived
at a `type: string` flag as a number and was refused as *must be type string*.
Fixed at the owner — the value is coerced toward the DECLARED type and then
checked — which also unbroke `fli deploy:logs --tail 200`, the command's own
documented example, and `cloudflare:dns`.

Pinned by four scenarios in `tests/zz-steps.test.js` over a new
`tests/fixtures/sibling-steps/`, each checked against a negative control:
widening the rule back fails the sibling test.

## 2026-08-14 — `fli scaffold <Model>` is run against a real installed app now

`FJS-036`. The templates had been updated twice and never put through the command
that uses them. CI's `scaffold` phase packed the working tree, installed a fresh
app and built it — and stopped one step short of the thing the row is about:
growing the app.

It now runs `fli scaffold Note --fields 'title:string body:text'` against the
installed app and builds again. Four generated files across all three realms, each
named individually rather than trusted to the exit code — `fli scaffold` reports
success per file, so a step that wrote nothing would otherwise pass:

```
db/schema.lite                        model Note { … }
api/src/services/notes.service.ts     the plural accessor
web/src/resources/Note.mesa           PascalCase singular — Invariant 19
web/src/routes/notes/index.mesa
```

Two of those four names are Invariant 19 in executable form. The second build is
what makes them more than files on disk.

## 2026-08-14 — `auth:install` scaffolded an auth.ts that could not import

Found while aligning the identity ladder, by running the shape the command
writes rather than reading it. Three defects in one file, each of which fails at
the first `bun run`:

- `createFjsAuth` and `createFjsAuthPlugin` are not exported by
  `@frontierjs/auth` — the names are `createLitestoneAuth` and
  `createAuthPlugin`. `project/_module.md` detected an installed auth by
  grepping for the same two absent names.
- `createClient('./db/schema.lite', { … })` — `createClient` destructures a
  single options object, so the positional form passes no schema at all.
- `encryption: { key }` is not an option; the key is `encryptionKey`.

Also aligned with the schema the same command writes: the generated `getLevel`
graded `userType === 'admin'` while `schema.lite`'s row and field policies read
`auth().isAdmin`, so a level and a policy disagreed about who an administrator
is — silently, because a policy filters rather than refuses. The resolver now
grades standing, and the generated `auth.ts` projects the app's own meaning of
'admin' onto it once, in `sessionFields`.

Verified by running the generated shape end to end against real packages:
client boots, register and login work, `role: 'admin'` reaches the session as
`isAdmin`, and an admin can write another user's role while an ordinary caller
cannot.

## 2026-08-14 — `fli new --full` installs

`--with litestream` named a package that exists neither on npm nor on disk.
Litestream is a Go binary that runs beside the app on the server; it is not a
dependency, and listing it in `validExtras` put `@frontierjs/litestream` into
`FJS_VERSIONS` and therefore into the generated manifest. `--full` adds every
extra, so **`fli new --full` failed in both directions**: `--source local`
aborted before writing anything (no `packages/litestream`), and `--source npm`
wrote the dep and 404'd at `bun install`.

`--with litestream` is now recognized by name rather than dropped, so the flag
says where the thing went instead of calling it unknown:

```
⚠ "litestream" is a server binary, not a dependency —
  see `litestone replicate` and `fli deploy:setup` — nothing to add here.
```

Verified by scaffolding `--full` for real against npm and installing: 136
packages, nine `@frontierjs/*`, no litestream anywhere in the output.

The capability behind the flag is worth having, and `FJS-242` is what it needs
first — `litestone replicate` reads one database path out of a config file
`fli new` does not write, while a schema declares many. `litestone backup`
already resolves every declared database from the schema; replication has not
caught up.

## 2026-08-14 — the API and the web can be deployed to different machines

`fli deploy` had one `server` and one `path`: the web release and the API
container went to the same box, and per-target overrides moved an *environment*,
never a *side*. `deploy:rollback` has had `--web` / `--api` since it was written,
so the rollback half already assumed a split the deploy half could not express.

`api` and `web` may now each carry their own `server` / `user` / `path`, joining
blocks that already exist (`deploy.api` had port/health/dockerfile, `deploy.web`
had domain/keep_releases/ssl). Most specific wins and a silent side inherits, so
an unsplit config resolves exactly as it did:

```
deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
```

```
fli deploy              # both halves
fli deploy --api        # API only
fli deploy --web        # web only
```

**A lock is per machine+path, not per run.** Two apps sharing a server are two
locks; one app split across two servers is two. A run that cannot take the second
lock releases the first rather than stranding it, and `09-cleanup` releases every
lock the run took — a split that aborted after locking both otherwise left the web
host locked with nothing to clear it.

**Both hosts are SSH-checked before anything moves**, and **a split whose hosts
are on different commits is refused**: each side builds from source on its own
machine, so divergent checkouts ship two versions under one release name. That is
the failure this feature is most likely to cause, so it fails loudly rather than
silently succeeding.

The transport already assumed nothing about co-location — the browser client
takes an absolute `url`, and `/ws` is registered beneath the router (`app.http.ws`,
not `app.get`) so it never carried `apiPrefix` in the first place. What a split
does need is CORS: Junction's default is `origins: []` deliberately, and the
WebSocket upgrade is an HTTP request, so it needs the same allowance.

Verified against scaffolded apps: the resolution matrix (unsplit, per-target,
per-side, per-target-and-side, inherited, unresolvable) and all three scopes
driven through the real command.

## 2026-08-13 — the Dockerfile matches the layout the scaffold actually writes

`FJS-232`. `make:deploy`'s template copied `api/package.json`, `api/bun.lockb*`
and `api/tsconfig*.json`, ran `bun run src/server.ts`, and never copied `db/` —
against a scaffold that writes one manifest at the app root, `api/index.ts` as
the entry, and the schema under `db/`.

**The root `README.md` § Project Structure had already ruled it** (Invariant 3),
so the template moved, not the app:

```dockerfile
COPY package.json bun.lock* ./
COPY api ./api
COPY db  ./db
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
```

`db/` is load-bearing twice: the entrypoint migrates and the pre-swap backup runs
`litestone backup`, and both find the databases by reading the schema. `fli new`
now writes the `db:migrate` and `db:backup` scripts the entrypoint calls —
`--schema db/schema.lite` also fixes the migrations directory, since litestone
resolves it as a sibling of the schema. `deploy:doctor` checks the ROOT manifest
for `db:migrate` + `start`, and warns when the Dockerfile has no `COPY db`.

**Verified by building it**: the image builds, `bun run db:migrate` resolves the
schema and creates the database inside the container, the app boots and answers
its health endpoint. Running it is also what caught the doctor rewrite leaving a
dangling `apiPkg` reference — valid JavaScript, so the parse sweep passed it.

What the build could not prove is filed as `FJS-241`: a scaffold made against
local sources carries `link:` dependency specs, which resolve on a laptop and
fail inside an image. That is why this path had never been run end to end.

## 2026-08-13 — the app backs itself up

`FJS-239`. `05-backup` shelled out to `sqlite3` on the host for the pre-deploy
snapshot. Two things wrong with that, and the second survives fixing the first.

**The binary was never installed** — `deploy:setup` provisions docker, nginx, git,
bun, rsync — and the step is `optional`, so on a server this tool set up the
snapshot warned once and the deploy went on into `06-swap`, whose container runs
migrations in its entrypoint.

**And `deploy.db.file` names one file.** A schema declares as many databases as it
likes; `example` and `basecamp` both declare `main` plus an `audit` logger. So even
with sqlite3 present, the snapshot would have copied the rows and left the trail.

Both go away by asking the app instead of reimplementing it: `docker exec
{appId}-api … litestone backup`, run before the swap so it captures the OLD
container while it is still serving. `litestone backup` reads the schema and
copies every declared database — SQLite hot through `$backup`, JSONL/logger
directories beside them. No host binary. First deploy has no container and says so
rather than failing.

`fli db:backup` had the same bug and a worse one: it backed up `development.db` or
`test.db`, names the CLI invented — a litestone app's paths come from `database`
blocks in the schema. It delegates now too, and gained `--vacuum` / `--zip` /
`--db` from the thing it delegates to.

`sqlite3` stays in `deploy:setup`, because an operator on a box running SQLite
wants a shell against it — with a comment that no longer claims the pipeline needs
it.

Pointing the deploy at `litestone backup` is also what exposed `FJS-240`: it was
reporting a partial backup as a success.

## 2026-08-13 — the deploy pipeline, swept: a leaked lock, a rollback of working code, a backup that never ran

Four defects, all on the path `fli new` → `make:deploy` → `deploy`, all found by
reading rather than by anything failing. That is the finding underneath the four.

**A step that threw skipped the cleanup step written to run on failure** (`FJS-237`).
`09-cleanup` declares `runOnAbort: true` so a bad deploy still releases
`{serverPath}/.deploy.lock` — but the runner only honored that for the abort
*flag*, and `07-health` sets the flag **and then throws**. The throw exited the
group loop, cleanup never ran, and the next deploy refused while naming a deploy
that had finished minutes earlier. Fixed in `core/runtime.js`: a throw now records
the error, sets `abort`, lets the loop finish so `runOnAbort` steps get their turn,
and re-throws afterwards — so the exit code is unchanged and `runOnAbort` finally
means *runs on abort or throw*, for every `_steps` command. Pinned by
`tests/fixtures/cleanup-on-throw/`.

**The health check polled a path the scaffold cannot serve, and rolled back
working deploys** (`FJS-238`). `healthPlugin()` registers through `app.get()`, the
one owner of `apiPrefix`, so a scaffolded app answers at `/api/health` — and
`make:deploy` wrote `/health`. Twenty seconds of 404, then `07-health` stopped the
new container and restored the old one, reporting a healthy API as a failed deploy.
The remedy it printed could not have fixed it either: `app.get('/health', …)` moves
with the prefix too. `make:deploy` now resolves `apiPrefix` from the app's own files
and writes the full path, naming where it read it. Three downstream copies of the
same blindness went with it — `deploy:doctor` warned on every prefixed app, and
`04-build-api`, `deploy:local` and `doctor` all defaulted `dockerfile` to
`api/deploy/Dockerfile`, a path `make:deploy` has never written.

**`07-health` now prints the URL it polled**, because a rollback that names nothing
reads as the application's fault.

**`deploy:setup` never installed `sqlite3`** (`FJS-239`, still open for its shape).
`05-backup` shells out to it for the pre-deploy snapshot and is `optional`, so on a
server this command set up, the backup warned once and the deploy carried on into
migrations with no snapshot — the one step whose purpose is to run before something
irreversible was the one not running.

Verified by scaffolding both app shapes into a temp directory and running the real
`make:deploy` and `deploy:doctor` against them.

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
