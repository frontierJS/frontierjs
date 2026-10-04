// core/latency.js — how long a request takes through the gate, hook and audit
// pipeline, as a tail measured at a constant arrival rate.
//
// A closed-loop generator (send, wait, send) stops sending while the server
// stalls, so the slow stretch contributes one sample instead of the hundreds a
// real client would have queued -- the tail it exists to record goes missing
// (coordinated omission). Here request i is SCHEDULED at start + i / rate, fired
// whether or not the earlier ones came back, and its latency is counted from
// that scheduled instant, not from when the loop got around to sending it.
//
// Reported, never gated: a timing is one machine on one afternoon
// (IDEAS/performance-regression-watch.md). What IS held to account is a case that
// measured nothing -- any failed request, or zero samples, makes the case throw,
// because a run whose requests all 401'd would otherwise print a fast, quiet p99.

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** p50/p95/p99/max of a list of milliseconds. Nearest-rank, no interpolation:
 *  every figure is a latency that was actually observed. */
export function percentiles(samples) {
  if (!samples.length) return { n: 0, p50: null, p95: null, p99: null, max: null }
  const s = [...samples].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] }
}

/** Fire `fire(i)` at `rate` per second for `durationMs`, after `warmupMs` of the
 *  same that is not recorded. `fire` resolves on success and throws on a bad
 *  answer. Throws if any request failed or none was sampled. */
export async function runCase({ name, fire, rate = 50, durationMs = 5000, warmupMs = 1000 }) {
  const interval = 1000 / rate
  const total = Math.round((warmupMs + durationMs) / interval)
  const warm = Math.round(warmupMs / interval)
  const samples = []
  const failures = []
  const inflight = []
  const t0 = performance.now()
  for (let i = 0; i < total; i++) {
    const due = t0 + i * interval
    const wait = due - performance.now()
    if (wait > 1) await sleep(wait)
    inflight.push(
      Promise.resolve().then(() => fire(i)).then(
        () => { if (i >= warm) samples.push(performance.now() - due) },
        (err) => { failures.push(err?.message ?? String(err)) },
      ),
    )
  }
  await Promise.all(inflight)
  if (failures.length) throw new Error(`${name}: ${failures.length} of ${total} request(s) failed, first: ${failures[0]}`)
  if (!samples.length) throw new Error(`${name}: measured no requests`)
  return { name, rate, ...percentiles(samples) }
}

/** Run each case in turn. A case that throws is recorded as `{ name, error }`
 *  and the rest still run, so one dead route does not hide the others. */
export async function runCases(cases) {
  const out = []
  for (const c of cases) {
    try { out.push(await runCase(c)) } catch (err) { out.push({ name: c.name, error: err.message }) }
  }
  return out
}

// ─── the cases a scaffolded app has ──────────────────────────────────────────

async function http(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

/** Cases over the `fli new` app: a gated read, a list, and a gated write that
 *  lands in the audit trail (User is `@@log(audit)`). Signs a throwaway user in
 *  through the app's own auth routes and seeds notes through its own service, so
 *  what is timed is the path a client takes. `base` is `http://host:port/api`.
 *  The scaffold has no model with a relation, so there is no list-with-include
 *  here; that case needs an app that has one. */
export async function scaffoldCases({ base, rate = 50, durationMs = 5000 }) {
  const email = `bench-${process.pid}@bench.invalid`
  const password = 'B3nch!Test-Passw0rd'
  const reg = await http('POST', `${base}/auth/register`, { body: { email, password, name: 'Bench' } })
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}: ${reg.text.slice(0, 200)}`)
  const login = await http('POST', `${base}/auth/login`, { body: { email, password } })
  const token = login.json?.token
  if (login.status !== 200 || !token) throw new Error(`login answered ${login.status} with no token: ${login.text.slice(0, 200)}`)

  const userId = reg.json?.user?.userId
  if (!userId) throw new Error(`register returned no user id: ${reg.text.slice(0, 200)}`)

  for (let i = 0; i < 50; i++) {
    const r = await http('POST', `${base}/notes`, { token, body: { title: `note ${i}`, body: 'x'.repeat(200) } })
    if (r.status !== 201) throw new Error(`seeding a note answered ${r.status}: ${r.text.slice(0, 200)}`)
  }

  const ok = (r, want) => { if (r.status !== want) throw new Error(`answered ${r.status}, wanted ${want}: ${r.text.slice(0, 120)}`) }
  const common = { rate, durationMs }
  return [
    { name: 'read: one note',              ...common, fire: async () => ok(await http('GET', `${base}/notes/1`), 200) },
    { name: 'list: 50 notes',              ...common, fire: async () => ok(await http('GET', `${base}/notes?$limit=50`), 200) },
    { name: 'write: gated create',         ...common, fire: async (i) => ok(await http('POST', `${base}/notes`, { token, body: { title: `w ${i}`, body: 'x'.repeat(200) } }), 201) },
    { name: 'write: gated + audited patch', ...common, fire: async (i) => ok(await http('PATCH', `${base}/users/${userId}`, { token, body: { name: `Bench ${i}` } }), 200) },
  ]
}

/** Read-only cases over plain GET paths -- for an app whose writes need
 *  credentials this module cannot invent, and whose real databases a bench must
 *  not write to. Each path answers 200 or the case is an error. */
export function getCases({ origin, paths, rate = 50, durationMs = 5000 }) {
  return paths.map(path => ({
    name: `GET ${path}`, rate, durationMs,
    fire: async () => {
      const r = await http('GET', origin + path)
      if (r.status !== 200) throw new Error(`answered ${r.status}: ${r.text.slice(0, 120)}`)
    },
  }))
}
