# @frontierjs/print-kit — project state

State as of **2026-10-09**. Moved in from `fjs-prototypes/transit/packages/print-kit`
today under `FJS-D816`; three prototypes (transit, lago, serpgrid) reach for
it and `example` does not, which is the signal the ruling amended the
exit trigger to.

## What works

- **12/12 tests pass** on this machine (Chrome + pdftotext present).
- PDF of a document, PNG of an element, page rules and margin boxes from
  data, the offline tab, `printer` claiming `app.printer`, refusal at
  boot by name with no Chrome, a wedged browser failing one job and the next
  printing on a fresh one.

## Open

- No consumer in this repo: `example` gets a PDF when something there needs
  one, not before.
