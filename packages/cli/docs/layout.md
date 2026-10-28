# cli — layout

The file-by-file map of `@frontierjs/cli`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
bin/       fli.js (the entry) · server.js · diagnose.js
core/
  compiler.js   .md command → JavaScript. Only a fence runs; an indented block
                is prose. `locate` maps a generated line to the module, the
                lifted <script> or the body — the offset alone covers the body
                Frontmatter is `@frontierjs/toolbelt/frontmatter`'s, and a
                refused block throws naming the file — never a reader here
  flags.js      what a declared flag or argument permits and how it is
                written — the `--no-push` spelling of a boolean that defaults
                on, `choices` and `min`/`max`, `kind` (what a value names, read
                only by completion), the flags every command has, and the
                declarations refused on every run. A leaf: `fli list`, `--help`
                and completion read it on the startup path, and `getConfig` is
                the one place a value is graded
  effects.js    `effects` and `confirm: human` — graded where flags are, and
                enforced in `Command()` before the body runs. `fli gui` runs a
                command in process, so a run with `emit` is never a terminal
  shell.js      `$` — the callable context `commandContext()` builds, and the
                shell behind the tag: `Bun.$` under fli's rules (captures unless
                `--verbose`, runs nothing under `--dry` through `log.dry`, throws
                with the command named). One object: steps get their own
                callable copy because a spread copies fields and not calls
  scope.js      the names a compiled command uses and binds nowhere, and a name
                declared twice in one scope — real lexical scopes over the unit
                the runtime loads, with the PROJECT's TypeScript as the parser.
                `command-resolves` and `test/scope.test.js` both read it
  tty.js        `$.tty` — single-key prompts, a typed line, a hidden one, a footer line, the
                screen lent to an editor, onExit. It patches stdout and stderr while it
                holds the terminal, and the runtime's SIGINT/SIGTERM handlers
                await `settleTtys()` before exiting. The terminal is put back
                on every path; onExit runs on every one but a bare `process.exit`
  color.js      `chalk` — fli's own, no dependency. Styles nest and never chain
                as properties; a line mixing styles is the tag, chalk-template's
                `{bold.cyan x}`, which reads markup only from the literal parts.
                A new command prints that way — README § Printing a line. An
                inner close reopens the outer style, since dim and bold share
                one close code. `chalk.fileLink(text, path, line)` is a
                clickable `file:line` (OSC 8), off wherever color is
  text.js       `echo.lines` — a block of output rows; false and null rows
                dropped. `untag`, which lets `echo` be a template tag. `plural(n, word)`
  install-preflight.js  `fli dev`'s third preflight — every declared package
                installed, looked for by name walking up, and the `link:` targets
                this machine's bun never registered, which fail `bun install` itself
  env-preflight.js  `fli dev`'s key preflight — whether `.env` gives the API the
                `ENCRYPTION_KEY` its `.env.example` names. Only that key: fli
                can make random bytes and no other blank is fli's to fill.
                `fillKey` is the same rule for `deploy:setup`'s first seed,
                written into the LOCAL `.env.production` (`FJS-D1381`)
  dev-run.js    `fli dev`'s surfaces as one labeled stream — each its own process
                group, stopped as one on exit, so a launcher's child never keeps a port.
                Compact by default: children get `FLI_DEV=1` and print one ready
                line each (`@frontierjs/toolbelt/devline`), laid out as one summary;
                every other line is HELD until it prints, never dropped, and a
                surface that exits or stays silent past `settleMs` releases it
  open-url.js   a URL in the person's browser — argv, detached; `fli dev`'s `o`,
                `fli gui --open`
  clipboard.js  text onto the clipboard over stdin, never a shell string —
                `env:send`'s link, `crypto:keygen --copy`
  requires.js   what a namespace's `_module.md`, or one command's frontmatter, says it cannot run without —
                `- KEY` or `- KEY: <url where one is made> <what to pick there>`, read by the
                runtime, the doctor, `--verbose` and the gui through one
                `requiresOf`. At a terminal a missing key is ACQUIRED: the page
                offered, the paste stored, the run goes on; with no person
                present it is the refusal, plus a placeholder in the global env.
                A command may call `acquireMissing` itself (`env:send`'s `VW_*`)
                with `ttyPrompts(tty)`; a `secret` entry is read without echo
  global-env.js `~/.config/fli/.env` — the one spelling of the path, the line
                writer `fli eset` uses, the placeholder and the header. `~/.fli/`
                is machine state (locks, caches, a walk's defaults), never a key.
                `pickEnv` is the keys a send carries, for `env:send` and
                `tell --env`
  command-parse.js  does every command in a routes tree parse — each compiled
                with the module the runtime pairs it with, checked by `node
                --check`, reported at the `.md` line. The `command-parses` rule
                and the shipped-command sweep both call it
  runtime.js    executes a compiled command
  registry.js   command discovery and resolution
  prose.js      the markdown side
  checks.js     the architecture rules — shared with scripts/ci.mjs. The rule
                table, the runner, the baseline and the fixes; a rule's BODY is
                in `checks/` by realm: `data.js`, `api.js`, `ui.js`, then
                `app.js` for an app-scope rule belonging to no realm and
                `repo.js` for the workspace's own, each exporting its slice of
                `CHECKS`; `lib.js` is the readers two slices share. A reader
                one slice uses stays in that slice
  tree.js       what a clone of this root holds — tracked plus unignored
                untracked. A check that asks the disk instead is green here and
                red on a runner; `null` without git, and the caller uses the disk
  bun-fence.js  a temp `BUN_INSTALL` for a run that scaffolds `--source local`,
                whose `bun link` otherwise re-points the machine's global `fli`
                at this tree. `scripts/ci.mjs` and `scaffold-build.mjs` fence
                themselves at start (`FJS-1364`), and a fix-loop lane's session
                runs under one for its whole length (`laneEnv`, `FJS-3258`)
  runnables.js  what this project can START — surfaces, tools, drives, suites,
                tasks, snapshots, pages, each a row with an id, a command and a port.
                A PAGE is an HTML file a command declares in its frontmatter
                (`pages:` — file and flags) and reads its own default output
                name back from (`metadata.pages`), so the row and the file
                cannot disagree; `readPage(root, row)` serves one by ROW, never
                by path, for `fli gui` and basecamp's /pages/. `tasks(root)`
                is exported alone for the workbench's Run tab, which cannot pay
                the snapshot walk
                Derived from files that would break something else if they were
                wrong; `repo-map.js` reads the same readers. `probeState` is the
                one answer to which of them are up, and it has FOUR — `unknown`
                is a row with no port, which is a different sentence from `down`
  children.js   the process table behind a start button. Two runners allowed and
                nothing else, `detached: true` and a `-pid` kill because a child
                is a LAUNCHER: signaling the pid kills the wrapper and leaves
                the server answering. It also keeps the LAST finished run per
                row — facts only (when, how long, the exit, and whether the stop
                was asked for), because the words differ by kind and belong to
                the page. `stopped` is marked before the signal: a SIGTERM looks
                the same whoever sent it
  ci-log.js     the CI run log — `scripts/ci.mjs` appends events to
                `.cache/ci-runs/` DURING the run, and `/api/ci` folds them. One
                owner of the format, the test counts and the reading, so the
                runner and the page cannot drift. A count is `null` when no
                summary was readable and `partial` when part of the script was
                not — never 0, which must mean *ran nothing*. Starting a run is
                `node scripts/ci.mjs` with flags built from names, its own
                process group so `stop` takes the suite too; one at a time
  advisories.js what the `advisories` CI phase fails on — the runtime closure
                of every published package, and the advised packages in it
                (THREATS B16). Walked by node's lookup chain, never through a
                package's `exports`, and tested under NODE: bun resolves a
                `package.json` an exports map hides, so a bun-only test passes
                the walk that let a high advisory through (`FJS-3370`)
  release-view.js the Release realm read rather than typed — the pivot verdict
                per app (local, free, on page load) and what is SERVING (remote,
                a press). The split is the design: every other panel on that page
                reads the tree, and a panel that ssh'd while a page loaded would
                be the monitoring agent this realm refuses. It re-derives no
                verdict — `classifyPivot` and the revert refusals are reached by
                running the command that owns them, because a second
                implementation is how the GUI ends up disagreeing with the
                terminal about whether a deploy can be undone. It also owns
                the release IN ORDER — `RELEASE_STEPS`, the allow-list the
                Release screen runs from, each step `fli <argv>` in the root or
                one app, looked up by key and never composed from a request.
                `spawnStep` is the one runner behind every walked flow
  publish-view.js `ws:pub` walked — `PUBLISH_STEPS`, and the gate every
                page option passes before argv: `ws:pub` pastes `--tag` and
                `--otp` into a shell string, so a value is refused, never
                escaped, and `--filter` matches by SUBSTRING, so a package
                whose name would select a second one is refused too
  latency.js    request latency as a tail at a constant arrival rate, counted from the
                scheduled instant so a stall lengthens it. A case with a failed request
                or no samples is an error, never a fast p99. Reported, never gated;
                `scaffoldCases` is the `fli new` app's four (read, list, gated write,
                gated + audited write), run by `scripts/scaffold-build.mjs --floor`
  bench.js      what a BUILT app costs — brotli bytes per surface, the first load
                `index.html` names, disk, and the RSS of a booted process tree —
                behind `test:bench`. Bytes are gated by a ratchet-down-only
                `bench.baseline.json`; boot figures are reported and never fail,
                because a timing is one machine on one afternoon. Reads `dist/`
                and never builds one
  ask-claude.js the console's output handed to `claude -p` and the reply read
                back, for `fli gui`'s `ask claude`. Read-only by construction
                (`--tools` plus a Bash allow-list; a print session denies the
                rest rather than prompting) and hooks OFF — this repo's Stop hook
                would keep a one-question session chasing `fli done`, and it
                records items as shown for the person's own session too. Not
                `ask.js`, which resolves a question against the registers.
                WORK mode is the other end — every permission, a budget, hooks
                optional — for basecamp's workbench (`domain/workbench/workbench.ts` there),
                which reads this file's argv and event reader by import. Its
                REVIEWER is the read-only default with `reviewPrompt`, a fresh
                session rather than the builder's resumed one. AGENT mode is
                `:ask`: no built-in tool, one MCP server (`--mcp-config`, the
                app at a declared standing) and `mcp__app` allowed, measured
                on 2.1.308 as an init with `tools: []`. `contentPrompt`
                is a site OWNER's ask, which basecamp runs with `runAsk` in
                EDIT mode over a copy of a draft's `content/`, handing its own
                `env` so its key reaches that child only
  tldr.js       `fli tldr` — a question answered as a tldr page: the prompt
                and the renderer. The session is `runAsk` above, read-only
                with the same budget; a reply that strays from the shape
                still prints, line for line. `VOCABULARY.md` (through
                `authoredVocabulary`) goes into the prompt and colors the
                page, matched CASE-SENSITIVE and never at a sentence start,
                since Run, Call, Page and Move are terms and English both
  vite-ask.js   the browser's half: a dev-only Vite plugin serving the panel
                (`vite-ask-client.js`) and `POST /__fjs/ask`, `/stop`, `/undo`,
                which run `ask-claude.js` in EDIT mode scoped to the Vite root
                (or the `root` it is handed: Haven's scene editor is served
                from `editor/` and hands `web/src/`, with Mesa's `locRoot`
                the same, so a pick's loc and the scope agree),
                reading also each `@frontierjs/*` AGENTS.md (`findGuides`) and
                the app's `db/` — never the app root, which holds `api/.env`,
                and `/text`, a text edit with no model
                (`@frontierjs/toolbelt/textedit`) that falls back to an ask
                when the text is not there exactly once.
                `/plan` is Make a plan, the ask with nothing to pick: the
                Workbench's `buildPlanPrompt` in a fresh session that may edit
                `PLAN.md` at the app root and nothing else, undoable and never
                Submit's — the Workbench's Open plan carries it out.
                Sierra turns it on (`src/build/ask-plugin.js`); nothing here
                does. A request must carry this server's Origin, and under
                `ASK_ADMIT_URL` the page's Bearer token too, graded by the
                app's own `account/me` standing (`admitCaller`). An undo
                restores a file whole only while it is exactly what the run
                left (`createLedger`); a file another writer touched since
                gets the run's own hunks reversed instead. `/submit` commits
                the runs' files on a `wb/*` branch, pushes and opens the PR
                with `gh` — refused while any other file is dirty, and in a
                preview worktree while the branch holds anything outside the
                Vite root
  ask-context.js  what a pick's SOURCE says that its HTML does not, for the
                ask prompt — the `{#each}` around it, the loops and files
                under it (the only way to the route when the pick is a
                layout's slot wrapper), and the resources those loop files
                import with their model's fields. A text scan; a file it
                cannot read adds nothing. The panel's kind and scope chips
                are keys, and their sentences are `EDIT_KINDS`/`EDIT_SCOPES`
                in `ask-claude.js`, so a request cannot write prompt text
  preview.js    what a PREVIEW branch may hold — `previewScope`, the one answer
                behind `fli check`'s `preview-ui-only` and the panel's Submit.
                A preview is a worktree whose private git dir holds
                `fjs-preview` (never the tree: Submit would commit it), graded
                from `merge-base HEAD origin/HEAD` — the diff the pull request
                carries, so nothing stores a base. `markPreview` writes the
                marker, for basecamp's Open. Plain node, for `checks.js`
  done.js       is the change in the working tree FINISHED — a new module or command named where its
                siblings are, a new `.gitignore` rule that hides a file on
                disk, then `fli check`'s error rules (changed files only),
                test-files-run, register:check and the snapshots asked about
                this tree. Grades the close-out, never the change. `stopVerdict` is the Stop hook's whole policy:
                block only on an item not shown since HEAD moved
  decisions.js  what is waiting on the owner — the open questions in ISSUES
                § Needs a decision and every IDEAS paper's `## Open questions`,
                each ruled · decidable (lettered options) · open. A READ of
                where the questions are argued, never a third list of them
  plan.js       a plan read off its boxes — `fli plan`, and basecamp's
                workbench Plan tab by import. Phases of steps (`FJS-D927`):
                `next` is the FIRST OPEN BOX and is written nowhere, the `Q`
                bullets come through `decisions.js`'s `paperQuestions` rather
                than a second parse, and an unruled one is `blocking`.
                `tickStep` is the one writer — the workbench's manual tick,
                at the parser's own line so a fenced step is never ticked. The
                three prompts a plan runs under — Build, Go (`stepPrompt`) and
                Next (`nextHandoff`, which ends in `stepPrompt`) — are
                `ask-claude.js`'s, beside `reviewPrompt`, and the test asserts
                each guardrail sentence is still there
  decide.js     the ONE writer behind `register:decide` and the GUI panel: the
                ruling, the struck question, and a put-back when
                `register:check` finds a new error. A pick against the
                recommendation needs a reason. `settle` (`decide --by`) is the
                strike alone, citing a ruling that already answers it — no id
                minted, `DECISIONS.md` untouched. A bullet naming an open
                § Needs a decision row closes that row too, and a pick takes
                its id, so a `blocked by` naming it resolves to the ruling.
                `file` (`--file`) looks the id up in one named file through
                `paperQuestions` — a plan's `Q` outside `IDEAS/`, such as an
                app's `PLAN.md`, which no register source reads; the
                workbench's letter always passes it
  decide-walk.js  `fli decide` with no id — the queue one key per question,
                Enter the recommendation. Writes only through `decide`/`settle`;
                the tty, the editor and the viewer are handed in, so the test
                scripts them over real register files
  close.js      the writer behind `register:close` — an issue row MOVED into
                § Closed in that table's shape, the Detail's links carried into
                How, and put back when `register:check` finds a new error. It
                and `decide.js` share `errorKeys`/`newErrors` in register-check.js,
                and `moveToClosed` is the move `decide` reuses
  archive.js    the writer behind `register:archive` — § Closed past its newest
                40 rows moved verbatim to the top of ISSUES_ARCHIVE.md, and every
                `.md` link RESOLVING to a moved anchor repointed (compared by
                absolute path; code comments left alone). Put back, every file,
                on a new `register:check` error. `rotateHandoff` is the same move
                for HANDOFF.md — two newest sessions by heading date stay, the
                rest go to `docs/handoff-archive/<YYYY-MM>.md` with relative
                links rebased, refused when it would break more than it found
  tidy.js       the reader behind `fli tidy` — records past their keep (moved
                only under `--apply`, through `archive.js`), worktrees whose
                directory is gone, SQLite files outside every `<app>/db/`, temp
                entries grouped by the `mkdtemp` prefix in this repo's source
                that writes them, and ignored directories past 500M — a Cargo
                `target/` named as one, with its `cargo clean` and any binary
                the crate (`crateName` in desktop-surface.js) no longer builds.
                Deletes nothing: a gitignored `.db` here is as often dev data
                as debris
  file.js       the writer behind `register:file` — the next id (the max the
                registers hold anywhere, archive included, at the project's
                width) atop its severity's table, put back on a new
                `register:check` error, which is also what catches two sessions
                minting one id. `decision` files into § Needs a decision under
                the next D id; `blocks` writes `blocked by` into the held row.
                `registerHigh` is the highest of each, read by the workbench
                when a plan step starts so the rows above are that step's,
                and `filedSince` lists them between one step's marks and the next's
  amend.js      the writer behind `register:amend` — `--detail` APPENDED to an
                open row's Detail after ` · `, Verified re-dated today; a closed
                row refused (a regression is a new row). Put back on a new
                `register:check` error
  repro.js      the runner behind `register:repro` — the one `*.test.*` file
                a row links, N runs each alone, in its package's `bun run
                test`, and beside N of junction's `bun run typecheck`
                (`FJS-D1146`, `FJS-D1148`). A file's result is read from bun's
                junit report, because the console prints a file only when it
                printed something; a report not naming it refuses the run, and
                so does a typecheck that exits nonzero. `reproVerdict` reads
                the counts; the command writes them through `amendIssue`,
                whose `drop` strips `env: timing` on a code verdict.
                `linkedTest` is the row-only refusal, which `timing-unmeasured` asks
                of an unmeasured timing row to name its way out
  find.js       the reader behind `register:find` — issue rows, archive and
                rulings holding every term, answered as id, title and file:line
                and never the body unless `show` asks for it (`--show`, which
                replaces `sed -n Np ISSUES.md`); title hits and open rows first
  next.js       the open register ranked — severity, then citations, `blocked by`
                edges, code touched recently and REACH (packages depending on the
                row's, via `workspaceDeps` in runnables.js), every term printed with its
                row. `WEIGHTS` is one frozen table and no flag moves it. A
                `by hand` segment stays ranked as `byHand`; `fix:loop` skips it.
                `env: <cause>` is the sibling, `ENV_CAUSES` the closed list it
                is counted by, and `register-check` grades it. `seam: <name>`
                is the third (`seamOf`), graded as `seam-name` against the
                § Bridge index key list `seams.js` reads; `bySeam` groups on
                it for `fli next --by seam`
                Proposals are not ranked; nothing measurable separates them
  register-atlas.js  the registers as one page to work from — `register:atlas`,
                for any project declaring `registers`, not only this workspace.
                Reads through `registers.js`, `decisions.js` and `next.js` and
                parses nothing itself, so a record missing here is missing from
                `fli next` too. A register link is relative to ITS file, so each
                is resolved there and re-expressed from where the page is
                written. Not a snapshot: the ranking reads git history
  terms.js      the vocabulary this workspace asks a newcomer to learn, counted in
                three lenses that are learned differently — concepts, language
                words, api identifiers. Ranked by SPREAD, because a term in
                twelve packages is core and three hundred hits in one file is
                jargon. Nothing is excluded: a non-concept is CLASSIFIED, so a
                word in the wrong class can be found. Exploratory and ungated —
                its page carries no generator line, and `FJS-1211` is where the
                gated `ws:dictionary` it becomes is filed.
                **`VOCABULARY.md` is the root register and not the only one**:
                `PACKAGE_REGISTERS` is a declared table of packages that define
                their own terms — one row, `@frontierjs/css`, whose 56 terms and
                8 axes its own spec grades against the real CSSOM. Read rather
                than copied in, and NAMED rather than globbed, on the same
                argument `phrases` makes: declaring a term is a claim somebody
                makes. The root file outranks it, **except where the root row
                says `open`** — the file's own word for not decided — and those
                land in the audit as `undecidedButDefined`, because most of them
                are one spelling over two realms (a Table is a `<table>` in css
                and a database table in litestone) and the answer is which sense
                to name. A register that stops resolving returns every one of
                its terms to `unnamed`, which is what a package that named
                nothing also looks like, so the COUNT each one contributed is
                printed.
                **The corpus is four file KINDS and either dimension can be
                subtracted** — `markdown`, `code`, `framework` (`.mesa`/`.lite`)
                and `web` — because *which concepts are in the code* is a
                different question from *which are written about*, and a term
                explained at length and named by nothing is invisible while the
                corpus is prose alone. A source file is read WHOLE, so an
                identifier the api lens already counts is counted here too; that
                is the trade, and switching `code` off is what undoes it. A
                concept row therefore carries the JOINT breakdown `owner|kind`,
                since switching a kind off has to recompute SPREAD and how many
                owners are left is not decidable from two separate tallies. The
                api and language lenses read DECLARATIONS rather than the corpus,
                so the chips do not apply and the row hides on those tabs.
                **The AUDIT stays on prose**, deliberately: every question in it
                is about the authored registers, and asking them of the wider
                corpus moves all of them at once with nothing saying so —
                measured, `unlabelled` 0 → 123, dead doctrine 4 → 0, the
                forbidden column 18 → 28. **Nothing this workspace generated is
                corpus**, by name (`.snapshot.`), by header (`generated by:`)
                and by one named file — `repo-terms.html`, this command's own
                2 MB page, which carries neither marker because it is ungated
  proofs.js     which drive proves a change — owns `DRIVES_FILE`, parses its
                table and resolves both its columns. A PARSE and never
                a second table; not a build graph, and it must not become one.
                `changedTree` is the ONE reader of what changed — untracked
                files and their content included — for `proves`, `prove`,
                `done` and `/api/proves`. Every tier but `path` reads only what
                the project runs, and the symbol tier only code lines that
                CHANGED rather than moved, as whole identifiers
  file-kind.js  what a path IS — source, test, doc, config, generated, asset,
                example — for `codegraph.js` and `proofs.js` both. Zero
                dependencies, because `checks.js` reaches it on plain node
  prove.js      runs what `proofs.js` names — each drive's *Start first* steps
                in order, the drive, then the stop — behind `fli prove`. It owns
                the ORDER only: spawning is `children.js`'s and every process is
                injected. A server port that already answers fails the drive
                rather than being reused (`FJS-740`). A drive's `holds` (`ports`,
                `db`) are taken first through `guard.js`'s `treeHold` and waited
                for, so two proves in one tree queue. `drive-holds` in
                `checks.js` grades the declaration against what the drive reads
  intent.js     what a person asked, resolved against the app's schema — a
                CANDIDATE (a claim, facts in plain words) in, a verdict with a
                citation out; `fli intent` is its first caller. Pure over the
                parsed schema and three snapshot TEXTS, so the command loads the
                APP's litestone and this package still depends on none. It
                refuses a candidate carrying an identifier, and words matching
                two things resolve to nothing — `IDEAS/intent-recognizer.md`
  wireframe.js  a screen written in @frontierjs/css terms (a WIREFRAME, JSON)
                read into components, .mesa, a draft schema and a terminal
                drawing — behind `make:wireframe`. `analyze` is the one owner
                of what a component is and what its props are; every output
                reads it, because the prototype decided one badge in two places
                and got two answers. Pure: the vocabulary and the kit come in,
                strings go out, and the command grades them with the APP's mesa
                and litestone. `TONE_TAKERS` and `KIT_PROPS` are copies, and
                `test/wireframe.test.js` fails when either source moves —
                `IDEAS/wireframe.md`
  server.js     also the control surface's own endpoints — `/api/runnables`,
                `/api/state`, `/api/proves`, `/api/health/:id`, `/api/page/:id`
                (a committed page, served because a `file://` link from an http
                page is refused — the id is looked up against the runnable rows
                and never joined onto a path), and start/stop/
                output. The health probe is HERE and not in the page: 5500
                fetching 8110 is cross-origin, and a CORS failure reads exactly
                like the app being down
  console.js    the console's `.mesa` screens, compiled per request with no
                build (`IDEAS/one-console.md`), for both targets: served to a
                browser at `/console/`, and mounted in this terminal by
                `runTerminalConsole` — `fli gui` at a TTY without `--open`.
                Mesa, the kit and toolbelt come from the copies THIS `fli`
                holds (`ownPackageRoot` in `assets.js`) through one import map
                read off each package's `exports` — URLs for the browser, files
                for the terminal's Bun loader, which rewrites them into the
                compiled text because Bun never asks a plugin about a loaded
                module's package imports. The compiler and the runtime come
                from one mesa root, or a screen compiles against one copy and
                runs on another. A compile error is served as a module that
                throws naming the file
  map-view.js   the console's `:map` — which directories here are apps (a
                `db/schema.lite` under the root or a surface's dir), one app's
                map as `project:map --json` spawned in it, and the secret fill.
                An app is named by its directory and looked up in that list,
                never joined onto a path
  live-view.js  the console's `:live`, `:call`, `:data` and `:ask` — junction's devtools
                carried to the panes: the reads (rows as somebody among them,
                `FJS-D1427`), the queue's three acts and a call as somebody, which runs INSIDE the app so its announcement
                reaches `:live` (`FJS-D1426`), each an allow-listed shape, and devtools' socket relayed a frame a line with `open`
                and `closed` of its own, so a quiet app and an absent one differ.
                `agentUrl` is devtools' `/api/mcp` as somebody, the one MCP
                server `:ask`'s agent is handed (`FJS-D1428`).
                The server reads devtools because a browser may not: it is
                another origin that allows none. The port is `fli gui
                --devtools-port`, default the reserved 5503
  env-health.js which secrets an app's `.env.example` names and which are
                set, and `fillSecret`, the one write — through that same list,
                so a key it does not name is refused. `project:map` reports it
                and `:map` offers the fill
  check-worker.js  one scope of `/api/check` on its own thread, so the scopes
                overlap (wall time is the repo scope, not the sum) and the server
                stays answerable; `handleCheck` shares one run among overlapping
                requests
  proxy.js      one listener, so a dev surface has a NAME — `example.localhost`
                for `localhost:8010`. TCP and not `node:http`, because bun's
                emits `upgrade` and hands over a socket nothing written to ever
                reaches the client, and junction's live layer is a socket.
                Nothing is rewritten: junction READS the Host and vite allows
                `*.localhost`. The target is picked per CONNECTION, which is the
                one bound and is why nothing may come to depend on it
  blast.js      how far a change to a file reaches — how many files NAME it,
                for `fli gs`'s `↑n`. It computes nothing: `referenceGraph` in
                `codegraph.js` is the one answer to *who names this file* and
                the bands are its `BLAST`, so a file the codegraph page draws as
                a hub is marked in the listing too. What it owns is the narrow
                collection — the texts that reading needs and nothing else,
                which is ~0.4s against the full codegraph's ~6s, the difference
                being the TypeScript function measurement. **The scan cannot be
                narrowed by target**: knowing who names `parser.js` means
                reading everyone. Two cheaper readings are refused and say why
                in the header — `git grep -F` per file is slower AND a second
                matcher, and prefiltering texts by the target's BASENAME is
                unsound, since `@frontierjs/toolbelt/inflect` resolves through
                `exports` to `src/inflect/index.js` and the importing text
                never contains `index.js`. `null` is *no reading*, never 0
  git-status.js the working tree grouped by place and by what each file IS —
                behind `fli gs`. Pure: the three git readings in as strings, a
                model out, so the command only renders. The grouping is cosmetic
                and the COUNT is not — a role rule that stops matching drops a
                file from a listing somebody is reading to decide what to commit,
                and a dropped row reads as a clean file
  git-history.js  commits per day as a column chart, time across — behind
                `fli ghist`. Pure: `git log --shortstat` text in, or
                `--name-status` for `--files`, rows out. Every
                day in range is a bucket, zero or not, or the x axis stops being
                time; week buckets start Monday
  claude-usage.js  Claude Code sessions and output tokens per day — `fli
                ghist --claude`'s second chart, on `git-history.js`'s buckets.
                Pure: one transcript's text in. Dedupes by message id, because a
                streamed reply is several lines; a subagent adds tokens and no
                session. Only as far back as Claude Code keeps transcripts
  doctor.js     can this MACHINE run fli — binaries, the two env files, and the
                env vars a namespace declares. The sibling of `checks.js` and
                deliberately not merged with it: a missing `sqlite3` is not an
                architecture finding. `blocked` is system and config only,
                because a missing token blocks one namespace and nothing else
  preflight.js  what a drive needs started FIRST — the *Start first* column of
                the drive table, ordered, resolved onto rows the page can press.
                Reading the prose beat declaring it beside the script and beat
                asking the drive, because the answer was already written down
  typecheck.js  tsc's output, filtered to your files — shared with scripts/typecheck.mjs
  schema-apply.js  how `outbox:install`, `backfill:install` and `auth:install`
                land the schema they edited — `migrate dev` in an app with a
                migration history, `db push` in one with none. A push there
                leaves a table in app.db and in no file, and the next
                `db:migrate` refuses it (`FJS-1797`). `.command` is the verb
                `make:model` and `make:scaffold` tell a person to run
                (`FJS-1870`)
  app-config.js what a scaffolded app is GIVEN — deps, scripts, configs, workflow,
                and AGENTS.md: `AGENT_DOCS` is the packages whose TARBALL carries one,
                held to `exports.snapshot.md` in both directions, so a package that
                starts shipping one is a red test until it is listed here
  deps.js       the third-party packages a root declares and `bun.lock` installed —
                `ws:deps`'s snapshot and the body of its push to basecamp's
                `/dependencies/`. The latest version and advisories are never
                in it: they change with no commit
  crud-templates.js     what a GENERATED CRUD page IS — shared by `make:scaffold`
                        and `admin:generate`. Built on @frontierjs/ui
  scaffold/     the files `fli new` WRITES, one module per surface, each builder a
                pure function of the spec — `app.js` the root (package.json,
                README, .gitignore, fli.json, the empty schema), `api.js` the
                `api/` surface (index, app, core/*, the access test, the retention
                job, junction.config), `web.js` the `web/` surface (index.html,
                vite + sierra configs, App.mesa, nav, controls, every route).
                `project/new.md` keeps the questions, the spec and the file list;
                the text of what is written lives here so a test can import a
                builder instead of slicing the command with a regex
  widget-surface.js     what a `widgets/` surface IS — shared by `new` and `make:widget`
  site-surface.js       what a `site/` surface IS — ditto, `make:site`
  extension-surface.js  what an `extension/` surface IS — ditto, `make:extension`
  desktop-surface.js    what a `desktop/` surface IS — `make:desktop`, the binary and
                        API origin `desktop:run` reads off one, the start-or-reuse
                        of the API and dev server `desktop:run` and `dev:desktop`
                        share, and the launcher entry `desktop:install` writes.
                        `example/desktop/`
                        is its output, compared byte for byte in the suite, because
                        only `verify:desktop` can build a shell and it runs the example
  shortcuts.js  what a SHORTCUT is — a project-local name for a command line,
                written as an ordinary command file rather than held in a
                table, so discovery, help, completion and `fli edit` already
                know about it. It owns the two refusals as well as the shape:
                a name the registry already answers to, and a target of more
                than one line
  image.js      WHICH BYTES ran, and how far that answer travels — a registry
                digest means the same thing anywhere, an image id means it on
                one host, and a tag means nothing at all
  build-check.js  can this image be PROMOTED, or only deployed — the three doors
                configuration takes into an artefact (the context, an ENV line,
                a build ARG) plus an unpinned base. It traces a context file
                ACROSS STAGES, because a wholesale `COPY --from=b /app /app`
                ships what a subtree copy does not, and grading on the context
                copy alone refuses every multi-stage build here. Pure — the
                caller reads the files, so the suite needs no daemon
                — and `inspectIgnored` grades the context against what GIT
                ignores, the app's own list of what is not source (`FJS-3524`)
  release-preflight.js  will a Basecamp App start, keep its data and be
                reached — its settings (Variables, volume, port, health,
                Domains) against what the app declares (defineEnv's spec, the
                schema's databases, the health route, the Dockerfile's final
                stage). `basecamp:deploy` asks before it builds. The spec is read
                by running the env module with junction's `defineEnv` swapped for
                a recorder, since the real one throws on every required key
  docker-context.js  can the BUILDER's docker read the build context at all —
                asked with `docker build --check`, which parses and builds
                nothing, because the answer is a property of that machine's
                docker packaging and not of the path (a snap sees nothing
                outside its user's home, `/tmp` included). Pure grader, one
                probe script; the suite needs no daemon
  revert.js     can serving state be put back, and what stops it — seven
                refusals, four of them with no override because they are not
                judgement calls. All of them reported, never just the first. It
                targets the previous TRANSITION rather than the previous release:
                build-on-target puts no digest in the id, so two deploys of
                different source mint the same one and a lookup by id answers
                whichever is newest — which is the one serving (measured: a
                revert restored the bytes it was reverting from and said it
                worked)
  machine.js    running a command on the machine being deployed to, and moving an
                IMAGE between two of them (`shipTo` — `docker save | docker load`,
                which preserves the id, so the digest a Release names is the
                digest that starts). ONE owner for
                (host, script) → the argv that runs it there, and the script
                travels on STDIN — `context.exec` is `/bin/sh -c`, so an
                interpolated script is parsed twice and nine of this pipeline's
                ten multi-line commands were syntax errors on the target for as
                long as they existed. `localhost` is a transport rather than a
                simulation, which is what makes the pipeline runnable in CI at
                all. `run`/`capture` are the verbs; `tty` and `pipe` exist
                because stdin can carry one thing and `docker exec -it` and the
                journal runner each want it
  guard.js      one writer at a time across processes, on this machine — a
                `wx`-created file holding the winner's pid. `ports.js` takes it
                over `sessions.lock`, and `withRegisterGuard` (registers.js) over
                every `close`/`file`/`amend`/`decide`/`settle`, keyed on where
                `ISSUES.md` really is, because fix-loop lanes write the main
                tree's through a link. Not reentrant: a caller never wraps one.
  lock.js       is another run working in this directory — the format, the
                parser, the four scripts and the reading of one. A DIFFERENT
                question from the journal's *what state did the last run leave*,
                and the two only looked like rival answers because this one could
                not expire (`FJS-D156`). It records the run, the actor, when, and
                WHICH STEP — never a pid: `fli` runs on the operator's machine and
                reaches the target one command at a time, so a pid there is dead
                the moment it is written and no probe can be built on one.
                `set -C` is the compare-and-set. `--resume` takes it over,
                `deploy:unlock` drops it and settles nothing
  journal.js    the deploy journal — statements and verdicts, all pure. The
                brain is HERE and `journal-runner.mjs` is the half that ships to
                the target: it binds parameters and decides nothing, which is
                what lets the suite drive the real runner against a temp file.
                `migrationPlan` is how a journal reaches the next FORMAT: the
                DDL is `CREATE TABLE IF NOT EXISTS` throughout, so a target that
                has deployed once holds constraints no new DDL can reach, and
                `formatVersion` shipped able only to refuse. A migration's table
                text is FROZEN here and never read off the snapshot — a snapshot
                is the shape now and a migration is the shape at one format —
                and it is held honest by an oracle that migrates a fixture and
                compares it to a fresh database
  edge.js       the Caddy routes in front of a deployed app and the origin its
                web build names for the API — one origin, or `deploy.api.domain`
                as a second. The one reader of both domains, because a route and
                a bundle that read them separately name two different hosts.
                Routes join Outpost's `ingress` server (`FJS-D564`), merged into
                Caddy's WHOLE config and written back with `If-Match`, so a write
                Outpost made between the read and the write is a 412 and not a
                route lost; a hostname another route holds is refused. Per-app
                access logs, which Caddy rolls itself. Loaded verbatim by
                `pauseEdgeCycle`
  pause.js      taking an app down on purpose: the Caddy guard (the first
                handler of every route, matched on the file it stats), the
                page, the drift verdict and the refusals. All pure. The guard is
                found by its `@id` through the admin API, never by the route's
                shape. `file_server` answers 200 for a page it found unless told
                `status_code: 503`. And the queue half
                (`FJS-D262`): the script that runs Caravan's OWN bin inside the
                serving container, and the verdict read off its JSON — it never
                writes Caravan's tables and never names a jobs database path
  journal-runner.mjs  copied to the target and run with bun. Imports
                `bun:sqlite` and nothing else, because a deploy target has no
                node_modules — the build is inside Docker
  deploy-plan.js  the journal rows a transition WOULD write — `Transition` +
                `TransitionStep`, built once and either printed (1d) or inserted
                (1e). The step list is READ off `_steps-docker/` with the
                runner's own filter and sort, and each `skip:` is evaluated the
                way the runner evaluates it, so a plan cannot describe a
                pipeline that has moved
  release.js    what a Release IS — the four terms and the content-addressed id.
                Minting writes nothing: the id is a pure function of the tree and
                the configuration, which is what makes a digest promotable
  vendor.js     pack the workspace into an app's build context
  vaultwarden.js  a Vaultwarden/Bitwarden vault read in-process — login, sync,
                decrypt, `get('Item/field')` — behind `env:pull --from
                vaultwarden`, which resolves `KEY=vw://…` refs. Its one write is
                `createSend` (`env:send`); `receiveSend` (`env:pull --from send`)
                needs no login, and every call spends one of the Send's reads. `dotenvLine` writes
                only a spelling `loadEnv` and Bun's own loader read back alike,
                and answers null for the rest (`FJS-3415`)
  health-target.js  where an app answers health and whether anything serves it —
                the plugin call in the API source, `plugins: { health: true }` in
                junction.config.js, or a route literal graded against the
                CONFIGURED path. One module because `make:deploy` and
                `deploy:doctor` both ask, and asking separately is how they came
                to disagree with an app that worked. It also answers the CLASH,
                which `start()` refuses by name
  deploy-image.js  what an API image needs beyond api/ and db/ — a Chrome
                when the app depends on print-kit or its API imports mesa/drive,
                web/src when the API reads a template from it (`FJS-2269`).
                `make:deploy` writes the lines and `fli check`'s
                `deploy-image-needs` grades a Dockerfile written before the
                need, so the two read one answer. Those two are the only roads to
                a browser (`FJS-D1214`): a playwright or puppeteer dependency is
                named as off them, never read as a third kind of Chrome
  argv.js       the command line into `{ _, ...flags }`, read before the command
                is known, so a value's type is how it LOOKS and getConfig
                coerces toward the declaration after. `BOOL_ARGV` never takes a
                value, nor a command's own booleans, which bootstrap adds by
                reading argv again once the command is known; a boolean not
                typed is ABSENT — a defaulted `false`
                beside `-d` is how `db:import -d` once ran for real
  verbosity.js  one bit — did the caller type `--verbose`. A leaf with no
                imports, read on the startup path, set in `bootstrap.js` before
                anything logs. Not `--debug`, which asks for stack traces
  codegraph.js  a project drawn as one tile per tracked file — heat and blast
                radius on top, complexity and exposure (complexity no test
                covers) below, and a score folding three of them — for
                `project:codegraph`. Age, churn, tested and cycle are still
                graded, for the page's `more`. **`source` is what the project
                SHIPS**: source in a package the workspace does not publish is
                the kind `private` — graded and scored like source, counted as
                source nowhere — read off that manifest's own field rather than
                a list of names, so orion crosses back the day it publishes. **TWO graphs and they answer
                different questions**: `referenceGraph` is *who names this file*
                and counts any path-shaped string wherever it sits, which is
                right for a usedBy tally; `importGraph` reads STATEMENTS with
                comments blanked, because a layer is a claim about what must be
                correct beneath a file and the loose reading fused 99 files into
                one cycle out of two comments — `toolbelt → junction`, which
                Invariant 1 forbids. `layerGraph` turns the second into a
                `depth` (the LONGEST path down; a cycle collapses to one node
                first, or the longest path is infinite) and a `cycle` count.
                NOT a snapshot: heat reads a clock and TESTED
                may come from a `coverage/lcov.info` nobody commits. Bands are
                fixed thresholds, never the project's own percentiles, or every
                badge would draw the same complexity. A separate collection from
                `repo-map.js`, so a command of its own rather than a
                `ws:atlas --as` (`FJS-D240`). Colors are `@frontierjs/css` TONES
                mixed over the theme's ground — `color-mix()` on the page, the
                same oklab mix computed for a PNG — so a theme or one line of
                `TONES`/`MIX`/`SCORE_RAMP` moves every picture. The score ramp is
                danger alone, turned in hue, and its climb away from the ground is
                tested over every theme the stylesheet ships. A bare package
                import resolves through that package's own `package.json`
                (`exportTarget`), never a guessed folder — the guess dropped every
                `@frontierjs/junction` import in the repo
  functions.js  what is INSIDE a file — every function with its cyclomatic and
                cognitive complexity, its nesting and its length, for
                `codegraph.js`. The parser is the PROJECT's: `fli` is global, so
                a dependency of the app is not beside the CLI, and this resolves
                the way `app-schema.js` does — *installed HERE* (the directory
                under the project's node_modules, read through its own
                manifest), never `require.resolve`, which bun answers from its
                global cache and memoizes (`FJS-666`). No parser is not a
                failure: `cognitive` is null, every other reading holds, and the
                page says which of the three reasons it was — because *quiet*
                and *nobody read this* must not draw the same tile
  export-pairs.js  two `exports` keys reaching one file under two spellings —
                `ws:exports` fails on one. A `.mesa` subpath keeps its extension
                (tools recognise a component by it), every other is bare
  signatures.js what an app can CALL from a published package — `fli sig`.
                One TypeScript program over every package's declared entry
                points, each module's exports followed through the checker, so
                the name listed is the one an app imports. A name no export
                carries falls to the declarations that hold it as a member
  outline.js    one file's shape as line ranges — `fli outline`, and the policy
                of `.claude/hooks/outline-hint.mjs` (`wideRead`/`readVerdict`),
                which REFUSES a Read with no limit, a bare `cat` or a `sed -n`
                window over `WINDOW_AT` on a file of `BLOCK_AT` lines, carrying
                the outline in the refusal, and hints at `HINT_AT`. The user
                settings register it again with `--global`, for every project. Parser and names are
                `functions.js`'s, so a row and the codegraph's worst function
                agree; a range starts at its attached comment. A `.lite` is
                read by brace depth over toolbelt's `tokenize`, a `.mesa` by
                its column-0 blocks with each script parsed at its own lines
  cat.js        markdown rendered for a terminal — `fli cat`. The renderer is
                `Bun.markdown.ansi`; this owns what is handed to it (frontmatter
                and a column-0 `<script>` as fences, a relative link as a
                `file://` URL) and reads a section through `outline.js`
  file-tree.js  a folder drawn as a tree — `fli tree`. The listing is
                `tree.js`'s, so ignored files are absent with no skip list;
                icons are emoji with DEFAULT emoji presentation only, since one
                needing U+FE0F is one cell in some terminals and two in others.
                On a wide terminal each top-level folder is a LANE, packed down
                then across; a row is measured in cells (`visibleWidth`), never
                in string length, or every column after an emoji shifts
  guarded-write.js the policy of `.claude/hooks/guarded-write.mjs` — decision-rules
                hinted in front of a WRITE to `DECISIONS.md`, `IDEAS/` or
                litestone's parser/catalog. A Bash command counts only where
                the path is a write target (redirect, `tee`, `sed -i`, mv/rm,
                a git verb, an inline `writeFile`), never where it is read
  codegraph-page.js the codegraph model as one page; reads no files. `gilbert`,
                `gridFor` and `coreLayout` are serialized into its script with
                `toString()` and every band and score is graded in node, so the
                page cannot lay a file out differently from the PNG. Its own
                stylesheet writes no hex (tested)
  repo-rings.js the same model as rings, center out — `ws:atlas --as=rings`,
                for somebody opening the workspace cold. A package's ring is the
                `Ring` column of the root `CLAUDE.md` table, and one with none is
                drawn *unplaced* and warned about; the test fails on any in this
                tree. Reads no files; `client` is serialized with `toString()`.
                Not a snapshot: it counts the registers (`FJS-D589`)
  repo-work.js  how work moves through the registers, one clickable map —
                written by the same `--as=rings` run beside the rings page,
                which links it from home and the project ring. Only where the
                project has the `fix-next` skill: a map of loops a project does
                not run sends somebody after commands that are not there. Counts
                come from `next.js` and `decisions.js`, so they agree with `fli
                next`; the fix loop's figures from `~/.fli/fix-loop.jsonl`
  png.js        RGBA → PNG with no dependency. `stored` is the desktop icon's,
                whose bytes are compared to `example/desktop/` and so cannot move
                with the zlib a runtime carries
  tell.js       what a Frontier network member keeps on a machine — the key, `config.json`'s
                `frontier`, this member's `chain.json` once a machine is linked, the pins (by chain root), signing a request — for the namespace and for the
                notice line `bootstrap.js` prints before every command at a
                terminal while letters wait (`FJS-D1398`). On the startup path,
                so builtins only at the top; the line comes from the LAST check,
                and one over a minute old starts this file detached to ask
                `GET /waiting` again, so no command waits on the network
  frontier-member.js  this machine as a member — its keys, its chain as it and
                the post hold it, the nick it speaks as. Imported by both the
                `frontier:` verbs, which are the identity, and `tell:send` and
                `tell:inbox`, which read it, so a member is written once
  pgp-words.js  the PGP word list, a word per byte, for `frontier:who`'s eight
                words. Both ends of a comparison read it, so a word moved here
                reads as a mismatch to every older fli
  crest.js      the same 64 bits as a 5×5 picture in two heraldic tinctures,
                beside the words in `frontier:who`, and `crestSvg`, the
                Worker's `GET /badge/<number>.svg`. Recognition, never proof; a
                bit moved here redraws every member's crest
  (the chain and the member row are `@frontierjs/toolbelt/frontier`, read by
                the Worker and by Haven as well — `FJS-D1416`…`FJS-D1421`)
  tell-worker.js  the Cloudflare Worker `fli tell` speaks to — one Durable
                Object, members and their chains, invites, letters, and the
                `/follow` socket `inbox -f` holds (`FJS-D1392`). A
                member with a sealing key is sent only sealed letters; a plain
                one to them is refused here (`FJS-D1402`). `frontier:link` is four
                routes over one `asks` row, and the post carries the pieces
                without signing any; a revoke is a longer chain on `POST /chain`
                with the rotated key sealed to each machine left (`rekeys`), and
                storing it drops the revoked machine and closes its socket.
                A paper key is a machine like any other here: its link and
                sealed copy arrive on `POST /chain`, and `GET /chain` with no
                nick answers the caller's own, which is how typed words learn
                their member. The object makes its own signing pair on first
                use (`FJS-D1467`) and signs a member's row on asking — the
                join's answer and `GET /row` — never storing one.
                `GET /badge/<number>.svg` is the one route nobody signs, for a
                README. A file is an R2 object (`FILES`) with its row in
                `files`; the Worker streams `PUT /file/<id>` and
                `GET /file/<id>/bytes` itself and asks the object each step on
                a `/file/<id>/<step>` path it never forwards, and the alarm
                sweeps a row at its `sweepAt`. `GET /file/<id>` is the
                download page, its script `openFile`'s own source inlined.
                `test/post-files.mjs` drives it on `wrangler dev`
                Never imported: wrangler bundles it from a config `ws:post`
                writes, so it runs in workerd and imports toolbelt and nothing
                Bun-only. `cloudflare:workers` is not imported either, since
                it does not resolve outside workerd
  cloudflare.js fli's one owner of the Cloudflare dialect — every call one
                spawn of Cloudflare's `cf` (`FJS-D1469`), no credential and no
                HTTP here. A profile row spawns with `CLOUDFLARE_API_TOKEN`
                DELETED, since `cf` lets the env token beat `--profile`; lists
                walk pages, zones go by id. Every `cf:` command takes
                `--profile` through `profileFor`; Pages and Workers verbs take
                no `--account-id`, so the account rides the spawn as
                `CLOUDFLARE_ACCOUNT_ID`. `IDEAS/cloudflare-dns.md` § Measured
                is what it was read against. `test/cloudflare.test.js` drives it over
                `test/fixtures/cf/stand-in.mjs`, which keeps the real `cf`'s token
                precedence — a new `cf` version is a new fixture file
  config.js · bootstrap.js · ports.js · utils.js · server.js
commands/  one directory per namespace — `fli list` prints them all
db/        deploy.lite + ddl.snapshot.sql — the deploy journal's models, and the
           DDL derived from them. The snapshot is what ships: nothing on a target
           can emit DDL, so the fragment stays the single source and the
           `snapshots` phase fails a stale derivation. OPENED, not installed:
           `createClient({ schema, db })` with `db` naming `deploy.db` on the
           target, so it declares no `database` block and `@@db(main)` in it
           does not parse
cli/src/   the CLI's own source tree
console/   the console's screens, `.mesa` — `Console.mesa` is the root both
           targets mount, the pane strip; then one file per pane (`Run`,
           `Check`, `Decide`, `Ship`, `ProjectMap` — not `Map`, which would
           shadow the global a compiled component uses — `Live`, `Call`, `Data` and `Ask`). `Flow` is one walked
           flow, the release or the publish: it draws the steps the server's
           tables name and grades none of them — `Ship` does, from what it has
           read. `:map`'s parts are `MapChain`, `MapMachines`, `MapWarden` and
           `MapPanel` (every other list); what they draw is `map-model.js`,
           pure and tested, and `map-reference.js` is what the chain IS for
           every project. On the terminal an `<svg>` paints only its
           `aria-label`, so a picture there is also a row of buttons (a
           machine's moves), and a run of inline nodes is joined by text
           arrows. A pane unmounts when another is shown, so `:check`'s tree
           walk runs only while it is in view.
           The keys are ONE `keys()` on `Console`'s root, a pane's table
           (handed up through `keyed`, its labels the actions) ahead of the
           console's; `Legend` is `bindings()` over the same tables, drawn
           in the terminal's footer strip (`legendAt`) or at the page's foot.
           The root keeps focus, so a key arriving with focus outside it
           only brings focus back.
           A screen reads `server.js`'s endpoints through its `api` prop and
           nothing else, so the browser and the terminal draw one copy
web/       the browser-facing side
test/     one file per module under core/, plus the deploy pipeline's own
           layer: plan (the rows a transition would write), journal (the rows
           it does write, through the REAL runner against a real SQLite file),
           revert (the seven refusals, and what each one's way out is), machine
           (the argv, and — executed — that a script reaches a shell untouched),
           and deploy-scripts (every script the pipeline can send to a machine,
           parsed with `sh -n`)
```
