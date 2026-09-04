// site/src/routes/tutor.meta.js — the tutorial page's samples.
//
// Every one of them is a TRANSCRIPT or a verbatim lift, not a paraphrase: the
// page's claim is that the tutorial runs and proves itself, and a hand-written
// approximation of its output would be the one thing on the site that has never
// been executed. The step and the failure are copied out of real runs.

import { block, sniff } from '../data/code.js'

const SAMPLES = {
  // What a person types. `--source npm` is the default outside a checkout, so
  // there is nothing to pass.
  START: `$ npx @frontierjs/cli tutor:app

# or, keeping what it builds so you can read it afterwards
$ npx @frontierjs/cli tutor:app --workspace ~/frontier-tutorial`,

  // Lifted from a run of lesson 1, steps 7 and 8. The lines beginning ✓ are
  // probes against the running world, not echoes of a command that exited 0.
  STEP: `  [7/10] 07-push
· Pushing schema to database...
✓ Schema applied
✓ the note table exists in db/app.db
✓ api answers /api/health
✓ GET /api/notes is served, and public

  [8/10] 08-write
✓ POST /api/notes with a token is accepted
✓ the same POST with no token is refused
✓ the row is in db/app.db
· open http://127.0.0.1:8000/notes/ and it is there`,

  // The step's own source. The row is read out of the app's SQLite file rather
  // than off the response, and the refusal is a PAIR with the acceptance.
  ASSERT: `await must(context, probe.httpJson({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: { authorization: \`Bearer \${token}\` },
  body,
  expect:  (j) => j && j.title === title,
  name:    'POST /api/notes with a token is accepted',
}))

// The control. Same request, no token — and it must be
// refused, or the acceptance says nothing about the gate.
await must(context, probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  body,
  expect:  401,
  name:    'the same POST with no token is refused',
}))

// Not the response — the database. A service that answers
// 201 and writes nowhere passes every check above this.
await must(context, probe.sqliteRow({
  db:      join(appDir, 'db', 'app.db'),
  sql:     'select id, title from note where title = ?',
  params:  [title],
  expect:  (rows) => rows.length === 1,
  name:    'the row is in db/app.db',
}))`,

  // A real refusal, copied out of a run where something already held the port.
  FAIL: `✗ port 8000 is free for the API
    asked     port 8000 free
    got       something is already listening there
    likely    something is already listening on 8000 — another app, or an earlier run of this lesson
    reproduce fli ports:status
    continue  fli tutor:app
              fli tutor:app --step 1

✗ 01-preflight refused — nothing after it ran`,

  // The phase, as CI prints it. The four times are one sequential run of the
  // same four commands the phase issues — not four best-of numbers, and not a
  // plausible-looking transcript. Lesson 3 is where the ninety seconds go: it
  // builds real images.
  CI: `─── tutor ─────────────────────────────────────────────
  ✓ tutor:app (7.8s)
  ✓ tutor:access (13.9s)
  ✓ tutor:deploy (98.9s)
  ✓ tutor:fleet (5.9s)`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, sniff(src))])),
  }
}
