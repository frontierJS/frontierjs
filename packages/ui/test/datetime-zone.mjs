/*
 * datetime-zone.mjs
 * DateTimeInput's conversions in a STATED zone (FJS-2636).
 *
 * The helpers live in the component's <script module>, so the module half is
 * lifted out and imported on its own. Every expectation is written out by hand
 * for America/Chicago, so the run holds in whatever zone the host is in: run
 * it under `TZ=Pacific/Auckland` as well as UTC.
 *
 * Run: node test/datetime-zone.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../components/forms/DateTimeInput.mesa', import.meta.url)), 'utf8')
const mod = /<script module>([\s\S]*?)<\/script>/.exec(src)[1]
const { toLocalInput, fromLocalInput, localZoneLabel, inDstGap } =
  await import('data:text/javascript;base64,' + Buffer.from(mod).toString('base64'))

const timeZone = 'America/Chicago'

assert.equal(toLocalInput('2026-03-04T09:30:00.000Z', { timeZone }), '2026-03-04T03:30', 'winter is CST, UTC-6')
assert.equal(toLocalInput('2026-07-04T09:30:45.000Z', { timeZone, seconds: true }), '2026-07-04T04:30:45', 'summer is CDT, UTC-5')
assert.equal(toLocalInput('2026-03-04T09:30:00.000Z', { timeZone: 'Asia/Kolkata' }), '2026-03-04T15:00', 'a half-hour zone')
assert.equal(toLocalInput('', { timeZone }), '', 'nothing stays nothing')

assert.equal(fromLocalInput('2026-07-01T14:45', { timeZone }), '2026-07-01T19:45:00.000Z', 'a summer wall clock is read as CDT')
assert.equal(fromLocalInput('2026-03-08T12:00', { timeZone }), '2026-03-08T17:00:00.000Z', 'just after spring-forward')
assert.equal(fromLocalInput('2026-12-25T00:00', { timeZone }), '2026-12-25T06:00:00.000Z', 'a winter wall clock is read as CST')
assert.equal(fromLocalInput('2026-12-25T00:00:30', { timeZone: 'Asia/Kolkata' }), '2026-12-24T18:30:30.000Z', 'seconds survive')
assert.equal(fromLocalInput('', { timeZone }), '', 'a cleared box sends nothing')
assert.equal(fromLocalInput('not a date', { timeZone }), '', 'an unparseable entry sends nothing')

for (const iso of ['2026-01-15T00:00:00.000Z', '2026-03-08T07:59:00.000Z', '2026-11-01T06:59:00.000Z', '2026-07-01T23:59:00.000Z']) {
  assert.equal(fromLocalInput(toLocalInput(iso, { timeZone }), { timeZone }), iso, `round trip ${iso}`)
}

assert.equal(localZoneLabel(new Date('2026-03-04T09:30:00Z'), timeZone), 'CST')
assert.equal(localZoneLabel(new Date('2026-07-04T09:30:00Z'), timeZone), 'CDT')

// FJS-3155: the label names the zone AT THE VALUE, so a summer value in a winter
// month still reads CDT, and an absent or unparseable value falls back to now.
assert.equal(localZoneLabel('2026-07-04T09:30:00.000Z', timeZone), 'CDT', 'a value as a string')
assert.equal(localZoneLabel('2026-01-04T09:30:00.000Z', timeZone), 'CST')
assert.ok(localZoneLabel('', timeZone).length > 0 && localZoneLabel('nope', timeZone).length > 0, 'no value, no throw')

// A wall time the zone skipped is refused, not moved to a neighbor.
assert.equal(inDstGap('2026-03-08T02:30', { timeZone }), true, 'spring-forward gap, Chicago')
assert.equal(inDstGap('2026-03-08T02:00', { timeZone }), true, 'first minute of the gap')
assert.equal(inDstGap('2026-03-08T03:00', { timeZone }), false, 'first minute after the gap')
assert.equal(inDstGap('2026-03-08T01:59', { timeZone }), false, 'last minute before the gap')
assert.equal(inDstGap('2026-11-01T01:30', { timeZone }), false, 'a fold is ambiguous, not missing')
assert.equal(inDstGap('2026-03-08T02:30:15', { timeZone }), true, 'seconds do not hide it')
assert.equal(inDstGap('', { timeZone }), false, 'nothing is not a gap')
assert.equal(inDstGap('2026-03-08T02:30', { timeZone: 'Asia/Kolkata' }), false, 'a zone with no DST')

// No zone stated: the browser's own, exactly as before.
assert.equal(fromLocalInput('2026-07-01T14:45'), new Date('2026-07-01T14:45').toISOString())

console.log('datetime-zone: ok')
