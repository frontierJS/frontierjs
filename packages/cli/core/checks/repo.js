// ─── checks/repo.js — this workspace's own rules ──────────────────────────────
//
// Every `scope: 'repo'` rule: the package-root standard, the drive table, the
// registers and the notes — a claim with an AUTHORITY in the tree, graded against
// it (`FJS-D133`). One slice of the rule bodies `core/checks.js` runs; the table,
// the runner and the baseline stay there. The rule table itself arrives as the
// `rules` argument rather than by import, because this module is imported by
// the file that owns it. Plain ESM on node, `@frontierjs/toolbelt` and this
// package only.

import { join, basename, resolve, relative }                                                                                                                  from 'path'
import { existsSync, readFileSync, statSync }                                                                                                                 from 'fs'
import { homedir }                                                                                                                                            from 'os'
import { docFences, isRunnable }                                                                                                                              from '@frontierjs/toolbelt/docfences'
import { parseFrontmatter }                                                                                                                                   from '@frontierjs/toolbelt/frontmatter'
import { packageDirs, readProofs, reachable, DRIVES_FILE, rottedPaths, resolveRun }                                                                           from '../proofs.js'
import { treePaths }                                                                                                                                          from '../tree.js'
import { readPreambles, resolveNeeds }                                                                                                                        from '../preflight.js'
import { readCourse }                                                                                                                                         from '../tutorial.js'
import { hostCollisions }                                                                                                                                     from '../proxy.js'
import { docWordUnknown, docCitesDead, docClaimsCount, COUNTABLES, checkRulesCountable, docInvariantRef, docStatusStale, docMapNarration, docUncheckedCount } from '../doc-audit.js'
import { runnables }                                                                                                                                          from '../runnables.js'
import { invariantCoverage }                                                                                                                                  from '../invariants.js'
import { hazardCoverage }                                                                                                                                     from '../hazards.js'
import { seamOwnership, SKILL as SEAM_SKILL, keyLiteral, unlisted }                                                                                           from '../seams.js'
import { readRegisters }                                                                                                                                      from '../registers.js'
import { kindOf }                                                                                                                                             from '../file-kind.js'
import { safeRead, walk }                                                                                                                                     from './lib.js'

export const CHECKS = {

  // A test file no script names is a test that never runs, and it is silent in
  // the worst way: the suite is green, the count goes up as files are added, and
  // the one file nobody listed is the one written last — which is the one
  // written for the defect just fixed. Measured here first: `packages/cli`'s own
  // `test/pipe.test.js` pins `FJS-379` and had never been run by `bun run test`.
  //
  // Only where the script HAND-LISTS files. `bun test` and `vitest run` discover
  // their own, and a package that lets its runner walk the directory cannot have
  // this problem — which is the argument for the shape, not for the rule.
  //
  // Every `test*` script counts, not just `test`: a file run by `test:browser`
  // is a file something runs, and grading against one script would report it as
  // orphaned. And only `*.test.*` — a harness beside the tests (a stub, a
  // client) is support code and is named by whatever imports it.
  // ── the proof table ────────────────────────────────────────────────────────
  //
  // `DRIVES.md` § *Which drive proves a change* is knowledge that was paid for
  // one defect at a time, and nothing had ever checked it. Both
  // failures are silent and they fail in opposite directions: a row naming a
  // drive that has been renamed is advice that dies when taken, and a drive no
  // row names is knowledge that exists and cannot be found.
  //
  // Graded differently for that reason. An unresolvable target is never right —
  // the row names something that is not there. An unnamed drive can be: a
  // broader row may cover it, and some drives are about a package rather than
  // about a change anyone makes to the framework.

  'proof-target': ({ root }) => {
    const rows     = safeRunnables(root)
    const findings = []
    const packages = packageDirs(root)
    // No git means no answer about what a clone holds, so the rot half is skipped.
    const tree     = treePaths(root)

    for (const p of readProofs(root)) {
      // The Changed column is the half a diff has to hit, and it fails silently
      // both ways: a cell nothing can match is a row `fli proves` never prints,
      // and a path that moved matches nothing from the day it moved.
      if (!reachable(p.changed, packages)) {
        findings.push({
          file: join(root, DRIVES_FILE), line: p.line,
          message: `the proof table row for "${p.changed}" can be hit by no change: it has no backticked path, ` +
                   'no package name in its leading words and no backticked symbol of four or more characters, ' +
                   'so `fli proves` never prints it. Name the package first, or backtick a path or symbol the change touches.',
        })
      }
      for (const dead of tree ? rottedPaths(p.changed, tree) : []) {
        findings.push({
          file: join(root, DRIVES_FILE), line: p.line,
          message: `the proof table row for "${p.changed}" names \`${dead}\`, and no file in the tree is that path. ` +
                   'A path that moved matches no diff from then on, so the row stops being printed.',
        })
      }

      const targets = resolveRun(p.run, { root, rows })
      // Targets are read only after a `where` anchor, so a cell with none reads
      // as zero targets: `fli proves` lists the row with nothing to run.
      if (!targets.length) {
        findings.push({
          file: join(root, DRIVES_FILE), line: p.line,
          message: `the proof table sends a change in "${p.changed}" to no target at all: the Run cell has ` +
                   'no `where`: `target` pair, so `fli proves` lists the row with nothing to run. ' +
                   'Anchor each drive, `.`: `ci` for the workspace root.',
        })
        continue
      }
      for (const t of targets) {
        // A sibling checkout (`../fjs-prototypes/chat`) is graded where it is
        // present; CI checks out this repository alone (FJS-D1179). The probe is
        // here and not in `resolveRun`, whose answer the committed report reads.
        if (t.kind === 'outside' && siblingLacks(t, root)) {
          findings.push({
            file: join(root, DRIVES_FILE), line: p.line,
            message: `the proof table sends a change in "${p.changed}" to \`${t.where}\`: ` +
                     `\`${t.name}\`, and ${t.dir} declares no such script or file. ` +
                     'A row that names a drive which has been renamed is advice that fails when it is taken.',
          })
          continue
        }
        if (t.kind !== 'unknown') continue
        findings.push({
          file: join(root, DRIVES_FILE), line: p.line,
          message: `the proof table sends a change in "${p.changed}" to \`${t.where}\`: ` +
                   `\`${t.name}\`, and ${t.dir ? `${t.dir} declares no such script or file` : `there is no ${t.where} here`}. ` +
                   'A row that names a drive which has been renamed is advice that fails when it is taken.',
        })
      }
    }
    return { findings }
  },

  'proof-drive-named': ({ root }) => {
    const rows = safeRunnables(root)
    if (!rows.length) return { skipped: 'no runnables — not a workspace with drives' }

    const named = new Set()
    for (const p of readProofs(root)) {
      for (const t of resolveRun(p.run, { root, rows })) if (t.id) named.add(t.id)
    }
    if (!named.size) return { skipped: 'no proof table' }

    return { findings: rows.filter(r => r.kind === 'drive' && !named.has(r.id)).map(r => ({
      file: join(root, r.source), line: 1,
      message: `\`${r.name}\` in ${r.dir} is a drive that no row of DRIVES.md's proof table names, ` +
               'so nobody is told to run it for any change. Either add a row, or say in one that an ' +
               'existing row covers it.',
    })) }
  },

  // ── the drive table's other column ────────────────────────────────────────
  //
  // *Start first* is the preamble — `verify:live` needs `db:seed`, then `api`
  // and `web` — and it is now read: `runnables.js` puts it on the row so one
  // button can run the whole thing. Which makes a renamed script worse than it
  // was, because the advice is no longer only read by a person who can see it
  // is wrong; it is pressed.
  //
  // An error rather than a warning, for the same reason `proof-target` is: the
  // row names something that is not there, and there is no reading of that
  // which is correct.

  'drive-preamble': ({ root }) => {
    const rows = safeRunnables(root)
    if (!rows.length) return { skipped: 'no runnables — not a workspace with drives' }

    const preambles = readPreambles(root)
    if (!preambles.length) return { skipped: 'no drive table' }

    const findings = []
    for (const p of preambles) {
      for (const n of resolveNeeds(p.needs, p.dir, rows)) {
        if (n.id) continue
        findings.push({
          file: join(root, DRIVES_FILE), line: p.line,
          message: `\`${p.script}\` says to run \`${n.run}\` first, and ${p.dir} declares no such script. ` +
                   'The dashboard presses this before it runs the drive, so a step that has been renamed ' +
                   'is a preamble that fails where it used to be prose somebody could correct.',
        })
      }
    }
    return { findings }
  },

  // ── the names ─────────────────────────────────────────────────────────────
  //
  // `example.localhost` is derived from the app's package name and the surface
  // it belongs to, so two apps whose names reduce to one label take one name —
  // and whichever started first would answer it. That is the same failure
  // `strictPort` exists for, one layer up, and it is silent in the same way:
  // the page works, and it is the wrong app.

  // ── the course ─────────────────────────────────────────────────────────────
  //
  // Eleven commands in one directory become a COURSE by having an order, and
  // the order is stated in three places: `index.md`'s LESSONS array, each
  // lesson's own `## Lesson N —` heading, and each lesson's finish step naming
  // the next one to run. Nothing held them together, and inserting a lesson at
  // position 2 costs twenty hand edits across eleven files.
  //
  // Split the way the proof table is, and for the same reason. Naming something
  // that is not there, or contradicting the order, is never right — a heading
  // with the wrong number misleads and a pointer at the wrong lesson is advice
  // that fails when it is taken. A lesson the index does not list can be
  // deliberate, so it is a warning.

  'tutor-order': ({ root }) => {
    const course = readCourse(root)
    if (!course) return { skipped: 'no commands/tutor — not the workspace that ships the tutorial' }
    if (!course.order.length) return { skipped: 'tutor/index.md declares no LESSONS' }

    const index    = join(course.dir, 'index.md')
    const byId     = new Map(course.lessons.map(l => [l.id, l]))
    const findings = []

    course.order.forEach((id, i) => {
      const lesson = byId.get(id)
      if (!lesson) {
        findings.push({ file: index, line: 1,
          message: `the index lists \`${id}\` and there is no command file declaring that title. ` +
                   'Somebody running the tutorial in the order it states reaches a command that does not exist.' })
        return
      }

      const position = i + 1
      if (lesson.heading !== null && lesson.heading !== position)
        findings.push({ file: join(course.dir, lesson.file), line: lesson.headingLine,
          message: `this lesson calls itself Lesson ${lesson.heading} and the index has it at ${position}. ` +
                   'The number is what a reader counts by, and every other lesson\'s prose refers to it.' })

      const expected = course.order[i + 1] ?? null
      if (lesson.next === expected) return

      const where = lesson.finishFile ?? join(course.dir, lesson.file)
      if (!lesson.finishFile)
        findings.push({ file: join(course.dir, lesson.file), line: 1,
          message: `${lesson.stepsName} has no finish step, so this lesson names no next one. ` +
                   `The index has \`${expected ?? 'nothing'}\` after it.` })
      else if (expected && !lesson.next)
        findings.push({ file: where, line: 1,
          message: `this lesson names no next one, and the index has \`${expected}\` after it. ` +
                   'A person following the pointers stops here.' })
      else if (!expected)
        findings.push({ file: where, line: lesson.nextLine,
          message: `this is the last lesson the index lists and it points at \`${lesson.next}\`.` })
      else
        findings.push({ file: where, line: lesson.nextLine,
          message: `this lesson points at \`${lesson.next}\` and the index has \`${expected}\` after it. ` +
                   'Two orders, and the one a person follows is this one.' })
    })

    return { findings }
  },

  'tutor-lesson-named': ({ root }) => {
    const course = readCourse(root)
    if (!course) return { skipped: 'no commands/tutor — not the workspace that ships the tutorial' }

    const listed   = new Set(course.order)
    const findings = []

    for (const l of course.lessons) {
      if (!listed.has(l.id))
        findings.push({ file: join(course.dir, l.file), line: 1,
          message: `\`${l.id}\` is a lesson that tutor/index.md does not list, so \`fli tutor\` never ` +
                   'names it and nothing points at it. Add it to LESSONS, or say why it is reached another way.' })
      if (!l.hasStepsDir)
        findings.push({ file: join(course.dir, l.file), line: 1,
          message: `\`${l.id}\` declares \`steps: ${l.stepsName}\` and there is no such directory beside it.` })
    }

    for (const orphan of course.orphanSteps)
      findings.push({ file: join(course.dir, orphan), line: 1,
        message: `${orphan} is a step directory no lesson claims with \`steps:\`, so nothing runs it.` })

    return { findings }
  },

  'dev-host-unique': ({ root }) => {
    const rows = safeRunnables(root)
    if (!rows.length) return { skipped: 'no runnables — nothing to derive a name from' }

    // No second guard: the reserved tooling slots always derive a name, so a
    // rule that skipped when nothing had one could never run.
    return { findings: hostCollisions(rows).map(c => ({
      file: join(root, 'packages', 'cli', 'core', 'ports.js'), line: 1,
      message: `${c.host} is derived by both ${c.ids.join(' and ')}. ` +
               'A name comes from the package name and the surface, so two packages whose names ' +
               'reduce to one label share one — and whichever started first answers it, which is ' +
               '`strictPort`\'s failure one layer up. Give one of them a distinct name.',
    })) }
  },

  'test-files-run': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const findings = []
    let looked = 0

    for (const dir of pkgs) {
      let pkg
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }

      // `:watch` is a dev affordance rather than the suite, and it is invariably
      // the bare runner — reading it would make every package look discovering.
      const bodies = Object.entries(pkg.scripts ?? {})
        .filter(([name]) => /^test(:|$)/.test(name) && !name.endsWith(':watch'))
        .map(([, body]) => body)

      // A runner walking a directory cannot forget a file, so the package has
      // nothing this rule can say. `bun test` counts as walking unless the
      // command names a file — `bun test test/` is a directory.
      const DISCOVERS = [/\bvitest\b/, /\bjest\b/, /\bnode\s+--test\b/]
      const segments  = bodies.join(' && ').split(/&&|;/)
      const walking   = segments.some(seg =>
        DISCOVERS.some(re => re.test(seg)) ||
        (/\bbun\s+test\b/.test(seg) && !/[\w.-]+\.[cm]?[jt]s\b/.test(seg)))
      if (walking) continue

      // A file named in a segment that follows a `bun test` on `&&` runs only
      // while that run is green — unrun in the one tree where it matters, a red
      // one. `;` and `||` reach the next segment whatever the last one did.
      const FILE   = /(?:\.\/)?(tests?)\/([\w.-]+\.[cm]?[jt]sx?)\b/g
      const filesIn = (text) => [...text.matchAll(FILE)].map(m => `${m[1]}/${m[2]}`)
      const ran   = new Set()
      const gated = new Set()
      for (const body of bodies) {
        const parts = body.split(/(&&|\|\||;)/)
        let behind = false
        for (let i = 0; i < parts.length; i += 2) {
          const files = filesIn(parts[i])
          for (const f of files) (behind ? gated : ran).add(f)
          if (parts[i + 1] !== '&&') behind = false
          else if (/\bbun\s+test(\s|$)/.test(parts[i])) behind = true
        }
      }
      const listed = new Set([...ran, ...gated])
      // Fewer than two named files is a script this rule has no business reading.
      if (listed.size < 2) continue
      looked++
      const gatedOnly = [...gated].filter(f => !ran.has(f))
      if (gatedOnly.length) findings.push({
        file: join(dir, 'package.json'),
        message: `${gatedOnly.length} test file(s) chained behind \`&&\` after a \`bun test\` — ${gatedOnly.join(', ')}. ` +
                 `They run only while every file before them passes, so in the tree where something is red ` +
                 `they are the ones that never run, and the count printed is the first segment's. Run the ` +
                 `segments with \`;\` and combine the exit codes, or put the files in one \`bun test\`.`,
      })

      const dirs = [...new Set([...listed].map(f => f.split('/')[0]))]
      // Two shapes of unrun file, and the second one needed a second signal.
      //
      // A `*.test.*` the script does not name is an unrun test, full stop.
      //
      // Anything ELSE in that directory is usually support code, and the thing
      // that tells support code apart from a dead harness is not its extension
      // — it is that support code is IMPORTED. jetty's HMR coverage was two
      // `.mjs` harnesses in `test/` that no script ran, that nothing imported,
      // and that could not have run at all: they resolved mesa by an absolute
      // path from another machine. They were the only cover for the seam
      // `FJS-481` broke, and ~450 green tests said nothing. Requiring BOTH — no
      // runner and no importer — is what separates them from a stub a test
      // pulls in.
      const RUNNABLE = /\.[cm]?[jt]sx?$/
      const bodiesOf = (d) => {
        const out = new Map()
        for (const name of safeRead(join(dir, d))) {
          if (!RUNNABLE.test(name)) continue
          try { out.set(name, readFileSync(join(dir, d, name), 'utf8')) } catch {}
        }
        return out
      }
      const orphans = []
      for (const d of dirs) {
        const files = bodiesOf(d)
        for (const [name] of files) {
          if (listed.has(`${d}/${name}`)) continue
          const isTest = /\.test\.[cm]?[jt]sx?$/.test(name)
          if (!isTest) {
            const stem = name.replace(RUNNABLE, '')
            // Imported by anything else in the directory → support code.
            const imported = [...files].some(([other, body]) =>
              other !== name && new RegExp(String.raw`['"\./]${stem}(\.[cm]?[jt]sx?)?['"]`).test(body))
            if (imported) continue
          }
          orphans.push(`${d}/${name}`)
        }
      }
      if (!orphans.length) continue

      findings.push({
        file: join(dir, 'package.json'),
        message: `${orphans.length} test file(s) that no script runs — ${orphans.join(', ')}. The script ` +
                 `names its files one at a time, so a file added later is simply never run: the suite is ` +
                 `green, the count rises, and the file nobody listed is the one written last — which is ` +
                 `the one written for the defect just fixed. Add them, or let the runner walk the ` +
                 `directory.`,
      })
    }

    if (!looked) return { skipped: 'no package hand-lists its test files' }
    return { findings }
  },

  // Invariant 16 says a runnable example is verified, and the only grader a
  // hand-written page had was a link check — litestone's 2026-10-09 docs audit
  // found 17 examples that failed as written, each green for months (FJS-D860).
  // The fence contract is package-neutral: a ```lite, ```js, ```ts or ```mesa
  // block runs unless its info string says `fragment`. What runs it is the
  // package's own suite, because only the package can supply the prelude a
  // block needs — a client built from the nearest schema, a compiled
  // component — so this grades the WIRING and never the verdict: a package
  // fencing an unmarked runnable block has `test/doc-examples.test.*`, and a
  // test script that reaches it (FJS-2331).
  //
  // `packages/cli/commands/**` is never read: a `.md` there is a command.
  'doc-examples-run': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const findings = []
    for (const dir of pkgs) {
      const blocks = runnableFences(dir)
      if (!blocks.length) continue

      const runner = ['ts', 'js', 'mjs'].map(ext => join(dir, 'test', `doc-examples.test.${ext}`)).find(existsSync)
      let pkg = {}
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch {}
      const bodies = Object.entries(pkg.scripts ?? {})
        .filter(([name]) => /^test(:|$)/.test(name) && !name.endsWith(':watch'))
        .map(([, body]) => body)
      // A script wraps and chains (`node tmp-run.mjs 'bun test test/ && bun bench/x.mjs'`), so
      // the file-name test reads from `bun test` to the end of that command, not the whole body.
      const walks = bodies.some(b => b.split(/&&|\|\||[;|]/).some(cmd => {
        const at = cmd.search(/\bbun\s+test\b/)
        return at >= 0 && !/[\w.-]+\.[cm]?[jt]s\b/.test(cmd.slice(at))
      }))
      const runs  = runner && (walks || bodies.some(b => b.includes('doc-examples.test')))
      if (runs) continue

      const langs = [...new Set(blocks.map(b => b.lang))].join(', ')
      const files = [...new Set(blocks.map(b => b.file))]
      findings.push({
        file: join(dir, files.length === 1 ? files[0] : 'package.json'),
        message: runner
          ? `test/${basename(runner)} exists and no test script runs it — ${blocks.length} runnable fence(s) ` +
            `(${langs}) across ${files.length} file(s) are graded by nothing.`
          : `${blocks.length} runnable fence(s) (${langs}) across ${files.length} doc file(s) and no ` +
            `test/doc-examples.test.* to run them. A fenced example nothing executes is a sketch wearing ` +
            `an example's clothes; litestone's runner is the shape (FJS-D860). Mark a sliver \`fragment\` ` +
            `on its info string, and run the rest.`,
      })
    }
    return { findings }
  },

  'package-root-md': ({ root }) => {
    const pkgs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      if (existsSync(join(dir, 'package.json'))) pkgs.push(dir)
    }
    if (!pkgs.length) return { skipped: 'no packages/' }

    const STANDARD = ['README.md', 'CLAUDE.md', 'PROJECT_STATE.md']

    // AGENTS.md is permitted and not required. It is the same KIND of thing as
    // CLAUDE.md — a root-level document whose whole value is being findable at
    // the root, under the name other tools have converged on — but it is written
    // for a consumer of the package rather than a contributor to it, so a package
    // nobody writes against does not owe one. Ruled 2026-08-30, DECISIONS.md.
    const allowed  = new Set([...STANDARD, 'AGENTS.md'])

    // A `*.snapshot.md` is generated and gated, not documentation — nobody is
    // asked to hold it in their head, and it cannot move: CI reruns each
    // snapshot's generator from the file's own directory, and an app is built
    // with the cwd its own scripts use. `packages/basecamp` is a package and an
    // app at once, which is the only reason this crosses the rule at all.
    const generated = (name) => /\.snapshot\.md$/.test(name)

    const findings = []
    for (const dir of pkgs) {
      const entries = safeRead(dir)

      const extra = entries.filter(n => n.endsWith('.md') && !allowed.has(n) && !generated(n))
      if (extra.length) findings.push({
        file: dir,
        message: `${extra.length} markdown file(s) beyond the three at the package root — ${extra.join(', ')}. ` +
                 `README/CLAUDE/PROJECT_STATE is the standard, because the root is the index and ` +
                 `an index nobody can hold in their head is a directory listing. Does this one belong at ` +
                 `the root, or in docs/? Record the answer as an allowance either way.`,
      })

      // One finding per absent file, and the finding points AT that file rather
      // than at the directory: an allowance is keyed by path, so a package
      // excused for a fifth file at its root would otherwise be excused for
      // every missing one too.
      for (const name of STANDARD.filter(n => !entries.includes(n))) findings.push({
        file: join(dir, name),
        message: `${name} is missing from the package root. The three are what somebody picking this ` +
                 `package up cold reads in order — what it is (README), how to work in it (CLAUDE), ` +
                 `where it stands (PROJECT_STATE); what changed is git — so an absent one is a ` +
                 `question with no answer rather than a shorter index. A package deliberately without ` +
                 `it is an allowance under "structure", same as a fifth file.`,
      })
    }
    return { findings }
  },

  // Invariant 17 sends everything past the three root files into `docs/`, and
  // says nothing about `docs/` having an index — so a page can be written,
  // committed and linked by nothing. That is not a discoverability nicety: a
  // reader who cannot find `exact-numbers.md` reads `roadmap.md` instead and
  // concludes the feature does not exist (`FJS-560`).
  //
  // The rule only fires where the package HAS chosen to keep an index. A `docs/`
  // with no README is a directory, and a directory of one file is not lying to
  // anyone; four or more without one is the shape that starts to.
  'docs-index': ({ root }) => {
    const dirs = []
    for (const name of safeRead(join(root, 'packages'))) {
      const docs = join(root, 'packages', name, 'docs')
      if (existsSync(docs)) dirs.push([name, docs])
    }
    if (!dirs.length) return { skipped: 'no packages/*/docs/' }

    const findings = []
    for (const [pkg, docs] of dirs) {
      const pages = safeRead(docs).filter(n => n.endsWith('.md') && n !== 'README.md')
      const index = join(docs, 'README.md')

      if (!existsSync(index)) {
        if (pages.length >= 4) findings.push({
          file: docs,
          message: `${pages.length} pages in ${pkg}/docs/ and no README.md to index them. ` +
                   `Past a handful the directory listing stops being an index — a reader looking ` +
                   `for one of these finds whichever file they already knew about.`,
        })
        continue
      }

      // A link, not a mention: the failure is a page nothing NAVIGATES to, and
      // prose citing a filename does not.
      const text   = readFileSync(index, 'utf8')
      const linked = new Set([...text.matchAll(/\]\(\.?\/?([A-Za-z0-9._-]+\.md)[^)]*\)/g)].map(m => m[1]))
      const orphan = pages.filter(n => !linked.has(n))

      if (orphan.length) findings.push({
        file: index,
        message: `${orphan.length} page(s) in ${pkg}/docs/ are linked from nothing — ${orphan.join(', ')}. ` +
                 `An unindexed page is a page a reader reaches only by already knowing it is there, ` +
                 `which is the population that does not need it. Link it, or delete it.`,
      })
    }
    return { findings }
  },

  // ─── the notes ──────────────────────────────────────────────────────────────
  //
  // Four rules with one shape: a document that says something the tree does not
  // say back. The bodies are in `core/doc-audit.js`, which carries the corpus
  // and the argument for what a rule here may grade.

  'doc-word-unknown':  ({ root }) => docWordUnknown({ root }),

  'doc-cites-dead':    ({ root }) => docCitesDead({ root }),

  'doc-claims-count':  ({ root, rules }) => docClaimsCount({ root, countables: [...COUNTABLES, checkRulesCountable(rules)] }),

  'doc-invariant-ref': ({ root, rules }) => docInvariantRef({ root, rules }),

  'doc-status-stale':  ({ root }) => docStatusStale({ root }),

  'doc-map-narration': ({ root }) => docMapNarration({ root }),

  'doc-unchecked-count': ({ root, rules }) => docUncheckedCount({ root, countables: [...COUNTABLES, checkRulesCountable(rules)] }),

  'invariant-enforcer': ({ root, rules }) => invariantEnforcer({ root, rules }),

  'hazard-enforcer':    ({ root, rules }) => hazardEnforcer({ root, rules }),

  'seam-owner': ({ root }) => seamOwner({ root }),

  'seam-listed': ({ root }) => seamListed({ root }),

  'threat-row':  ({ root }) => threatRow({ root }),

  'skill-pointer':      ({ root }) => skillPointer({ root }),

  // FJS-D890: an official connector is a target builder, payload types, an
  // error mapping, a sink and a drive, always. The sink and the drive are the
  // two pieces a connector can ship without and still compile, so a missing one
  // is silent until an app's own drive sends a request out of the process. The
  // peer is what keeps two copies of conduit from being installed beside an app.
  // A sink is `sink.*`, `*-sink.*` or `*.sink.*`; a drive is `drive.*`,
  // `*-drive.*` or `*.drive.*`, or anything under a `drive/` directory.
  'connector-contract': ({ root }) => {
    const dirs = safeRead(join(root, 'packages'))
      .filter(name => /^conduit-./.test(name))
      .map(name => join(root, 'packages', name))
      .filter(dir => existsSync(join(dir, 'package.json')))
    if (!dirs.length) return { skipped: 'no packages/conduit-*' }

    const SINK  = /(^|[.-])sink\.[cm]?[jt]sx?$/
    const DRIVE = /(^|[.-])drive(\.(test|spec))?\.[cm]?[jt]sx?$/
    const findings = []
    for (const dir of dirs) {
      let sink = false, drive = false
      walk(dir, 6, d => {
        const inDrive = /(^|[\\/])drive$/.test(d)
        for (const name of safeRead(d)) {
          if (SINK.test(name)) sink = true
          if (DRIVE.test(name) || (inDrive && /\.[cm]?[jt]sx?$/.test(name))) drive = true
        }
      })
      let pkg = {}
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { /* unreadable: no peer */ }
      const peer = Boolean(pkg.peerDependencies?.['@frontierjs/conduit'])

      const missing = []
      if (!sink)  missing.push('a sink (`sink.ts` or `<vendor>-sink.ts`), which owns the chaos: a duplicate delivery, a lost response, a moved clock')
      if (!drive) missing.push('a drive (`drive.ts`, `<vendor>.drive.ts` or a `drive/` directory), which runs the sink and the fixture through one script')
      if (!peer)  missing.push('`@frontierjs/conduit` under `peerDependencies`, so an app resolves one conduit')
      if (!missing.length) continue
      findings.push({
        file: join(dir, 'package.json'),
        message: `${pkg.name ?? dir} is missing ${missing.join('; ')} (FJS-D890). A connector without them ` +
                 `compiles and ships, and the first request to leave the process is the app's own.`,
      })
    }
    return { findings }
  },

  'american-spelling':  ({ root }) => americanSpelling({ root }),

  'home-path-literal':  ({ root }) => homePathLiteral({ root }),
}

/**
 * The runnable rows, or none.
 *
 * A rule must never take the whole check down, and this one reads a tree that
 * may be anything: a client app, a half-scaffolded directory, a checkout with
 * no `packages/`. An empty list makes both proof rules degrade honestly —
 * `proof-target` still grades a script against the package that declares it,
 * and `proof-drive-named` skips.
 */
function safeRunnables(root) {
  try { return runnables(root) } catch { return [] }
}

/** Whether a `../` proof target's sibling checkout is on disk and has no such script or file. */
function siblingLacks(t, root) {
  const dir = resolve(root, t.where)
  if (!existsSync(dir)) return false
  if (t.command === null) return !existsSync(join(dir, t.name))
  const script = t.name.replace(/^bun run /, '').split(/\s+/)[0]
  try { return !JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.[script] } catch { return true }
}

// ─── american-spelling ────────────────────────────────────────────────────────
//
// `FJS-D192` flipped this repo from British to American, prose and identifiers
// alike, and nothing graded it — so it re-drifted, and the second sweep
// (`FJS-D239`'s neighbour, 2026-09-07) was 1,131 replacements across 285 files.
// A ruling nothing measures is a ruling that has to be re-applied by hand every
// few weeks, which is `FJS-D190`'s argument about invariants one tier down.
//
// **The table is the -ise/-ize family and nothing else.** It is the one that
// actually drifts, because both spellings look correct to a reader and neither
// is flagged by any editor. `-our`, `-re` and `-ce` are not graded: `colour`
// went with `FJS-D192` itself and stayed gone, and a rule that fires on `centre`
// would have to know it is not a proper noun.
//
// **Three legitimate English nouns are the reason this is a word list and not a
// suffix rule**: `parenthesis`, `synthesis` and `initialism` all carry `-is-`
// and none is a British spelling. Every entry below therefore carries enough
// letters that it cannot match one — each needs the `-e`, `-ing` or `-ation`
// those nouns do not have. A suffix rule tried on this repo rewrote `analyses`,
// the plural of `analysis`, in `toolbelt/inflect` AND in the test that guards
// it, in one commit, leaving nothing to fail — the comment there is a warning
// rather than history.
//
// **What is deliberately not graded**: `cancelled`, which `FJS-D192` names as
// its one standing exception (a persisted enum value across `example` and
// `basecamp`, so a rename is a migration); the two append-only archives, whose
// entries record what was written; and generated `*.snapshot.*`, which is its
// generator's output rather than anybody's prose.

const BRITISH = [
  'summarise', 'normalise', 'serialise', 'sanitise', 'memoise', 'materialise',
  'recognise', 'initialise', 'organise', 'optimise', 'minimise', 'maximise',
  'finalise', 'visualise', 'anonymise', 'tokenise', 'itemise', 'humanise',
  'pluralise', 'singularise', 'generalise', 'neutralise', 'canonicalise',
  'synchronise', 'containerise', 'parameterise', 'internalise', 'editorialise',
  'institutionalise', 'parenthesise', 'synthesise', 'deserialise',
  'normalisation', 'organisation', 'optimisation', 'itemisation',
  'materialisation', 'memoisation', 'pluralisation', 'neutralisation',
  'containerisation', 'singularisation',
  'normalising', 'organising', 'optimising', 'summarising', 'sanitising',
  'materialising', 'recognising', 'initialising', 'synthesising',
  'parenthesising', 'synchronising', 'pluralising', 'generalising',
  'tokenising', 'finalising', 'maximising', 'visualising', 'anonymising',
  'catalogue', 'greylist', 'labelling',
]

const BRITISH_RE = new RegExp(`(${BRITISH.join('|')})`, 'i')

const SPELL_EXT  = /\.(js|ts|mjs|cjs|jsx|tsx|md|lite|mesa|json|html|css|sql|yml|yaml)$/

// Four exemptions beyond the archives, and the last is the one that matters.
// `*.live.*` is `ws:atlas --live`'s deliberately ungated output and `out/` is a
// build directory. This file is where the table above lives, so a rule reading
// its own source would report every word it exists to find — the shape a
// dictionary check always has, and cheaper to state than to encode around by
// splitting the strings.
//
// **`test/fixtures/corpus/` is foreign input and grading it would be wrong**,
// not merely noisy: those schemas are fetched from real projects so the readers
// meet input nobody here wrote, and `Organisation` is Documenso's own model
// name. Correcting it would edit somebody else's schema and break the very
// property the corpus exists for. The rule grades what this repo WROTE.
const SPELL_SKIP = /\.snapshot\.|\.live\.|\/out\/|test\/fixtures\/corpus\/|docs\/handoff-archive\/|ISSUES_ARCHIVE\.md$|core\/checks\.js$/

function americanSpelling({ root }) {
  const findings = []
  const seen     = new Set()

  walk(root, 6, (dir) => {
    for (const name of safeRead(dir)) {
      if (!SPELL_EXT.test(name)) continue
      const file = join(dir, name)
      const rel  = relative(root, file)
      if (SPELL_SKIP.test(rel) || seen.has(rel)) continue
      seen.add(rel)
      let text
      try { if (!statSync(file).isFile()) continue; text = readFileSync(file, 'utf8') }
      catch { continue }
      if (!BRITISH_RE.test(text)) continue
      text.split('\n').forEach((line, i) => {
        const m = BRITISH_RE.exec(line)
        if (!m) return
        // The escape, and it is narrow on purpose: a line carrying `spelling-exempt`
        // is one where the British form is INPUT rather than prose — a synonym
        // table holding what a searcher types, a matcher for a column an app
        // named itself. Correcting those deletes the entry rather than fixing a
        // spelling. It takes a reason on the same line because the marker is the
        // only thing a reader will see.
        if (/spelling-exempt/.test(line)) return
        // One finding per LINE and at most three per file: a sweep is one
        // action, and a hundred rows of the same word is a report nobody reads.
        if (findings.filter(f => f.file === file).length >= 3) return
        findings.push({ file, line: i + 1,
          message: `writes \`${m[1]}\` — this repo is American throughout, prose and identifiers ` +
                   `alike (\`FJS-D192\`). Write \`${american(m[1])}\`.` })
      })
    }
  })
  return { findings }
}

// The American form of one British word, derived rather than paired: every entry
// in the table above differs only in `s` → `z`, except the three that are a
// different word. A second column would be a second thing to keep in step.
function american(word) {
  const lower = word.toLowerCase()
  const out = lower === 'catalogue' ? 'catalog'
            : lower === 'greylist'  ? 'graylist'
            : lower === 'labelling' ? 'labeling'
            : lower.replace(/is(e|a|i)/, 'iz$1')
  return word[0] === word[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out
}

// ─── home-path-literal ────────────────────────────────────────────────────────
//
// A script with the repo root hardcoded under one developer's home runs on that
// machine and nowhere else, and nothing on that machine notices.
//
// **The pattern is THIS machine's home, never `/home/<anything>`.** A leak is
// the author's own home and the rule runs where the author works. The tree holds
// legitimate placeholders — `/home/user` in a path classifier's fixtures,
// `/home/node` in a Dockerfile — and a generic pattern fires on every one. A
// runner with a different home finds nothing; the leak is caught before commit.
//
// The file list is git's, so a gitignored scratch file is not a finding.

const HOME_EXT = /\.(js|ts|mjs|cjs|jsx|tsx|md|lite|mesa|json|html|css|sql|yml|yaml|sh|toml|txt)$/

function homePathLiteral({ root, home = homedir() }) {
  const findings = []
  // A home of `/` or a bare `/root` would match too much to mean anything.
  if (!home || home.split('/').filter(Boolean).length < 2) return { findings }
  const pattern = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`)

  const tree  = treePaths(root)
  const files = []
  if (tree) for (const rel of tree.files) files.push(rel)
  else walk(root, 6, dir => { for (const name of safeRead(dir)) files.push(relative(root, join(dir, name))) })

  for (const rel of files) {
    if (!HOME_EXT.test(rel)) continue
    const file = join(root, rel)
    let text
    try { if (!statSync(file).isFile()) continue; text = readFileSync(file, 'utf8') }
    catch { continue }
    if (!pattern.test(text)) continue
    text.split('\n').forEach((line, i) => {
      if (!pattern.test(line)) return
      if (findings.filter(f => f.file === file).length >= 3) return
      findings.push({ file, line: i + 1,
        message: `names \`${home}\`, this machine's home directory. Derive a path from ` +
                 '`import.meta.url`, write it relative to the repo, or use `~/` for a checkout outside it; ' +
                 'a fixture that needs a home uses a placeholder such as `/home/user`.' })
    })
  }
  return { findings }
}

/** A package's hand-written docs: the three root files plus everything under docs/. */
function docPages(dir) {
  const out = ['README.md', 'AGENTS.md', 'CLAUDE.md'].filter(f => existsSync(join(dir, f)))
  walk(join(dir, 'docs'), 6, d => {
    for (const name of safeRead(d))
      if (name.endsWith('.md') && !name.includes('.snapshot.')) out.push(relative(dir, join(d, name)))
  })
  return out
}

/** Every runnable fence in a package's docs not marked `fragment`, as `{ file, line, lang }`. */
function runnableFences(dir) {
  const out = []
  for (const file of docPages(dir)) {
    let text
    try { text = readFileSync(join(dir, file), 'utf8') } catch { continue }
    for (const f of docFences(text))
      if (isRunnable(f)) out.push({ file, line: f.line, lang: f.lang })
  }
  return out
}

// ─── skill-pointer ────────────────────────────────────────────────────────────
//
// The root `CLAUDE.md` keeps a NAME for each section it moved behind
// `.claude/skills/` — `data-hazards` (`.claude/skills/`) in prose, and the
// realm table's Skill column. A skill loads by that name, so a directory
// renamed out from under the pointer leaves the sentence reading exactly as it
// did with nothing behind it: `proof-target`'s failure, one document up. The
// frontmatter is the other half — the Skill tool registers a skill under
// `name:` rather than under the directory, so the two disagreeing is a skill
// the pointer can name and the tool cannot find.
//
// Only the pointer is graded. Whether the skill still SAYS what the sentence
// promises is a judgement; whether the file is there is a fact, and it is the
// half that rots. A skill CLAUDE.md never names is not reported: a skill fires
// off its own description, and a pointer is one way in rather than the only one.
//
// A skill can point at skills too — `which-skill` is nothing but pointers — so
// every `SKILL.md` is read the same way, tables only: a skill's prose is full of
// backticked words, and the Skill column is the one place a name is unambiguous.

const SKILL_PROSE = /`([a-z][a-z0-9-]*)`\s*\(`\.claude\/skills\/`\)/g

/** Skill name → first line it is cited on, from `text`'s Skill-column tables. */
function skillTableNames(text, named = new Map()) {
  let col = -1
  text.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) { col = -1; return }
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (col === -1) { col = cells.findIndex(c => /^skill$/i.test(c)); return }
    if (/^-+$/.test(cells[col] ?? '')) return
    const m = /^`([a-z][a-z0-9-]*)`$/.exec(cells[col] ?? '')
    if (m && !named.has(m[1])) named.set(m[1], i + 1)
  })
  return named
}

function skillPointer({ root }) {
  const claude = join(root, 'CLAUDE.md')
  if (!existsSync(claude)) return { skipped: 'no root CLAUDE.md' }
  const skillsDir = join(root, '.claude', 'skills')

  const citers = []
  const text   = readFileSync(claude, 'utf8')
  const named  = new Map()
  for (const m of text.matchAll(SKILL_PROSE))
    if (!named.has(m[1])) named.set(m[1], text.slice(0, m.index).split('\n').length)
  citers.push({ file: claude, label: 'CLAUDE.md', named: skillTableNames(text, named) })

  for (const dir of safeRead(skillsDir).sort()) {
    const file = join(skillsDir, dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const cited = skillTableNames(readFileSync(file, 'utf8'))
    if (cited.size) citers.push({ file, label: `the skill \`${dir}\``, named: cited })
  }

  if (!citers.some(c => c.named.size)) return { skipped: 'CLAUDE.md names no skill' }

  const findings = []
  const graded   = new Set()
  for (const { file: citer, label, named } of citers) {
    for (const [name, line] of named) {
      const file = join(skillsDir, name, 'SKILL.md')
      if (!existsSync(file)) {
        findings.push({ file: citer, line,
          message: `names the skill \`${name}\` and \`.claude/skills/${name}/SKILL.md\` is not in the tree. ` +
                   `The sentence reads the same with nothing behind it — point it at what replaced the ` +
                   `skill, or put the skill back.` })
        continue
      }
      if (graded.has(name)) continue
      graded.add(name)
      let declared
      try { declared = parseFrontmatter(readFileSync(file, 'utf8')).frontmatter.name } catch (err) {
        findings.push({ file, line: err.line ?? 1,
          message: `has frontmatter that does not read — ${err.message.replace(/^line \d+: /, '')}. ` +
                   `The Skill tool registers a skill under its \`name:\`, so one that cannot be read ` +
                   `names nothing.` })
        continue
      }
      if (declared !== name) findings.push({ file, line: 1,
        message: `is named \`${name}\` by ${label} and declares \`name: ${declared ?? '(none)'}\`. The Skill ` +
                 `tool registers it under the frontmatter, so the pointer names a skill the tool cannot ` +
                 `find — make the two agree.` })
    }
  }
  return { findings }
}

// ─── invariant-enforcer ───────────────────────────────────────────────────────
//
// `core/invariants.js` declares which test, phase or drive fails when an
// invariant stops being true — the half no table can derive. A declaration is
// advice, and advice that fails when taken is worse than none: an invariant
// pointing at a renamed suite reads as covered from every angle, and the only
// way to find out is to go looking for the assertion by hand.
//
// So this grades the pointer and nothing else. Whether the named suite really
// holds the assertion is a judgement no rule can make; whether the file is
// still there is a fact, and it is the half that rots. Same argument, same
// severity and the same shape as `proof-target`.
//
// It does NOT report an invariant with no enforcer at all. That is the gap the
// snapshot exists to publish, and a check that failed on it would be a red
// build for a piece of honesty — the fastest way to have somebody delete the
// row rather than write the rule.

function invariantEnforcer({ root, rules }) {
  const rows = invariantCoverage({ root, rules })
  if (!rows.length) return { skipped: 'CLAUDE.md declares no numbered Invariants section' }

  const findings = []
  for (const row of rows) {
    for (const e of row.enforcers) {
      if (e.resolved || e.derived) continue
      findings.push({
        file: join(root, 'packages', 'cli', 'core', 'invariants.js'),
        message: `Invariant ${row.n} names ${e.kind} \`${e.at}\`, which is not in the tree. ` +
                 `A declared enforcer that does not resolve reports the invariant as covered ` +
                 `and there is nothing behind it — point it at what replaced it, or record ` +
                 `the invariant as having no enforcer, which \`invariants.snapshot.md\` is ` +
                 `written to say out loud.`,
      })
    }
  }
  return { findings }
}

// ─── hazard-enforcer ──────────────────────────────────────────────────────────
//
// A rule names the live hazard it grades by its realm and a prefix of the
// bullet's bold lead (`core/hazards.js`), and `hazards.snapshot.md` is read off
// that. A key that matches no bullet credits nothing, and the hazard it meant
// turns `none` in the snapshot with nothing saying why — rewording a bullet is
// all it takes. A key matching two is a guess. Both are one-word fixes, so both
// are errors. A hazard no rule names is not reported: that is the gap the
// snapshot publishes, the same line `invariant-enforcer` draws.

function hazardEnforcer({ root, rules }) {
  const { hazards, unresolved } = hazardCoverage({ root, rules })
  if (!hazards.length) return { skipped: 'no realm skill under .claude/skills/ lists a hazard' }

  return {
    findings: unresolved.map(u => ({
      file: join(root, 'packages', 'cli', 'core', 'checks.js'),
      message: `Rule \`${u.rule}\` names hazard '${u.key}', which matches ${u.matches} bullets of ` +
               `its realm skill. A key must be the realm and a prefix of ONE bullet's bold lead — ` +
               (u.matches ? 'lengthen the prefix until one is left.' :
                            'the bullet was reworded or moved; point the key at what it says now.'),
    })),
  }
}

// ─── seam-owner ───────────────────────────────────────────────────────────────
//
// The `bridge-index` skill opens *reach for them before grepping*, and twenty-six
// of its eighty-five bullets name the file to reach for. That claim is advice,
// and it rots the same way `invariants.js`'s enforcers rot: a seam that moves
// leaves the bullet pointing at where it used to live, and a reader who greps
// the stated path and finds nothing concludes the seam is gone rather than that
// the sentence is stale. `matchesQuery` moved to `@frontierjs/toolbelt/match`
// under `FJS-D26` and the bullet still named sierra, which is the shape.
//
// Two ways the claim can be false and both are facts rather than judgements:
// the path is not in the tree, or the path is there and the name is not in it.
// The second is the one that reads as correct from every angle, because a
// re-export puts the name in the module's public surface while the declaration
// lives somewhere else entirely — so where it was forwarded FROM is reported,
// since the fix is unusable without it.
//
// It does NOT report a bullet that names no owner. Fifty-nine name none, that
// is the gap `seams.snapshot.md` exists to publish, and failing on it would be
// a red build for a piece of honesty.

function seamOwner({ root }) {
  const rows = seamOwnership({ root })
  if (!rows.length) return { skipped: `no ${SEAM_SKILL}` }

  const file     = join(root, SEAM_SKILL)
  const findings = []

  for (const r of rows) {
    if (r.owner === null) continue

    if (!r.ownerExists) {
      findings.push({ file, line: r.line,
        message: `\`${r.names[0]}\` names \`${r.owner}\`, which is not in the tree. A seam whose ` +
                 `stated owner has gone reads as owned from every angle, and the reader who greps it ` +
                 `concludes the seam moved rather than the sentence.`,
      })
      continue
    }

    // A key is never declared, so the question a file can answer about one is
    // whether it mentions it at all. That is a weaker claim than a declaration
    // and it catches the failure that happens: the minting moved, the bullet
    // did not. Without it, twenty-four owners were unfalsifiable.
    if (r.kind === 'key') {
      if (r.mentioned) continue
      findings.push({ file, line: r.line,
        message: `\`${r.names[0]}\` names \`${r.owner}\`, which never mentions \`${keyLiteral(r.names[0])}\`. ` +
                 `A key has no declaration to point at, so the owner is where it is MINTED — and a file ` +
                 `that does not contain the string is not minting it.`,
      })
      continue
    }

    if (r.inOwner) continue

    findings.push({ file, line: r.line,
      message: r.reexport
        ? `\`${r.names[0]}\` names \`${r.owner}\`, which only re-exports it from \`${r.reexport}\`. ` +
          `A re-export puts the name in that module's surface and leaves the declaration elsewhere, so ` +
          `Invariant 4's one owner is the module it came from — name that one, and keep the forward as ` +
          `where it is consumed.`
        : `\`${r.names[0]}\` names \`${r.owner}\`, which declares no \`${r.id}\`. Either the seam moved ` +
          `and the bullet did not, or the owner is right and the name on the bullet is not what the ` +
          `code calls it — both send a reader to the wrong file.`,
    })
  }
  return { findings }
}

// ─── seam-listed ──────────────────────────────────────────────────────────────
//
// `CLAUDE.md` § Bridge index says what it is for out loud: the key list stays
// at the root so *is there an owner for this already* is answerable without
// loading ninety paragraphs. A seam absent from it answers that question NO,
// which is the one wrong answer the section can give — and it had been giving
// it for `signIn`, ruled in `FJS-D261` and explained in its own bullet, for as
// long as the two lists were kept by hand and compared by nobody.
//
// It grades one direction. A name in the key list with no bullet behind it is
// `doc-cites-dead`'s shape and not this one; a seam explained and never listed
// is this one, because the skill is the origin and the key list is the copy.

function seamListed({ root }) {
  const gaps = unlisted(root)
  if (!gaps.length) return { findings: [] }

  const file = join(root, 'CLAUDE.md')
  return { findings: gaps.map(s => ({
    file, line: s.line,
    message: `\`${s.names[0]}\` is a seam the \`bridge-index\` skill explains and § Bridge index ` +
             `does not name. The key list is what answers *is there an owner for this already* ` +
             `without loading the skill, and a seam missing from it answers no. Add it under ` +
             `**${s.section}**.`,
  })) }
}

// ─── threat-row ───────────────────────────────────────────────────────────────
//
// `THREATS.md` is a Map of what each adversary may do (`FJS-D656`), and a row's
// *Proved by* is the only part of it that can be wrong without anyone reading
// it wrong: a renamed suite leaves the boundary reading as proved, and an audit
// grading the table skips it. So a row naming no test, a path that is not in
// the tree, or a path that is not a test is an error. Where the table has an
// *ASVS* column, a row citing no ASVS requirement is one too: the standard is
// what the table is graded against, and a bare chapter (`V8`) matches no line
// of the gap sheet.
//
// *Open* is graded the other way round: the page's rule (a test asserting an
// open hole belongs in *Open*) has a converse, and a fixed hole stayed there as
// prose while the tests proving the fix stayed out of *Proved by*. An *Open*
// cell whose every `FJS-###` is a closed row is an error (a ruling cited
// there is a limit held by design, and stays), and so is a test named there that carries no `test.failing`.
//
// A dead path in *Enforced at* is `doc-cites-dead`'s. Whether the named test
// really holds the promise, or the ID really names it, no rule decides.

const THREATS_FILE = 'THREATS.md'

function threatRow({ root }) {
  const file = join(root, THREATS_FILE)
  if (!existsSync(file)) return { skipped: `no ${THREATS_FILE}` }

  const findings = []
  const reg     = readRegisters(root)
  const settled = new Set(reg.issues.filter(r => r.closed)
    .flatMap(r => [r.id, ...(r.aliases ?? [])]).map(id => id.toLowerCase()))
  const citeRe  = reg.prefix ? new RegExp(`\\b${reg.prefix}-D?\\d+\\b`, 'gi') : null
  let col = -1, asvs = -1, open = -1, rows = 0
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) { col = -1; return }
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (col === -1) {
      col  = cells.findIndex(c => /^proved by$/i.test(c))
      asvs = cells.findIndex(c => /^asvs$/i.test(c))
      open = cells.findIndex(c => /^open$/i.test(c))
      return
    }
    if (cells.every(c => /^:?-+:?$/.test(c))) return
    rows++
    const at    = { file, line: i + 1 }
    const label = cells[0] || `line ${i + 1}`
    if (asvs !== -1 && !/\bV\d+\.\d+\.\d+\b/.test(cells[asvs] ?? '')) {
      findings.push({ ...at,
        message: `row ${label} cites no ASVS requirement in *ASVS*. Name the ASVS 5.0 requirement ` +
                 `(\`V8.2.1\`) the promise answers to; docs/ASVS.md lists each one in scope.` })
    }
    if (open !== -1) {
      const cell  = cells[open] ?? ''
      const cited = citeRe ? [...new Set([...cell.matchAll(citeRe)].map(m => m[0].toUpperCase()))] : []
      if (cited.length && cited.every(id => settled.has(id.toLowerCase()))) findings.push({ ...at,
        message: `row ${label} lists ${cited.join(', ')} under *Open*, and every one is closed. A ` +
                 `fixed hole is not open: move the test that proves the fix to *Proved by* and ` +
                 `write \`—\` here.` })
      for (const [, p] of cell.matchAll(/`([^`\s]+\/[^`\s]+)`/g)) {
        if (kindOf(p) !== 'test') continue
        if (!existsSync(join(root, p))) findings.push({ ...at,
          message: `row ${label} names \`${p}\` in *Open*, which is not in the tree.` })
        else if (!/\b(?:test|it)\.failing\b/.test(readFileSync(join(root, p), 'utf8'))) findings.push({ ...at,
          message: `row ${label} names \`${p}\` in *Open*, and it carries no \`test.failing\`. A ` +
                   `test that passes proves the promise: move it to *Proved by*.` })
      }
    }
    const paths = [...(cells[col] ?? '').matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map(m => m[1])
    if (!paths.some(p => kindOf(p) === 'test')) {
      findings.push({ ...at,
        message: `row ${label} names no test in *Proved by*. A boundary with no test reads as proved ` +
                 `from every angle — name the test that fails when the promise breaks, written from ` +
                 `the repo root.` })
    }
    for (const p of paths) {
      if (!existsSync(join(root, p))) findings.push({ ...at,
        message: `row ${label} names \`${p}\`, which is not in the tree. Point it at what replaced ` +
                 `the test, or the row has lost its proof.` })
      else if (kindOf(p) !== 'test') findings.push({ ...at,
        message: `row ${label} names \`${p}\` in *Proved by*, which is not a test. The file that ` +
                 `keeps the promise belongs in *Enforced at*.` })
    }
  })
  if (!rows) return { skipped: `${THREATS_FILE} has no table with a *Proved by* column` }
  return { findings }
}
