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
//   the REVERT filter, paired both ways — a pause in the history must not move
//   which Release a revert offers, and removing the filter has to be visible.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import {
  GUARD_MARKER, nginxGuard, pausedFile, pagePath, fliDir, vhostPath,
  DEFAULT_PAGE, driftVerdict, pauseRefusals, REFUSALS,
} from '../core/pause.js'
import { chooseTarget, transitionsSince, servingHistory } from '../core/revert.js'

const NGINX_STEP = readFileSync(new URL('../commands/deploy/_steps-setup/05-nginx.md', import.meta.url).pathname, 'utf8')

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
    expect(NGINX_STEP).toContain('nginxGuard(serverPath)')
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
    expect(NGINX_STEP.indexOf('nginxGuard(serverPath)')).toBeLessThan(NGINX_STEP.indexOf('${sslBlock}'))
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
