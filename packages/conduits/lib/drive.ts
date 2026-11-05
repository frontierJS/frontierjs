// lib/drive.ts — the assertion shape every drive here shares.
//
// `t(name, actual)` records one row; `report(got, expected)` compares each row
// deep-equal against the expected table and prints the diff, so a drive reads
// as a table of claims rather than a script that throws at the first miss. The
// same shape as `example/web/test/lib/report.mjs`, written again here because a
// prototype must not import a drive helper out of another app's tree.

export type Rows = Record<string, unknown>

export function results() {
  const got: Rows = {}
  return {
    got,
    t(name: string, actual: unknown) {
      if (name in got) throw new Error(`drive: row '${name}' recorded twice`)
      got[name] = actual
    },
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
const norm = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Rows).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, norm(x)]))
    : v

/** Prints every row and exits 1 on any miss. A row expected and never recorded is a miss. */
export function report(got: Rows, expected: Rows): number {
  let failed = 0
  for (const [name, want] of Object.entries(expected)) {
    const have = got[name]
    const ok = name in got && same(have, want)
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
    if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${name in got ? JSON.stringify(have) : '(not recorded)'}`)
  }
  for (const name of Object.keys(got)) if (!(name in expected)) { failed++; console.log(` FAIL  ${name}  (recorded, not expected)`) }
  if ('__threw' in got) failed++
  console.log(`\n${failed ? `${failed} failed` : 'all green'} — ${Object.keys(expected).length} rows`)
  return failed ? 1 : 0
}

/** `fetch` to a sink's control endpoint. */
export const control = (base: string) => ({
  reset: () => fetch(`${base}/_sink/reset`, { method: 'POST' }).then(r => r.json()),
  arm:   (what: Rows) => fetch(`${base}/_sink/arm`, { method: 'POST', body: JSON.stringify(what) }).then(r => r.json()),
  seen:  <T = unknown>() => fetch(`${base}/_sink/seen`).then(r => r.json() as Promise<T[]>),
})

/** The conduit a drive runs a connector through. Short timeouts, so a lost
 *  response costs a second rather than the default ten. */
export const DRIVE_RESILIENCE = { timeout_ms: 800, retry_limit: 2, deadline_ms: 6_000 }
