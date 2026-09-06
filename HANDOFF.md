# Handoff

**The two most recent sessions, narrative. Older ones rotate into
`docs/handoff-archive/`.** This is an assessment file (`PHILOSOPHY.md` §VII):
dated, never cited as behavior, and read cold rather than consulted.

**It names nothing a register does not also hold.** A defect gets an id in
`ISSUES.md`, a settled argument a ruling in `DECISIONS.md`, a shipped change a
line in the package's `CHANGES.md`, and a live fact a sentence in a `CLAUDE.md`.
What belongs here is the ORDER those were found in and why one led to the next —
the half a register cannot carry, and the half that costs nothing when the entry
rotates out. A session that ends with something recorded only here has not
finished.

---

# Handoff — 2026-09-05 (a lesson for the thing an app has to say)

> **`@frontierjs/notifications` had no tutorial coverage of any kind**, and
> neither did the mail path under it — `app.notify`, `defineNotification` and
> `IMail` appeared in no lesson. `tutor:notify` is lesson 7 now, eight steps and
> twenty assertions, sitting after `tutor:jobs` because the two are the same
> argument from opposite ends: one is *do it later*, the other is *tell somebody
> now*, and the refusal in this one points back at the other.

> **Every beat was measured before it was written**, which is the only reason
> the sharp ones are in it. A rename of a notification file is silent in BOTH
> directions — the old rows keep the old type and nothing warns — and it is only
> when a `type:` is stated that the loader says anything at all. A transport
> declared with no formatter refuses with `data: { committed: true }` on the
> response, so the note the hook fired on was written and stayed written while
> nothing was delivered. Neither of those is in the README; both are what an
> app hits at four in the afternoon.

> **The absence is asserted against a count taken a moment earlier**, and paired
> with the identical request once the transport is removed. A refusal with no
> control beside it is also what a broken app does.

> **Found by running it**: the step that states `type:` guarded on
> `src.includes('type:')`, and the file's own header comment says *the file
> names the type: NoteAdded* — so the guard read as already-done, the edit never
> happened, and the failure surfaced two assertions later as the loader being
> blamed for not reporting. Same shape as the `editSchema` bug the course run
> found the day before: a guard that asks a whole file whether it contains a
> string is asking the wrong question, and both times the wrong answer arrived
> disguised as a different component's bug.

> **`FJS-910` came out of writing step 1.** `@frontierjs/auth` ships its schema
> as `.lite` files an app imports, which is what lets an upgrade reach an
> installed app and what `fli check`'s `package-model-drift` grades against.
> `@frontierjs/notifications` ships none: its one required model exists only in
> a README, every app types it out, and the drift rule skips with *no dependency
> ships a .lite file*. The lesson has to write the model into the app for the
> same reason.

> **The course caught what the lesson could not.** The `Notification` model
> tripped `fli check`'s `polymorphic-subject`, and the symptom was two lessons
> away: `tutor:tools` asserts the check panel is CLEAN before it breaks it on
> purpose, so a lesson that leaves a warning behind makes a later lesson accuse
> a panel that is reporting correctly. Reproduced as three commands in one
> workspace, fixed in the model, and the package README now says the same thing
> to every app that copies it.

> **The insert renumbered six lessons** — a heading, a `Lesson N done` line and a
> next-pointer each — and none of that was checked by hand: `tutor-order` and
> `tutor-lesson-named` are rules, so a missed one is an error rather than a
> stale sentence. That machinery was built two days ago for exactly this move
> and this is the first time it has been used.

---

# Handoff — 2026-09-04 (the tools that report on an app, and three of them lying)

> **The tutorial had ten lessons about building an app and none about looking at
> one.** `fli tutor:tools` is lesson 2 now — `fli gui` (8500), `fli db:studio`
> (8502), junction's `devtools()` console (8503) and `fli project:view` (8501),
> with a question each and a *when to open which* at the end. The GUI is the
> starting point because it is the only one that knows about the other three.

> **Writing it found that three of the four were reporting something false**,
> which is the argument for the lesson: nothing in the repo had ever started one
> of these and asked it a question, so the surfaces whose whole job is to report
> on an app were the least graded thing in the tree.

> **`FJS-762` is the worst of them.** An anonymous POST answered 401 and arrived
> in the console's call feed as `notes create · ok`. `hooks.ts` sets `ctx.error`
> inside `runCore`, an AROUND hook wraps runCore, and `gateAuth` is an around
> hook — so *every auth refusal an app makes* was emitted as a success. A
> validation 400 was correct, because it is thrown from `validated:`, inside
> runCore, which is why the field looked as though it worked. The test is the
> pair, one call refused by an around hook and one allowed through the same
> service, since a fix that marked everything an error is indistinguishable from
> the refused side.

> **`FJS-763` is `FJS-449` surviving in one field.** Studio's `/api/info`
> reported `development.db` — `loadConfig`'s default, a file not on disk — while
> the studio was really reading the declared database. The printed banner had
> been fixed; the field a script reads had not. `--no-open` went in beside it,
> because a studio started by a test opens a browser window on the CI runner.

> **And every app `fli new` writes was warning about itself.** The generated
> `db.ts` passed its schema PATH under `createClient({ schema })` — which
> litestone reads as a path, and which `schema-in-memory` reports on, because the
> key is all a source reader can see. Now `path:`, the spelling litestone's own
> error message asks for.

> **The tutorial had no compiler for its own ORDER either**, and inserting a
> lesson showed it: the order is stated in `index.md`'s LESSONS array, in each
> lesson's `## Lesson N —` heading, and in each finish step's pointer at the next
> one, and moving nine lessons cost twenty hand edits. `core/tutorial.js` reads
> the course and two rules grade it, split the way the proof table is —
> `tutor-order` an error for naming something that is not there or contradicting
> the order, `tutor-lesson-named` a warning for a lesson the index does not list.
> It found a real dead end on its first run: `tutor:fleet` named no next lesson,
> so a person following the pointers stopped one short, and the *where to go from
> here* block was on lesson 10 rather than on the last one.

> **`tutor:ui` is the hole the other eleven left.** Data, API and Deployment were
> each taught by asking the running world; the UI realm — three packages — had
> one step, so a person finished the course having never seen a form. It opens a
> real page, asserts the generated form against the schema, then adds ONE
> attribute to one column and reloads: the same empty submit that was a legal
> write is now refused in the browser, and the assertion is that the row count
> did not move rather than that a message appeared. `core/browser.js` is the
> page driver it needed — small and shipped, because mesa's harness is a spec
> runner and `files:` does not publish it, so an installed app has none.

> **Three assumptions about the schema had to come out of three lessons**, and
> they are one mistake: an assertion keyed on a particular gate, a particular
> length rule or a particular field policy stops being an assertion the moment a
> LATER lesson edits that column, and every one of them was found by running the
> lessons in the order a person runs them. `tutor:tools`'s refusal pair is a
> signed-in read against an anonymous write now; `tutor:ui` takes its own rule
> back out before asking about the before, and reads the schema to decide whether
> the ticked box is part of what it asserts.

> **Two things about the lesson are worth keeping.** Its liveness assertion is
> graded by AGREEMENT rather than by `up`: the port comes out of the ports table,
> so running the API elsewhere makes `down` the correct answer, and the lesson
> probes that port itself and requires the two verdicts to match — false for a
> page reporting whatever it was told last, in either direction, at any port.
> And its refusal pair is a signed-in read against an anonymous write rather than
> the same caller twice, because lesson 3 raises the read gate on the model this
> lesson is looking at: a pair built on a particular gate stops being a pair the
> moment somebody edits the schema. Both were found by the lesson failing, in a
> workspace that had been through lesson 3.
