// transaction.js — `$transaction`: one open transaction per connection,
// nesting by SAVEPOINT, and which connection a read goes to while one is open.

import { AsyncLocalStorage } from '#host'

// ─── Transaction manager ──────────────────────────────────────────────────────
// Uses SAVEPOINTs for nesting so $transaction + createMany compose safely.
//
// The depth counter is per CLIENT, and one connection can hold one transaction.
// So "am I nested?" cannot be answered by the counter alone: a second REQUEST
// arriving while the first is awaiting sees depth > 0 and looks identical to a
// genuinely nested call. It used to be treated as one, and that was `FJS-237`:
//
//   A: begin()  → depth 0→1, BEGIN IMMEDIATE, awaits
//   B: begin()  → sees depth 1 → SAVEPOINT sp_1 INSIDE A's transaction
//   B: commit() → RELEASE sp_1        ← B's caller is told it succeeded
//   A: rollback → ROLLBACK            ← B's rows are gone
//
// B also read A's uncommitted rows, because makeReadRouter sends every read to
// the write connection while depth > 0.
//
// The two cases need opposite treatment and only the async context can tell
// them apart: a nested call runs INSIDE the outer callback and inherits its
// store, a concurrent request does not. So re-entrancy is asked of
// AsyncLocalStorage, and anything else waits for the lock.
//
// This serializes what SQLite already serializes — two BEGIN IMMEDIATEs cannot
// overlap on one connection, and the old code avoided the error only by nesting
// into someone else's transaction. What changes is that the second caller waits
// instead of being silently enrolled in a transaction it cannot see.

// The txState objects the CURRENT async context has an open transaction on.
// A Set because a callback may hold transactions on more than one client.
const _txOwned = new AsyncLocalStorage()

// Does the calling context own this client's open transaction? The only honest
// reading of "am I inside it" — `state.depth` answers whether ANYBODY is, which
// is a different question and the wrong one for every caller that is not the
// holder. Every transaction here is opened through `exclusive`/`wrapExclusive`,
// which establish ownership before `begin`, so an open transaction always has an
// owning context and this can be asked instead of the counter.
const ownsTx = (state) => _txOwned.getStore()?.has(state) ?? false

// ── Every file a write can reach, not main's alone ───────────────────────────
//
// `conns` is `[{ name, db }]`, main first, one entry per write CONNECTION — two
// declarations on one file are one entry (`FJS-D232`). Holding main's alone left
// a second file's statements outside every transaction: a refused createMany
// there kept the rows before the bad one, and a throwing `$transaction` rolled
// back main and left the other file's writes standing (`FJS-1459`).
//
// A rollback reaches every file. The COMMIT cannot be one act across two
// connections, so it runs file by file with main last — main holds the outbox
// (`FJS-D35`), so a refusal anywhere before it leaves the durable effects
// unwritten — and a refusal part way is thrown naming what committed and what
// rolled back, the one thing a caller cannot find out afterwards.
export function makeTxManager(conns, state = { depth: 0 }, ledger = null) {
  const db = conns[0].db
  const each = (sql) => { for (const c of conns) c.db.run(sql) }
  let spCount = 0

  // Lock as a promise chain. `tail` always resolves when the current holder
  // releases, so awaiting it is FIFO and starvation-free.
  let tail = Promise.resolve()

  function acquire() {
    let release
    const prev = tail
    tail = new Promise(r => { release = r })
    return prev.then(() => release)
  }

  const isReentrant = () => ownsTx(state)

  const withOwnership = (fn) => {
    const store = new Set(_txOwned.getStore() ?? [])
    store.add(state)
    return _txOwned.run(store, fn)
  }

  // ── Announcements held until the write is real ────────────────────────────
  //
  // An event announced at statement time is a claim about a row that may not
  // exist a moment later: a create inside a transaction that rolls back still
  // reached `$tapEvents` → junction's `announceDataWrites` → every open tab,
  // and nothing ever retracted it. Held here instead, and the mark makes a
  // SAVEPOINT rollback exact — the events queued since that savepoint go with
  // the rows they describe, and the ones from before it survive (`FJS-D170`).
  //
  // Flushed only when the OUTERMOST transaction commits, because until then
  // the rows are still provisional.
  const pending = []
  function queueEvent(fire) { pending.push(fire) }
  function flushPending() {
    const fns = pending.splice(0, pending.length)
    for (const fire of fns) fire()
  }

  // ── Which side of an @@anonymous pairing this transaction has written ──────
  //
  // An anonymous row and a logged row written together are re-attributable:
  // the trail's clock, in order, lines up with the anonymous table's rowid
  // order, and the logged row usually names the person (`FJS-D349`). Returns
  // the model on the OTHER side already written, which the caller refuses.
  // Marked per frame like `pending`, so a savepoint rolled back takes its
  // writes out of the pairing.
  const wrote = []
  function noteWrite(model, anonymous) {
    const other = wrote.find(w => w.anonymous !== anonymous)
    wrote.push({ model, anonymous })
    return other?.model ?? null
  }

  function begin() {
    // BEGIN IMMEDIATE (matching the $transaction doc comment): take the write
    // lock up front. A deferred BEGIN upgrades to a write lock mid-transaction,
    // which under concurrency surfaces as avoidable SQLITE_BUSY retries.
    if (state.depth === 0) {
      // A file that refuses its BEGIN (another process holds it past the busy
      // timeout) must not leave the ones before it holding a write lock.
      conns.forEach((c, i) => {
        try { c.db.run('BEGIN IMMEDIATE') }
        catch (e) { for (const o of conns.slice(0, i)) o.db.run('ROLLBACK'); throw e }
      })
    }
    else { spCount++; each(`SAVEPOINT sp_${spCount}`) }
    state.depth++
    return { sp: state.depth === 1 ? null : spCount, mark: pending.length, cmark: ledger?.length ?? 0, wmark: wrote.length }
  }

  function commit(frame) {
    const { sp } = frame
    // Graded BEFORE the depth moves. A refusal here is thrown to the caller's
    // own catch, which calls rollback() — and rollback decrements too, so a
    // grade after the decrement would take the counter negative on every
    // refusal.
    if (sp == null && ledger) { ledger.grade(db); ledger.truncate(0) }
    state.depth--
    if (sp != null) { each(`RELEASE sp_${sp}`); return }
    const order = [...conns.slice(1), conns[0]]
    for (let i = 0; i < order.length; i++) {
      try { order[i].db.run('COMMIT') }
      catch (e) {
        // Settled here, not by the caller's rollback(): the depth has already
        // moved, and the files committed before this one cannot be rolled back.
        frame.settled = true
        pending.length = frame.mark
        wrote.length = 0
        for (const c of order.slice(i)) { try { c.db.run('ROLLBACK') } catch {} }
        if (conns.length === 1) throw e
        const names = (cs) => cs.map(c => c.name).join(', ') || 'none'
        throw Object.assign(new Error(
          `Transaction could not commit in database '${order[i].name}': ${e.message}. ` +
          `Each database file commits on its own, so a transaction spanning files is not atomic at its commit — ` +
          `committed: ${names(order.slice(0, i))} · rolled back: ${names(order.slice(i))}`,
          { cause: e }), { committed: order.slice(0, i).map(c => c.name), rolledBack: order.slice(i).map(c => c.name) })
      }
    }
    wrote.length = 0
    flushPending()
  }

  function rollback(frame) {
    if (frame.settled) return
    const { sp, mark, cmark, wmark } = frame
    state.depth--
    pending.length = mark
    wrote.length = wmark
    if (ledger) ledger.truncate(cmark)
    // Every file is rolled back even when one refuses, then the first refusal
    // is thrown — stopping at it would leave the rest holding their writes.
    let failed = null
    for (const c of conns) {
      try {
        if (sp == null) c.db.run('ROLLBACK')
        else { c.db.run(`ROLLBACK TO sp_${sp}`); c.db.run(`RELEASE sp_${sp}`) }
      } catch (e) { failed ??= e }
    }
    if (failed) throw failed
  }

  function wrap(fn) {
    const frame = begin()
    try { const r = fn(); commit(frame); return r }
    catch (e) { rollback(frame); throw e }
  }

  // The async entry point. `fn` may await; a nested call inherits the store and
  // takes a SAVEPOINT without touching the lock, which is what stops a genuine
  // nesting (basecamp's /setup) from waiting on a lock its own caller holds.
  async function exclusive(fn) {
    if (isReentrant()) {
      const frame = begin()
      try { const r = await fn(); commit(frame); return r }
      catch (e) { rollback(frame); throw e }
    }
    const release = await acquire()
    try {
      return await withOwnership(async () => {
        const frame = begin()
        try { const r = await fn(); commit(frame); return r }
        catch (e) { rollback(frame); throw e }
      })
    } finally { release() }
  }

  // The sync-body entry point, for bulk writes. The BODY stays synchronous —
  // only the acquire is awaited, which the callers can do because every table
  // method is already async. Without this a createMany arriving during another
  // request's transaction joined it and was lost on that request's rollback.
  async function wrapExclusive(fn) {
    if (isReentrant()) return wrap(fn)
    const release = await acquire()
    try { return withOwnership(() => wrap(fn)) }
    finally { release() }
  }

  return { begin, commit, rollback, wrap, exclusive, wrapExclusive, queueEvent, noteWrite, ledger, owns: () => ownsTx(state), state }
}

// ─── Read routing ─────────────────────────────────────────────────────────────
//
// Reads normally go to the readonly WAL connection, which is what lets them run
// concurrently with writes. Inside a transaction that is wrong: the writes are
// uncommitted on the write connection, and WAL isolation means the read
// connection cannot see them. A create() followed by a findMany() in the same
// $transaction returned [] — the row existed, the reader was looking at a
// snapshot taken before it.
//
// While THIS CONTEXT holds a transaction, its reads route to the write
// connection instead, which observes its own uncommitted work. Outside one,
// nothing changes.
//
// Routing on `txState.depth` instead sent every read in the process to the write
// connection while any transaction was open anywhere, so a concurrent request's
// ordinary findMany read another request's uncommitted rows — measured, and it
// is a dirty read across callers rather than a visibility fix for the holder
// (`FJS-638`). The holder is identified the same way `wrapExclusive` identifies
// a genuine nesting, so the two cannot disagree about who is inside.

export function makeReadRouter(readDb, writeDb, txState) {
  return {
    query:  (sql) => (ownsTx(txState) ? writeDb : readDb).query(sql),
    inTx:   () => ownsTx(txState),
    // The router REPLACES conn.readDb, so the wrapper it closes over is
    // reachable from nowhere else — without this, _closeAll's readDb.close()
    // is a silent no-op and the read side keeps answering off a closed handle.
    close:  () => readDb.close?.(),
    // Routed the same way `query` is, and for the same reason: inside a
    // transaction the read runs on the write handle, and an extension loaded
    // into the other one is not loaded into the one the statement compiles on.
    get $plain()     { return (ownsTx(txState) ? writeDb : readDb).$plain },
    get $raw()       { return (ownsTx(txState) ? writeDb : readDb).$raw },
    get cacheSize()  { return readDb.cacheSize },
    set cacheSize(v) { readDb.cacheSize = v },
  }
}
