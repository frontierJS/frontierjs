// build-check.js — would this build produce an artefact that can be promoted?
//
// Phase 1c of IDEAS/release-transitions.md, and the other half of what 2.3f
// started. `core/image.js` made a deploy able to SAY which bytes it ran. That is
// only worth having if the same bytes can serve more than one environment —
// invariant 1: one artefact promotes from staging to production unchanged, and
// only its bindings differ. A build that bakes configuration into the image
// breaks that silently: the result still builds, still starts, still answers
// health, and still reports a digest. It is simply a DIFFERENT digest per
// environment, and nothing says so.
//
// Measured rather than assumed. Two build contexts identical except for a
// `.env.production`, `COPY . .`, no `.dockerignore`:
//
//   stage       sha256:dfa9655f267c02…      DIFFERENT
//   production  sha256:32ab9ba5e266f8…      the configuration is in the digest
//
// and the negative control — the same two trees with `.env*` ignored:
//
//   stage       sha256:fa3ecac547cb08…      IDENTICAL
//   production  sha256:fa3ecac547cb08…      one artefact serves both
//
// Three doors, and closing one does not close the others:
//
//   the CONTEXT   a value file the build copies      `.dockerignore` closes it
//   an ENV line   a value written into the image     it cannot
//   a build ARG   a value recorded in the history    it cannot
//
// The third is a leak rather than a promotion problem, and is measured too:
// `--build-arg JWT_SECRET=hunter2` leaves the value in two `docker history`
// lines, readable by anyone who can read the image.
//
// ─── why the context rule traces stages ──────────────────────────────────────
//
// The first version of this file graded a file as baked the moment a COPY off
// the context reached it, and that is wrong in a multi-stage build — measured:
// two trees whose `.env` differed, copied wholesale into a build stage whose
// runtime stage takes only `dist/`, produce a byte-IDENTICAL final image.
//
//   a  sha256:ee755b27af7aa2…   b  sha256:ee755b27af7aa2…    SAME
//
// So the question is not *did a COPY reach it* but *does it reach the FINAL
// image*, which is a walk across stages: `COPY --from=build /app /app` ships
// everything that stage held, and `COPY --from=build /app/site/dist ./dist`
// ships a subtree. Both forms are in this repo. The intermediate case is not
// nothing — the value sits in a layer on the build host, readable with
// `docker build --target build` (measured) — so it is a warning rather than
// silence, and rather than a refusal.
//
// Everything here is a pure function of text. No daemon, no network, no fs —
// the caller reads the files and passes their contents, which is what lets the
// rules be tested without Docker (the same reason `core/image.js` takes an
// already-inspected object).

export const RULES = {
  'context-config':    'a deployment value the FINAL image would carry',
  'build-stage-config':'a deployment value left in an intermediate build layer',
  'env-config':        'an ENV line holding a value the environment is meant to provide',
  'build-secret':      'a credential written into the image or its build history',
  'unpinned-base':     'a base image that is a moving name rather than fixed bytes',
  'unreadable-build':  'something in this build the check could not evaluate',
}

// ─── paths ───────────────────────────────────────────────────────────────────

export function joinPath(...parts) {
  const s   = parts.filter(p => p !== null && p !== undefined && p !== '').join('/')
  const abs = s.startsWith('/')
  const out = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** `a/b/c` → ['a', 'a/b', 'a/b/c'] — a pattern naming a directory covers what is under it. */
const selfAndAncestors = (path) => {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

const under = (dir, path) => {
  const d = dir.replace(/\/+$/, '')
  return path === d || path.startsWith(d + '/')
}

// ─── globs ───────────────────────────────────────────────────────────────────
//
// Docker matches a .dockerignore pattern with Go's filepath.Match, extended so
// `**` crosses separators — and plain `*` does NOT. That distinction is the
// whole of the rule and it is measured: with `.env.*`, a root `.env.production`
// is excluded and `api/.env.production` is COPIED. `**/.env.*` reaches both. An
// app whose Dockerfile copies subdirectories therefore needs the `**` form, and
// an app whose ignore file was written for the root looks protected.
//
// A pattern using a character range is handed to the regex engine as written. If
// it does not compile we say so rather than guessing, because both guesses are
// silent: called ignored, a baked secret goes unreported; called included, every
// correct app gets a false refusal.

export function compileGlob(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        // `**/` may match nothing at all, so `**/x` matches a bare `x`.
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?' }
        else out += '.*'
      } else out += '[^/]*'
    }
    else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) return null
      out += pattern.slice(i, close + 1)
      i = close
    }
    else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  try { return new RegExp(out + '$') } catch { return null }
}

const cleanPattern = (p) => String(p).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')

// ─── .dockerignore ───────────────────────────────────────────────────────────

export function parseDockerignore(text) {
  const out = []
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const negate  = line.startsWith('!')
    const pattern = cleanPattern(negate ? line.slice(1).trim() : line)
    if (!pattern) continue
    out.push({ pattern, negate, re: compileGlob(pattern), line: i + 1 })
  }
  return out
}

/**
 * Would the build send this path to the daemon?
 *
 * Answers `ignored` · `included` · `unknown`, three rather than two for the
 * reason every matcher in this repo has three (toolbelt's `match`): a matcher
 * forced to return a boolean has to guess, and a wrong guess is silent whichever
 * way it falls. `unknown` is what a pattern this check cannot read produces.
 *
 * Docker's own rule is that the LAST matching pattern decides, which is what
 * makes `!` work at all.
 */
export function ignoreDecision(path, patterns) {
  if (patterns.some(p => !p.re)) return 'unknown'
  const candidates = selfAndAncestors(path)
  let decision = 'included'
  for (const p of patterns) {
    if (candidates.some(c => p.re.test(c))) decision = p.negate ? 'included' : 'ignored'
  }
  return decision
}

// ─── the Dockerfile ──────────────────────────────────────────────────────────
//
// Enough of the grammar to answer the questions and no more. Continuations are
// joined first, because `ENV NODE_ENV=production \` on its own line is the form
// this repo's own template writes and a line-at-a-time reader sees half of it.

function instructionsOf(text) {
  const out = []
  let buffer = null, startedAt = 0
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.replace(/\r$/, '')
    if (buffer === null && /^\s*(#|$)/.test(line)) continue
    if (buffer === null) { buffer = ''; startedAt = i + 1 }
    const continues = /\\\s*$/.test(line)
    buffer += line.replace(/\\\s*$/, '') + (continues ? ' ' : '')
    if (continues) continue
    out.push({ no: startedAt, text: buffer.replace(/\s+#[^\n]*$/, '').trim() })
    buffer = null
  }
  if (buffer !== null) out.push({ no: startedAt, text: buffer.trim() })
  return out
}

function parseCopy(rest, line, workdir) {
  const from = rest.match(/--from=(\S+)/)?.[1] ?? null
  const bare = rest.replace(/--\S+=\S+\s*/g, '').trim()
  const parts = bare.startsWith('[')
    ? (() => { try { return JSON.parse(bare) } catch { return [] } })()
    : bare.split(/\s+/).filter(Boolean)
  const dest = parts.at(-1) ?? null
  return {
    line, from, workdir, dest,
    sources: parts.slice(0, -1).map(s => (from ? String(s) : cleanPattern(s))),
  }
}

function parseKeyValues(rest, line) {
  const out = []
  // `ENV KEY value` (legacy, one key, the value may hold spaces) vs `ENV A=1 B=2`.
  if (!rest.includes('=')) {
    const [key, ...value] = rest.split(/\s+/)
    if (key) out.push({ line, key, value: value.join(' ') || null })
    return out
  }
  for (const pair of rest.match(/[\w.-]+=(?:"[^"]*"|'[^']*'|\S*)/g) ?? []) {
    const at = pair.indexOf('=')
    out.push({ line, key: pair.slice(0, at), value: pair.slice(at + 1).replace(/^["']|["']$/g, '') || null })
  }
  return out
}

export function parseDockerfile(text) {
  const instructions = instructionsOf(text)
  const froms = [], envs = [], args = [], copies = [], stages = []
  const names = new Set()
  let cur = null

  for (const { no, text: t } of instructions) {
    const m = t.match(/^(\w+)\s+([\s\S]*)$/)
    if (!m) continue
    const verb = m[1].toUpperCase()
    let rest = m[2].trim()

    if (verb === 'FROM') {
      rest = rest.replace(/^(--\S+\s+)*/, '')
      const [ref, , stage] = rest.split(/\s+/)
      const digest = ref.includes('@') ? ref.split('@')[1] : null
      const named  = digest ? ref.split('@')[0] : ref
      const tag    = named.includes(':') ? named.slice(named.lastIndexOf(':') + 1) : null
      const from   = {
        line: no, ref,
        image: tag ? named.slice(0, named.lastIndexOf(':')) : named,
        tag, digest,
        // A FROM naming an EARLIER stage is not a base image, and flagging it
        // would refuse every multi-stage build in this repo.
        stageRef: names.has(named.toLowerCase()),
      }
      froms.push(from)
      if (stage) names.add(stage.toLowerCase())
      cur = { name: stage ? stage.toLowerCase() : null, index: stages.length, from, workdir: '/', copies: [] }
      stages.push(cur)
      continue
    }

    if (verb === 'WORKDIR' && cur) { cur.workdir = joinPath(cur.workdir, rest); continue }

    if (verb === 'ENV' || verb === 'ARG') {
      const rows = parseKeyValues(rest, no)
      ;(verb === 'ENV' ? envs : args).push(...rows)
      continue
    }

    if (verb === 'COPY' || verb === 'ADD') {
      const c = parseCopy(rest, no, cur?.workdir ?? '/')
      copies.push(c)
      if (cur) cur.copies.push(c)
    }
  }

  return { froms, envs, args, copies, stages, instructions }
}

// ─── where a context file lands ──────────────────────────────────────────────
//
// Docker copies the CONTENTS of a directory source, not the directory itself:
// `COPY api ./api` puts `api/.env` at `<workdir>/api/.env`, and `COPY . .` puts
// `.env` at `<workdir>/.env`. A glob that matched a file lands under its own
// basename. A glob that matched only an ANCESTOR of the file is the case this
// cannot resolve, and it says so.

const destBase = (dest, workdir) => (dest?.startsWith('/') ? dest : joinPath(workdir, dest ?? '.'))

export function contextLanding(copy, path) {
  const base = destBase(copy.dest, copy.workdir)
  for (const s of copy.sources) {
    if (s === '.' || s === '') return { at: joinPath(base, path) }
    if (path === s)             return { at: joinPath(base, path.split('/').pop()) }
    if (path.startsWith(s + '/')) return { at: joinPath(base, path.slice(s.length + 1)) }
    const re = compileGlob(s)
    if (!re) continue
    if (re.test(path))                                     return { at: joinPath(base, path.split('/').pop()) }
    if (selfAndAncestors(path).some(a => re.test(a)))      return { unknown: true }
  }
  return null
}

/** Where a path already inside stage S lands when another stage copies from it. */
export function stageLanding(copy, held) {
  const base = destBase(copy.dest, copy.workdir)
  for (const raw of copy.sources) {
    const src = raw.startsWith('/') ? raw.replace(/\/+$/, '') : '/' + cleanPattern(raw)
    if (held === src)         return { at: joinPath(base, held.split('/').pop()) }
    if (under(src, held))     return { at: joinPath(base, held.slice(src.length + 1)) }
    const re = compileGlob(src)
    if (re && re.test(held))  return { at: joinPath(base, held.split('/').pop()) }
  }
  return null
}

/**
 * Does a context file reach the FINAL image?
 *
 * Returns `{ ships, stagesHolding, at, line, unknown }`. `ships: null` means the
 * walk could not decide — a glob whose landing place is ambiguous — which is
 * reported rather than resolved either way.
 */
export function traceToFinalImage(df, path) {
  const holdings = df.stages.map(() => new Map())   // stage index → imagePath → line
  let unknown = false
  let firstLine = null

  for (const [i, stage] of df.stages.entries()) {
    for (const copy of stage.copies) {
      if (!copy.from) {
        const landed = contextLanding(copy, path)
        if (!landed) continue
        if (landed.unknown) { unknown = true; firstLine ??= copy.line; continue }
        holdings[i].set(landed.at, copy.line)
        firstLine ??= copy.line
        continue
      }
      // `--from` names a stage by name or by index; anything else is an external
      // image, which cannot be carrying this context's files.
      const src = df.stages.findIndex((s, n) =>
        s.name === String(copy.from).toLowerCase() || String(n) === String(copy.from))
      if (src === -1 || src >= i) continue
      for (const [heldPath, line] of holdings[src]) {
        const landed = stageLanding(copy, heldPath)
        if (landed?.at) holdings[i].set(landed.at, line)
      }
    }
  }

  const final = holdings.at(-1) ?? new Map()
  const stagesHolding = holdings.map((h, i) => (h.size ? i : -1)).filter(i => i >= 0)
  return {
    ships: final.size > 0 ? true : (unknown ? null : false),
    at:    [...final.keys()][0] ?? null,
    line:  [...final.values()][0] ?? firstLine,
    stagesHolding,
    unknown,
  }
}

// ─── what counts as deployment state ─────────────────────────────────────────
//
// `.env.example` is the opposite of the problem: it declares which keys the
// environment must supply and carries no values, which is exactly what step 01b
// compares against. Copying it in is harmless and often deliberate.

const DECLARATION = /^\.env\.(example|sample|template|dist)$/i

export const isEnvFile = (path) => {
  const name = path.split('/').pop() ?? ''
  return /^\.env(\..+)?$/i.test(name) && !DECLARATION.test(name)
}

/**
 * A live database is the sharpest form of the same mistake — one deployment's
 * state, in the artefact.
 *
 * The extensions are a LIST because two readers need them: this predicate, which
 * grades a path, and `CONTEXT_FIND`, which is the same question spelled for
 * `find`. They were written twice and disagreed — the finder listed `*.db` and
 * not `*.db-wal`, so SQLite's own sidecars were invisible to the check that
 * exists to catch them, and every deploy after the first shipped the running
 * app's write-ahead log into the image. It also moved the image digest on every
 * deploy, which is what made an unchanged redeploy mint a new Release.
 */
export const STATE_EXTENSIONS = ['db', 'db-wal', 'db-shm', 'sqlite', 'sqlite3']

const STATE_RE = new RegExp(`\\.(${STATE_EXTENSIONS.join('|')})$`, 'i')

export const isStateFile = (path) => STATE_RE.test(path)

export const classifyContextFile = (path) =>
  isEnvFile(path) ? 'config' : isStateFile(path) ? 'state' : null

// A key whose value should never be in an image, whatever the app declares.
// `_URL` is deliberately absent: a DATABASE_URL usually carries a password and a
// SITE_URL never does, and one regex cannot tell them apart — a connection
// string that is environment config is caught by `env-config` instead, which
// asks the app rather than guessing. PUBLISHED is the carve-out in the other
// direction: a publishable key is published on purpose.
const CREDENTIAL = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|_KEY|APIKEY|CREDENTIAL|DSN)$/i
const PUBLISHED  = /^(PUBLIC|NEXT_PUBLIC|VITE|PUBLISHABLE)/i

/** Roles the image legitimately fixes: they describe the ARTEFACT, not a deployment of it. */
const ARTEFACT_ROLE = new Set(['NODE_ENV', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TERM'])

// ─── the check ───────────────────────────────────────────────────────────────

/**
 * @param dockerfile    the Dockerfile's text
 * @param dockerignore  the context root's .dockerignore, or null
 * @param contextFiles  context-relative paths present in the tree
 * @param declaredKeys  keys from .env.example — what the ENVIRONMENT supplies
 */
export function inspectBuild({
  dockerfile   = '',
  dockerignore = null,
  contextFiles = [],
  declaredKeys = [],
} = {}) {
  const df       = parseDockerfile(dockerfile)
  const patterns = parseDockerignore(dockerignore)
  const declared = new Set(declaredKeys)
  const findings = []
  const add = (rule, level, title, detail, hint, line) =>
    findings.push({ rule, level, title, detail, hint, line })

  const ignoreHint = (file) => {
    const name = file.split('/').pop()
    return patterns.length
      ? `Add \`**/${name}\` to .dockerignore — a bare \`${name}\` matches the context root only.`
      : 'Add a .dockerignore excluding `**/.env` and `**/.env.*`, with `!.env.example` if the declaration is wanted.'
  }

  // ── the context ────────────────────────────────────────────────────────────
  for (const file of contextFiles) {
    const kind = classifyContextFile(file)
    if (!kind) continue
    if (ignoreDecision(file, patterns) === 'ignored') continue

    if (ignoreDecision(file, patterns) === 'unknown') {
      add('unreadable-build', 'warn',
        `cannot tell whether ${file} is excluded`,
        '.dockerignore holds a pattern this check cannot evaluate, so whether the build copies this file is undecided.',
        'Simplify the pattern, or settle it by hand: `docker build --no-cache` then `docker run <image> ls -a`.',
        null)
      continue
    }

    const trace = traceToFinalImage(df, file)
    if (!trace.stagesHolding.length && trace.ships === false) continue

    const noun = kind === 'config' ? 'configuration' : 'one deployment’s data'

    if (trace.ships === true) {
      add('context-config', 'error',
        `${file} would be in the image`,
        `It lands at ${trace.at}. That puts ${noun} in the digest: the same tree then builds a different image per ` +
        'environment, so there is nothing to promote, and the digest describes one deployment rather than one artefact.',
        ignoreHint(file),
        trace.line)
    } else if (trace.ships === null) {
      add('unreadable-build', 'warn',
        `cannot tell whether ${file} reaches the image`,
        'A COPY source matched a directory above this file by glob, so where it lands is ambiguous to this check.',
        'Name the directory rather than globbing it, or settle it with `docker run <image> ls -a`.',
        trace.line)
    } else {
      add('build-stage-config', 'warn',
        `${file} is copied into an intermediate build stage`,
        'The final image does not carry it and its digest is unaffected, so this build is still promotable. But the value ' +
        'sits in a layer on the build host, readable with `docker build --target <stage>` — which is a leak rather than a ' +
        'promotion problem, and outlives the deploy.',
        ignoreHint(file),
        trace.line)
    }
  }

  // ── ENV ────────────────────────────────────────────────────────────────────
  for (const e of df.envs) {
    if (e.value === null || ARTEFACT_ROLE.has(e.key.toUpperCase())) continue

    if (CREDENTIAL.test(e.key) && !PUBLISHED.test(e.key) && !/^\$/.test(e.value)) {
      add('build-secret', 'error',
        `ENV ${e.key} carries a value`,
        'A credential written with ENV is in the image config and is readable with `docker image inspect` — the container ' +
        'never has to be run.',
        'Pass it at run time: the deploy already mounts --env-file, and a Release records a pinned REFERENCE, never a value.',
        e.line)
      continue
    }

    if (declared.has(e.key)) {
      add('env-config', 'error',
        `ENV ${e.key} is also declared in .env.example`,
        `The environment is meant to supply ${e.key}, and this line fixes it in the bytes. Two environments then need two ` +
        'images, which is the thing a promotable artefact is defined against.',
        `Remove the ENV line and keep ${e.key} in the env file the container is started with.`,
        e.line)
    }
  }

  // ── ARG ────────────────────────────────────────────────────────────────────
  for (const a of df.args) {
    if (!CREDENTIAL.test(a.key) || PUBLISHED.test(a.key)) continue
    add('build-secret', 'warn',
      `ARG ${a.key} names a credential`,
      'A value passed to a build arg is recorded in `docker history` — measured at two lines for one `--build-arg` — so it ' +
      'is readable by anyone who can read the image, whether or not it reaches the running process.',
      'Take it at run time instead, or mount it (`RUN --mount=type=secret`), which is not written down.',
      a.line)
  }

  // ── the base ───────────────────────────────────────────────────────────────
  // Two grades, because they are two different claims. No tag, or `latest`, means
  // *whatever that name points at today* — the build is not reproducible from the
  // tree at all. A version tag is reproducible while nobody moves it, which is
  // most of the time and is what this repo's own template writes; refusing it
  // would make `fli make:deploy` scaffold something that fails its own check.
  for (const f of df.froms) {
    if (f.stageRef || f.digest || f.image === 'scratch' || f.image.startsWith('$')) continue

    if (!f.tag || f.tag === 'latest') {
      add('unpinned-base', 'error',
        `FROM ${f.ref} is unpinned`,
        `${f.tag ? '`latest`' : 'No tag, which means `latest`'} is a name, not bytes. Two builds of one commit weeks apart ` +
        'start from different base images, so the digest this deploy reports says nothing about what a later build of the ' +
        'same tree would produce.',
        `Pin it: \`FROM ${f.image}:<version>@sha256:…\` — \`docker image inspect ${f.ref} --format '{{index .RepoDigests 0}}'\`.`,
        f.line)
    } else {
      add('unpinned-base', 'warn',
        `FROM ${f.ref} is a moving tag`,
        `\`${f.tag}\` is republished as its upstream releases, so it is stable in practice rather than by construction. ` +
        'A digest is the only pin, and it is what makes two builds of one tree comparable.',
        `Append the digest where reproducibility matters: \`FROM ${f.ref}@sha256:…\`.`,
        f.line)
    }
  }

  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

/** Would this refuse a deploy? */
export const refuses = (findings) => findings.some(f => f.level === 'error')

/** One line, for a pipeline step or the doctor's checklist. */
export function summarize(findings) {
  if (!findings.length) return 'promotable: no deployment state in the bytes'
  const errors = findings.filter(f => f.level === 'error').length
  const warns  = findings.length - errors
  return errors
    ? `${errors} refusal(s), ${warns} warning(s)`
    : `promotable, with ${warns} warning(s)`
}

// ─── gathering ───────────────────────────────────────────────────────────────
//
// Three callers ask the same four questions — the deploy step (over ssh, of the
// server's checkout), `deploy:local` and `deploy:doctor` (of this tree) — and
// the answers have to come from ONE place or they drift. What differs between
// them is only how a file is read, so that is the parameter.
//
// The context is not walked wholesale: a real app root holds node_modules, and
// the only files that can bake a deployment into an image are the ones named
// here — and it is BUILT from the same list `classifyContextFile` grades rather
// than spelled beside it, because the two were written twice and disagreed.

export const CONTEXT_FIND =
  `find . \\( -name node_modules -o -name .git -o -name dist \\) -prune -o -type f ` +
  `\\( -name '.env' -o -name '.env.*' ` +
  STATE_EXTENSIONS.map(e => `-o -name '*.${e}' `).join('') +
  `\\) -print 2>/dev/null | head -200`

/**
 * Assemble the four inputs from a `read(relativePath) → string | null` and a
 * `list() → string[]`. Both may be local or remote; nothing here knows which.
 */
export function gather({ read, list, dockerfile = 'deploy/Dockerfile' }) {
  const text = read(dockerfile)
  if (text === null) return { missing: dockerfile }
  return {
    dockerfile:   text,
    dockerignore: read('.dockerignore'),
    contextFiles: (list() ?? []).map(p => p.replace(/^\.\//, '')).filter(Boolean),
    declaredKeys: (read('.env.example') ?? '')
      .split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
      .filter(Boolean),
  }
}

/** One finding as the lines a caller prints. The shape is the same everywhere. */
export function renderFinding(f) {
  const where = f.line ? ` (line ${f.line})` : ''
  return [`${f.title}${where}`, `  ${f.detail}`, `  fix: ${f.hint}`]
}

// ─── reading a tree ──────────────────────────────────────────────────────────
//
// The rules above take no fs on purpose — that is what lets the whole set be
// tested without Docker and without fixtures on disk. This is the one function
// that touches a filesystem, and it exists so the two LOCAL callers
// (`deploy:local`, `deploy:doctor`) do not grow a directory walk each. The
// remote caller cannot use it and supplies its own `list`, which is why `gather`
// takes one rather than doing this itself.

const SKIP = new Set(['node_modules', '.git', 'dist', '.bun', 'coverage'])

export function walkContextFiles(root, { fs, limit = 200 } = {}) {
  const out = []
  const walk = (dir, prefix) => {
    if (out.length >= limit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(`${dir}/${e.name}`, rel) }
      else if (classifyContextFile(rel)) out.push(rel)
    }
  }
  walk(root, '')
  // Sorted, so two runs over one tree report in the same order — readdir order
  // is the filesystem's business and a report that reshuffles reads as churn.
  return out.sort()
}

/** The local half of `gather`, for a caller that has the tree in front of it. */
export function gatherLocal({ root, fs, dockerfile = 'deploy/Dockerfile' }) {
  const read = (rel) => {
    try { return fs.readFileSync(`${root}/${rel}`, 'utf8') } catch { return null }
  }
  return gather({ read, list: () => walkContextFiles(root, { fs }), dockerfile })
}
