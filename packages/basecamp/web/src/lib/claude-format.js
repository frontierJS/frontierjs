// src/lib/claude-format.js — how the Claude Code tab writes a count, a dollar
// figure and a share. One place, so every table on the tab rounds alike.

/** `1,234,567` */
export const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—')

/** `$12.34`; a price under a cent shows as `<$0.01` rather than a zero that reads as free. */
export const usd = (n) => (typeof n !== 'number' ? '—' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

/** `12.3%` of a fraction. */
export const share = (fraction) => (typeof fraction === 'number' ? `${(fraction * 100).toFixed(1)}%` : '—')

/** A row's tokens in all four kinds. */
export const tokensOf = (r) => r.input + r.cacheWrite + r.cacheRead + r.output

/** Replace the home directory with `~`. */
export const tilde = (p, home) => (p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p ?? '')
