/**
 * @frontierjs/mesa-compiler-md — Markdown + frontmatter compiler for Mesa.
 *
 * Compiles a .md file to the same output as compile() from compiler.js.
 * Returns the same ctx shape plus ctx.frontmatter, ctx.layout, ctx.markdownHTML.
 *
 * Pipeline:
 *   1. Parse frontmatter (--- block)
 *   2. Extract <script> block if present
 *   3. Protect Mesa block directives with HTML comment placeholders
 *      (Mesa components pass through naturally via allowDangerousHtml)
 *   4. Run unified / remark-gfm / rehype
 *   5. Restore placeholders
 *   6. Reconstruct as .mesa source and feed to compile()
 */

import { glow }        from '@frontierjs/toolbelt/glow'
import { frontmatterPositions, parseFrontmatter, splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { compile, locFileOf, parseText } from './compiler.js'
import { TARGETS } from './host/targets.js'
import { missingPeer } from './optional-peer.js'

const MD = 'Compiling a .md file'
const MD_PEERS = 'unified remark-parse remark-gfm remark-rehype rehype-slug rehype-stringify'
const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkRehype },
  { default: rehypeSlug }, { default: rehypeStringify }] = await Promise.all([
  import('unified').catch(missingPeer('unified', MD, MD_PEERS)),
  import('remark-parse').catch(missingPeer('remark-parse', MD, MD_PEERS)),
  import('remark-gfm').catch(missingPeer('remark-gfm', MD, MD_PEERS)),
  import('remark-rehype').catch(missingPeer('remark-rehype', MD, MD_PEERS)),
  import('rehype-slug').catch(missingPeer('rehype-slug', MD, MD_PEERS)),
  import('rehype-stringify').catch(missingPeer('rehype-stringify', MD, MD_PEERS)),
])

// ─── Script block ─────────────────────────────────────────────────────────────

// A `.md` body is content. Exactly one <script> may appear in it and it must be
// the first thing after the frontmatter — that one is the component's instance
// script, and nothing else is code.
//
// The match used to be unanchored: the FIRST <script> found anywhere, at any
// depth, in any paragraph, was hoisted into the component factory and deleted
// from the output. A static build then imported that module under Bun with full
// filesystem, network and `process` access, and the page it produced looked
// clean. Any pipeline prerendering authored or imported Markdown — a docs
// directory, a CMS export, a contributed post — executed it.
const LEADING_SCRIPT_RE = /^\s*<script([^>]*)>[\s\S]*?<\/script>/
const ANY_SCRIPT_RE     = /<script([^>]*)>[\s\S]*?<\/script>/gi

// `type` says whether a browser would run the block, but Mesa's compiler parses
// whatever <script> it finds as JavaScript regardless. So a non-JS type is not a
// safe passenger either — `<script type="application/ld+json">` left in the body
// reaches the compiler and dies as a script parse error somewhere further down.
// One rule covers both: a `.md` body carries no <script> but the leading one,
// and that one has to be JavaScript.
const JS_SCRIPT_TYPES = new Set([
  '', 'module', 'text/javascript', 'application/javascript',
  'text/ecmascript', 'application/ecmascript',
])

function scriptTypeOf(attrs) {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '')
  return (m ? (m[1] ?? m[2] ?? m[3]) : '').trim().toLowerCase()
}

function refusal(attrs, why) {
  return `<script${attrs}> in a Markdown body: ${why}. A .md carries one leading ` +
    '<script> block, which is the component\'s script; put anything else in a ' +
    'layout or a .mesa component.'
}

/**
 * Extract the leading <script> block from a Markdown body.
 *
 * Returns { script, body, errors } — `errors` names every <script> refused, and
 * a refused block is removed from the body so it can neither run nor reach the
 * Mesa compiler as a second script.
 */
function extractScript(body) {
  const errors = []
  let script   = ''
  let rest     = body

  const lead = LEADING_SCRIPT_RE.exec(body)
  if (lead) {
    rest = body.slice(lead[0].length)
    if (JS_SCRIPT_TYPES.has(scriptTypeOf(lead[1]))) {
      script = lead[0].trimStart()
    } else {
      errors.push(refusal(lead[1], 'a leading block is compiled as JavaScript, so it may not declare another type'))
    }
  }

  rest = rest.replace(ANY_SCRIPT_RE, (_, attrs) => {
    errors.push(refusal(attrs, 'only the block before any content is the component\'s script'))
    return ''
  })

  return { script, body: rest, errors, bodyStart: lead ? lead[0].length : 0 }
}

/**
 * In the developer's script block, `export const name` and `export let name`
 * without initializers are valid Mesa but invalid JS (acorn rejects const).
 * Add `= undefined` so the Mesa compiler can parse them.
 */
function fixUninitialized(script) {
  return script.replace(
    /\b(export\s+(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*)(\s*[,;\n])/g,
    (m, decl, end) => {
      // Skip if it already has an initializer ( = something )
      if (/=/.test(m)) return m
      return `${decl} = undefined${end}`
    }
  )
}

// ─── Placeholder system ───────────────────────────────────────────────────────

// Block-level Mesa directives get wrapped in <p> by remark.
// Replace them with HTML comments (block-level, preserved by rehype).
// Mesa component tags (<Counter />) pass through with allowDangerousHtml — no protection needed.
// Inline expressions ({title}, {count}, etc.) survive Markdown intact.

const PLACEHOLDER_RE = /<!--MESA:(\d+)-->/g

function protect(src) {
  const map = []
  const store = (s) => {
    const i = map.length
    map.push(s)
    return `<!--MESA:${i}-->`
  }

  // Block-level directives: lines whose trimmed content is ONLY a Mesa directive.
  // These are: {#if ...}, {:else}, {:else if ...}, {/if},
  //            {#each ...}, {/each}, {#await ...}, {:then ...}, {:catch ...}, {/await},
  //            {#snippet ...}, {/snippet}, {@html ...}
  // Match the whole line including leading/trailing whitespace.
  src = src.replace(
    /^[ \t]*(\{[#/:@][^{}]*\})[ \t]*$/gm,
    (_, directive) => store(directive)
  )

  return { protected: src, map }
}

function restore(src, map) {
  return src.replace(PLACEHOLDER_RE, (_, idx) => map[Number(idx)] ?? '')
}

// ─── Markdown processor ───────────────────────────────────────────────────────

// Default (no user plugins) — singleton for performance
const _defaultProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(slugHeadings)
  .use(rehypeStringify, { allowDangerousHtml: true })

// rehypeSlug slugs the Markdown text, and Mesa fills `{path}` in later, so an
// interpolated heading was served with its variable name as the id
// (`see-how-company_name-can-help-you`) over words the reader sees differently
// (FJS-1500). Such a heading has no static slug and gets no id. rehypeSlug skips
// a heading that has one, so the held heading is given a placeholder for its
// run, which also keeps it from taking a slug a later duplicate would then miss.
// An escaped brace is a sentinel here, whose name would otherwise be slugged.
const HELD_ID = 'mesa-held-heading'
const HEADING = /^h[1-6]$/

function slugHeadings() {
  const slug = rehypeSlug()
  return (tree) => {
    const held = []
    const swapped = []
    const walk = (node, inCode, heading) => {
      if (node.type === 'text' && heading) {
        if (!inCode && parseText(node.value, { pathOnly: true }).parts.some((p) => p.type === 'exp')) held.push(heading)
        if (node.value.includes(BRACE_ESCAPE)) {
          swapped.push([node, node.value])
          node.value = node.value.split(BRACE_ESCAPE).join('{')
        }
      }
      const isHeading = node.type === 'element' && HEADING.test(node.tagName)
      for (const child of node.children ?? []) {
        walk(child, inCode || node.tagName === 'code', isHeading ? node : heading)
      }
    }
    walk(tree, false, null)
    for (const h of held) h.properties.id = HELD_ID
    slug(tree)
    for (const h of held) delete h.properties.id
    for (const [node, value] of swapped) node.value = value
  }
}

/**
 * Build a processor with user-supplied remark/rehype plugins inserted
 * after the built-in plugins. User remark plugins run after remarkGfm;
 * user rehype plugins run after slugHeadings.
 *
 * Each entry in remarkPlugins/rehypePlugins is either:
 *   - a function (the plugin itself)
 *   - [plugin, options]  (plugin with options)
 */
function buildProcessor(remarkPlugins = [], rehypePlugins = [], fileLine = null) {
  let p = unified()
    .use(remarkParse)
    .use(remarkGfm)

  for (const entry of remarkPlugins) {
    const [plugin, opts] = Array.isArray(entry) ? entry : [entry]
    p = opts !== undefined ? p.use(plugin, opts) : p.use(plugin)
  }

  p = p.use(remarkRehype, { allowDangerousHtml: true })
       .use(slugHeadings)

  for (const entry of rehypePlugins) {
    const [plugin, opts] = Array.isArray(entry) ? entry : [entry]
    p = opts !== undefined ? p.use(plugin, opts) : p.use(plugin)
  }

  // Last, so it stamps what the user's plugins left standing.
  if (fileLine) p = p.use(() => (tree) => stampLoc(tree, fileLine))

  return p.use(rehypeStringify, { allowDangerousHtml: true })
}

// Mesa's own `data-fjs-loc` names a line of the TEMPLATE the Markdown compiles
// to, which is not a line of the file, so alt-click on prose opened the wrong
// one (FJS-1711). The line of the file is only known here, from the hast
// positions; the compiler makes the `line:column` file-relative.
function stampLoc(node, fileLine) {
  if (node.type === 'element' && node.position) {
    const { line, column } = node.position.start
    node.properties = { ...node.properties, [LOC_ATTR_PROP]: `${fileLine(line)}:${column}` }
  } else if (node.type === 'raw' && node.position) {
    node.value = stampRawTags(node.value, node.position.start, fileLine)
  }
  for (const child of node.children ?? []) stampLoc(child, fileLine)
}

// Raw HTML in prose reaches the Mesa compiler as text, so its tags get the
// template's line unless they say otherwise. Each lowercase opening tag is
// stamped with its own place in the raw text; a component tag makes no element
// to stamp, and a `>` inside a quoted value or a `{}` expression does not end
// a tag.
function stampRawTags(value, start, fileLine) {
  let out = ''
  let i = 0
  while (i < value.length) {
    if (value.startsWith('<!--', i)) {
      const end = value.indexOf('-->', i)
      const to = end < 0 ? value.length : end + 3
      out += value.slice(i, to)
      i = to
      continue
    }
    if (value[i] !== '<' || !/[a-z]/.test(value[i + 1] ?? '')) {
      out += value[i++]
      continue
    }
    const name = /^<[a-z][\w:-]*/.exec(value.slice(i))[0]
    let j = i + name.length
    let quote = null
    let depth = 0
    for (; j < value.length; j++) {
      const c = value[j]
      if (quote) { if (c === quote) quote = null }
      else if (c === '"' || c === "'") quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth <= 0) break
    }
    const tag = value.slice(i, j)
    if (/\sdata-fjs-loc[=\s>/]/.test(tag + '>')) {
      out += name + value.slice(i + name.length, j)
    } else {
      const before = value.slice(0, i)
      const nl = before.lastIndexOf('\n')
      const line = fileLine(start.line + (before.split('\n').length - 1))
      const column = nl < 0 ? start.column + i : i - nl
      out += `${name} ${LOC_ATTR_PROP_NAME}="${line}:${column}"${value.slice(i + name.length, j)}`
    }
    i = j
  }
  return out
}
const LOC_ATTR_PROP_NAME = 'data-fjs-loc'
const LOC_ATTR_PROP = 'dataFjsLoc'

async function markdownToHTML(src, { remarkPlugins, rehypePlugins, path, fileLine = null } = {}) {
  const hasPlugins = (remarkPlugins?.length ?? 0) + (rehypePlugins?.length ?? 0) > 0
  const processor = hasPlugins || fileLine
    ? buildProcessor(remarkPlugins, rehypePlugins, fileLine)
    : _defaultProcessor
  // A bare string leaves `file.path` undefined, and a plugin cannot key on the
  // file it is compiling.
  return String(await processor.process(path ? { value: src, path } : src))
}

// ─── Frontmatter → export declarations ───────────────────────────────────────

/**
 * Generate export declarations for frontmatter keys not already declared
 * in the developer's script block.
 * Inlines the actual frontmatter value as the default so the component works
 * standalone (REPL, direct render) without a parent passing props.
 * Declared as const because frontmatter values are immutable.
 */
function frontmatterToExports(fm, innerScript) {
  const declared = new Set()
  const re = /\bexport\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
  let m
  while ((m = re.exec(innerScript)) !== null) declared.add(m[1])

  return Object.keys(fm)
    .filter((k) => !declared.has(k))
    .map((k) => `  export const ${k} = ${JSON.stringify(fm[k])}`)
    .join('\n')
}

// `[path, 'content/x.md:7:9']` for each text, number or yes/no the
// frontmatter holds, through `locLines` when the caller rewrote the file first.
function writtenAt(source, config) {
  const file = locFileOf(config)
  if (!file) return []
  return frontmatterPositions(source).map(({ path, line, column }) =>
    [path, `${file}:${config.locLines?.[line - 1] ?? line}:${column}`])
}

// ─── Fenced-code decoding ─────────────────────────────────────────────────────

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g

/**
 * HTML-decode a fence body on its way to glow(), which re-encodes what it emits.
 *
 * ONE pass, never a chain of replaces: rehype writes `<` as `&#x3C;` and `&` as
 * `&#x26;`, so decoding the numeric forms first and the named ones second turns
 * a source line that literally reads `&lt;` (`&#x26;lt;` on the wire) into a
 * `<`, and the reader is shown something nobody wrote. A single pass cannot
 * decode its own output.
 */
function decodeEntities(str) {
  return str.replace(ENTITY, (whole, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    return name in NAMED ? NAMED[name] : whole
  })
}

// Carries `\{` across the Markdown step, which would otherwise strip the
// backslash as a CommonMark escape and hand Mesa a live `{…}`. A private-use
// codepoint, so no author text can collide with it.
const BRACE_ESCAPE = '\uE0F1MESA_LBRACE\uE0F1'

// ─── Layout ───────────────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Wrap a Markdown body in the component its `layout:` names — mdsvex's
 * `layout`, which is how a Markdown block says what it is a block OF.
 *
 * Mesa owns the wrap and the caller owns the NAME: `layouts` maps a name to a
 * file, because where layouts live and which directory wins is a question for
 * the framework compiling the app (Sierra's `markdownLayouts`). Without a map,
 * `layout:` is metadata and nothing is wrapped — as before.
 *
 * The layout is handed every frontmatter key as a prop (the file's own values,
 * or whatever the parent passed over them), the parent's `class` and undeclared
 * attributes, and the body both ways a layout can read one: element children
 * for `<slot />`, the `children` prop for `{@render children?.()}`. Nothing
 * says which protocol a layout speaks, so it gets both (STATIC_RENDERING.md);
 * a `children`-prop layout is warned once that the element children went
 * unrendered, which is the runtime's own check and true.
 *
 * @returns {{ layoutImport: string, body: string, layoutError: string|null }}
 */
function wrapInLayout(html, frontmatter, layouts) {
  const name = frontmatter.layout
  if (!layouts || typeof name !== 'string' || name === '') {
    return { layoutImport: '', body: html, layoutError: null }
  }

  const file = Object.hasOwn(layouts, name) ? layouts[name] : null
  if (!file) {
    const known = Object.keys(layouts).sort()
    return {
      layoutImport: '',
      body: html,
      layoutError: `layout: ${name} names no layout. ` +
        (known.length ? `Known: ${known.join(', ')}.` : 'No layout directory holds any file.') +
        ' Write `layout: false` for a file that has none.',
    }
  }

  const props = Object.keys(frontmatter)
    .filter((k) => k !== 'layout' && IDENTIFIER.test(k))
    .map((k) => `${k}={${k}}`)
    .join(' ')

  return {
    layoutImport: `  import MarkdownLayout from ${JSON.stringify(file)}`,
    body: [
      '{#snippet markdownBody()}',
      html,
      '{/snippet}',
      `<MarkdownLayout ${props} {class} {...$attributes} children={markdownBody}>{@render markdownBody()}</MarkdownLayout>`,
    ].join('\n'),
    layoutError: null,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Compile a .md file to the same output format as compile().
 *
 * @param {string} source   — raw .md file contents
 * @param {object} [config] — same options as compile(), plus:
 *   config.layouts {Record<string,string>} — layout name → file. With it, a
 *     `layout:` in the frontmatter wraps the body in that component, and a name
 *     it does not hold is a compile error. Without it, `layout:` wraps nothing.
 *   config.remarkPlugins / config.rehypePlugins — unified plugins; each sees
 *     `file.path` as `config.filename` (or `config.path`).
 * @returns {Promise<object>} ctx — same as compile(), plus:
 *   ctx.frontmatter  {object}       — parsed frontmatter values
 *   ctx.layout       {string|null}  — frontmatter.layout value
 *   ctx.markdownHTML {string}       — raw HTML from the Markdown step
 */
export async function compileMd(source, config = {}) {
  // 1. Frontmatter — toolbelt's reading, which is sierra's too, so the route's
  //    `page.meta` and this module's `frontmatter` are one object (FJS-1541).
  //    A refused block compiles as `{}` and says so, as sierra does (FJS-509).
  let frontmatter, afterFm, frontmatterError = null
  try {
    ({ frontmatter, body: afterFm } = parseFrontmatter(source))
  } catch (err) {
    frontmatter = {}
    afterFm = splitFrontmatter(source).body
    frontmatterError = `frontmatter ${err.message}`
  }

  // 2. Script block
  const { script: scriptBlock, body: mdBody, errors: scriptErrors, bodyStart } = extractScript(afterFm)

  // A hast position as a line of the file: past the lines ahead of the
  // Markdown body, then back through `locLines` when the caller rewrote the
  // file first. Sierra synthesizes a four-line script block for an
  // auto-import, and without the map every prose stamp below it named a line
  // four past its own. Null when `loc` is off: the stamp is dev-only, and a
  // custom processor is not worth building for nothing.
  const locOn = config.loc ?? !!config.dev
  const fmEnd = source.endsWith(afterFm) ? source.length - afterFm.length : Math.max(0, source.indexOf(afterFm))
  const lineBase = source.slice(0, fmEnd + bodyStart).split('\n').length - 1
  const fileLine = locOn ? (line) => config.locLines?.[line + lineBase - 1] ?? line + lineBase : null
  const innerScript = scriptBlock
    ? fixUninitialized(
        scriptBlock
          .replace(/^<script[^>]*>\s*/m, '')
          .replace(/\s*<\/script>$/m, '')
      )
    : ''

  // 3. Protect block-level Mesa directives
  //     `\{` is the escape for a literal brace (FJS-D213), and CommonMark eats
  //     the backslash itself — `\{title}` reaches Mesa as `{title}` and
  //     interpolates. Carried across the Markdown step as a sentinel instead.
  const { protected: protectedMd, map } = protect(mdBody.replace(/\\\{/g, BRACE_ESCAPE))

  // 4. Markdown → HTML
  const rawHTML = await markdownToHTML(protectedMd, {
    remarkPlugins: config.remarkPlugins,
    rehypePlugins: config.rehypePlugins,
    path: config.filename ?? config.path,
    fileLine,
  })

  // 5. Restore
  const html = restore(rawHTML, map)

  // 5b. Syntax-highlight fenced code blocks that have a language tag,
  //     then escape { } inside all remaining <code> content so Mesa
  //     doesn't treat inline code as reactive expressions.
  const safeHtml = html
    // Fenced code blocks with a language: run glow(), wrap in <pre>
    .replace(/<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, encoded) => {
        // rehype already HTML-encoded the content — decode before passing to glow
        // Restored BEFORE glow: the sentinel is plain text, and glow tokenizes
        // it apart, so restoring afterwards finds nothing to replace and the
        // sentinel is served to the reader.
        const code = decodeEntities(encoded).split(BRACE_ESCAPE).join('\\{')
        // Strip the class suffix rehype adds (e.g. "js mn3k01re1" → "js")
        const language = lang.split(' ')[0]
        const highlighted = glow(code.trimEnd(), { language, prefix: false, mark: false })
        return `<pre>${highlighted}</pre>`
      }
    )
    // Fenced code blocks without a language: just escape {}
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, content) =>
      '<pre><code>' + content.split(BRACE_ESCAPE).join('\\{').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;') + '</code></pre>'
    )
    // Inline code: escape {}
    .replace(/<code([^>]*)>([\s\S]*?)<\/code>/g, (_, attrs, content) =>
      `<code${attrs}>${content.split(BRACE_ESCAPE).join('\\{').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')}</code>`
    )
    // Outside code, the escaped brace becomes a character reference — the one
    // spelling of `{` that reaches the DOM as text and never opens a `{…}`.
    .split(BRACE_ESCAPE).join('&#123;')

  // 5c. The component `layout:` names wraps the body (FJS-1493).
  const { layoutImport, body, layoutError } = wrapInLayout(safeHtml.trim(), frontmatter, config.layouts)

  // 6. Build merged <script> block
  const fmExports = frontmatterToExports(frontmatter, innerScript)
  const mergedScript = [layoutImport, fmExports, innerScript].filter(Boolean).join('\n\n').trim()

  // The frontmatter again, at MODULE scope. The exports above are props, which
  // only an instance can read, so a page listing a directory of `.md` files — a
  // collection — could render each body and read none of its fields: no
  // reviewer, no rating, nothing to sort by. mdsvex's `metadata`. A `.md` file
  // has no `<script module>` of its own (a second script is refused), so this
  // one cannot collide.
  //
  // A stamping build records where each value was written, so an element a
  // block draws from one (`{item.name}`) names that line and not the block's
  // (`FJS-D1231`). A host target's runtime has no stamps to give it; the
  // server's string mode writes them as the DOM path does.
  const stamps = !TARGETS[config.target] || TARGETS[config.target].mode === 'string'
  const written = locOn && stamps && !frontmatterError ? writtenAt(source, config) : []
  const moduleScript = written.length
    ? `<script module>\n  import { recorded as __mesaRecorded } from '@frontierjs/mesa/runtime'\n` +
      `  export const frontmatter = __mesaRecorded(${JSON.stringify(frontmatter)}, ${JSON.stringify(written)})\n</script>`
    : `<script module>\n  export const frontmatter = ${JSON.stringify(frontmatter)}\n</script>`

  const mesaSource = [
    moduleScript,
    mergedScript ? `<script>\n${mergedScript}\n</script>` : '',
    body
  ]
    .filter(Boolean)
    .join('\n\n')

  // 7. Compile as Mesa. In prose `{…}` is a bare path and nothing else
  //     (FJS-D213); `.mesa` is unchanged. `locLines` maps the file handed
  //     over, and this template is not that file.
  const ctx = await compile(mesaSource, { ...config, locLines: null, pathInterpolation: true })

  // 8. Attach metadata
  ctx.frontmatter  = frontmatter
  ctx.layout       = frontmatter.layout ?? null
  ctx.markdownHTML = safeHtml

  if (frontmatterError) scriptErrors.unshift(frontmatterError)
  if (layoutError) scriptErrors.push(layoutError)
  if (scriptErrors.length) {
    ctx.analysis ??= {}
    ctx.analysis.errors ??= []
    ctx.analysis.errors.push(...scriptErrors)
    // Reported here as well as collected: compile() drains the error list to
    // `warning` as its last act, and these are pushed after it has returned, so
    // a caller watching only that channel would be told nothing.
    scriptErrors.forEach((e) => ctx.warning?.({ message: e }))
  }

  return ctx
}
