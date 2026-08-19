// Node loader hook: intercepts .md imports and compiles them into ESM modules.
// String parsing only — no template compiler at runtime, in either the CLI or
// the Web GUI. A command file is markdown with a <script> block and ```js
// bodies, and that is all this reads.
//
// NOTE: a command's <script> block runs from its open tag to the LAST closing tag
// in the file, so a command may freely EMIT script tags — every scaffold that
// writes a .mesa Resource does. It follows that a command has exactly one script
// block; a second one would be swallowed into the first.

import { pathToFileURL } from 'url'

const utf8Decoder = new TextDecoder('utf-8')
const bufToString = (buf) => (typeof buf === 'string' ? buf : utf8Decoder.decode(buf))

// ─── Node loader hooks ────────────────────────────────────────────────────────

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.endsWith('.md')) {
    return {
      url: new URL(specifier, 'file://' + process.cwd() + '/').href,
      shortCircuit: true
    }
  }
  return defaultResolve(specifier, context)
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.md')) {
    const { readFile } = await import('fs/promises')
    const template = await readFile(new URL(url), 'utf8')
    // Pass the file path so compileCli can emit a sourceURL pragma —
    // runtime error stacks then point to the .md instead of a temp shim.
    const { fileURLToPath } = await import('url')
    const source = compileCli(template, '', fileURLToPath(url))
    return { format: 'module', source, shortCircuit: true }
  }
  return defaultLoad(url, context)
}

// ─── CLI Compiler ─────────────────────────────────────────────────────────────

export function compileCli(template, moduleScript = '', sourcePath = '') {
  const frontmatter = extractFrontmatter(template)
  const ownScript   = extractScriptBlock(template)
  // Module script is prepended so namespace helpers are available everywhere
  const scriptBlock = moduleScript
    ? moduleScript + '\n\n' + ownScript
    : ownScript

  // Strip the <script> block before transformMarkdown so its indented lines
  // don't get picked up by the tab-indent detection and leak into run()
  const scriptStripped = stripScriptBlocks(template)
  const mainBody       = transformMarkdown(scriptStripped)

  // sourceURL pragma — Node and Bun both honor this. Stack traces for runtime
  // errors will reference the .md file path instead of the temp .__fli_*.mjs
  // shim, which is the user's source of truth and survives after temp cleanup.
  const sourceURL = sourcePath
    ? `\n//# sourceURL=${pathToFileURL(sourcePath).href}\n`
    : ''

  return `
import 'zx/globals'
${scriptBlock}

export const metadata = ${JSON.stringify(frontmatter)}

export async function run(context) {
  const { flags, args, flag, arg, log, answers = {} } = context
  // Override the ZX global echo with context.echo when provided (web/SSE runs).
  // This works because 'zx/globals' sets globalThis.echo, and we re-assign it
  // locally here. For CLI runs context.echo is undefined and ZX's echo is used.
  const echo = context.echo ?? globalThis.echo
  ${mainBody}
  return context
}${sourceURL}`.trimStart()
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

// A fence is `---` ALONE on its line, at the top of the file and again to
// close. The looser `/^---[\s\S]*?---\s*/` that five call sites carried by hand
// ended the block at the first `---` anywhere, mid-line included, so a
// `description: use --- as a divider` left the rest of the frontmatter and its
// own closing fence sitting in the body — and the meta parser, whose regex was
// the stricter of the two, disagreed with the body about where the file began.
// Blank lines after the closing fence go with it — the old strip ate them and
// the markdown walkers were written against a body that starts at content.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$)/

/** `{ meta, body }` from one match, so nothing can disagree about the split. */
export function splitFrontmatter(template) {
  const text  = bufToString(template)
  const match = text.match(FRONTMATTER)
  if (!match) return { meta: {}, body: text }
  return { meta: parseYaml(match[1]), body: text.slice(match[0].length) }
}

/** The body with its frontmatter removed. The one owner — do not re-derive it. */
export function stripFrontmatter(template) {
  return splitFrontmatter(template).body
}

export function extractFrontmatter(template) {
  return splitFrontmatter(template).meta
}

function parseYaml(yaml) {
  const lines = yaml.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))

  // Count leading spaces directly — avoids regex match + capture allocation
  // per call (this fires once per line of frontmatter).
  const indent = (line) => {
    let n = 0
    while (n < line.length && line.charCodeAt(n) === 32) n++
    return n
  }

  const result = {}
  let stack = [{ container: result, indentLevel: -1 }]
  const top = () => stack[stack.length - 1]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lvl = indent(raw)
    const line = raw.trim()

    while (stack.length > 1 && lvl <= top().indentLevel) stack.pop()

    const current = top().container

    // Bare dash — object array item
    if (line === '-') {
      const item = {}
      if (Array.isArray(current)) current.push(item)
      stack.push({ container: item, indentLevel: lvl })
      continue
    }

    // Inline array item: "- value"
    const inlineItem = line.match(/^-\s+(.+)$/)
    if (inlineItem && Array.isArray(current)) {
      current.push(coerceYamlValue(inlineItem[1]))
      continue
    }

    // Key: value
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (kv) {
      const [, key, value] = kv
      const val = value.trim()
      if (val === '') {
        // Blank/comment lines are pre-filtered out (see line 97), so the next
        // line in `lines` is the next meaningful line. If it's more indented,
        // we have a child block; otherwise the value is empty string.
        const nextLine = lines[i + 1]
        const nextLvl  = nextLine ? indent(nextLine) : -1
        const hasChild = nextLine && nextLvl > lvl
        if (hasChild) {
          const nextTrimmed = nextLine.trim()
          const isArray = nextTrimmed === '-' || nextTrimmed.startsWith('- ')
          const child = isArray ? [] : {}
          current[key] = child
          stack.push({ container: child, indentLevel: lvl })
        } else {
          current[key] = ''
        }
      } else {
        current[key] = coerceYamlValue(val)
      }
      continue
    }
  }

  return result
}

function coerceYamlValue(val) {
  if (val === 'true')  return true
  if (val === 'false') return false
  if (val === 'null' || val === '~') return null
  // Only coerce to number if it round-trips cleanly — avoids surprising
  // conversions like "+123" → 123, "0xff" → 255, "1e3" → 1000, "Infinity" → null.
  // We want a YAML 1.2 scalar that's unambiguously a plain integer or float.
  if (/^-?\d+$/.test(val) || /^-?\d+\.\d+$/.test(val)) {
    const n = Number(val)
    if (Number.isFinite(n)) return n
  }
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) return val.slice(1, -1)
  return val
}

// ─── Script block helpers ─────────────────────────────────────────────────────

// Find the <script> block: first open tag to the LAST close tag.
//
// This used to be a non-greedy /<script[^>]*>([\s\S]*?)<\/script>/, which stopped
// at the first close tag anywhere in the block. Every command that GENERATES a
// file containing a script tag — each scaffold that writes a .mesa Resource — had
// its script cut off mid-template-literal, and the remainder was handed to
// transformMarkdown as prose. The result was syntactically broken JavaScript;
// `make:model`, `make:resource` and nine others shipped in that state.
//
// Greedy rather than tag-depth-matched, because the tags are not balanced and
// cannot be: `make/model.md` mentions `<script module>` inside a comment, which no
// counter can tell from a real one. A command has exactly one script block, so
// "first open to last close" is both what a reader sees and what parses.
//
// The open tag must START a line. A command that only MENTIONS a script tag
// mid-sentence — `project/view.md` explains that it "injects a <script> tag" in
// a comment — is talking about one, not opening one. Without the anchor that
// mention matched, and since nothing closed it the no-close fallback below ate
// the rest of the file: `project:view` built its map and exited without ever
// starting the server, silently.
//
// Returns { start, end, inner }, or null when there is no script block.
function matchScriptBlock(body, from = 0) {
  const openRe = /^[ \t]*<script[^>]*>/gm
  openRe.lastIndex = from
  const open = openRe.exec(body)
  if (!open) return null

  const contentStart = open.index + open[0].length
  const closeRe = /<\/script\s*>/g
  closeRe.lastIndex = contentStart

  let last = null
  let m
  while ((m = closeRe.exec(body))) last = m

  // No close tag at all — take everything after the open rather than losing it.
  if (!last) return { start: open.index, end: body.length, inner: body.slice(contentStart) }

  return { start: open.index, end: last.index + last[0].length, inner: body.slice(contentStart, last.index) }
}

function extractScriptBlock(template) {
  const body  = stripFrontmatter(template)
  const block = matchScriptBlock(body)
  return block ? block.inner.trim() : ''
}

// Remove the <script>...</script> block from template so transformMarkdown
// never sees its contents (avoids indented lines leaking into run() body).
//
// Exactly ONE block, the same one extractScriptBlock takes — first open to last
// close. A command has one script block by construction (see matchScriptBlock),
// so any later open tag is a command EMITTING a script tag: a scaffold writing a
// .mesa Resource inside a ```js body. Looping here stripped that emitted tag and
// everything after it, so the command's own code vanished from run().
function stripScriptBlocks(template) {
  const block = matchScriptBlock(template)
  if (!block) return template
  return template.slice(0, block.start) + template.slice(block.end)
}

// ─── transformMarkdown ────────────────────────────────────────────────────────
// Ported verbatim from original mdsvex-loader.js.
// Prose → commented out, ```js → raw JS, ```bash → ZX $`...`

export function transformMarkdown(buf) {
  const output = []
  const tabRe = /^(  +|\t)/
  const codeBlockRe =
    /^(?<fence>(`{3,20}|~{3,20}))(?:(?<js>(js|javascript|ts|typescript))|(?<bash>(sh|shell|bash))|.*)$/
  let state = 'root'
  let codeBlockEnd = ''
  let prevLineIsEmpty = true

  const body = stripFrontmatter(buf)

  for (const line of body.split(/\r?\n/)) {
    switch (state) {
      case 'root': {
        if (tabRe.test(line) && prevLineIsEmpty) {
          output.push(line)
          state = 'tab'
          continue
        }
        const { fence, js, bash } = line.match(codeBlockRe)?.groups || {}
        if (!fence) {
          prevLineIsEmpty = line === ''
          output.push('// ' + line)
          continue
        }
        codeBlockEnd = fence
        if (js)        { state = 'js';    output.push('') }
        else if (bash) { state = 'bash';  output.push('await $`') }
        else           { state = 'other'; output.push('') }
        break
      }
      case 'tab':
        if (line === '')           { output.push('') }
        else if (tabRe.test(line)) { output.push(line) }
        else { output.push('// ' + line); state = 'root' }
        break
      case 'js':
        if (line === codeBlockEnd) { output.push(''); state = 'root' }
        else output.push(line)
        break
      case 'bash':
        if (line === codeBlockEnd) { output.push('`'); state = 'root' }
        else output.push(line)
        break
      case 'other':
        if (line === codeBlockEnd) { output.push(''); state = 'root' }
        else output.push('// ' + line)
        break
    }
  }
  return output.join('\n')
}

// ─── extractSegments ──────────────────────────────────────────────────────────
// Literate-markdown decomposition: split a command body into an ordered list
// of segments the GUI can render top-to-bottom. The runtime ignores this —
// transformMarkdown handles execution. Segments are purely for presentation.
//
// Returns:
//   {
//     script:   string | null         // <script> block contents (module-level)
//     segments: [
//       { type: 'prose', content }
//       { type: 'code',  lang: 'js'|'bash'|'other', content }
//     ]
//   }
//
// Frontmatter is stripped before walking. Empty prose chunks between adjacent
// code blocks are dropped. Script and code content are trimmed of outer
// blank lines; prose preserves internal whitespace.

export function extractSegments(template) {
  const raw = stripFrontmatter(template)

  // Pull script block out first so the segment walker doesn't see it.
  const scriptMatch = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  const script = scriptMatch ? scriptMatch[1].trim() : null
  const body = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')

  const segments = []
  const tabRe = /^(  +|\t)/
  const codeBlockRe =
    /^(?<fence>(`{3,20}|~{3,20}))(?:(?<js>(js|javascript|ts|typescript))|(?<bash>(sh|shell|bash))|(?<other>.*))$/

  let state       = 'root'
  let codeFence   = ''
  let codeLang    = 'other'
  let buffer      = []
  let prevWasEmpty = true

  const flushProse = () => {
    const content = buffer.join('\n').trim()
    if (content) segments.push({ type: 'prose', content })
    buffer = []
  }
  const flushCode = (lang) => {
    // Strip leading/trailing blank lines from code content
    const content = buffer.join('\n').replace(/^\s*\n|\n\s*$/g, '')
    if (content) segments.push({ type: 'code', lang, content })
    buffer = []
  }

  for (const line of body.split(/\r?\n/)) {
    switch (state) {
      case 'root': {
        if (tabRe.test(line) && prevWasEmpty) {
          flushProse()
          buffer.push(line)
          state = 'tabcode'
          continue
        }
        const groups = line.match(codeBlockRe)?.groups
        if (!groups?.fence) {
          prevWasEmpty = line === ''
          buffer.push(line)
          continue
        }
        // Hit a fence — flush prose buffer, start collecting code
        flushProse()
        codeFence = groups.fence
        codeLang  = groups.js ? 'js' : groups.bash ? 'bash' : 'other'
        state = 'code'
        break
      }
      case 'code':
        if (line === codeFence) {
          flushCode(codeLang)
          state = 'root'
          prevWasEmpty = true
        } else {
          buffer.push(line)
        }
        break
      case 'tabcode':
        if (line === '') {
          buffer.push(line)
        } else if (tabRe.test(line)) {
          buffer.push(line)
        } else {
          // Unindented line — close the tab block, restart in root with this line
          // Strip the tab prefix from each accumulated line
          buffer = buffer.map(l => l.replace(tabRe, ''))
          flushCode('other')
          state = 'root'
          prevWasEmpty = false
          buffer.push(line)
        }
        break
    }
  }

  // Flush whatever's left — could be unterminated prose or unterminated code
  if (state === 'root') {
    flushProse()
  } else if (state === 'code') {
    flushCode(codeLang)
  } else if (state === 'tabcode') {
    buffer = buffer.map(l => l.replace(tabRe, ''))
    flushCode('other')
  }

  return { script, segments }
}

