/*
 * `xlink:` and `xml:` are namespaces, not part of the attribute name
 * (`FJS-885`).
 *
 * `setAttribute('xlink:href', …)` creates an attribute whose literal name holds
 * a colon, in NO namespace. An HTML parser forgives it and Chrome renders the
 * icon, which is why it survived; an XHTML document, a standalone `.svg`, and
 * anything that re-serializes the DOM as XML do not, and there the reference is
 * simply gone.
 *
 * This spec is in the browser drive rather than beside the other attribute
 * tests because happy-dom normalizes the colon form into the namespace by
 * itself — under it the fix and its absence are indistinguishable, and a test
 * would pass for the wrong reason.
 */
export const name = 'xlink:/xml: attributes are namespaced (FJS-885)'
export const covers = ['set_attribute', 'namespaces', 'svg']

const XLINK = 'http://www.w3.org/1999/xlink'
const XML   = 'http://www.w3.org/XML/1998/namespace'

const read = `
  const use  = document.querySelector('#use')
  const text = document.querySelector('#text')
  const other = document.querySelector('#other')
  return {
    href:      use.getAttributeNS(${JSON.stringify(XLINK)}, 'href'),
    hrefNs:    use.getAttributeNode('xlink:href')?.namespaceURI ?? null,
    lang:      text.getAttributeNS(${JSON.stringify(XML)}, 'lang'),
    invented:  other.getAttribute('foo:bar'),
    inventedNs: other.getAttributeNode('foo:bar')?.namespaceURI ?? null,
  }
`

export async function run(t) {
  await t.mount('namespaced-attributes')

  const first = await t.evaluate(read)
  t.is(first.href, '#one', 'xlink:href is readable through the XLink namespace')
  t.is(first.hrefNs, XLINK, 'and the attribute node really carries it')
  t.is(first.lang, 'en', 'xml:lang is readable through the XML namespace')

  // The control. Only the two real namespaces are special: a colon name a
  // caller invents must stay a plain attribute, or every `foo:bar` in an app
  // moves somewhere nothing reads.
  t.is(first.invented, 'x', 'an invented prefix is still a plain attribute')
  t.is(first.inventedNs, null, 'and it is in no namespace')

  await t.clickAt('#swap')
  const after = await t.evaluate(read)
  t.is(after.href, '#two', 'and a reactive update writes through the namespace too')
  t.is(after.hrefNs, XLINK, 'without falling back to the colon name')
}
