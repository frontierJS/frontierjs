/*
 * health.spec.mjs — answering is not working.
 *
 * `tests/server.test.js` covers the probe. What it cannot answer is the half
 * this feature exists for: a badge that only appears when the app has something
 * to say, and stays away when it has not.
 *
 * The third case is the one that decides whether the feature is usable. A Vite
 * dev server is up and has no opinion about its own readiness, and a page that
 * rendered that as unhealthy would leave every web surface permanently red —
 * which is how a signal gets ignored.
 *
 * A health-shaped server is bound here rather than an app started: what is
 * under test is the page, and a real Junction app would make this drive own the
 * machine for a minute to assert a badge.
 */
import { createServer } from 'node:http'

export const name = 'answering, and whether it is working'

const HEALTH = {
  status: 'ok', app: 'stand-in', version: '0.0.0', uptime: 90,
  checks: { database: { status: 'ok', latencyMs: 1 }, mail: { status: 'ok', latencyMs: 4 } },
  ts: 'now',
}

const DEGRADED = {
  ...HEALTH, status: 'degraded',
  checks: { database: { status: 'ok', latencyMs: 1 }, mail: { status: 'fail', latencyMs: 30, error: 'ECONNREFUSED' } },
}

/**
 * Bind `port` and answer `body` at `/health`. Null if somebody already has it.
 *
 * `body: null` is a server that answers 404 everywhere — a Vite dev server,
 * which is up and has no opinion about its own readiness.
 */
async function serve(port, body) {
  const server = createServer((req, res) => {
    if (!body || req.url !== '/health') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body.current ?? body))
  })
  try {
    await new Promise((ok, no) => { server.once('error', no); server.listen(port, '0.0.0.0', ok) })
    return () => new Promise(r => server.close(r))
  } catch { return null }
}

const badge = (id, part) =>
  `document.querySelector('#dash-groups [data-id="${id}"] [${part}]')`

export async function run(t) {
  // The page's own 3s interval also calls `pollState`, and health is refreshed
  // on one tick in five — so an interval tick landing between setting up a
  // state and reading it decides whether this spec refreshed or not. Stopping
  // the timer makes every poll below one this spec asked for.
  await t.evaluate(`stopStatePoll(); return true;`)

  // A surface whose port nothing is holding RIGHT NOW. Taking the first one on
  // the list skips the whole spec on any machine where somebody has the app
  // running, which on a developer's machine is most of them — and a spec that
  // usually skips is a spec that stops catching anything.
  const row = await t.evaluate(`
    const { state } = await fetch('/api/state').then(r => r.json());
    const r = dashRows.find(r => r.kind === 'surface' && r.port && state[r.id]?.state === 'down');
    return r ? { id: r.id, port: r.port, name: r.name } : null;
  `)
  t.ok(row, `a surface to stand a health server behind (${row?.id})`)

  const body = { current: HEALTH }
  const stop = await serve(row.port, body)
  if (!stop) {
    t.ok(true, `:${row.port} is already held on this machine — nothing to assert against it`)
    await t.evaluate(`startStatePoll(); return true;`)
    return
  }

  try {
    /* ── healthy ───────────────────────────────────────────────────────── */

    const ok = await t.evaluate(`
      const { state } = await fetch('/api/state').then(r => r.json());
      await refreshHealth(state);     // asked for, rather than left to the tick
      await pollState();
      const el = ${badge(row.id, 'data-health')};
      const st = ${badge(row.id, 'data-state')};
      return { hidden: el.hidden, text: el.textContent, tone: el.className, title: el.title,
               state: st.textContent };
    `)
    t.is(ok.state, 'answering', 'the port is answering, which is what the state badge says')
    t.is(ok.hidden, false, 'and the health badge appears once the app has something to say')
    t.is(ok.text, 'healthy', 'a health answer with no failing check reads as healthy')
    t.ok(/success/.test(ok.tone), 'and is toned as one')
    t.ok(/database ok/.test(ok.title) && /mail ok/.test(ok.title),
      `the checks are NAMED, not summarized — "${ok.title}"`)

    /* ── degraded, and it says which ───────────────────────────────────── */

    // The whole point of the feature: `up` becomes *up, and its mail check is
    // failing*. A degraded badge with nothing saying which dependency is down
    // sends somebody to the logs for a fact this already has.
    body.current = DEGRADED
    const bad = await t.evaluate(`
      const { state } = await fetch('/api/state').then(r => r.json());
      await refreshHealth(state);
      await pollState();
      const el = ${badge(row.id, 'data-health')};
      const st = ${badge(row.id, 'data-state')};
      return { text: el.textContent, tone: el.className, title: el.title, state: st.textContent };
    `)
    t.is(bad.state, 'answering', 'the socket is still open, so the state badge has not moved')
    t.is(bad.text, '1 check failing', 'and the health badge is what changed')
    t.ok(/danger/.test(bad.tone), 'toned as a failure')
    t.ok(/mail fail/.test(bad.title), `naming the check that failed — "${bad.title}"`)

    /* ── the detail, printed ───────────────────────────────────────────── */

    const printed = await t.evaluate(`
      const before = document.querySelectorAll('#output-lines .gui-line').length;
      showHealth(${JSON.stringify(row.id)});
      return [...document.querySelectorAll('#output-lines .gui-line')]
        .slice(before).map(el => el.textContent).join('\\n');
    `)
    t.ok(/ECONNREFUSED/.test(printed), 'the check`s own error reaches the console')
    t.ok(/stand-in 0\.0\.0/.test(printed), `and the app names itself — "${printed.split('\n')[0]}"`)

    /* ── nothing to say is not a failure ───────────────────────────────── */

    // The case that decides whether the badge is usable, and it must be a row
    // that is UP: a Vite dev server answers 404 at both candidate paths, and
    // rendering that red would leave every web surface here permanently wrong.
    // A row that is merely DOWN is hidden one branch earlier and proves nothing.
    const other = await t.evaluate(`
      const { state } = await fetch('/api/state').then(r => r.json());
      const r = dashRows.find(r => r.kind === 'surface' && r.port
        && r.id !== ${JSON.stringify(row.id)} && state[r.id]?.state === 'down');
      return r ? { id: r.id, port: r.port } : null;
    `)
    const stopQuiet = other && await serve(other.port, null)
    if (!stopQuiet) {
      t.ok(true, 'no second port free to stand a silent server behind')
    } else {
      try {
        const quiet = await t.evaluate(`
          const { state } = await fetch('/api/state').then(r => r.json());
          await refreshHealth(state);
          await pollState();
          const li = document.querySelector('#dash-groups [data-id="' + ${JSON.stringify(other.id)} + '"]');
          return { state: li.querySelector('[data-state]').textContent,
                   hidden: li.querySelector('[data-health]').hidden };
        `)
        t.is(quiet.state, 'answering', 'the silent server is up, so the state badge says so')
        t.is(quiet.hidden, true, 'and a row that answers no health question shows nothing rather than unhealthy')
      } finally { await stopQuiet() }
    }

  } finally {
    await stop()
  }

  /* ── a verdict never outlives the process it was about ────────────────── */

  // The case the cache exists for. A row that goes down and comes back is a NEW
  // process, and health is only refreshed every fifth tick — so without
  // dropping the answer, the badge shows the previous process's verdict about a
  // process that has not been asked anything.
  const down = await t.evaluate(`
    const { state } = await fetch('/api/state').then(r => r.json());
    await refreshHealth(state);
    await pollState();
    return { state: ${badge(row.id, 'data-state')}.textContent,
             hidden: ${badge(row.id, 'data-health')}.hidden };
  `)
  t.is(down.state, 'not running', 'the port stopped answering')
  t.is(down.hidden, true, 'and the health it last reported goes with it')

  const restarted = await serve(row.port, { current: DEGRADED })
  if (!restarted) {
    t.ok(true, 'could not rebind to stand a second process behind that port')
    await t.evaluate(`startStatePoll(); return true;`)
    return
  }
  try {
    const fresh = await t.evaluate(`
      await pollState();              // deliberately WITHOUT refreshing health
      return { state: ${badge(row.id, 'data-state')}.textContent,
               hidden: ${badge(row.id, 'data-health')}.hidden };
    `)
    t.is(fresh.state, 'answering', 'a new process is answering on the same port')
    t.is(fresh.hidden, true,
      'and it carries no verdict until it is asked — not the last process\'s')
  } finally { await restarted() }

  await t.evaluate(`startStatePoll(); return true;`)
}
