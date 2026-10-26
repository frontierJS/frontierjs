// ─── checks/lib.js — the readers more than one slice shares ────────────────────
//
// How a rule reads an app: the surface list, the source files of a surface with
// comments blanked to spaces (so an offset found here names the same bytes on
// disk), the schema and its models, the tree walk. A reader one slice alone
// uses stays in that slice; a second slice reaching for it moves it here. Plain
// ESM on node, `@frontierjs/toolbelt` and this package only.

import { existsSync, statSync, readFileSync, readdirSync } from 'fs'
import { join, relative, extname, basename }               from 'path'
import { singularize, camel }                              from '@frontierjs/toolbelt/inflect'
import { appSchemaModels, appSchemaViews }                 from '../app-schema.js'

export const SCRIPT_EXT = new Set(['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts'])

// Every surface directory an app may carry beside db/ (Invariant 3). The client
// surfaces are the ones whose source runs in a browser, a webview or an
// extension. One list, because a surface missing from one rule's copy is source
// that rule never reads, and nothing says so.
export const CLIENT_SURFACES = ['web', 'widgets', 'site', 'extension', 'desktop', 'mobile']

export const SURFACES        = ['api', ...CLIENT_SURFACES]

/**
 * Whether `root` is an app, for the rules that read SURFACES. A schema is one
 * sign, and a web-only, widgets-only or site-only project has none — a manifest
 * (`package.json` or `.fli.json`) with a surface beside it is the other. The
 * manifest alone is not enough: any package has one, and a rule that scolds
 * every library is a rule people turn off. The rules that read the schema keep
 * their own `db/schema.lite` gate.
 */
export function isAppRoot(root) {
  if (existsSync(join(root, 'db', 'schema.lite'))) return true
  const manifest = ['package.json', '.fli.json'].some(f => existsSync(join(root, f)))
  return manifest && SURFACES.some(d => existsSync(join(root, d)))
}

export const rel = (root, p) => relative(root, p).split('\\').join('/')

export const stem = p => p.replace(/\.(d\.)?(ts|js|mjs|mts|cjs|cts|mesa)$/, '')

/** Every file of the given extensions under the named directories, in tree order. */
export function sources(root, exts, ...dirs) {
  const want = exts instanceof Set ? exts : new Set(exts)
  const out  = []
  for (const dir of dirs) {
    walk(join(root, dir), 6, here => {
      for (const name of safeRead(here)) {
        if (!want.has(extname(name))) continue
        const full = join(here, name)
        try { if (statSync(full).isFile()) out.push(full) } catch { /* dangling link */ }
      }
    })
  }
  return out
}

/** Every script under the named directories of an app. */
export function scripts(root, ...dirs) { return sources(root, SCRIPT_EXT, ...dirs) }

/**
 * The text from an opening paren to the one that closes it.
 *
 * Rules that ask *what is inside this call* need the whole call rather than the
 * line it started on: an options object, a scheduler's callback and a
 * createResource's `model:` are all routinely three lines below the name. An
 * unbalanced call answers what is left of the file rather than nothing, which
 * over-reports rather than under-reports — the safer direction for a rule whose
 * other answer is silence.
 */
export function spanFrom(text, open) {
  const close = closingParen(text, open)
  return close === -1 ? '' : text.slice(open + 1, close)
}

/** The index of the `)` closing the `(` at `open`, or -1 — including unbalanced. */
export function closingParen(text, open) {
  if (text[open] !== '(') return -1
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * A file's source with its comments blanked — spaces, not deletions, so every
 * offset and line number stays where it was.
 *
 * Blanked rather than kept because most of what these rules look for is
 * DESCRIBED in a comment somewhere in this repo's own apps, in exactly the
 * words the rule matches. A check that fires on the paragraph explaining the
 * hazard is one people turn off.
 *
 * **Quote-aware, and that is not fussiness.** A regex sweep blanks from the
 * `//` in `'http://localhost:8010'` to the end of the line, so a `callHeaders:`
 * sitting after a CORS origin on one line disappears — and the rule that reads
 * it then reports a correctly-declared header as undeclared. Blanking too much
 * is how a source rule cries wolf, which costs more than the rule is worth.
 *
 * A scanner rather than a parser: it knows strings, template literals and the
 * two comment forms, and nothing else. Regex literals are not tracked — a `//`
 * cannot appear inside one (that is an empty regex, which no engine accepts) —
 * and an escaped quote is honored, which is the only escape that matters here.
 */
export function readCode(path, { strings = false } = {}) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return '' }

  const out = [...text]
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (c === '"' || c === "'" || c === '`') {
      const from = ++i
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === c) { i++; break }
        i++
      }
      if (strings) blank(from, i - 1)
      continue
    }

    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      blank(i, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const to  = end === -1 ? text.length : end + 2
      blank(i, to)
      i = to
      continue
    }

    i++
  }
  return out.join('')
}

/**
 * Source with its comments blanked, for a rule that matches on CODE.
 *
 * A rule reading a file with a regex reads the prose too, and a file that
 * explains its own convention quotes the thing being explained — which is how
 * `resource-file-name` came to report a resource as naming the model its doc
 * comment mentioned. Blanked rather than deleted so nothing else shifts: the
 * only rules here that care about a comment's CONTENT ask for the raw text.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export function schemaFile(root) {
  const path = join(root, 'db', 'schema.lite')
  return existsSync(path) ? { path, text: readFileSync(path, 'utf8') } : null
}

// A line scan, not the parser. `fli check` must answer without a database, a
// migration or an installed litestone, and a rule about a NAME does not need the
// AST. `@@external` is exempt from invariant 2, so it is skipped here too.
export function models({ text }) {
  const out   = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (!m) continue
    if (bodyOf(lines, i).includes('@@external')) continue
    out.push({ name: m[1], line: i + 1 })
  }
  return out
}

/** The text from a model's opening line to its closing brace. */
export function bodyOf(lines, start) {
  const out = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += (lines[i].match(/{/g) ?? []).length
    depth -= (lines[i].match(/}/g) ?? []).length
    if (i > start && depth <= 0) break
  }
  return out.join('\n')
}

/**
 * Every `target: 'static'` surface in an app — its config, its routes directory.
 *
 * The surface is the config's grandparent (Invariant 3 puts configuration in
 * `config/`), falling back to its parent for an app that keeps it at the
 * surface root — which `surface-config` reports separately rather than this
 * rule failing to see the surface at all.
 */
export function staticSurfaces(root) {
  const out = []
  walk(root, 4, dir => {
    for (const name of safeRead(dir)) {
      if (!/^sierra.*\.config\.[cm]?[jt]s$/.test(name)) continue
      const path   = join(dir, name)
      const config = readCode(path)
      if (!/target\s*:\s*['"`]static['"`]/.test(config)) continue

      const surface   = basename(dir) === 'config' ? join(dir, '..') : dir
      const routesDir = config.match(/routesDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? 'src/routes'
      out.push({ path, config, surface, routes: join(surface, routesDir) })
    }
  })
  return out
}

// ─── the schema, as far as three rules need it ────────────────────────────────

/**
 * The one answer to *does this name reach a model*, shared by `service-model`
 * and `resource-model-miss` — the same question asked from the API realm and
 * from the UI realm, and two answers to it is how one of them starts grading an
 * app by a rule the app does not run.
 *
 * `db.<accessor>` is the model name with a lower first letter, so the singular
 * has to arrive in that spelling: `productVariants` reaches `ProductVariant`
 * and `product-variants` never can, which is exactly the case that has to be
 * stated rather than derived.
 */
export function modelResolver(schema, root) {
  // The app's WHOLE seed, not db/schema.lite — `core/app-schema.js` says why,
  // and is the one owner both this and `fli admin:generate` read. `@@external`
  // is exempt from invariant 2, so it is dropped here as `models()` drops it.
  const known = new Map(
    (root ? appSchemaModels(root) : models(schema))
      .filter(m => !m.external)
      .map(m => [m.name.toLowerCase(), m.name]))

  // A `view` is a legal `model:` for a read-only service and resolves the same
  // way — its `@@gate` grades the caller at the Data boundary exactly as a
  // model's does (`FJS-970`). Added to the same map rather than checked beside
  // it, so every message this rule writes keeps naming one thing.
  if (root) for (const v of appSchemaViews(root)) {
    if (!known.has(v.name.toLowerCase())) known.set(v.name.toLowerCase(), v.name)
  }

  const resolves = (name) => {
    const clean = name.replace(/Service$/i, '')
    for (const candidate of [clean, singularize(clean.charAt(0).toLowerCase() + clean.slice(1))]) {
      const hit = known.get(candidate.toLowerCase())
      if (hit) return hit
    }
    return null
  }

  const modelNamed = (pascal) => known.get(pascal.toLowerCase()) ?? null

  return { resolves, modelNamed }
}

/**
 * A `.lite` line with its comment text removed, carrying block state across
 * lines. Answers `[code, stillInBlock]`.
 *
 * One owner because there were two readings and both were wrong in the same
 * direction: a line scan that skips a line STARTING with `//` still reads a
 * trailing one, so `// was @@gate(7) once` declared a gate and a comma inside
 * a note split a declared move in half. Both are the same mistake — comment
 * text is content to a regex and is not content to the language.
 *
 * Both of the language's forms, which is what litestone's own lexer drops. A
 * quoted string is NOT lexed here, so a `//` inside one reads as a comment; no
 * schema in this repo has one, and the alternative is a string lexer inside a
 * line scan that exists to need no parser at all.
 */
export function withoutComments(line, inBlock = false) {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const two = line.slice(i, i + 2)
    if (inBlock) { if (two === '*/') { inBlock = false; i++ } continue }
    if (two === '//') return [out, false]
    if (two === '/*') { inBlock = true; i++; continue }
    out += line[i]
  }
  return [out, inBlock]
}

/**
 * The services over each model, each with whether it serves EVERY declared
 * move (`FJS-1255`) — true unless it declares `methods:`. A declared list
 * serves the moves it names, and a name in it is already a literal the
 * either-spelling test counts, so the list needs no parse of its own.
 * `servesCreate` is the same question for `create`: `'readOnly'` answers no,
 * and a list answers yes only when it names the verb.
 * Junction resolves a service's model as `service-model` does: `model:` when
 * stated, else the name its registry gives the file.
 */
export function servingServices(root, files, code, schema) {
  const { resolves } = modelResolver(schema, root)
  const out = new Map()
  for (let i = 0; i < files.length; i++) {
    if (!/\.service\.[cm]?[jt]s$/.test(basename(files[i]))) continue
    const src = code[i]
    if (!/\bcreate(Base)?Service\b/.test(src)) continue
    const stated = src.match(/\bmodel\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/)
    const model  = resolves(stated ? stated[1] : camel(basename(files[i]).replace(/\.service\.[cm]?[jt]s$/, '')))
    if (!model) continue
    if (!out.has(model)) out.set(model, [])
    const narrowed = /\bmethods\s*:/.test(src)
    out.get(model).push({
      path: files[i], servesAll: !narrowed,
      servesCreate: !narrowed || (!/\bmethods\s*:\s*['"`]readOnly/.test(src) && /['"`]create['"`]/.test(src)),
    })
  }
  return out
}

// ─── English, as far as it is decidable ───────────────────────────────────────
//
// Deliberately narrow. `Status`, `Address`, `Progress` and every other singular
// ending in `s` are why the `ss` and `us` cases are excluded rather than
// allow-listed — an allow-list is a thing to maintain, and the words it would
// hold are exactly the ones a schema uses.

// This was hand-rolled regex, and it was the fifth copy of a fact
// `@frontierjs/toolbelt/inflect` already owns — the same drift `FJS-D197`
// names, one package further along. `service-model` above derives with
// `singularize`; this one did it again in ten lines of endings.
//
// The kit is strictly better on every case the copy answered differently.
// `Series`, `Species` and `News` were FALSE POSITIVES — correctly-named models
// warned at forever — and `People` was a FALSE NEGATIVE, which is the one that
// matters: `model People` slipped past the copy in silence, which is precisely
// the failure this rule exists to prevent.
export function looksPlural(name) {
  return singularize(name) !== name
}

// ─── walking ──────────────────────────────────────────────────────────────────

export const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output', '.vite'])

export function walk(dir, depth, fn) {
  if (depth < 0 || !existsSync(dir)) return
  try { fn(dir) } catch { /* an unreadable directory is not a finding */ }
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(dir, name)
    try { if (statSync(child).isDirectory()) walk(child, depth - 1, fn) } catch { /* dangling link */ }
  }
}

export function safeRead(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

export const lineOf = (text, index) => text.slice(0, index).split('\n').length
