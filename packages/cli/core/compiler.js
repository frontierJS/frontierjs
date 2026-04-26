// Node loader hook: intercepts .md imports and compiles them into ESM modules.
// CLI path uses only string parsing — no Svelte/mdsvex at runtime.
// compileSvelte() is available for the Web GUI layer when needed.

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
    const source = compileCli(template)
    return { format: 'module', source, shortCircuit: true }
  }
  return defaultLoad(url, context)
}

// ─── CLI Compiler ─────────────────────────────────────────────────────────────

export function compileCli(template, moduleScript = '') {
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
}
`.trimStart()
}

// ─── Svelte compiler — Web GUI path only, not used by CLI ─────────────────────

export async function compileSvelte(template) {
  const { compile: mdcompile } = await import('mdsvex')
  const { compile: sveltecompile } = await import('svelte/compiler')
  const { code: svelteCode } = await mdcompile(template, {})
  const result = sveltecompile(svelteCode, {
    name: 'FliCommand',
    modernAst: true,
    generate: 'server'
  })
  return result.js.code
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

export function extractFrontmatter(template) {
  const match = template.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return parseYaml(match[1])
}

function parseYaml(yaml) {
  const lines = yaml.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))

  const indent = (line) => line.match(/^(\s*)/)[1].length

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
        const nextLine = lines[i + 1]
        const nextTrimmed = nextLine?.trim() ?? ''
        const isArray = nextTrimmed === '-' || nextTrimmed.startsWith('- ')
        const child = isArray ? [] : {}
        current[key] = child
        stack.push({ container: child, indentLevel: lvl })
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
  const n = Number(val)
  if (!isNaN(n) && val.trim() !== '') return n
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) return val.slice(1, -1)
  return val
}

// ─── Script block helpers ─────────────────────────────────────────────────────

// Extract content inside the first <script>...</script>
function extractScriptBlock(template) {
  const body = template.replace(/^---[\s\S]*?---\s*/, '')
  const match = body.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  return match ? match[1].trim() : ''
}

// Remove all <script>...</script> blocks from template so transformMarkdown
// never sees their contents (avoids indented lines leaking into run() body)
function stripScriptBlocks(template) {
  return template.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
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

  const body = bufToString(buf).replace(/^---[\s\S]*?---\s*/, '')

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
