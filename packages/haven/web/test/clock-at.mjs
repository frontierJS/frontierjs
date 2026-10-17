/**
 * web/test/clock-at.mjs — a drive's terminal at a time of day it chooses.
 * Preloaded into the child (`BUN_OPTIONS=--preload <this>`): with
 * `HAVEN_CLOCK_AT` a fraction of the day (0.25 is mid-morning, 0.75 full
 * night), the child's `Date.now()` reads that point of the day at start and
 * runs on from it. The sky and a night door ask nothing but `Date.now()`, so
 * a drive that waited for the real clock would pass or fail by the hour.
 *
 * Traps:
 * - Only a child holding a session token may take it. A signed login
 *   (`fli haven`) stamps the request with this clock, and the server refuses
 *   one more than five minutes from its own as stale (`WINDOW`, login.ts).
 */
import { DAY_MS } from '../src/lib/scene/sky.js'

const at = Number(process.env.HAVEN_CLOCK_AT)
if (process.env.HAVEN_CLOCK_AT && Number.isFinite(at)) {
  const real  = Date.now
  const t0    = real()
  const shift = at * DAY_MS - (t0 % DAY_MS)
  Date.now = () => real() + shift
}
