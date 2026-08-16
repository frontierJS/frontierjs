// web/src/session.js — who the browser thinks you are.
//
// Almost nothing. `@frontierjs/sierra/junction` owns the session now: the
// reactive object, the boot restore, sign in and sign out. This file used to be
// 87 lines of fetch, localStorage and status-code branching, and every app was
// writing its own copy of it slightly differently (`FJS-D20`).
//
// The LEVEL is still the server's judgement — GET /api/account/me answers it
// because api/app.ts passes `services: { level: shopGateLevel }`, so the
// role→level mapping stays in api/gate.ts and is never derived here. The UI
// reads it only to decide what to offer; every request is graded again on
// arrival.
//
// Readers declare `$: session.level`. Signing in is `await signIn(...)`, which
// resolves with the session already loaded.

export { session, signIn, signOut, refresh, ready } from '@frontierjs/sierra/junction'
