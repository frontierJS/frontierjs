// web/src/money-control.js — what a `@money` column looks like on a form.
//
// A contributed control, which is two registrations and one name across them:
// `registerControl` (sierra) answers WHICH control a column gets, from the
// schema alone, in plain Node; `registerFormControl` (@frontierjs/ui) says what
// that name renders as. A name is the only thing that can cross, because
// sierra's table has to run in a prerender and a snapshot where no component
// can be loaded, and the kit peers on mesa and css and cannot import sierra
// (`FJS-D17`).
//
// ─── The failure it exists for ────────────────────────────────────────────
//
// `@money(USD)` stores a whole number of CENTS, so `Order.total` reaches the
// browser as an integer and the built-in table renders it as what it is: a
// number spinner stepping by one. A person raising a telephone order for
// forty-two dollars types 42, the form sends 42, and the shop has charged
// forty-two cents — with every screen, every check and every receipt agreeing
// with each other about it.
//
// The box is therefore in MAJOR units and the value handed back is minor. The
// conversion is `@frontierjs/toolbelt/units` in both directions and is written
// nowhere else on this surface: `toMinor` rounds, because `8.29 * 100` is
// 828.9999999999999 and the multiplication a form reaches for first loses a
// cent on the prices that look exact.
//
// ─── Why it reads the declaration and not the column name ─────────────────
//
// `rule['x-money']` is `@money` as it arrives on the wire — `{ currency }` for
// a stated one, `{ field }` where a sibling column holds the code per row, and
// `{}` for the app's default. Resolving on a name ending in `Cents` would be a
// convention this schema does not use and would miss every column that adopts
// `@money` next.
//
// `@scale(2)` is the sibling case and is deliberately NOT claimed: `x-scale` on
// `Discount.value` is a percentage half the time, and a control that put a
// dollar sign in front of it would be wrong on every `percent` row.
import { registerControl }     from '@frontierjs/sierra/junction'
import { registerFormControl } from '@frontierjs/ui/controls'
import { fromMinor, toMinor }  from '@frontierjs/toolbelt/units'
import Input                   from '@frontierjs/ui/components/forms/Input.mesa'

import { BASE } from './money.js'

/** The code this column is in. A `field:` binding names a sibling column and
 *  this control cannot see the record, so the shop's base is the honest answer
 *  there — `Payment` is the only model that binds one and no screen writes it. */
const codeFor = (rule) => rule?.['x-money']?.currency ?? BASE

registerControl('money', (rule) => (rule?.['x-money'] ? 'money' : null))

registerFormControl('money', Input, {
  props: ({ field, value, onvalue }) => {
    const code = codeFor(field.rule)
    return {
      name:  field.name,
      type:  'number',
      // Two decimals for a dollar, none for a yen, three for a dinar. The step
      // is the currency's minor unit expressed in major ones, which is exactly
      // what `fromMinor(1, code)` is.
      step:  fromMinor(1, code),
      // '' and not 0 for an absent value: a form that pre-fills a zero is a
      // form that has answered a question nobody asked.
      value: value == null || value === '' ? '' : fromMinor(value, code),
      oninput: (e) => {
        const raw = e.target.value
        // Blank stays blank. `createResource` strips it to null, which is what
        // a nullable money column means and what `@default(0)` fills in.
        onvalue(raw === '' ? '' : toMinor(Number(raw), code))
      },
    }
  },
})
