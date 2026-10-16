// scripts/bench-round.mjs — one round of a package's `bench/cases.mjs`: each case
// timed beside its floor in this process, printed for scripts/bench-ab.mjs.
//
//   bun bench/cases.mjs            one round, printed
//   bun bench/cases.mjs --json     one round, as the line scripts/bench-ab.mjs reads
//
// A case is `{ name, ceiling, ops, open(), run(ctx, i), floor(ctx, i) }`, and
// what `open()` returns may carry `close()`. The floor is the same work with
// nothing of ours in between, so the ratio is what our code costs over it.
//
// scripts/bench-ab.mjs copies this file over the base ref's copy along with the
// case file, so both sides time with one loop. A loop edited on one side only
// would measure the loop.

// µs per op. A tenth of the ops first, so neither side is timed while the JIT
// is still tiering it up.
async function time(fn, ctx, ops) {
  for (let i = 0; i < ops / 10; i++) await fn(ctx, i)
  const t0 = performance.now()
  for (let i = 0; i < ops; i++) await fn(ctx, i)
  return (performance.now() - t0) / ops * 1000
}

export async function round(cases) {
  const out = []
  for (const c of cases) {
    try {
      const ctx     = await c.open()
      const floorUs = await time(c.floor, ctx, c.ops)
      const us      = await time(c.run, ctx, c.ops)
      await ctx.close?.()
      out.push({ name: c.name, ceiling: c.ceiling, us, floorUs })
    } catch (e) {
      out.push({ name: c.name, ceiling: c.ceiling, error: e?.message ?? String(e) })
    }
  }
  return { declared: cases.length, cases: out }
}

export async function main(cases) {
  const r = await round(cases)
  if (process.argv.includes('--json')) console.log('BENCH_CASES ' + JSON.stringify(r))
  else for (const c of r.cases) console.log(c.error
    ? `${c.name.padEnd(16)} FAILED  ${c.error}`
    : `${c.name.padEnd(16)} ${c.us.toFixed(2).padStart(8)} µs   floor ${c.floorUs.toFixed(2).padStart(7)} µs   ${(c.us / c.floorUs).toFixed(2)}x  (ceiling ${c.ceiling}x)`)
}
