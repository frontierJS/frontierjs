// journal.js — the deploy journal, as statements and decisions.
//
// Phase 1e of IDEAS/release-transitions.md. 1d built the rows and printed them;
// this writes them, on the target, as the deploy runs.
//
// ─── where it runs, and why fli gains no dependency ──────────────────────────
//
// The journal is on the TARGET, because it records what happened on that host —
// two operators deploying from two laptops must not hold two answers to *what
// is serving*. `fli` runs on a laptop. So every write crosses ssh.
//
// What is actually on a deploy target was measured rather than assumed:
// `deploy:setup` installs docker, nginx, git, **bun**, rsync and **sqlite3**,
// and `02-pull` leaves a git checkout with no `node_modules` — the build happens
// inside Docker. So litestone is NOT there and cannot be imported there.
//
// That settles the dependency question without adding one. The schema is
// `db/deploy.lite`; its DDL is a COMMITTED snapshot (`db/ddl.snapshot.sql`,
// `litestone ddl --schema deploy.lite`) which the `snapshots` CI phase found and
// began checking with no CI edit at all. So the fragment stays the single source
// of the schema, the DDL is derived from it and never hand-written, and what
// ships to the target is a file plus a runner small enough to have no imports
// beyond `bun:sqlite`.
//
// ─── the brain is here and the runner is dumb ────────────────────────────────
//
// Everything in this module is a pure function returning `{ sql, params }` or a
// verdict. `core/journal-runner.mjs` binds and executes and decides nothing.
// That split is deliberate and it is the same one `@frontierjs/outpost` makes
// with `createDocker({ run })`: the half that is hard to test is the half that
// gets shipped somewhere else, so it is made too small to be wrong.
//
// **Parameters are bound, never interpolated** (Invariant 8). An app id, a step
// name and an actor all reach these statements from configuration a person
// wrote.

/**
 * The journal's own format, written into the `journal` row.
 *
 * A resumed transition replays rows an earlier version wrote, so a reader has to
 * be able to ask what wrote them before it parses any of them.
 */
export const JOURNAL_FORMAT = 1

/**
 * The table names the DDL emits.
 *
 * Litestone emits snake_case singular table names and verbatim camelCase
 * columns, so hand-written SQL binds to exactly these and nothing else. They are
 * named once here and asserted against the committed DDL by the suite — a
 * guessed table name is a runtime failure on a machine nobody is watching.
 */
export const TABLE = {
  journal:    'journal',
  release:    'release',
  bindings:   'binding_set',
  transition: 'transition',
  step:       'transition_step',
}

const stamp = (now) => now ?? new Date().toISOString()
const bool  = (v) => (v ? 1 : 0)
const json  = (v) => JSON.stringify(v ?? null)

// ─── the file's own header row ───────────────────────────────────────────────

/**
 * Claim the journal for this app and host, and read back whatever is there.
 *
 * `INSERT OR IGNORE`: the row is written once and every later deploy reads it.
 * The read is what matters — `app` and `host` are on the row so that pointing
 * `fli` at the wrong `deploy.db` is a refusal rather than a history of somebody
 * else's machine, and `formatVersion` is what a future reader asks before it
 * parses anything.
 */
export function openJournal({ app, host, now } = {}) {
  return [
    {
      name: 'claim',
      sql:  `INSERT OR IGNORE INTO "${TABLE.journal}" ("id", "formatVersion", "app", "host", "createdAt")
             VALUES ('journal', ?, ?, ?, ?)`,
      params: [JOURNAL_FORMAT, app, host, stamp(now)],
    },
    { name: 'journal', sql: `SELECT * FROM "${TABLE.journal}" WHERE "id" = 'journal'`, params: [] },
  ]
}

/**
 * Is this journal one this deploy may write to?
 *
 * Three refusals rather than one boolean, because the ways out differ: a wrong
 * app is a wrong path, a moved host is a restored backup or a copied disk, and a
 * newer format is a `fli` too old to understand what it is looking at.
 */
export function journalVerdict(row, { app, host }) {
  if (!row) return { ok: true, reason: null, kind: 'new' }
  if (row.formatVersion > JOURNAL_FORMAT)
    return {
      ok: false, kind: 'format',
      reason: `this journal was written in format ${row.formatVersion} and this fli understands ${JOURNAL_FORMAT} — upgrade fli rather than writing rows it cannot read`,
    }
  if (row.app !== app)
    return { ok: false, kind: 'app', reason: `this journal belongs to "${row.app}" and this deploy is "${app}" — the path names another app's history` }
  if (row.host !== host)
    return {
      ok: false, kind: 'host',
      reason: `this journal was written on "${row.host}" and this deploy targets "${host}" — a copied disk or a restored backup carries a history that is not this machine's`,
    }
  return { ok: true, reason: null, kind: 'open' }
}

// ─── what is serving ─────────────────────────────────────────────────────────

/**
 * The state a precondition is graded against.
 *
 * `serving` is the Release of the last transition that SUCCEEDED, which is not
 * the last transition: a failed deploy leaves the previous release serving, and
 * recording the attempted one as serving is how a journal starts lying.
 */
export function readState({ app, environment }) {
  return [
    {
      name: 'serving',
      sql: `SELECT t.*, r."schemaHash", r."pivot", r."bindingsHash"
              FROM "${TABLE.transition}" t
              JOIN "${TABLE.release}" r ON r."id" = t."releaseId"
             WHERE t."app" = ? AND t."environment" = ? AND t."status" = 'succeeded'
             ORDER BY t."finishedAt" DESC, t."rowid" DESC
             LIMIT 1`,
      params: [app, environment],
    },
    {
      name: 'generation',
      sql: `SELECT MAX("generation") AS "generation" FROM "${TABLE.bindings}"
             WHERE "app" = ? AND "environment" = ?`,
      params: [app, environment],
    },
  ]
}

/**
 * Every transition already recorded for one intent — the term `--plan` could not
 * answer (`core/plan.js`, `transitionId`).
 *
 * Queried by COLUMNS rather than by id, because the attempt number is inside the
 * id: asking by id could only ever find the attempt you already guessed.
 */
export function readAttempts({ kind, app, environment, fromReleaseId, releaseId, generation }) {
  return [{
    name: 'attempts',
    sql: `SELECT "id", "status" FROM "${TABLE.transition}"
           WHERE "kind" = ? AND "app" = ? AND "environment" = ?
             AND "releaseId" = ? AND "generation" = ?
             AND "fromReleaseId" IS ?
           ORDER BY "rowid"`,
    params: [kind, app, environment, releaseId, generation, fromReleaseId ?? null],
  }]
}

/**
 * The transition an interrupted run left open, found WITHOUT its Release id.
 *
 * `readAttempts` keys on `releaseId`, which is the right question for an
 * ordinary deploy: different bytes are a different Release and deserve their own
 * transition. It is the wrong question for `--resume`, because the Release id
 * carries the image digest and a local image id is not a content address — an
 * unchanged tree rebuilt without a full cache hit produces different bytes on
 * paper, so the lookup missed the row it was standing on and every resume opened
 * a second transition (`FJS-595`). Measured: one Dockerfile and one unchanged
 * file give `1f021e1eccf8` cached and `a9c17ea37ed9` with `--no-cache`.
 *
 * So a resume asks the question it means — *what is open here* — and adopts what
 * it finds, Release included. Scoped to one app and environment, and to the
 * kinds that can be continued, because a revert opens a transition of its own and
 * must not be picked up by a deploy.
 */
export function readLiveTransition({ kind = 'deploy', app, environment } = {}) {
  return [{
    name: 'live',
    sql: `SELECT t.*, r."digest" AS "r_digest", r."imageRef" AS "r_imageRef",
                 r."bindingsHash" AS "r_bindingsHash", r."schemaHash" AS "r_schemaHash",
                 r."pivot" AS "r_pivot", r."pivotDeclared" AS "r_pivotDeclared",
                 r."audienceKey" AS "r_audienceKey", r."createdBy" AS "r_createdBy"
            FROM "${TABLE.transition}" t
            JOIN "${TABLE.release}" r ON r."id" = t."releaseId"
           WHERE t."kind" = ? AND t."app" = ? AND t."environment" = ?
             AND t."status" IN ('planned','running')
           ORDER BY t."rowid" DESC
           LIMIT 1`,
    params: [kind, app, environment],
  }]
}

/**
 * Resume, or start a new attempt?
 *
 * A transition still `planned` or `running` is one this deploy was interrupted
 * in the middle of — rerunning must find that row rather than opening a second.
 * A `succeeded` or `failed` one is finished, so the next run is a NEW attempt:
 * deploy R2, revert to R1, deploy R2 again is three operations and the third is
 * not a replay of the first.
 */
export function attemptDecision(rows = []) {
  const live = rows.find(r => r.status === 'planned' || r.status === 'running')
  if (live) return { attempt: rows.indexOf(live) + 1, resume: live }
  return { attempt: rows.length + 1, resume: null }
}

// ─── recording ───────────────────────────────────────────────────────────────

/**
 * The Release, written once.
 *
 * `INSERT OR IGNORE` is correct rather than lazy: the id is the hash of the
 * Release's own terms, so a row that is already there is the same Release and a
 * second write would have nothing to change.
 */
export function recordRelease(release, { now } = {}) {
  return [{
    name: 'release',
    sql: `INSERT OR IGNORE INTO "${TABLE.release}"
          ("id","app","environment","digest","imageRef","bindingsHash","generation",
           "schemaHash","pivot","pivotDeclared","pivotFindings","retentionUntil",
           "audienceKey","createdAt","createdBy")
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      release.id, release.app, release.environment,
      release.digest ?? null, release.imageRef ?? null,
      release.bindingsHash, release.generation ?? 1,
      // NOT NULL in the table. A Release minted with no release surface has no
      // data boundary in its id, which is a weaker claim and must not be stored
      // as though it were a hash.
      release.schemaHash ?? '',
      release.pivot ?? 'unknown', bool(release.pivotDeclared),
      json(release.pivotFindings ?? []), release.retentionUntil ?? null,
      release.audienceKey ?? 'everyone', stamp(now), release.createdBy ?? null,
    ],
  }]
}

/** The bindings as they stood at one generation. Unique on (app, environment, generation). */
export function recordBindings({ app, environment, generation, hash, values, secretRefs, createdBy, now } = {}) {
  return [{
    name: 'bindings',
    sql: `INSERT OR IGNORE INTO "${TABLE.bindings}"
          ("app","environment","generation","hash","values","secretRefs","createdAt","createdBy")
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [app, environment, generation, hash, json(values ?? {}), json(secretRefs ?? {}), stamp(now), createdBy ?? null],
  }]
}

/**
 * Open the transition and its steps.
 *
 * Every insert is `OR IGNORE` and every id is an `occurrenceKey`, which together
 * are the resume: a rerun writes the same ids, changes nothing, and reads back
 * the statuses a previous run left. That is the whole mechanism — there is no
 * separate resume path to get wrong.
 */
export function openTransition({ transition, steps = [], now } = {}) {
  const at = stamp(now)
  const out = [{
    name: 'transition',
    sql: `INSERT OR IGNORE INTO "${TABLE.transition}"
          ("id","kind","app","environment","releaseId","fromReleaseId","generation",
           "status","crossesPivot","plan","actor","startedAt")
          VALUES (?,?,?,?,?,?,?,'running',?,?,?,?)`,
    params: [
      transition.id, transition.kind, transition.app, transition.environment,
      transition.releaseId, transition.fromReleaseId ?? null, transition.generation,
      bool(transition.crossesPivot), json(transition.plan), transition.actor ?? null, at,
    ],
  }]

  for (const s of steps) {
    out.push({
      name: `step:${s.name}`,
      sql: `INSERT OR IGNORE INTO "${TABLE.step}"
            ("id","transitionId","name","ordinal","status","precondition")
            VALUES (?,?,?,?,?,?)`,
      params: [s.id, s.transitionId, s.name, s.ordinal, s.status, json(s.precondition ?? {})],
    })
  }

  // A resumed transition is `failed` or `planned` on disk and must go back to
  // `running`, or the settle at the end moves a row nothing thinks is open.
  out.push({
    name: 'reopen',
    sql: `UPDATE "${TABLE.transition}" SET "status" = 'running', "finishedAt" = NULL
           WHERE "id" = ? AND "status" IN ('planned','failed')`,
    params: [transition.id],
  })

  // `output` is in the projection because a RESUME reads these rows: a replayed
  // step contributes nothing to the run, so what it recorded has to come back
  // with it. Without the column a resumed deploy ran `docker run … undefined`.
  out.push({
    name: 'steps',
    sql: `SELECT "id","name","ordinal","status","precondition","output" FROM "${TABLE.step}"
           WHERE "transitionId" = ? ORDER BY "ordinal"`,
    params: [transition.id],
  })

  return out
}

// ─── running a step ──────────────────────────────────────────────────────────

/**
 * What a rerun does with a step it already has a row for.
 *
 * `succeeded` replays into a no-op, which is the property the whole id scheme
 * exists for. `running` is a step a previous run was inside when it died, and it
 * RUNS AGAIN with that said out loud — a half-finished step is not a finished
 * one, and this pipeline holds at least one (`06-swap` renames a container) that
 * a person needs told about rather than reassured.
 */
export function resumeDecision(row) {
  if (!row)                       return { action: 'run',   note: null, output: null }
  // A replayed step contributes nothing to the run's own state, so whatever it
  // recorded has to come back with the decision — `04-build-api` records which
  // bytes it built, and `06-swap` starts them. Without it a resumed deploy ran
  // `docker run … undefined`, which is the resume broken in exactly the case it
  // exists for: a crash between the build and the swap.
  if (row.status === 'succeeded') return { action: 'skip',  note: 'already succeeded — replayed into a no-op', output: row.output ?? null }
  if (row.status === 'skipped')   return { action: 'skip',  note: 'skipped by its own predicate', output: null }
  if (row.status === 'running')   return { action: 'rerun', note: 'a previous run died inside this step — running it again', output: null }
  return { action: 'run', note: null, output: null }
}

/**
 * Claim the step. Compare-and-set, so two runners cannot both hold it.
 *
 * The lock `01-preflight` takes already excludes a second deploy; this is the
 * narrower guarantee that survives it being wrong.
 */
export function claimStep({ id, now } = {}) {
  return [
    {
      name: 'claim',
      sql: `UPDATE "${TABLE.step}" SET "status" = 'running', "startedAt" = ?
             WHERE "id" = ? AND "status" IN ('pending','running','failed')`,
      params: [stamp(now), id],
    },
    { name: 'step', sql: `SELECT * FROM "${TABLE.step}" WHERE "id" = ?`, params: [id] },
  ]
}

export function finishStep({ id, status, output, durationMs, now } = {}) {
  return [{
    name: 'finish',
    sql: `UPDATE "${TABLE.step}"
             SET "status" = ?, "finishedAt" = ?, "durationMs" = ?, "output" = ?
           WHERE "id" = ?`,
    // An output is a diagnostic, not a log: a whole docker build belongs in the
    // terminal, and a row that grows without bound is a journal nobody can read.
    params: [status, stamp(now), durationMs ?? null, output ? String(output).slice(0, 2000) : null, id],
  }]
}

export function settleTransition({ id, status, now } = {}) {
  return [{
    name: 'settle',
    sql: `UPDATE "${TABLE.transition}" SET "status" = ?, "finishedAt" = ? WHERE "id" = ?`,
    params: [status, stamp(now), id],
  }]
}

// ─── the precondition ────────────────────────────────────────────────────────

/**
 * Did the world move between planning this and running it?
 *
 * Three terms, which is what `db/deploy.lite` declares a step records: the
 * Release serving, the binding generation, and the schema as at last applied.
 * **Nothing here reconciles** — drift refuses and names itself, because the two
 * answers were produced by two different intents and picking one is a guess
 * about which person was right.
 *
 * An expectation of `null` for `serving` on an EMPTY journal is agreement, not
 * drift: a first deploy plans against nothing and finds nothing.
 */
export function preconditionVerdict(expected = {}, actual = {}) {
  const drift = []
  const cmp = (key, was, now, what) => {
    if (was === undefined) return
    if ((was ?? null) !== (now ?? null))
      drift.push({ key, expected: was ?? null, actual: now ?? null, what })
  }

  cmp('serving', expected.serving, actual.serving,
    'another release was deployed after this one was planned')
  cmp('generation', expected.generation, actual.generation,
    'the bindings moved to a new generation after this was planned')
  cmp('schemaHash', expected.schemaHash, actual.schemaHash,
    'the release surface changed after this was planned')

  return { ok: drift.length === 0, drift }
}

/** The sentence a refusal prints. One line per term that moved, and what to do. */
export function formatDrift(drift = []) {
  const lines = ['The world moved between planning this deploy and running it:']
  for (const d of drift)
    lines.push(`  ${d.key}: planned against ${d.expected ?? '—'}, found ${d.actual ?? '—'} — ${d.what}`)
  lines.push('', 'Nothing here reconciles the two. Re-run the deploy to plan against what is actually serving.')
  return lines.join('\n')
}

// ─── reading it back ─────────────────────────────────────────────────────────

/** The recent history of one app and environment, newest first. */
export function readHistory({ app, environment, limit = 10 }) {
  return [{
    name: 'history',
    sql: `SELECT t."id", t."kind", t."status", t."releaseId", t."fromReleaseId",
                 t."generation", t."crossesPivot", t."actor", t."startedAt", t."finishedAt",
                 r."digest", r."pivot"
            FROM "${TABLE.transition}" t
            LEFT JOIN "${TABLE.release}" r ON r."id" = t."releaseId"
           WHERE t."app" = ? AND t."environment" = ?
           ORDER BY t."rowid" DESC
           LIMIT ?`,
    params: [app, environment, limit],
  }]
}

/** One Release by id — the terms a revert has to grade, which history does not carry. */
export function readRelease({ id }) {
  return [{
    name: 'release',
    sql: `SELECT * FROM "${TABLE.release}" WHERE "id" = ?`,
    params: [id],
  }]
}

/**
 * The transition that put a Release into service, and the steps it recorded.
 *
 * A revert needs a STARTABLE image, and the Release id carries a hash of the
 * digest rather than the digest itself — so the way back to bytes is the
 * transition that built them (`04c-journal` mints the id after step 04 runs),
 * which is why this returns both.
 */
export function readServingTransition({ app, environment, releaseId }) {
  return [{
    name: 'transition',
    sql: `SELECT * FROM "${TABLE.transition}"
           WHERE "app" = ? AND "environment" = ? AND "releaseId" = ? AND "status" = 'succeeded'
           ORDER BY "finishedAt" DESC, "rowid" DESC LIMIT 1`,
    params: [app, environment, releaseId],
  }]
}

/** The binding set at one generation — what a revert compares today's against. */
export function readBindingSet({ app, environment, generation }) {
  return [{
    name: 'bindings',
    sql: `SELECT * FROM "${TABLE.bindings}"
           WHERE "app" = ? AND "environment" = ? AND "generation" = ?`,
    params: [app, environment, generation],
  }]
}

export function readSteps({ transitionId }) {
  return [{
    name: 'steps',
    sql: `SELECT "name","ordinal","status","durationMs","output","startedAt","finishedAt"
            FROM "${TABLE.step}" WHERE "transitionId" = ? ORDER BY "ordinal"`,
    params: [transitionId],
  }]
}

// ─── the transport ───────────────────────────────────────────────────────────
//
// Nothing below decides anything either; it sequences the statements above and
// hands them to an injected `exec`. Two callers supply two very different ones —
// the pipeline's runs `bun journal-runner.mjs` over ssh on the target, the
// suite's runs the identical file against a temp database on this machine — and
// that is what lets the whole protocol be tested without a server.

export class JournalError extends Error {
  constructor(message, kind) { super(message); this.name = 'JournalError'; this.kind = kind }
}

/**
 * @param exec  (stdinJson) => stdoutJson — runs the runner, wherever it lives
 * @param db    the journal's path ON the machine `exec` reaches
 * @param ddl   `db/ddl.snapshot.sql`, sent every call (CREATE TABLE IF NOT EXISTS)
 */
export function journalClient({ exec, db, ddl, now = null } = {}) {
  const send = async (statements, { transaction = true } = {}) => {
    const raw = await exec(JSON.stringify({ db, ddl, statements, transaction }))
    let out
    try { out = JSON.parse(String(raw ?? '').trim()) }
    catch { throw new JournalError(`the journal runner answered something that is not JSON: ${String(raw ?? '').slice(0, 200)}`, 'transport') }
    if (!out?.ok) throw new JournalError(out?.error ?? 'the journal runner failed and said nothing', 'sqlite')
    return out.results
  }

  const one = (r, name) => r[name]?.rows?.[0] ?? null

  return {
    send,

    /** Claim the file, and refuse one that belongs to another app or host. */
    async open({ app, host }) {
      const r = await send(openJournal({ app, host, now }))
      const row = one(r, 'journal')
      const verdict = journalVerdict(row, { app, host })
      if (!verdict.ok) throw new JournalError(verdict.reason, verdict.kind)
      return { journal: row, verdict }
    },

    /** What is serving, and at which binding generation. */
    async state({ app, environment }) {
      const r = await send(readState({ app, environment }))
      const serving = one(r, 'serving')
      return {
        serving:     serving?.releaseId ?? null,
        schemaHash:  serving?.schemaHash ?? null,
        generation:  one(r, 'generation')?.generation ?? null,
        transition:  serving?.id ?? null,
      }
    },

    /** Resume the interrupted attempt, or number a new one. */
    async attempt(intent) {
      const r = await send(readAttempts(intent))
      return attemptDecision(r.attempts?.rows ?? [])
    },

    /**
     * What is open here, asked without a Release id — the `--resume` lookup.
     *
     * Answers the transition AND the Release it was deploying, because adopting
     * one without the other would resume the old transition against the bytes
     * this run just built, which is the two halves disagreeing rather than a
     * resume.
     */
    async live({ kind = 'deploy', app, environment } = {}) {
      const row = one(await send(readLiveTransition({ kind, app, environment })), 'live')
      if (!row) return null
      return {
        transition: row,
        release: {
          id: row.releaseId, app: row.app, environment: row.environment,
          digest: row.r_digest ?? null, imageRef: row.r_imageRef ?? null,
          bindingsHash: row.r_bindingsHash, generation: row.generation ?? 1,
          schemaHash: row.r_schemaHash ?? null, pivot: row.r_pivot ?? 'unknown',
          pivotDeclared: !!row.r_pivotDeclared, pivotFindings: [],
          audienceKey: row.r_audienceKey ?? 'everyone', createdBy: row.r_createdBy ?? null,
        },
      }
    },

    /** Record the Release, its bindings and the transition, and read the steps back. */
    async begin({ release, bindings, transition, steps }) {
      const r = await send([
        ...recordRelease(release, { now }),
        ...(bindings ? recordBindings({ ...bindings, now }) : []),
        ...openTransition({ transition, steps, now }),
      ])
      return { steps: r.steps?.rows ?? [], resumed: (r.transition?.changes ?? 0) === 0 }
    },

    async claim({ id }) {
      const r = await send(claimStep({ id, now }))
      return one(r, 'step')
    },

    async finish(args)  { await send(finishStep({ ...args, now })) },
    async settle(args)  { await send(settleTransition({ ...args, now })) },

    async history({ app, environment, limit }) {
      const r = await send(readHistory({ app, environment, limit }), { transaction: false })
      return r.history?.rows ?? []
    },

    async stepsOf(transitionId) {
      const r = await send(readSteps({ transitionId }), { transaction: false })
      return r.steps?.rows ?? []
    },

    async release(id) {
      const r = await send(readRelease({ id }), { transaction: false })
      return one(r, 'release')
    },

    async servingTransition(args) {
      const r = await send(readServingTransition(args), { transaction: false })
      return one(r, 'transition')
    },

    async bindingSet(args) {
      const r = await send(readBindingSet(args), { transaction: false })
      return one(r, 'bindings')
    },
  }
}
