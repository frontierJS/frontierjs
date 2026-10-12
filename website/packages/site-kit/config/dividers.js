// config/dividers.js — `====` and `===`, the two lines that give a Markdown
// page its shape without the author writing markup.
//
//   ====|.split.muted     a band: <section class="band muted"> holding a
//                         <div class="container split">, to the next `====`
//   ===|.featured         an article inside the band: <article class="featured">
//   ====|block            closes the band; what follows is plain flow again
//
// Text before the first `====` is a band of its own when the page has any, and
// `===` with no `====` splits the whole file into articles. Position is the
// syntax and never a class (FJS-D614): a band or an article carries only the
// words its divider names.
//
// A word after `|` is either a css look word, placed the way Block places it
// (src/block-look.js), or a class of the site's own. The site's words are
// recorded in `words` and checked against the built stylesheets once the
// pages are written (config/dialect.js), because a misspelt class renders
// unstyled and says nothing.
//
// The output is markup, not a `<Block>` tag: Sierra binds a component by
// scanning the source before Mesa compiles it, so a tag written here would
// bind nothing.

import { axisOf, bandClasses, cellClasses } from '../src/block-look.js'

const DIVIDER = /^(====|===)(?:\|(.*))?$/
const CLASS_NAME = /^-?[_a-zA-Z][\w-]*$/

function refuse(file, divider, message) {
  throw new Error(`[site-kit] ${file ?? 'a Markdown file'}: "${divider}" — ${message}`)
}

/** The divider a node is, or null: a paragraph holding only `===…` or `====…`. */
function dividerOf(node) {
  if (node.type !== 'paragraph' || node.children?.length !== 1 || node.children[0].type !== 'text') return null
  const text = node.children[0].value.trim()
  const m = DIVIDER.exec(text)
  return m ? { text, band: m[1] === '====', descriptor: m[2] ?? '' } : null
}

/**
 * A divider's look: the css words sorted onto their axes, the rest as the
 * site's own classes. `close` is `====|block`.
 */
function readDivider({ text, band, descriptor }, file) {
  const [head, ...words] = descriptor.split('.')
  if (band && head === 'block' && words.length === 0) return { close: true }
  if (head) refuse(file, text, `"${head}" before the first "." names nothing — write ${band ? '====' : '==='}|.${head}`)

  const look = {}
  const extra = []
  for (const word of words) {
    if (!CLASS_NAME.test(word)) refuse(file, text, `"${word}" is not a class name`)
    const axis = axisOf(word)
    if (!axis) {
      extra.push(word)
      continue
    }
    const [key, value] = axis
    if (look[key]) refuse(file, text, `two ${key} words, "${look[key]}" and "${value}"`)
    look[key] = value
  }
  return { look, extra }
}

const html = (value) => ({ type: 'html', value })
const classAttr = (list) => (list ? ` class="${list}"` : '')

/**
 * @param {{ words?: Map<string, Array<{ divider: string, word: string }>> }} [options]
 *   — where each file's own class words are recorded for the build's check
 */
export default function remarkDividers({ words } = {}) {
  return (tree, vfile) => {
    const file = vfile?.path
    if (file) words?.delete(file)
    if (!tree.children.some((node) => dividerOf(node))) return

    const record = (divider, extra) => {
      if (!words || !file || extra.length === 0) return
      if (!words.has(file)) words.set(file, [])
      words.get(file).push(...extra.map((word) => ({ divider, word })))
    }

    // A region is a band or plain flow; inside one, `===` starts articles.
    const regions = [{ band: null, nodes: [], articles: null }]
    const current = () => regions[regions.length - 1]

    for (const node of tree.children) {
      const divider = dividerOf(node)
      if (!divider) {
        const region = current()
        ;(region.articles ? region.articles[region.articles.length - 1].nodes : region.nodes).push(node)
        continue
      }
      const read = readDivider(divider, file)
      if (read.close) {
        regions.push({ band: null, nodes: [], articles: null })
        continue
      }
      record(divider.text, read.extra)
      if (divider.band) {
        regions.push({ band: read, nodes: [], articles: null })
        continue
      }
      const region = current()
      region.articles ??= region.nodes.length ? [{ look: {}, extra: [], nodes: region.nodes }] : []
      region.nodes = []
      region.articles.push({ ...read, nodes: [] })
    }

    // Text ahead of the first `====` is a band like the rest of the page.
    const [preamble] = regions
    if (regions.some((r) => r.band) && (preamble.nodes.length || preamble.articles)) {
      preamble.band = { look: {}, extra: [] }
    }

    const out = []
    for (const region of regions) {
      if (!region.band && !region.nodes.length && !region.articles) continue
      const body = region.articles
        ? region.articles.flatMap((a) => [
            html(`<article${classAttr(cellClasses({ ...a.look, extra: a.extra }))}>`),
            ...a.nodes,
            html('</article>'),
          ])
        : region.nodes
      if (!region.band) {
        out.push(...body)
        continue
      }
      const { outer, inner } = bandClasses({ ...region.band.look, extra: region.band.extra })
      out.push(html(`<section class="${outer}"><div class="${inner}">`), ...body, html('</div></section>'))
    }
    tree.children = out
  }
}
