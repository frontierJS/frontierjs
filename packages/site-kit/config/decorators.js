// config/decorators.js — a quote whose first line names an element becomes
// that element, the way a ksite page has always wrapped a run of Markdown in
// a class without writing markup.
//
//   > [.checklist]              <div class="checklist">
//   > [section#faq.gap-square]  <section id="faq" class="gap-square">
//   > [aside.note] Heads up     <aside class="note" title="Heads up">
//   > [memo] ### Question       <details><summary><h3>Question</h3></summary>
//   > [memo][### Question]      the same: the title may sit in a second bracket
//
// The tag is any lowercase word (FJS-D2127): a capital would reach Mesa as a
// component, so `> [Note]` stays a quote, and so does a line whose bracket is
// not `tag#id.class` (`> [see p. 3]`, `> [!NOTE]`). `memo` is `details`, and a
// details' title is its <summary>, a heading when it starts with `#`.
//
// A class word is the site's own, recorded in `words` beside the dividers' and
// checked against the built stylesheets (config/dialect.js), because a
// misspelt `.cheklist` renders an unstyled quote and says nothing.

const DECORATOR = /^\[([a-z][a-z0-9-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)\](.*)$/
const SECOND_BRACKET = /^\[([^\]]*)\]\s*$/

/** The decorator a quote opens with, or null: its first paragraph's first line. */
function decoratorOf(quote) {
  const para = quote.children?.[0]
  const text = para?.type === 'paragraph' ? para.children?.[0] : null
  if (text?.type !== 'text') return null
  const [line] = text.value.split('\n')
  const m = DECORATOR.exec(line.trim())
  if (!m || !(m[1] || m[2] || m[3])) return null
  const after = m[4].trim()
  const title = (SECOND_BRACKET.exec(after)?.[1] ?? after).trim()
  return {
    line: line.trim(),
    tag: m[1] === 'memo' ? 'details' : m[1] || 'div',
    id: m[2],
    classes: m[3].split('.').filter(Boolean),
    title,
  }
}

/** Drop the decorator's line from the quote, and its paragraph when nothing else was in it. */
function stripLine(quote) {
  const para = quote.children[0]
  const text = para.children[0]
  const rest = text.value.slice(text.value.indexOf('\n') + 1 || text.value.length)
  if (rest) text.value = rest
  else para.children.shift()
  if (!para.children.length) quote.children.shift()
}

/** `### Question` is an h3 holding Question; anything else is the plain text. */
function summaryOf(title) {
  const hashes = /^(#{1,6})\s*(.*)$/.exec(title)
  const inner = hashes
    ? { type: 'heading', depth: hashes[1].length, children: [{ type: 'text', value: hashes[2] }] }
    : { type: 'text', value: title }
  return { type: 'summary', data: { hName: 'summary' }, children: [inner] }
}

function decorate(quote, d) {
  stripLine(quote)
  const props = {}
  if (d.classes.length) props.className = d.classes
  if (d.id) props.id = d.id
  if (d.title && d.tag === 'details') quote.children.unshift(summaryOf(d.title))
  else if (d.title) props.title = d.title.replace(/#/g, '').trim()
  quote.data = { ...quote.data, hName: d.tag, hProperties: props }
}

/**
 * @param {{ words?: Map<string, Array<{ divider: string, word: string }>> }} [options]
 *   — the map remarkDividers clears per file; this pass runs after it and adds to it
 */
export default function remarkDecorators({ words } = {}) {
  return (tree, vfile) => {
    const file = vfile?.path
    const record = (line, classes) => {
      if (!words || !file || !classes.length) return
      if (!words.has(file)) words.set(file, [])
      words.get(file).push(...classes.map((word) => ({ divider: line, word })))
    }
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'blockquote') {
          const d = decoratorOf(child)
          if (d) {
            decorate(child, d)
            record(`> ${d.line}`, d.classes)
          }
        }
        walk(child)
      }
    }
    walk(tree)
  }
}
