// ─── edit-prompt.js — what the Vite ask panel and a site edit say to Claude ──
//
// The rules, the chips (kinds, scopes, efforts) and the prompts for a change
// asked of picked elements on a page, or of a site's content by its owner
// (`basecamp`'s site edit). `@frontierjs/claude` owns how the session is started
// and reads none of this.

import { ASK_EFFORT } from '@frontierjs/claude'
import { guideList } from './plan-prompt.js'

// What the browser's picker sends with an element: the page renders as narrow
// a reply as the console does, and the file and line are where to start, not a
// fence — a change asked of one element is often one in the component it uses.
export const EDIT_RULES = [
  'I picked one or more elements on a page running in a FrontierJS dev server and asked for a change to them. When I pick several, the one instruction covers all of them.',
  'Make the change with the Edit tool. Use Write only to create a new file, such as a new section or component. You may change files under the app directory and nowhere else; a call outside it is denied, so say what you would change there instead. You may also read the framework guides listed below and the app\'s db/ directory.',
  'The page hot-reloads when a file is saved, so I will see the result as soon as you edit. Make the smallest change that does what I asked, in the style of the file you are in.',
  'Another session may be editing this tree. Re-read a file before you edit it, and never rewrite more of it than the change needs.',
  'Reply in two or three short lines: what you changed and where (file:line).',
].join('\n\n')

// The panel's chips. The page sends a key and the sentence lives here, so a
// request cannot put words of its own into the prompt through them. "every" is
// the one a looped element needs: an ask about one card of twelve is otherwise
// read as a change to that card, edited in with a condition.
//
// A kind also names the guides to read first and the effort it runs at. The
// cost of a run is the guides it reads, not its thinking: a Style ask at low
// made the same edit as at high in half the time, so effort is the lever and
// not the model, and the panel's effort chip overrides it.
export const EDIT_KINDS = {
  text:     { says: 'the words only. Leave markup, classes and script alone.', guides: [], effort: 'low' },
  style:    { says: 'how it looks: classes, and @frontierjs/css tones and treatments rather than colors. Leave the markup structure and the script alone.', guides: ['css', 'ui'], effort: 'low' },
  layout:   { says: 'arrangement and size: markup structure and layout classes. Leave the data and the behavior alone.', guides: ['css', 'ui', 'mesa'], effort: 'high' },
  behavior: { says: 'what it does: event handlers and script. Keep how it looks.', guides: ['mesa', 'sierra', 'junction'], effort: 'high' },
  data:     { says: 'what it shows: which fields, records, order or filter. Reach the data through the resource the page already reads.', guides: ['sierra', 'junction', 'litestone'], effort: 'high' },
}

// A site owner's ask (`IDEAS/owner-editing.md` Phase 4, `FJS-D1242`): basecamp
// runs `askArgv({ edit })` scoped to a copy of the draft's `content/`, so the
// tools hold the scope and these sentences only say why. The owner reads the
// reply, not a developer. `locked` is site-kit's `LOCKED_KEYS`, passed in, since
// this package does not depend on site-kit; the grade after the run refuses
// what these words fail to stop.
export const CONTENT_RULES = [
  'I own this website and asked for a change to its words. Its content is the markdown under content/: each file is a page, a block of a page or an item of a collection, with its front matter between the --- lines and its prose after them.',
  'Make the change with the Edit tool. Use Write only to add a new file beside ones like it, such as a new item in a collection. You may change files under content/ and nowhere else.',
  'Where I asked for something everywhere, look through every file before deciding there are no more. Make the smallest change that does what I asked, in the style of the file you are in.',
  'Reply in two or three short lines a person who does not code can read: what you changed, and on which pages.',
].join('\n\n')

// An ask is typed on a page and says "it" or "this" about what is on it.
// Without the page a run searches every file first, a model turn of its own
// (FJS-D2126).
// A file past the caller's budget comes as `text: null` and is named, so the
// run knows the page shows it and reads it rather than searching for it.
function pageLine(page) {
  if (!page?.files?.length) return null
  const whole = page.files.filter((f) => f.text != null)
  const named = page.files.filter((f) => f.text == null).map((f) => f.path)
  return [
    `I asked while looking at the page at ${page.path}. When my words say "it" or "this", or do not say where, they mean something on this page. These are the files it shows, its own first, as they are now. Find the change in them before searching, and look through the other files only when I asked for something everywhere or the change is not here.`,
    named.length ? `The page also shows ${named.join(', ')}, too long to include here: read them when the change is not in the files below.` : null,
    ...whole.map((f) => `<file path="${f.path}">\n${f.text}\n</file>`),
  ].filter(Boolean).join('\n\n')
}

/**
 * An owner's ask: the rules, the front-matter keys to leave alone, the page it
 * was asked on (`{ path, files }`, the files the caller has checked), the request.
 */
export function contentPrompt({ request, locked = [], page = null } = {}) {
  const keep = locked.length
    ? `Leave these front-matter keys exactly as they are wherever a file has them at the top level: ${locked.join(', ')}. They decide how the site looks, and a change to one is refused whole.`
    : null
  return [CONTENT_RULES, keep, pageLine(page), `The change: ${String(request ?? '').trim().slice(0, 4000)}`].filter(Boolean).join('\n\n')
}

export const EDIT_SCOPES = {
  every:     'every item its loop draws. Edit the loop body once, not one item.',
  component: 'the whole component or section the element belongs to.',
  page:      'the whole page, wherever the same thing appears on it.',
}

// An outerHTML is context, not the subject; a page section is easily 50KB. The
// budget is for the whole prompt, so ten picks cost what one does.
export const EDIT_MAX_HTML = 4000

// Each length's cut of `total`: a short one keeps all of its own and what it
// leaves over goes to the longer ones, rather than every pick getting total/n.
export function shareBudget(lengths, total = EDIT_MAX_HTML) {
  const out = new Array(lengths.length).fill(0)
  let left = total
  const order = lengths.map((n, i) => i).sort((a, b) => lengths[a] - lengths[b])
  order.forEach((i, k) => {
    out[i] = Math.min(lengths[i], Math.floor(left / (order.length - k)))
    left -= out[i]
  })
  return out
}

// The page panel offers three: the steps between them are too fine to choose
// from a glance.
export const PANEL_EFFORTS = ['low', 'high', 'max']

/** The effort an edit runs at: the one asked for, else its kind's, else `ASK_EFFORT`. */
export function editEffort(kind, asked = null) {
  return asked || (Object.hasOwn(EDIT_KINDS, kind ?? '') ? EDIT_KINDS[kind].effort : ASK_EFFORT)
}

/**
 * The prompt for one ask: the picked elements, where each one's source is, what
 * to do. `picks` is `[{ loc, html, size }]`, where `size` is the outerHTML's
 * whole length when the page already cut `html`; a pick may carry what
 * `core/ask-context.js` read off the source — `loops` around it, `inner` loops
 * and `files` under it — and `data` is the resources those files read, one
 * line each. `kind` and `scope` are `EDIT_KINDS`/`EDIT_SCOPES` keys. The rules
 * and the guide list travel only on a first question, as in `askPrompt`;
 * `rules: false` keeps the guides and drops the rules, for a prompt handed to
 * an agent the panel does not run.
 */
export function editPrompt({ instruction, picks = [], page = null, followUp = false, rules = !followUp, kind = null, scope = null, data = [], images = 0, guides = [] }) {
  const known = Object.hasOwn(EDIT_KINDS, kind ?? '')
  const parts = []
  if (rules) parts.push(EDIT_RULES)
  if (!followUp && guides.length) parts.push(guideList(guides))
  const first = known ? guides.filter(g => EDIT_KINDS[kind].guides.includes(g.pkg)) : []
  if (first.length) parts.push(`Before this change, read: ${first.map(g => g.file).join(', ')}`)
  const change = String(instruction ?? '').trim()
  if (change) parts.push(`Change: ${change}`)
  if (images > 0) parts.push(`I pasted ${images === 1 ? 'an image' : `${images} images`} with this; ${images === 1 ? 'it comes' : 'they come'} after this text.`)
  if (known) parts.push(`What to change: ${EDIT_KINDS[kind].says}`)
  if (Object.hasOwn(EDIT_SCOPES, scope ?? '')) parts.push(`How far: ${EDIT_SCOPES[scope]}`)
  if (page) parts.push(`The page: ${String(page).slice(0, 300)}`)
  const htmls = picks.map(p => String(p.html ?? ''))
  const cuts  = shareBudget(htmls.map(h => h.length))
  const loop  = l => `{#each ${l.head}} at ${l.at}`
  picks.forEach((p, i) => {
    const lines = [picks.length > 1 ? `Element ${i + 1} of ${picks.length}:` : 'The element:']
    if (p.loc) lines.push(`- source: ${p.loc}`)
    if (p.via) lines.push(`- drawn by ${p.via}, a package component's own markup: the source is the line that placed that component, so change what it passes (props, slot content) rather than the package's file`)
    if (p.repeats > 1) lines.push(`- drawn ${p.repeats} times on the page from that source`)
    if (p.loops?.length) lines.push(`- inside: ${p.loops.map(loop).join(' › ')}`)
    if (p.files?.length) lines.push(`- written in, under it: ${p.files.join(', ')}`)
    if (p.inner?.length) lines.push(`- loops under it: ${p.inner.map(loop).join('; ')}`)
    const h = htmls[i], size = Math.max(Number(p.size) || 0, h.length)
    if (h) lines.push(`- rendered HTML, outlined (a run of siblings from one source folded to the first, long text clipped)${cuts[i] < size ? `, first ${cuts[i]} of ${size} chars` : ''}:\n\`\`\`html\n${h.slice(0, cuts[i])}\n\`\`\``)
    parts.push(lines.join('\n'))
  })
  if (data.length) parts.push(['What those loops can read — the resources their files import:', ...data.map(d => `- ${d}`)].join('\n'))
  return parts.join('\n\n')
}
