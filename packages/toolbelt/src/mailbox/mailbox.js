/*
 * mailbox.js — a mailbox as a header writes it: `Name <local@domain>`.
 *
 * Three copies of this rule drifted apart: junction's SMTP header writer, and
 * the two inbound mail connectors that render a vendor's parsed sender back
 * into the `from` junction's `assertMailbox` splits. One quoted on `( )` and one
 * did not, and both STRIPPED `"` and `< >` from a name where the grammar
 * escapes them, so `"Ada \"the\" Lovelace"` arrived as `Ada the Lovelace`. A
 * connector may not import junction (`FJS-D1091`), so the one rule lives below
 * both.
 *
 * It renders and does not grade. Whether an address is one, and whether a name
 * holds a control character, is the sender's question and junction answers it
 * before anything reaches a wire. A non-ASCII name is quoted as given: turning
 * it into encoded-words is a wire encoding, and the SMTP writer does it there.
 */

const ATOM_PHRASE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ .-]+$/

/** `Name <address>`; the name bare where it is atoms, else a quoted-string; the address alone when there is no name. */
export function formatMailbox(address, name) {
  const n = (name ?? '').trim()
  if (!n) return address
  if (ATOM_PHRASE.test(n)) return `${n} <${address}>`
  return `"${n.replace(/(["\\])/g, '\\$1')}" <${address}>`
}
