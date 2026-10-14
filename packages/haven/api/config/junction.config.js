// api/config/junction.config.js
//
// What Haven declares about its API. Strangers reach it from a public CLI,
// so every bound is on from the first deploy. A socket's own bounds are in
// api/src/app.ts: the transport is built before this file is read.

export default {
  middleware: {
    // Per IP, before any principal exists — a flood that never reaches a
    // service is still counted. A line said is limited per member in
    // messages.service.ts.
    rateLimit: { max: 300, window: '1m' },
  },
}
