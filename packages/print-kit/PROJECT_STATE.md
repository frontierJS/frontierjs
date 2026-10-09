# @frontierjs/print-kit — project state

State as of **2026-10-09**. Moved in from `fjs-prototypes/transit/packages/print-kit`
today under `FJS-D811`; three prototypes (transit, lago, serpgrid) reach for
it and `example` does not, which is the signal the ruling amended the
exit trigger to.

## What works

- **11/11 tests pass** on this machine (Chrome + pdftotext present).
- PDF of a document, PNG of an element, page rules and margin boxes from
  data, the offline tab, `printerPlugin` claiming `app.printer`, refusal at
  boot by name with no Chrome.

## Open

- `FJS-2230` — the unexplained wedge (one run in six, three jobs in a row).
- No consumer in this repo: `example` gets a PDF when something there needs
  one, not before.
