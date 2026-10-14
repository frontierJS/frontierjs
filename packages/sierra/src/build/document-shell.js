/**
 * build/document-shell.js — a static app's `document` applied to `index.html`.
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
 */

import { documentParts } from './prerender.js'

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
 * at the end of `<head>`, `bodyEnd` at the end of `<body>`.
 */
export function applyDocument(html, doc = {}) {
  const parts = documentParts(doc)

  const htmlStated = [
    ...(doc.lang ? [['lang', 'lang']] : []),
    ...(doc.htmlClass ? [['class', 'htmlClass']] : []),
  ]
  const bodyStated = [
    ...(doc.bodyClass ? [['class', 'bodyClass']] : []),
    ...Object.keys(doc.bodyAttrs ?? {}).map((k) => [k.toLowerCase(), `bodyAttrs.${k}`]),
  ]

  let out = html.replace(/<html\b[^>]*>/i, (tag) => {
    refuseRestated(tag, 'html', htmlStated)
    return tag.replace(/>$/, `${parts.htmlAttr}>`)
  })
  out = out.replace(/<body\b[^>]*>/i, (tag) => {
    refuseRestated(tag, 'body', bodyStated)
    return tag.replace(/>$/, `${parts.bodyAttr}>`)
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

export function documentShellPlugin(config) {
  return {
    name: 'sierra:document-shell',
    transformIndexHtml(html) {
      return config.document ? applyDocument(html, config.document) : html
    },
  }
}
