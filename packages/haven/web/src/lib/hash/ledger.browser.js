// src/ledger.browser.js — `#ledger` in a browser, the twin of `ledger.js`. A
// page reads no register on the machine it is open on, so the workshop's piles
// are the snapshot it was built with and `/ledger` is no command there.
export function checkout() { return null }

export function recount() { throw new Error('a page counts nothing on a machine') }
