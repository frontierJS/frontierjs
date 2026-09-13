// ─── pause.test.js — taking an app down on purpose ───────────────────────────
//
// Phase 3b. Three things are asserted here and the third is the one a unit file
// can uniquely make:
//
//   the GUARD is a string this repo writes and nginx reads, so what is checked
//   is the shape that has a trap in it — a URI `error_page` re-enters the
//   rewrite phase, hits the same `if`, and nginx refuses the config for a
//   redirection cycle. That the guard WORKS is asked of a real nginx in CI's
//   `deploy` phase; this asks that it still has the shape that worked.
//
//   the DRIFT table, which is the whole reason a pause is a transition and not
//   a file: the journal records an intent and the file records what is in
//   force, and the two rows that matter are the ones where they disagree.
//
//   the QUEUE half (FJS-D262) — the script that runs Caravan's bin in the
//   container, and the verdict read off what it printed. Each verdict row is
//   paired with the one beside it, since a grader that failed everything or
//   passed everything would satisfy the rows about either alone.
//
//   the REVERT filter, paired both ways — a pause in the history must not move
//   which Release a revert offers, and removing the filter has to be visible.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import {
  GUARD_MARKER, nginxGuard, pausedFile, pagePath, fliDir, vhostPath,
  DEFAULT_PAGE, driftVerdict, pauseRefusals, REFUSALS,
  queueScript, queueVerdict, queueStateLine, jobsVolumeVerdict, QUEUE_HOLDER, CARAVAN_BIN,
} from '../core/pause.js'
import { execFileSync } from 'child_process'
import { chooseTarget, transitionsSince, servingHistory } from '../core/revert.js'

const NGINX_STEP = readFileSync(new URL('../commands/deploy/_steps-setup/05-nginx.md', import.meta.url).pathname, 'utf8')
const EDGE_SRC   = readFileSync(new URL('../core/edge.js', import.meta.url).pathname, 'utf8')

// ─── the guard ───────────────────────────────────────────────────────────────

describe('the nginx guard', () => {
  const guard = nginxGuard('/srv/shop')

  test('carries the marker the other two readers grep for', () => {
    expect(guard).toContain(GUARD_MARKER)
  })

  test('tests the same file deploy:pause writes', () => {
    expect(guard).toContain(pausedFile('/srv/shop'))
    expect(pausedFile('/srv/shop')).toBe('/srv/shop/.fli/paused')
  })

  // The trap. `error_page 503 /some-uri` re-enters the rewrite phase, meets the
  // same `if`, and nginx refuses the whole config with a redirection cycle — so
  // the target has to be a NAMED location, which no URI can reach.
  test('sends 503 to a named location, never to a URI', () => {
    expect(guard).toMatch(/error_page\s+503\s+@\w+;/)
    expect(guard).not.toMatch(/error_page\s+503\s+\//)
  })

  test('stops the rewrite inside that location', () => {
    expect(guard).toMatch(/rewrite \^ \/maintenance\.html break;/)
  })

  // A 503 with no Retry-After is what takes a paused app out of a search index.
  test('answers with Retry-After, and does not let the refusal be cached', () => {
    expect(guard).toMatch(/add_header Retry-After \d+ always;/)
    expect(guard).toMatch(/add_header Cache-Control "no-store" always;/)
  })

  // `error_page` with no `=` preserves the status. An `=200` here would serve
  // the page and tell every client the app is fine.
  test('does not rewrite the status to something successful', () => {
    expect(guard).not.toMatch(/error_page\s+503\s*=/)
  })

  test('serves the page from the directory deploy:pause writes it to', () => {
    expect(guard).toContain(`root ${fliDir('/srv/shop')};`)
    expect(pagePath('/srv/shop')).toBe('/srv/shop/.fli/maintenance.html')
  })
})

describe('the vhost the setup step writes', () => {
  test('gets the guard from this module rather than carrying its own', () => {
    expect(EDGE_SRC).toContain('nginxGuard(serverPath)')
    expect(EDGE_SRC).not.toContain('fli:pause-guard')
    expect(NGINX_STEP).not.toContain('fli:pause-guard')
  })

  // One owner for where the vhost lives — `deploy:pause` greps it and
  // `deploy:status` reports on it.
  test('takes the vhost path from this module too', () => {
    expect(NGINX_STEP).toContain('vhostPath(appId)')
    expect(vhostPath('shop')).toBe('/etc/nginx/sites-available/shop')
  })

  // Both are rewrite-phase returns and the first one wins. After the redirect,
  // a paused app answers 301 to every plain-http caller and looks up.
  test('puts the guard ahead of the http→https redirect', () => {
    expect(EDGE_SRC.indexOf('nginxGuard(serverPath)')).toBeLessThan(EDGE_SRC.indexOf('${listen}'))
  })

  test('writes the default page beside the guard, not on first pause', () => {
    expect(NGINX_STEP).toContain('DEFAULT_PAGE')
    expect(NGINX_STEP).toContain('pagePath(serverPath)')
  })
})

describe('the default page', () => {
  // It is served while the app is down, so anything it had to fetch would be
  // the second thing broken.
  test('asks the network for nothing', () => {
    expect(DEFAULT_PAGE).not.toMatch(/<(script|img|link)\b/i)
    expect(DEFAULT_PAGE).not.toMatch(/https?:\/\//)
  })

  test('says what is happening and that the reader did nothing wrong', () => {
    expect(DEFAULT_PAGE).toMatch(/maintenance/i)
  })
})

// ─── the two answers, compared ───────────────────────────────────────────────

describe('what the journal says against what the edge does', () => {
  test('neither: serving', () => {
    expect(driftVerdict({ journalPaused: false, filePresent: false }))
      .toMatchObject({ state: 'serving', drift: false })
  })

  test('both: paused', () => {
    expect(driftVerdict({ journalPaused: true, filePresent: true }))
      .toMatchObject({ state: 'paused', drift: false })
  })

  // The two that are the reason this section exists. Each names a way out,
  // because there is no answer to which of the two is the stale one.
  test('recorded but not in force — the app is answering and the journal says it is not', () => {
    const v = driftVerdict({ journalPaused: true, filePresent: false })
    expect(v.drift).toBe(true)
    expect(v.detail).toContain('NOT in force')
    expect(v.fix).toContain('fli deploy:unpause')
  })

  test('in force but not recorded — paused by hand, and nothing knows why', () => {
    const v = driftVerdict({ journalPaused: false, filePresent: true })
    expect(v.drift).toBe(true)
    expect(v.summary).toContain('by hand')
    expect(v.fix).toContain('fli deploy:unpause')
  })
})

// ─── the refusals ────────────────────────────────────────────────────────────
//
// Every refusal is PAIRED with the same call one term away. A guard that refused
// everything would satisfy any test that only asked about the refusal.

describe('what a pause refuses', () => {
  const codes = (r) => r.map(x => x.code)

  const serving = { journalPaused: false, filePresent: false }
  const paused  = { journalPaused: true,  filePresent: true  }

  test('a vhost with no guard — the file would be written and nothing would read it', () => {
    expect(codes(pauseRefusals({ want: 'pause', vhostHasGuard: false, ...serving })))
      .toEqual(['no-guard'])
  })

  test('and the same call against a vhost that has one goes ahead', () => {
    expect(pauseRefusals({ want: 'pause', vhostHasGuard: true, ...serving })).toEqual([])
  })

  // An unpause is a removal. It works against a target nobody paused through
  // fli, which is how `paused by hand` stops being the answer.
  test('an unpause does not need the guard', () => {
    expect(pauseRefusals({ want: 'unpause', vhostHasGuard: false, ...paused })).toEqual([])
  })

  test('already paused is a refusal, because running it twice is two people', () => {
    const r = pauseRefusals({ want: 'pause', vhostHasGuard: true, ...paused })
    expect(codes(r)).toEqual(['already'])
    expect(r[0].fix).toContain('fli deploy:unpause')
  })

  test('already serving refuses an unpause the same way', () => {
    expect(codes(pauseRefusals({ want: 'unpause', vhostHasGuard: true, ...serving })))
      .toEqual(['already'])
  })

  // The two rows that make `already` a rule rather than a trap. Each is the
  // drift state, and in each the command being refused is the one that FIXES it.
  test('a journal saying paused over a target with no file accepts another pause', () => {
    expect(pauseRefusals({ want: 'pause', vhostHasGuard: true, journalPaused: true, filePresent: false }))
      .toEqual([])
  })

  test('a journal saying serving over a target paused by hand accepts an unpause', () => {
    expect(pauseRefusals({ want: 'unpause', vhostHasGuard: true, journalPaused: false, filePresent: true }))
      .toEqual([])
  })

  test('a deploy still open refuses, and names the way to finish it', () => {
    const r = pauseRefusals({ want: 'pause', vhostHasGuard: true, ...serving, inFlight: 't7 is open' })
    expect(codes(r)).toEqual(['in-flight'])
    expect(r[0].fix).toContain('t7 is open')
  })

  test('no journal refuses — a pause with no history cannot name a Release', () => {
    expect(codes(pauseRefusals({ want: 'pause', vhostHasGuard: true, journalOpen: false, ...serving })))
      .toEqual(['no-journal'])
  })

  test('every refusal names itself', () => {
    for (const [code, reason] of Object.entries(REFUSALS)) {
      expect(typeof reason).toBe('string')
      expect(reason.length).toBeGreaterThan(10)
      expect(code).not.toContain(' ')
    }
  })
})

// ─── what a pause must not do to a revert ────────────────────────────────────
//
// `chooseTarget` reads `succeeded[0]` as serving and `succeeded[1]` as the
// previous. With pause rows counted, both shift by one and the default target
// becomes the Release already running — which `same-bytes` then refuses, on the
// day a revert is wanted, in words that read as a bug in the revert.

describe('a pause in the history', () => {
  // Newest first, which is what `readHistory` answers.
  const withoutPause = [
    { id: 't3', kind: 'deploy', status: 'succeeded', releaseId: 'r2', fromReleaseId: 'r1' },
    { id: 't1', kind: 'deploy', status: 'succeeded', releaseId: 'r1', fromReleaseId: null },
  ]
  const withPause = [
    { id: 't5', kind: 'unpause', status: 'succeeded', releaseId: 'r2', fromReleaseId: 'r2' },
    { id: 't4', kind: 'pause',   status: 'succeeded', releaseId: 'r2', fromReleaseId: 'r2' },
    ...withoutPause,
  ]

  test('does not move which Release a revert offers', () => {
    expect(chooseTarget(withPause).targetId).toBe('r1')
  })

  // The control. The same history without the pause rows answers identically,
  // so the row above is about the filter and not about the fixture.
  test('and the same history without it answers the same', () => {
    expect(chooseTarget(withoutPause).targetId).toBe('r1')
    expect(chooseTarget(withPause).serving.releaseId).toBe(chooseTarget(withoutPause).serving.releaseId)
  })

  // What the bug looked like: unfiltered, `succeeded[1]` is the pause, whose
  // releaseId is the one already serving.
  test('unfiltered it would offer the Release already serving', () => {
    const succeeded = withPause.filter(h => h.status === 'succeeded')
    expect(succeeded[1].releaseId).toBe('r2')
    expect(chooseTarget(withPause).serving.releaseId).toBe('r2')
  })

  test('the pivot walk does not count them either', () => {
    expect(transitionsSince(withPause, 'r1').map(h => h.id)).toEqual(['t3'])
  })

  // A history written by an older fli has no `kind` on some rows. Dropping those
  // would hide real deploys, so an unstated kind counts.
  test('a row with no kind is kept', () => {
    expect(servingHistory([{ id: 'old', status: 'succeeded', releaseId: 'r1' }])).toHaveLength(1)
  })
})

// ─── the queues ──────────────────────────────────────────────────────────────

describe('the queue script', () => {
  const script = (o = {}) => queueScript({ container: 'shop_api_3000', verb: 'drain', actor: 'jordan', reason: 'fli deploy:pause t1', ...o })

  test('parses as a shell script, with an actor carrying the quote that breaks naive quoting', () => {
    for (const s of [script(), script({ actor: "O'Neil; rm -rf /" }), script({ verb: 'resume' })])
      execFileSync('sh', ['-n'], { input: s })
  })

  // A hostile actor is ONE argument. Run the arguments through a real shell and
  // count what arrives, rather than reading the text for quotes.
  test('hands the bin the actor as one argument, whatever it contains', () => {
    const actor = "O'Neil; echo pwned $(id)"
    const line  = queueScript({ container: 'c', verb: 'pause', actor }).split('\n').find(l => l.includes(' bun '))
    const args  = line.slice(line.indexOf('queue')).replace(/ 2>&1 \|\| true$/, '')
    const got   = execFileSync('sh', ['-c', `printf '%s\\n' ${args}`], { encoding: 'utf8' }).trim().split('\n')
    expect(got.slice(0, 6)).toEqual(['queue', 'pause', '--actor', actor, '--holder', QUEUE_HOLDER])
  })

  test('runs the bin by path, never through bunx', () => {
    expect(script()).toContain(`bun ${CARAVAN_BIN}`)
    expect(script()).not.toMatch(/bunx/)
  })

  test('a resume carries the holder and no reason', () => {
    expect(script({ verb: 'resume' })).toContain(`--holder '${QUEUE_HOLDER}'`)
    expect(script({ verb: 'resume' })).not.toContain('--reason')
  })
})

describe('what the queue half concludes', () => {
  const answer = (o) => JSON.stringify({ db: '/db/jobs.db', source: 'open', exists: true, caravan: true, liveInstances: 1, ...o })
  const v = (kind, o, noise = '') => queueVerdict({ kind, output: `${noise}${typeof o === 'string' ? o : answer(o)}\n` })

  test('a pause it made is ok; the same pause held by an operator warns that the unpause leaves it', () => {
    expect(v('pause', { changed: true, drained: true, running: 0, pause: { holder: QUEUE_HOLDER } }).level).toBe('ok')
    const other = v('pause', { changed: false, drained: true, running: 0, pause: { holder: null, actor: 'alice', reason: 'incident' } })
    expect(other.level).toBe('warn')
    expect(other.lines.join()).toMatch(/alice \(incident\)/)
  })

  test('a re-run over its own pause is ok, not a warning about somebody else', () => {
    expect(v('pause', { changed: false, drained: true, running: 0, pause: { holder: QUEUE_HOLDER } }).level).toBe('ok')
  })

  test('a drain that stopped waiting warns with the count; one that finished does not', () => {
    const late = v('pause', { changed: true, drained: false, running: 2, pause: { holder: QUEUE_HOLDER } })
    expect(late.level).toBe('warn')
    expect(late.lines.join()).toMatch(/2 job/)
  })

  test('nobody heartbeating on the file warns; one instance does not', () => {
    expect(v('pause', { changed: true, drained: true, running: 0, liveInstances: 0, pause: { holder: QUEUE_HOLDER } }).level).toBe('warn')
  })

  test('two databases open is a FAILURE naming both; nothing open is a note', () => {
    const two = v('pause', { exists: undefined, error: '2 Caravan jobs databases are open here', candidates: ['/db/a.db', '/db/b.db'] })
    expect(two.level).toBe('fail')
    expect(two.lines.join('\n')).toMatch(/\/db\/a\.db[\s\S]*\/db\/b\.db/)
    expect(v('pause', { exists: false, error: 'no process here has a Caravan jobs database open' }).level).toBe('note')
  })

  test('no container warns, no Caravan is a note, and output nobody can read fails', () => {
    expect(v('pause', '{"fli":"no-container"}').level).toBe('warn')
    expect(v('pause', '{"fli":"no-caravan"}').level).toBe('note')
    expect(queueVerdict({ kind: 'pause', output: 'error: Module not found\n' }).level).toBe('fail')
  })

  test('reads the LAST JSON line, past whatever bun printed first', () => {
    expect(v('pause', { changed: true, drained: true, running: 0, pause: { holder: QUEUE_HOLDER } }, 'warn: something {"not":"it"\n').level).toBe('ok')
  })

  test("an unpause that lifted its pause is ok; one that found an operator's still in force warns", () => {
    expect(v('unpause', { changed: true, pause: null }).level).toBe('ok')
    expect(v('unpause', { changed: false, pause: null }).level).toBe('ok')
    const held = v('unpause', { changed: false, pause: { queue: '*', actor: 'alice', holder: null } })
    expect(held.level).toBe('warn')
    expect(held.lines.join()).toMatch(/caravan queue resume/)
  })
})

describe('the queues line deploy:status prints', () => {
  const state = (o) => JSON.stringify({ db: '/db/jobs.db', source: 'open', exists: true, caravan: true, liveInstances: 1, verb: 'state', ...o })
  const deployPause = { queue: '*', pausedAt: 0, actor: 'jordan', reason: 'fli deploy:pause t1', holder: QUEUE_HOLDER }

  test('agreeing with the edge is not drift, in both directions', () => {
    expect(queueStateLine({ output: state({ paused: deployPause, queues: {} }), edgePaused: true }).drift).toBe(false)
    expect(queueStateLine({ output: state({ paused: null, queues: { default: { paused: null } } }), edgePaused: false })).toEqual({ text: 'claiming', drift: false })
  })

  test('an edge paused over claiming queues is drift; a deploy pause over a serving edge is drift', () => {
    expect(queueStateLine({ output: state({ paused: null, queues: { default: { paused: null } } }), edgePaused: true }).drift).toBe(true)
    expect(queueStateLine({ output: state({ paused: deployPause, queues: {} }), edgePaused: false }).drift).toBe(true)
  })

  // An operator's own pause over a serving edge is an operator's business.
  test("an operator's pause over every queue is not drift with the edge serving", () => {
    expect(queueStateLine({ output: state({ paused: { ...deployPause, holder: null }, queues: {} }), edgePaused: false }).drift).toBe(false)
  })

  test('an app with no Caravan is never drift', () => {
    expect(queueStateLine({ output: '{"fli":"no-caravan"}', edgePaused: true })).toEqual({ text: 'this app has no Caravan', drift: false })
  })

  test('the state script passes neither an actor nor a holder, and parses', () => {
    const s = queueScript({ container: 'c', verb: 'state' })
    execFileSync('sh', ['-n'], { input: s })
    expect(s).not.toMatch(/--actor|--holder/)
  })
})

describe('what a swap throws away (FJS-1095)', () => {
  const stats = (pending = 0, running = 0) => ({ pending, running, done: 0, failed: 0, cancelled: 0, oldestRunningMs: null, pausedMs: null })
  const state = (o) => JSON.stringify({ source: 'open', exists: true, caravan: true, liveInstances: 1, verb: 'state',
    paused: null, queues: { default: { paused: null, stats: stats(2, 1) } }, ...o })
  const v = (o) => jobsVolumeVerdict({ output: state(o), volume: '/db' })
  const every = { queue: '*', holder: 'fli:deploy', actor: 'jordan' }

  test('a database under the volume is silent; the same answer inside the container warns with what is lost', () => {
    expect(v({ db: '/db/jobs.db' })).toEqual({ level: 'ok', lines: [] })
    const inside = v({ db: '/app/db/jobs.db' })
    expect(inside.level).toBe('warn')
    expect(inside.lines.join('\n')).toMatch(/2 pending, 1 running/)
  })

  // The case a pause exists for. Paired with the same pause on the volume.
  test('a pause in force on a database inside the container is REFUSED; on the volume it is silent', () => {
    expect(v({ db: '/db/jobs.db', paused: every }).level).toBe('ok')
    const refused = v({ db: '/app/db/jobs.db', paused: every })
    expect(refused.level).toBe('fail')
    expect(refused.lines.join('\n')).toMatch(/every queue[\s\S]*unpause, deploy the binding/)
  })

  test("one queue's own pause is refused too, and named", () => {
    const one = v({ db: '/app/db/jobs.db', queues: { mail: { paused: { queue: 'mail' }, stats: stats() }, default: { paused: null, stats: stats() } } })
    expect(one.level).toBe('fail')
    expect(one.lines.join()).toMatch(/pause on mail/)
  })

  test('a sibling directory that merely starts with the volume name is not under it', () => {
    expect(v({ db: '/dbx/jobs.db' }).level).toBe('warn')
    expect(v({ db: '/db/nested/jobs.db' }).level).toBe('ok')
  })

  test('nothing to ask is silent; an answer that cannot say which database warns', () => {
    for (const out of ['{"fli":"no-container"}', '{"fli":"no-caravan"}', '{"source":"open","exists":false,"error":"none open"}'])
      expect(jobsVolumeVerdict({ output: out, volume: '/db' })).toEqual({ level: 'ok', lines: [] })
    expect(jobsVolumeVerdict({ output: '{"source":"open","candidates":["/a","/b"],"error":"2 open"}', volume: '/db' }).level).toBe('warn')
  })
})
