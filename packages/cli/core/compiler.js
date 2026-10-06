// Node loader hook: intercepts .md imports and compiles them into ESM modules.
// String parsing only — no template compiler at runtime, in either the CLI or
// the Web GUI. A command file is markdown with a <script> block and ```js
// bodies, and that is all this reads.
//
// NOTE: a command's <script> block runs from its open tag to the LAST closing tag
// in the file, so a command may freely EMIT script tags — every scaffold that
// writes a .mesa Resource does. It follows that a command has exactly one script
// block; a second one would be swallowed into the first.

import { parseFrontmatter } from '@frontierjs/toolbelt/frontmatter'

// What a writer puts after `key: ` — here so a command reaches it through
// `global.fliRoot` the way it reaches every other core module.
export { frontmatterValue } from '@frontierjs/toolbelt/frontmatter'

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

/**
 * A command's `.md` → an ESM module, plus the one number that maps a stack
 * frame in it back to the `.md`.
 *
 * `sourceLineOffset` is `genLine - mdLine`, and it is a single integer because
 * both transforms below preserve lines: `transformMarkdown` turns prose into
 * `//` comments rather than dropping it, and `stripScriptBlocks` leaves the
 * block's own height behind in blank lines. So a frame at generated line 15 is
 * `.md` line `15 - offset`, wherever in the file it is.
 *
 * There is NO `sourceURL` pragma any more. It relabelled the path in a frame
 * and nothing else — the line stayed the generated file's — so Node reported
 * `boom.md:15` for a throw on line 9 of an 11-line file: a location that reads
 * as authoritative and does not exist. Bun ignored the pragma, and ignores an
 * inline source map and a linked `.map` alike, so nothing in either runtime was
 * going to answer this. `core/stack.js` rewrites the frames instead, off this
 * offset, and gets both runtimes right (`FJS-066`).
 */
// ─── what a compiled command can see ─────────────────────────────────────────
// Three names and no more: `$` is the command in progress, handed to run() —
// the context, callable as the shell tag — and `path` and `fs` are the two
// builtins so many bodies reach for that importing them per file would be the
// first two lines of every command. Everything else a body uses is destructured
// from `$` in the head or imported in its own <script>. The free-identifier
// check (`core/scope.js`) reads this list; a fourth name goes here and nowhere
// else. A <script> importing `path` or `fs` itself declares the name twice,
// which is a SyntaxError the parse sweep reports.
export const SHIM_GLOBALS = ['$', 'path', 'fs']
export const SHIM_IMPORTS = "import path from 'node:path'\nimport fs from 'node:fs'"

export function compileCliWithMap(template, moduleScript = '', sourcePath = '') {
  const { meta: frontmatter, bodyLine } = splitFrontmatter(template)
  const own         = scriptBlockOf(template)
  const ownScript   = own?.script ?? ''
  // Module script is prepended so namespace helpers are available everywhere
  const scriptBlock = moduleScript
    ? moduleScript + '\n\n' + ownScript
    : ownScript

  // The block's contents move to the head, so what is left in place must not
  // reach transformMarkdown as prose.
  const scriptStripped = stripScriptBlocks(template)
  const mainBody       = transformMarkdown(scriptStripped)

  // Split at the body rather than interpolating in one literal, so the line the
  // body lands on is COUNTED rather than kept in step by hand. The body is not
  // indented into `run()` either: two leading spaces on its first line only
  // would put every column in a frame from that line two out.
  const head = `${SHIM_IMPORTS}
${scriptBlock}

export const metadata = ${JSON.stringify(frontmatter)}

export async function run($) {
  const { flags, args, flag, arg, log, tty, echo, chalk, answers = {} } = $
`

  const tail = `
  return $
}`

  // head's newline count is the generated line the body's first line sits on,
  // minus one; bodyLine is the .md line it came from.
  const sourceLineOffset = countLines(head) + 1 - bodyLine

  // The head is the one part the offset does not cover: a <script> block is
  // lifted out of its place and the namespace module's is pasted above it.
  const moduleFrom = countLines(SHIM_IMPORTS) + 2
  const moduleTo   = moduleScript ? moduleFrom + countLines(moduleScript) : moduleFrom - 1
  const ownFrom    = moduleScript ? moduleTo + 2 : moduleFrom
  const ownTo      = ownFrom + countLines(ownScript)
  const bodyFrom   = countLines(head) + 1
  const lastMdLine = countLines(template) + 1

  /**
   * Where generated line `n` was written. `module` lines count from the first
   * line of the namespace module's script, which this function never saw the
   * file of; `script` and `body` are lines of this `.md`. `null` is a line
   * the compiler wrote.
   */
  const locate = (n) => {
    if (moduleScript && n >= moduleFrom && n <= moduleTo) return { in: 'module', line: n - moduleFrom + 1 }
    if (own && ownScript && n >= ownFrom && n <= ownTo)   return { in: 'script', line: own.line + n - ownFrom }
    if (n >= bodyFrom) return { in: 'body', line: Math.min(n - sourceLineOffset, lastMdLine) }
    return null
  }

  return { code: head + mainBody + tail, sourcePath, sourceLineOffset, locate }
}

/** The module alone. Every caller that does not need the map. */
export function compileCli(template, moduleScript = '', sourcePath = '') {
  return compileCliWithMap(template, moduleScript, sourcePath).code
}

// ─── Frontmatter ───────────────────────────────────────────────────────────────

// What a block MEANS is `@frontierjs/toolbelt/frontmatter`'s — the reader sierra
// and mesa use (`FJS-D549`). fli kept one of its own that read `- a: b` as a
// one-key map, cut nothing at ` #` and took `"x" y` for a quoted string, so the
// same `.md` meant two things depending on which tool opened it. A block outside
// the subset is refused, naming the line in the FILE.

/**
 * `{ meta, body, bodyLine }` from one split, so nothing can disagree about it.
 * `bodyLine` is the 1-based line of the ORIGINAL that `body` starts at, which
 * is half of what maps a stack frame back to the `.md` — see
 * `compileCliWithMap`. Blank lines after the closing fence go with it: the
 * markdown walkers were written against a body that starts at content.
 *
 * @param {string} [file] named in a refusal, which otherwise says only the line
 * @throws {Error} on a block the kit refuses; `.line` is the file's line
 */
export function splitFrontmatter(template, file) {
  const text = bufToString(template)
  let parsed
  try { parsed = parseFrontmatter(text) } catch (err) {
    if (file && typeof err.line === 'number') err.message = `${file}: frontmatter ${err.message}`
    throw err
  }
  const { frontmatter, body: rest } = parsed
  if (rest.length === text.length) return { meta: frontmatter, body: text, bodyLine: 1 }
  const body = rest.replace(/^(?:[ \t]*\r?\n)+/, '')
  return {
    meta:     frontmatter,
    body,
    bodyLine: countLines(text.slice(0, text.length - body.length)) + 1,
  }
}

/** Newlines in `s`. The line a following character sits on, minus one. */
const countLines = (s) => {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** The body with its frontmatter removed. The one owner — do not re-derive it. */
export function stripFrontmatter(template, file) {
  return splitFrontmatter(template, file).body
}

export function extractFrontmatter(template, file) {
  return splitFrontmatter(template, file).meta
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
// the rest of the file: the served project map built its model and exited without ever
// starting the server, silently.
//
// Returns { start, contentStart, end, inner }, or null when there is no script block.
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
  if (!last) return { start: open.index, contentStart, end: body.length, inner: body.slice(contentStart) }

  return { start: open.index, contentStart, end: last.index + last[0].length, inner: body.slice(contentStart, last.index) }
}

/**
 * The `<script>` block's contents, trimmed, and the 1-based line of `text` its
 * first line is on — or null. The one reader of a script block for a command
 * AND a `_module.md`: the module's used to be a non-greedy match of its own,
 * so a helper that wrote a closing script tag lost everything after it.
 */
export function scriptBlockOf(text) {
  text = bufToString(text)
  const block = matchScriptBlock(text)
  if (!block) return null
  const lead = block.inner.length - block.inner.trimStart().length
  return {
    script: block.inner.trim(),
    line:   countLines(text.slice(0, block.contentStart + lead)) + 1,
  }
}

// Remove the <script>...</script> block from template so transformMarkdown
// never sees its contents.
//
// Exactly ONE block, the same one scriptBlockOf takes — first open to last
// close. A command has one script block by construction (see matchScriptBlock),
// so any later open tag is a command EMITTING a script tag: a scaffold writing a
// .mesa Resource inside a ```js body. Looping here stripped that emitted tag and
// everything after it, so the command's own code vanished from run().
// The block is REPLACED by its own height in blank lines rather than spliced
// out. Its contents move to the top of the generated file, so cutting the lines
// would shift everything below it and the one offset that maps a frame back to
// the `.md` would stop being one — a command with a script block in the middle
// needed two. Blank lines between statements cost nothing.
export function stripScriptBlocks(template) {
  const block = matchScriptBlock(template)
  if (!block) return template
  const cut = template.slice(block.start, block.end)
  return template.slice(0, block.start) + '\n'.repeat(countLines(cut)) + template.slice(block.end)
}

// ─── transformMarkdown ────────────────────────────────────────────────────────
// Prose → commented out, ```js → raw JS, ```bash → ZX $`...`, any other fence →
// commented out. A fence is the only thing that runs: markdown's indented code
// block is prose here, because an example indented in a paragraph — what a
// status line looks like — is how a reader writes, and it compiled as code.

export function transformMarkdown(buf) {
  const output = []
  const codeBlockRe =
    /^(?<fence>(`{3,20}|~{3,20}))(?:(?<js>(js|javascript|ts|typescript))|(?<bash>(sh|shell|bash))|.*)$/
  let state = 'root'
  let codeBlockEnd = ''

  const body = stripFrontmatter(buf)

  for (const line of body.split(/\r?\n/)) {
    switch (state) {
      case 'root': {
        const { fence, js, bash } = line.match(codeBlockRe)?.groups || {}
        if (!fence) {
          output.push('// ' + line)
          continue
        }
        codeBlockEnd = fence
        if (js)        { state = 'js';    output.push('') }
        else if (bash) { state = 'bash';  output.push('await $`') }
        else           { state = 'other'; output.push('') }
        break
      }
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

  // The same block the compiler lifts, so the GUI shows what runs.
  const script = scriptBlockOf(raw)?.script ?? null
  const body   = stripScriptBlocks(raw)

  const segments = []
  const codeBlockRe =
    /^(?<fence>(`{3,20}|~{3,20}))(?:(?<js>(js|javascript|ts|typescript))|(?<bash>(sh|shell|bash))|(?<other>.*))$/

  let state       = 'root'
  let codeFence   = ''
  let codeLang    = 'other'
  let buffer      = []

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
        const groups = line.match(codeBlockRe)?.groups
        if (!groups?.fence) {
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
        } else {
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
  }

  return { script, segments }
}

