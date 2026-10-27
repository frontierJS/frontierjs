/**
 * build/document-shell.js — a static app's `document` applied to `index.html`,
 * and the two shell facts every target's `index.html` carries.
 *
 * A prerendered page is wrapped by `wrapDocument()`, and `vite dev` serves
 * `index.html` instead, which nothing wrapped. Without this the dev page lacks
 * what every built page carries, and an app keeps it by stating each key twice
 * -- once in `document`, once in `index.html` -- where the two drift apart and
 * the build ships the copy dev never ran (`FJS-D971`). The build runs it too:
 * a home route that is not prerendered publishes the shell as `index.html`.
 *
 * A key stated in both places is refused by name rather than merged, because a
 * merge rule is a second answer to which copy wins, and the build already
 * answered it.
 *
 * `document` is a static-target key; an SPA's `index.html` is the whole of its
 * page. What an SPA's shell still gets is `lang` on `<html>` and the skip link
 * first in `<body>` (`FJS-D836`), each written only where the shell wrote
 * nothing -- a shell with no `<html>` tag at all, which the parser allows, is
 * given one so `lang` has somewhere to sit.
 */

import { documentParts, DEFAULT_LANG, SKIP_LINK, SKIP_LINK_GUARD, hasSkipLink } from './prerender.js'

// The opening tag's attribute names. A value never matters: stating the
// attribute at all is the second statement.
function attrNames(tag) {
  const inner = tag.replace(/^<\w+/, '').replace(/>$/, '')
  return new Set([...inner.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)].map((m) => m[1].toLowerCase()))
}

function refuseRestated(tag, element, stated) {
  const inShell = attrNames(tag)
  for (const [name, key] of stated) {
    if (inShell.has(name)) {
      throw new Error(
        `[Sierra] index.html's <${element}> states '${name}', and document.${key} states it too. ` +
        `A static app states it once, in document -- dev applies it (FJS-D971).`,
      )
    }
  }
}

/**
 * The shell with `document` applied: `lang` and `htmlClass` on `<html>`,
 * `bodyClass` and `bodyAttrs` on `<body>`, `meta`, `links`, `jsonLd` and `head`
 * at the end of `<head>`, `bodyEnd` at the end of `<body>`; and, whatever
 * `doc` holds, `lang` on an `<html>` that has none and the skip link first in
 * a `<body>` that has none.
 */
export function applyDocument(html, doc = {}) {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '<html>'
  const htmlStated = [
    ...(doc.lang ? [['lang', 'lang']] : []),
    ...(doc.htmlClass ? [['class', 'htmlClass']] : []),
  ]
  refuseRestated(htmlTag, 'html', htmlStated)
  const lang = doc.lang || (attrNames(htmlTag).has('lang') ? '' : DEFAULT_LANG)
  const parts = documentParts({ ...doc, lang })

  const bodyStated = [
    ...(doc.bodyClass ? [['class', 'bodyClass']] : []),
    ...Object.keys(doc.bodyAttrs ?? {}).map((k) => [k.toLowerCase(), `bodyAttrs.${k}`]),
  ]

  const opened = htmlTag.replace(/>$/, `${parts.htmlAttr}>`)
  let out = /<html\b/i.test(html)
    ? html.replace(/<html\b[^>]*>/i, opened)
    : /<!doctype\b[^>]*>/i.test(html)
      ? html.replace(/<!doctype\b[^>]*>/i, (d) => `${d}\n${opened}`)
      : `${opened}\n${html}`
  // The guard goes first in <head>, ahead of every stylesheet, so its layer is
  // the lowest; a shell with no <head> carries it just before the link.
  const writesSkip = !hasSkipLink(html)
  const hasHead = /<head\b[^>]*>/i.test(out)
  if (writesSkip && hasHead) out = out.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n  ${SKIP_LINK_GUARD}`)
  out = out.replace(/<body\b[^>]*>/i, (tag) => {
    refuseRestated(tag, 'body', bodyStated)
    const skip = !writesSkip ? '' : hasHead ? `\n  ${SKIP_LINK}` : `\n  ${SKIP_LINK_GUARD}\n  ${SKIP_LINK}`
    return tag.replace(/>$/, `${parts.bodyAttr}>${skip}`)
  })

  const head = parts.tags + parts.head
  if (head) out = out.replace(/<\/head>/i, `${head}\n</head>`)

  // The LAST closing tag: a shell may mention the closing body tag inside a
  // comment, and inserting at that one would put the scripts inside the comment.
  if (parts.bodyEnd) {
    const at = out.toLowerCase().lastIndexOf('</body>')
    if (at !== -1) out = `${out.slice(0, at)}${parts.bodyEnd}\n${out.slice(at)}`
  }
  return out
}

export function documentShellPlugin(config, target) {
  return {
    name: 'sierra:document-shell',
    transformIndexHtml(html) {
      return applyDocument(html, target === 'static' ? config.document ?? {} : {})
    },
  }
}
