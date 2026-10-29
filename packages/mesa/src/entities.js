/**
 * HTML character references as text. Two readers: the compiler, which turns
 * a template's static text into a string, and the terminal runtime, which
 * reads `{@html}` markup as the text it holds. The names are the whole HTML5
 * list (`entities-table.js`): the DOM path decodes through a parser that
 * knows them all, and the string mode has to write the same byte.
 */

import NAMED_ENTITIES from './entities-table.js'

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
