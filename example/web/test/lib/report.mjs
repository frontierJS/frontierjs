// web/test/lib/report.mjs — how a drive here grades what it recorded, and the
// one thing none of the seventeen copies of this could do.
//
// Every drive in this directory records into a `got` map and grades it against
// a hand-written `expected` map. Two lists that must agree with nothing deriving
// one from the other, and the disagreement is silent in exactly one direction:
// a key in `expected` the drive never sets FAILS loudly as `have undefined`,
// while an assertion the drive RUNS under a key the map does not carry is
// recorded and never looked at. It prints nothing, it cannot fail, and the
// total goes on looking right (`FJS-995` — found by making the mistake, and the
// drive reported *all 41 assertions passed* with 42 asserted).
//
// So the report walks BOTH lists. That is four lines, and it is the reason this
// is a module rather than four lines: sixteen copies is sixteen chances to
// write the eighteenth drive without them.
//
// ─── What collapsed on the way in ─────────────────────────────────────────
//
// The seventeen tails differed in three ways and two of them were nothing:
// whitespace, and whether the comparison was `===` or a `JSON.stringify` pair.
// The second is a real difference and the structural one is the superset — for
// the primitives the `===` drives compare, the two agree — so there is one
// comparison here and no option to pick it.
//
// The third was real: two drives cannot state their answer as a constant.
// `verify-jobs` grades its sweep against what the sweep FOUND, and `verify-pay`
// carries an order id minted by the run. Both are met by one rule rather than
// by two options — **an `expected` value that is a function is a predicate over
// what was recorded** — which is why this module takes no `normalize` and no
// `compare`.

/**
 * A recorder and the map it writes into.
 *
 *   const { got, t } = results()
 *   t('cart.tokenSurvivesAPreflight', res.status === 200)
 */
export function results() {
  const got = {}
  return { got, t: (label, value) => { got[label] = value } }
}

/**
 * Grade `got` against `expected` and print the rows. Returns the number of
 * failures, so the caller owns its own exit — a drive with something to say
 * after the table (`verify-jobs` warns that it cancelled every pending order)
 * cannot say it if this exits for them.
 *
 * `stoppedEarly` is the error a drive caught in its own `try`, and it counts as
 * a failure on its own: a run that threw halfway has rows it never reached, and
 * every one of them reads as absent rather than as wrong.
 */
export function report(got, expected, { stoppedEarly = null } = {}) {
  let failed = 0

  for (const [key, want] of Object.entries(expected)) {
    const have = got[key]
    // A key the drive never set can never tie, whatever the comparison says
    // about the two undefineds.
    const ok = typeof want === 'function'
      ? (have !== undefined && want(have) === true)
      : (have !== undefined && JSON.stringify(have) === JSON.stringify(want))
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
    if (!ok) {
      if (typeof want === 'function') console.log(`         predicate rejected ${JSON.stringify(have)}`)
      else {
        console.log(`         want ${JSON.stringify(want)}`)
        console.log(`         have ${JSON.stringify(have)}`)
      }
    }
  }

  // The half a per-drive loop cannot do. See the header.
  for (const key of Object.keys(got)) {
    if (key in expected) continue
    failed++
    console.log(`  FAIL ${key}`)
    console.log('         asserted and not listed in `expected` — add it, or the row is never graded')
  }

  if (stoppedEarly) console.error(`\nstopped early: ${stoppedEarly.message ?? stoppedEarly}`)

  console.log(failed || stoppedEarly
    ? `\n${failed} assertion(s) failed`
    : `\nall ${Object.keys(expected).length} assertions passed`)

  return failed || (stoppedEarly ? 1 : 0)
}
