/**
 * HTML character references as text. Two readers: the compiler, which turns
 * a template's static text into a string, and the terminal runtime, which
 * reads `{@html}` markup as the text it holds.
 */

// The named references an author types in prose, not HTML5's 2,231: a compiler
// that cannot reach a DOM needs a table, and one name missing from it prints as
// its own source rather than failing. A numeric reference is general.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lbrace: '{', rbrace: '}',
  nbsp: ' ', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°',
  plusmn: '±', times: '×', divide: '÷', middot: '·', bull: '•', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  cent: '¢', pound: '£', yen: '¥', euro: '€', frac12: '½', frac14: '¼', frac34: '¾',
  check: '✓', star: '☆', hearts: '♥'
}
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g

/**
 * Decode character references in ONE pass. A chain of replaces decodes its own
 * output: `&amp;lt;` is the text "&lt;", and `.replace(/&amp;/g, '&')` before
 * `.replace(/&lt;/g, '<')` turns it into "<".
 */
export function htmlEntitiesToText(text) {
  return text.replace(ENTITY, (whole, hex, dec, name) => {
    if (hex || dec) {
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10)
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole
    }
    return name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : whole
  })
}
