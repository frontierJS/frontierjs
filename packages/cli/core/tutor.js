// ─── tutor.js — the state behind `fli tutor` ─────────────────────────────────
//
// Three things, none of which a lesson step should be deciding for itself:
// WHERE the app being built lives, WHAT a previous run already finished, and
// the one recipe that turns a scaffolded app into one that deploys to this
// machine.
//
// ── Why there is a journal at all ────────────────────────────────────────────
//
// A lesson is long, it starts servers and builds images, and a person will
// close the terminal in the middle of one. Re-running from the top would be
// wrong twice: it costs minutes, and step 3 of `tutor:app` scaffolds an app
// that is already there. The step runner already calls
// `context.config.journal?.beforeStep/afterStep` around every step of any
// command that installs one and knows nothing about deploys — so a recorder
// here gets resume for free, the same way `fli deploy` did.
//
// The verdict vocabulary is `core/journal.js`'s, deliberately unchanged:
// `succeeded → skip` (replayed into a no-op, carrying what it recorded),
// `running → rerun` (a previous run died inside this step). Two implementations
// of *what does a half-finished run mean* is how they end up disagreeing.
//
// ── Why JSON and not the deploy journal ──────────────────────────────────────
//
// That one is SQLite on the deploy target, opened over ssh, because a deploy
// asks its question about a machine. A lesson asks it about a directory on the
// machine you are typing on, and there is no second writer — `FJS-D156`'s split
// between the lock (*is another run working here now*) and the journal (*what
// did the last run leave*). This is only the journal half.
//
// Zero dependencies, plain ESM, node or bun: `scripts/ci.mjs` runs on node.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, basename }  from 'node:path'
import { tmpdir }                   from 'node:os'

export const TUTOR_FORMAT   = 1
export const JOURNAL_NAME   = '.fli-tutor.json'
export const journalPath    = (workspace) => join(workspace, JOURNAL_NAME)

// ─── the workspace ────────────────────────────────────────────────────────────
//
// Two kinds and one branch, here rather than in nine steps. A person gets a
// real directory they can open afterwards — a tutorial whose output is deleted
// teaches you something you cannot then look at. CI gets a temp one, because a
// lesson must never write into the tree it is grading.
//
// `FJS_CI_WORKDIR` is honoured for the reason the deploy phase honours it: a
// shell with a private `/tmp` gives a Docker daemon that cannot read the build
// context, and the error is about a directory that is plainly there.

export function tutorWorkspace({ name, tmp = false, cwd = process.cwd() } = {}) {
  if (tmp) {
    const base = process.env.FJS_CI_WORKDIR || tmpdir()
    mkdirSync(base, { recursive: true })
    const dir = mkdtempSync(join(base, 'fjs-tutor-'))
    return { dir, kind: 'temp', app: name || 'my-app' }
  }

  if (!name) throw new Error('a named workspace needs a name — pass --workspace <dir>, or --tmp for a throwaway one')
  const dir = resolve(cwd, name)
  mkdirSync(dir, { recursive: true })
  return { dir, kind: 'named', app: basename(dir) }
}

// ─── reading and writing ──────────────────────────────────────────────────────
//
// Written through a rename, so a run killed mid-write leaves the previous
// journal rather than half of one — the pattern `core/registry.js` already uses
// for its cache. A journal that cannot be parsed is the one file whose loss
// makes every later run start from the top.

export function readJournal(workspace) {
  const path = journalPath(workspace)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function writeJournal(workspace, doc) {
  // A journal lives IN the workspace, so a workspace that has been swept has no
  // journal to write. The teardown step removes a temporary one and the runner
  // then records that step, in that order — which threw ENOENT about a temp file
  // and made a lesson that had just printed *done* exit 1.
  if (!existsSync(workspace)) return null

  const path = journalPath(workspace)
  const temp = `${path}.${process.pid}`
  writeFileSync(temp, JSON.stringify(doc, null, 2) + '\n')
  renameSync(temp, path)
  return doc
}

export function newJournal({ workspace, app, fli }) {
  return {
    format:    TUTOR_FORMAT,
    workspace,
    app,
    fli:       fli ?? null,
    createdAt: new Date().toISOString(),
    lessons:   {},
  }
}

// ─── the refusals ─────────────────────────────────────────────────────────────
//
// A journal belongs to one directory. Carrying it to another — a copied tree, a
// temp dir reused under a different name — would replay steps whose recorded
// paths point somewhere else, and the failure would surface several steps later
// as a file that is mysteriously absent. Named here instead.

export function journalVerdict(doc, { workspace }) {
  if (!doc) return { ok: true }
  if (doc.format !== TUTOR_FORMAT) {
    return { ok: false, kind: 'format',
             message: `this journal is format ${doc.format} and this fli writes ${TUTOR_FORMAT} — start again with --restart` }
  }
  if (doc.workspace && doc.workspace !== workspace) {
    return { ok: false, kind: 'workspace',
             message: `this journal was written for ${doc.workspace} and you are in ${workspace} — start again with --restart` }
  }
  return { ok: true }
}

// ─── the resume verdict ───────────────────────────────────────────────────────
// `core/journal.js`'s three answers, in its words.

export function resumeDecision(row) {
  if (!row)                     return { action: 'run' }
  if (row.status === 'succeeded') {
    return { action: 'skip', note: 'already done — replayed into a no-op', output: row.output }
  }
  if (row.status === 'skipped')  return { action: 'skip', note: 'skipped by its own predicate' }
  if (row.status === 'running')  return { action: 'rerun', note: 'a previous run died inside this step — running it again' }
  return { action: 'run' }
}

// ─── hydrate ──────────────────────────────────────────────────────────────────
//
// What every finished step recorded, merged, so a later step can find the app
// directory a much earlier one created.
//
// Called UP FRONT by the orchestrator and not only on replay — otherwise
// `fli tutor:deploy --step 8` has no `appDir` and fails as a TypeError several
// frames from anything a reader can act on.

export function hydrate(doc, lesson) {
  const steps = doc?.lessons?.[lesson]?.steps ?? {}
  const out   = {}
  for (const row of Object.values(steps)) {
    if (row.status !== 'succeeded' || !row.output) continue
    try { Object.assign(out, JSON.parse(row.output)) } catch { /* a note that is not JSON is not a fact */ }
  }
  return out
}

// ─── the recorder ─────────────────────────────────────────────────────────────
//
// Duck-typed to what `core/runtime.js` calls. `note(context, {...})` is how a
// step hands facts to the steps after it, and it is the same channel a REPLAYED
// step answers from — a step that is skipped runs none of its code, so anything
// it discovered has to come back out of the journal or the run continues with
// `undefined` where a path should be.

const MAX_NOTE = 2000

// `ephemeral` names the steps whose success is not a fact a journal can hold.
// Starting a server is the case: the row says `succeeded` and the process is
// gone, so replaying it into a no-op leaves every step after it talking to a
// port nothing is listening on. They are still RECORDED — a reader wants to see
// that they ran — they are only never skipped.
export function makeRecorder({ workspace, lesson, context, ephemeral = [], now = () => new Date().toISOString() }) {
  let doc = readJournal(workspace) ?? newJournal({ workspace, app: context?.config?.app })
  doc.lessons[lesson] ??= { status: 'running', startedAt: now(), steps: {} }

  const rows  = () => doc.lessons[lesson].steps
  const flush = () => writeJournal(workspace, doc)

  return {
    doc: () => doc,

    beforeStep(name) {
      // An explicit `--step N` is a person saying "do this one again". Honouring
      // a `succeeded` row there would make the flag silently do nothing.
      if (context?.flag?.step) return { run: true }

      const decision = ephemeral.includes(name) ? { action: 'run' } : resumeDecision(rows()[name])
      if (decision.action === 'skip') {
        if (decision.output) {
          try { Object.assign(context.config, JSON.parse(decision.output)) } catch {}
        }
        return { run: false, note: decision.note }
      }

      rows()[name] = { ...rows()[name], status: 'running', startedAt: now() }
      flush()
      return { run: true, note: decision.note }
    },

    afterStep(name, _num, { status, durationMs, output } = {}) {
      // The trap. A step that refuses by setting `context.config.abort` and
      // RETURNING is handed `succeeded` by the runner — nothing threw. A strict
      // lesson refuses that way on every failed probe, so taking the runner's
      // word would record every failure as done and the resume would skip it.
      const refused = Boolean(context?.config?.abort) && !context?.config?.stop
      const real    = refused ? 'failed' : status

      rows()[name] = {
        ...rows()[name],
        status:     real,
        finishedAt: now(),
        durationMs,
        output:     (output ?? context?.config?.__note?.[name] ?? null)?.slice?.(0, MAX_NOTE) ?? null,
      }
      flush()
    },

    settle(status) {
      doc.lessons[lesson].status     = status
      doc.lessons[lesson].finishedAt = now()
      flush()
    },

    restart() {
      delete doc.lessons[lesson]
      doc.lessons[lesson] = { status: 'running', startedAt: now(), steps: {} }
      flush()
    },
  }
}

// A step hands the steps after it a fact. Stored against the step's own name so
// `afterStep` can pick it up without the step having to know the recorder.
export function note(context, stepName, facts) {
  context.config.__note ??= {}
  context.config.__note[stepName] = JSON.stringify(facts)
  Object.assign(context.config, facts)
  return facts
}

// ─── the local-server recipe ──────────────────────────────────────────────────
//
// `fli make:deploy` writes a deploy block for a real host. This points it at
// THIS machine and a directory beside the app, which is what makes a deploy
// lesson possible at all: `core/machine.js` treats `localhost` as a transport
// rather than a simulation, so every command the pipeline sends reaches the
// same shell it would reach over ssh.
//
// `web: false` because the web half wants nginx and a domain, which is a
// different proof.
//
// One owner, two callers — this and `deployJournalCycle` in
// `scripts/scaffold-build.mjs`. They were the same eleven lines, and the CI
// pipeline is the only thing that would notice if the lesson's copy drifted.

export function pointAtLocalServer(source, { serverDir, port }) {
  const next = source
    .replace(/path: '[^']*',(\s*\/\/ deploy root)/, `path: '${serverDir}',$1`)
    .replace(/env:\s*'[^']*'/,                      `env:        '${serverDir}/.env.production'`)
    .replace(/port:\s*3000,/,                       `port:       ${port},`)
    .replace(/path:\s*'[^']*\/db',/,                `path:         '${serverDir}/db',`)
    .replace(/\n    web: \{[\s\S]*?\n    \},/,      '\n    web: false,')

  // A silent no-op here is the failure worth naming: every regex above misses,
  // the file is written back unchanged, and the deploy goes to whatever host
  // `make:deploy` was given — which is `localhost` only by luck.
  return { text: next, ok: next.includes(serverDir) }
}

// ─── teardown ─────────────────────────────────────────────────────────────────
// A temp workspace is removed unless the run asked to keep it. A named one
// never is: it is the thing the person came away with.

export function sweepWorkspace({ dir, kind }, { keep = false } = {}) {
  if (kind !== 'temp' || keep) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}
