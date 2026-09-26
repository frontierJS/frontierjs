// ─── prove.js — run what `fli proves` names ──────────────────────────────────
//
// `proves` answers *which drive*, and a person or an agent then did the rest by
// hand: read the *Start first* cell, start the API, poll its port, run the
// drive, stop what they started. An agent writes that spawn-and-poll by hand on
// every change, in a shell where backgrounding a server is unreliable, and a
// fix session spent seven of its thirty turns on it. This runs the same steps
// in the order `DRIVES.md` states them and reports one line per target.
//
// ── What it owns and what it borrows ────────────────────────────────────────
//
// It owns the ORDER only. Which targets is `provesFor`; what each drive needs
// first is the `needs` `runnables()` attaches from the *Start first* column;
// spawning, the process group and the kill are `children.js`'s, and whether a
// port answers is `ports.js`'s. Every one of those is injected, so the suite
// drives the order against fakes and nothing here spawns on its own.
//
// ── What it refuses ─────────────────────────────────────────────────────────
//
// **A server port that already answers.** A port that answers is not evidence
// the right process holds it (`FJS-740`) — a stale dev server from another tree
// passes every drive against the wrong code. The drive is failed by name with
// the port, and the servers it would have shared are not started.
//
// A step the table names and the drive's directory does not declare (`id:
// null` from `resolveNeeds`) fails its drive rather than being skipped, since a
// drive run without its preamble exits 1 on a missing server and reads as a
// broken change.
//
// Servers are started per drive and stopped after it. Two drives in one app
// could share an API, but a drive's `db:seed` runs before its servers, and a
// server kept across a reseed is serving rows the drive did not seed.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

const TAIL   = 30
const POLLMS = 250

/**
 * Run every target the proof rows name, in order.
 *
 * @param {object}   o
 * @param {object[]} o.proofs     `provesFor()`'s rows
 * @param {object[]} o.rows       `runnables()` — drive rows carry `needs`
 * @param {object}   o.procs      `{ startRow, stopRow, childOf, outputOf }` from `children.js`
 * @param {Function} o.answering  `port → Promise<boolean>`
 * @param {Function} [o.say]      one progress line
 * @returns {Promise<{ ran: object[], read: object[], gone: object[] }>}
 */
export async function prove({ proofs, rows, procs, answering, say = () => {}, bootMs = 60_000, runMs = 600_000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const byId = new Map(rows.map(r => [r.id, r]))
  const seen = new Set()
  const out  = { ran: [], read: [], gone: [] }

  for (const proof of proofs) {
    for (const t of proof.targets) {
      if (t.kind === 'file')    { out.read.push(t); continue }
      if (t.kind === 'unknown' || !t.command) { out.gone.push(t); continue }

      const key = `${t.dir}::${t.command}`
      if (seen.has(key)) continue
      seen.add(key)

      const drive = t.id ? byId.get(t.id) : null
      const argv  = t.command.split(/\s+/)
      const row   = { id: t.id ?? `script:${t.dir}/${t.name}`, name: t.name, dir: t.dir, kind: drive?.kind ?? 'script', argv }

      say(`▸ ${t.dir}: ${t.command}`)
      out.ran.push(await one(row, drive?.needs ?? [], { byId, procs, answering, say, bootMs, runMs, sleep }))
    }
  }
  return out
}

async function one(row, needs, ctx) {
  const t0      = Date.now()
  const started = []
  const result  = (ok, extra) => ({ name: row.name, dir: row.dir, command: row.argv.join(' '), ok, ms: Date.now() - t0, ...extra })

  try {
    for (const need of needs) {
      if (!need.id) return result(false, { reason: `Start first names \`${need.run}\`, which ${row.dir} does not declare` })
      const nrow = ctx.byId.get(need.id)

      if (typeof nrow?.port === 'number') {
        if (await ctx.answering(nrow.port)) {
          return result(false, { reason: `port ${nrow.port} (${need.script}) already answers — stop what holds it; a port that answers is not the right process (FJS-740)` })
        }
        ctx.say(`  start ${need.script} → :${nrow.port}`)
        const up = await boot(nrow, ctx)
        started.push(nrow.id)
        if (!up.ok) return result(false, { reason: up.reason, tail: up.tail })
        continue
      }

      ctx.say(`  run ${need.script}`)
      const ran = await runToExit(nrow ?? { id: need.id, name: need.script, dir: row.dir, argv: need.run.split(/\s+/) }, ctx, ctx.runMs)
      if (ran.code !== 0) return result(false, { reason: `${need.script} exited ${ran.code}`, tail: ran.tail })
    }

    const ran = await runToExit(row, ctx, ctx.runMs)
    return result(ran.code === 0, { code: ran.code, tail: ran.tail, ...(ran.code === 0 ? {} : { reason: ran.timedOut ? `no exit after ${ctx.runMs / 1000}s` : `exited ${ran.code}` }) })
  } finally {
    for (const id of started.reverse()) ctx.procs.stopRow(id)
    // The next drive starts the same ports; a server still releasing one would
    // be refused as already answering.
    for (const id of started) {
      const port = ctx.byId.get(id)?.port
      for (let waited = 0; typeof port === 'number' && waited < 10_000 && await ctx.answering(port); waited += POLLMS) await ctx.sleep(POLLMS)
    }
  }
}

async function boot(nrow, ctx) {
  const s = ctx.procs.startRow(nrow)
  if (!s.ok) return { ok: false, reason: s.error }
  for (let waited = 0; waited < ctx.bootMs; waited += POLLMS) {
    if (await ctx.answering(nrow.port)) return { ok: true }
    const exit = ctx.procs.childOf(nrow.id)?.exit
    if (exit) return { ok: false, reason: `${nrow.name} exited ${exit.code ?? exit.signal} before :${nrow.port} answered`, tail: tail(ctx, nrow.id) }
    await ctx.sleep(POLLMS)
  }
  return { ok: false, reason: `${nrow.name} started and :${nrow.port} did not answer within ${ctx.bootMs / 1000}s`, tail: tail(ctx, nrow.id) }
}

async function runToExit(row, ctx, limit) {
  const s = ctx.procs.startRow(row)
  if (!s.ok) return { code: null, tail: [s.error] }
  for (let waited = 0; waited < limit; waited += POLLMS) {
    const exit = ctx.procs.childOf(row.id)?.exit
    if (exit) {
      const lines = tail(ctx, row.id)
      ctx.procs.stopRow(row.id)
      return { code: exit.code ?? exit.signal, tail: lines }
    }
    await ctx.sleep(POLLMS)
  }
  const lines = tail(ctx, row.id)
  ctx.procs.stopRow(row.id)
  return { code: null, timedOut: true, tail: lines }
}

// `children.js` spawns with FORCE_COLOR, and escape codes are tokens to an agent.
function tail(ctx, id) { return ctx.procs.outputOf(id).slice(-TAIL).map(l => l.replace(/\x1b\[[0-9;]*m/g, '')) }
