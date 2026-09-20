// ─── seams.js — who owns each named cross-package handoff ────────────────────
//
// `CLAUDE.md` § Bridge index and the `bridge-index` skill are one list written
// twice: a key list at the root, eighty-five explained bullets in the skill.
// Both are hand-kept and nothing compares them, so a seam can exist in one and
// not the other — `signIn` is ruled in `FJS-D261`, carries its own bullet, and
// the key list has never named it.
//
// What nothing asked is the question Invariants 4 and 5 turn on: **does a
// seam's stated owner exist, and is the name in it?** Measured before this
// module: 85 bullets, 25 naming an owner, 60 naming none, and all 21 distinct
// paths resolving by diligence rather than by a gate.
//
// ── Two halves, and only one of them derives ────────────────────────────────
//
// The LIST derives. The bullets are the seams and the skill is where they are
// already written with their prose, so a second copy here would be the
// restatement this framework is a bet against. The OWNER is a statement
// somebody makes: that `$setAuth` belongs to `client.js` and not to one of the
// four type declarations that also carry the name cannot be read off the tree,
// because every one of the five sites declares it. So it is DECLARED in the
// bullet and CHECKED to resolve — the discipline `invariants.js` applies to an
// enforcer and `proof-target` applies to a drive.
//
// ── `none` is an answer ─────────────────────────────────────────────────────
//
// A seam with no stated owner is not a bug in this module, it is the finding.
// Writing it down separates *nobody has said* from *somebody said and I could
// not find it*, which read identically in prose.
//
// ── A wrong owner outranks a missing one ────────────────────────────────────
//
// A stated path that does not resolve FAILS; a bullet naming none reports. A
// reader who greps a dead path concludes the seam moved, so advice that fails
// when taken is worse than no advice.
//
// ── RESTATEMENTS are the number to watch ────────────────────────────────────
//
// Invariant 1 forbids the import that would let junction and orion share
// litestone's types, so each hand-declares the shape of the client it holds:
// `asSystem` has one implementation and eight other sites. That is Axiom 1's
// disease at the framework's own boundary, and it is countable.
//
// Zero dependencies, plain ESM, node or bun — the rule `snapshots.js`,
// `checks.js` and `repo-map.js` follow, because a caller runs before install.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative }                                  from 'node:path'

import { stripComments }                                   from './codegraph.js'

const read = p => { try { return readFileSync(p, 'utf8') } catch { return null } }

export const SKILL = '.claude/skills/bridge-index/SKILL.md'

// ─── the key list ────────────────────────────────────────────────────────────
//
// `CLAUDE.md` § Bridge index carries the names alone, so *is there an owner for
// this already* is answerable without loading ninety paragraphs. It is a DERIVED
// copy that nothing derived, and it drifted: `signIn` has carried its own bullet
// and its own ruling since `FJS-D261` and the key list never named it, so the
// one question that section exists to answer was answered no.
//
// It is not deleted in favor of this file, because inline at the point of
// reading is the whole of its value. It is CHECKED instead — the same
// relationship `invariants.snapshot.md` has with § Invariants, one direction
// further on.

export function readKeyList(root) {
  const text = read(join(root, 'CLAUDE.md'))
  if (text === null) return null

  const from = text.search(/^#+ Bridge index/m)
  if (from < 0) return null
  const rest = text.slice(from)
  const to   = rest.slice(1).search(/^## /m)
  const body = to < 0 ? rest : rest.slice(0, to + 1)

  return new Set([...body.matchAll(/`([^`]+)`/g)].map(m => identifierOf(m[1])))
}

/** Seams the skill explains and the key list has never named. */
export function unlisted(root, seams = null) {
  const listed = readKeyList(root)
  if (listed === null) return []
  return (seams ?? readSeams(root))
    .filter(s => !s.names.some(n => listed.has(identifierOf(n))))
}

// ─── reading the list ────────────────────────────────────────────────────────
//
// A bullet is one line and opens with its names, backtick-quoted and separated
// by ` / ` where one seam answers to two verbs (`$setAuth` / `asSystem`). The
// owner is the FIRST backticked source path in the bullet, which is the
// convention twenty-six of them already follow — a second path is where the
// seam is CONSUMED, and reading the last one made sierra the owner of
// `createJunctionClient`, which junction exports.

const SECTION = /^\*\*(.+?)\*\*\s*$/
const BULLET  = /^- (`[^`]+`(?: \/ `[^`]+`)*)/
const TICKED  = /`([^`]+)`/g
// Not every package puts its source under `src/`: auth's is at the package root
// and mesa's vite plugin is `mesa/mesa-vite/`, so anchoring on `src|core|commands`
// silently refused three owners that had just been written down.
//
// What separates a path from the three other things shaped like one — a relative
// mention (`build/schema-plugin.js`), an import specifier (`@frontierjs/ui/utils.js`)
// and a Vite alias (`@/api.js`) — is whether the first segment NAMES A PACKAGE.
// That is read off the tree rather than guessed at, so a new package needs no
// edit here and a plausible-looking non-path can never become an owner.
// `.mesa` counts: Invariant 18 makes a resource file source in this workspace,
// and `$context.form` is provided by one — so excluding the extension refused an
// owner the bullet had already written down.
const SRCPATH = /`((?:packages\/)?[a-z@][a-zA-Z0-9@._-]*\/[a-zA-Z0-9/._-]+\.(?:[cm]?[jt]s|mesa))`/g

function packageDirs(root) {
  try {
    return new Set(readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name))
  } catch { return new Set() }
}

/**
 * Every regex metacharacter, not just `$`.
 *
 * `client.auth.*` reduces to `*`, which is a quantifier with nothing to repeat
 * — the whole walk threw the moment that seam was given an owner, because a key
 * had never reached the re-export read before.
 */
const rx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text a KEY is written as where it is minted.
 *
 * A key has no declaration, so `seam-owner` could not grade one and eighteen
 * owners went in unfalsifiable — the exact thing this module exists to stop.
 * What it CAN ask is whether the stated owner mentions the key at all, which
 * catches the failure that actually happens: the minting moved and the bullet
 * did not. The receiver is dropped because `ctx.`, `$.`, `client.` and `page.`
 * are where the key is READ, never where it is written.
 */
const EXT = new Set(['js', 'ts', 'mjs', 'mts', 'cjs', 'mesa', 'lite'])

export function keyLiteral(name) {
  const bare = String(name).split(/[\s(]/)[0]
    .replace(/^(?:ctx|client|page|\$)\./, '')
    .replace(/\.\*$/, '')
    .replace(/^\*\./, '')
  if (!bare.includes('.')) return bare
  // `*.mount.js` is about `mount`, and taking the last segment asked whether
  // the owner contains the string `js`, which every JavaScript file does.
  const parts = bare.split('.').filter(x => x && !EXT.has(x))
  return parts[parts.length - 1] ?? bare
}

/**
 * Is asking *does the owner contain this string* worth anything for this key?
 *
 * For `x-fjs-build` it is nearly a proof. For `$` it is nothing, and for `log`
 * or `auth` it is close to nothing — every file in junction contains both. The
 * weakness is RECORDED rather than hidden, on `invariants.snapshot.md`'s
 * argument: a row claiming a whole check while holding a corner of it is the
 * most misleading thing the file can carry.
 */
export function weakLiteral(lit) {
  if (lit.length <= 2) return true
  return lit.length < 7 && !/[-@$_A-Z]/.test(lit)
}

/** `app.runAs(id, fn)` → `runAs`. The identifier a parser would find. */
export function identifierOf(name) {
  const bare = name.split('(')[0].trim()
  const last = bare.split('.').pop()
  return last.replace(/^@/, '')
}

export function readSeams(root) {
  const text = read(join(root, SKILL))
  if (text === null) return []

  const pkgs  = packageDirs(root)
  const seams = []
  let section = null

  for (const [i, line] of text.split('\n').entries()) {
    const s = line.match(SECTION)
    if (s) { section = s[1].trim(); continue }

    const b = line.match(BULLET)
    if (!b) continue

    const names = [...b[1].matchAll(TICKED)].map(m => m[1])
    const paths = [...line.matchAll(SRCPATH)].map(m => m[1])
      .filter(x => pkgs.has(x.replace(/^packages\//, '').split('/')[0]))
    const owner = paths.length ? paths[0] : null

    seams.push({
      section,
      names,
      line:  i + 1,
      owner: owner === null ? null : owner.startsWith('packages/') ? owner : `packages/${owner}`,
      kind:  names[0].includes('(') ? 'fn' : 'key',
    })
  }
  return seams
}

// ─── what the tree says ──────────────────────────────────────────────────────
//
// One walk, one index. Asking the tree per seam would read `client.js` eighty
// times, and it is twelve thousand lines.

const SOURCE = /\.[cm]?[jt]s$/
// `build` is NOT here: `sierra/src/build/` is source, and skipping it hid
// `appSrcDir` — a seam declared in the tree and reported as declared nowhere.
const SKIPDIR = new Set(['node_modules', 'dist', '.bun', 'coverage', 'test', 'tests', '__tests__'])

// A suite is not a seam's owner, and the globals one brings are not declarations:
// `svc.describe()` matched six hundred files before this line, because `describe`
// is what every test in the repo opens with.
const ISTEST = /\.(?:test|spec)\.[cm]?[jt]s$/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || SKIPDIR.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (SOURCE.test(e.name) && !ISTEST.test(e.name)) out.push(p)
  }
  return out
}

/**
 * Every line that DECLARES a name, by file. Five shapes, because a seam crosses
 * a boundary the language cannot type: an exported binding, a bare function, an
 * object or class method, an interface member, a property holding a function.
 */
function declarations(id) {
  const e = rx(id)
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${e}\\b` +
    `|^\\s*(?:export\\s+)?(?:async\\s+)?${e}\\s*[(<]` +
    `|^\\s*(?:readonly\\s+)?${e}\\s*:\\s*(?:async\\s*)?(?:\\(|function|<)` +
    // A named function expression is still where the thing is written, and the
    // Data boundary is built of them: `$levelOf` is `return function $levelOf`
    // inside the factory that binds it to a context, so the only line matching
    // the shapes above was the `.d.ts`.
    `|(?:return|=)\\s+(?:async\\s+)?function\\s+${e}\\b` +
    // Litestone hands every `$` seam out of a Proxy — `if (prop === '$tapEvents')`
    // — so the name is written nowhere a declaration parser looks, and the only
    // lines carrying it were the `.d.ts` restatements.
    `|prop\\s*===\\s*['"]${e}['"]`,
  )
}

/**
 * A `.d.ts` is a restatement by construction — it is the same fact in a second
 * dialect, which is what Axiom 1 is about — so it counts toward `restated` and
 * can never be an owner. The generated `db/schema.d.ts` an app commits is the
 * same thing one tier out.
 */
const TYPEONLY = /\.d\.[cm]?ts$/

export function buildIndex(root) {
  const roots = ['packages']
  const files = roots.flatMap(r => walk(join(root, r)))
  // Comments are blanked rather than dropped, so a line number still names the
  // line: this module's own comment quoting `return function $levelOf` was
  // counted as a declaration of it. One owner for that reading, in codegraph.
  return files.map(f => ({
    path:  relative(root, f),
    lines: stripComments(read(f) ?? '').split('\n'),
  }))
}

/**
 * Where a file re-exports a name from, or null. A stated owner that only
 * forwards is the seam having MOVED with nobody updating the claim — the
 * finding is useless without the module it moved to, so that is what is read.
 */
export function reexportOf(root, ownerPath, ids) {
  const text = read(join(root, ownerPath))
  if (text === null) return null
  for (const id of ids) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) continue   // `*` is not a name
    const e  = rx(id)
    const re = new RegExp(`export\\s*\\{[^}]*\\b${e}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`)
    const m  = text.match(re)
    if (m) return m[1]
  }
  return null
}

export function sitesFor(index, id) {
  const re = declarations(id)
  const hits = []
  for (const f of index) {
    const n = f.lines.findIndex(l => re.test(l))
    if (n >= 0) hits.push(`${f.path}:${n + 1}`)
  }
  return hits
}

// ─── the whole table ─────────────────────────────────────────────────────────
//
//   seamOwnership({ root }) → [{ …seam, ownerExists, inOwner, sites, restated }]
//
// `sites` is every declaring file; `restated` is that count minus the owner.
// A `key` seam is not a callable and is counted by MENTION, since `x-version`
// is a string in a schema and no parser will ever find a declaration of it.

export function seamOwnership({ root, index = null } = {}) {
  const seams = readSeams(root)
  if (!seams.length) return []
  const idx = index ?? buildIndex(root)

  return seams.map(seam => {
    const id    = identifierOf(seam.names[0])
    const ids   = [...new Set(seam.names.map(identifierOf))]
    const sites = seam.kind === 'fn' ? sitesFor(idx, id) : []
    const impl  = sites.filter(s => !TYPEONLY.test(s.split(':')[0]))

    // Every name on the bullet, because `ctx.enqueue` / `deliverOutbox` is one
    // seam with two verbs and the owner need only declare one of them.
    const held = seam.kind === 'fn' && seam.owner !== null
      && ids.some(x => sitesFor(idx, x).some(s => s.startsWith(`${seam.owner}:`)))

    // A key is graded by MENTION in its owner, the only question a file can
    // answer about a string that is never declared.
    const mentioned = seam.kind === 'key' && seam.owner !== null
      && (read(join(root, seam.owner)) ?? '').includes(keyLiteral(seam.names[0]))

    const ownerExists = seam.owner !== null && existsSync(join(root, seam.owner))
    const reexport    = ownerExists && !held ? reexportOf(root, seam.owner, ids) : null
    const inOwner     = held

    return {
      ...seam,
      id,
      sites,
      impl,
      ownerExists,
      inOwner,
      mentioned,
      reexport,
      restated: seam.owner === null ? Math.max(0, sites.length - 1) : Math.max(0, sites.length - 1),
      broken:   seam.owner !== null && !ownerExists,
    }
  })
}

// ─── rendering ───────────────────────────────────────────────────────────────

const esc = s => s.replace(/\|/g, '\\|')

export function renderSeams(rows) {
  const out     = []
  const owned   = rows.filter(r => r.owner !== null)
  const broken  = rows.filter(r => r.broken)
  const spread  = rows.filter(r => r.restated >= 3).sort((a, b) => b.restated - a.restated)

  out.push('<!-- generated by: fli ws:seams -->')
  out.push('')
  out.push('# Seams — who owns each named cross-package handoff')
  out.push('')
  out.push('Generated. The `bridge-index` skill is the source of the list and of every owner')
  out.push('claim; this file is the RESOLUTION — does the stated path exist, is the name in it,')
  out.push('and how many other files declare the same name. Invariants 4 and 5 are what it')
  out.push('serves, and `fli check`\'s `seam-owner` is what fails on a stated path that is gone.')
  out.push('')
  out.push('**`none` is an answer.** A seam nobody has assigned reads exactly like one that is')
  out.push('owned, so the gap is written down rather than left to be rediscovered.')
  out.push('')
  out.push('**A restatement is not a defect by itself.** Invariant 1 forbids the import that')
  out.push('would let junction and orion share litestone\'s types, so each declares the shape it')
  out.push('holds. The count is here because it is the only place that cost is visible.')
  out.push('')
  const gapFn  = rows.filter(r => r.owner === null && r.kind === 'fn')
  const gapKey = rows.filter(r => r.owner === null && r.kind === 'key')
  out.push(`Seams: **${rows.length}**. With a stated owner: **${owned.length}**. Stated and missing: **${broken.length}**.`)
  out.push('')
  if (!gapFn.length && !gapKey.length) {
    out.push('**Every seam names an owner.** A callable is graded by where it is DECLARED; a key — a `$` on a')
    out.push('wire, a schema keyword, a header — has no declaration anywhere, so its owner is where it is')
    out.push('MINTED and the question asked of that file is whether it contains the string at all. That is a')
    out.push('weaker claim, and it is the one a file can answer.')
    out.push('')
    const weak = rows.filter(r => r.kind === 'key' && r.owner && weakLiteral(keyLiteral(r.names[0])))
    out.push(`**${weak.length} of those checks are marked weak** and the mark is the point: asking whether`)
    out.push('junction contains the string `log` proves nothing, where `x-fjs-build` is nearly a proof. A row')
    out.push('that claimed the strong check while holding the weak one would be worse than no row.')
  } else if (!gapFn.length) {
    out.push(`**Every callable seam names an owner.** The ${gapKey.length} without one are not callables — a \`$\` on`)
    out.push('a wire, a schema keyword, a context property, a header, whose owner is where it is MINTED.')
  } else {
    out.push(`**${gapFn.length} callable seam(s) name no owner**, and ${gapKey.length} of the rest are not callables —`)
    out.push('a `$` on a wire, a schema keyword, a header — for which an empty cell is the answer, not a gap.')
  }
  out.push('')

  if (spread.length) {
    out.push('## Most restated')
    out.push('')
    out.push('| Seam | Owner | Other declaring files |')
    out.push('| --- | --- | --- |')
    for (const r of spread) {
      out.push(`| \`${esc(r.names[0])}\` | ${r.owner ? `\`${r.owner}\`` : '**none**'} | ${r.restated} |`)
    }
    out.push('')
  }

  let section = null
  for (const r of rows) {
    if (r.section !== section) {
      section = r.section
      out.push(`## ${section}`)
      out.push('')
      out.push('| Seam | Owner | Declared in | Other sites |')
      out.push('| --- | --- | --- | --- |')
    }
    const names = r.names.map(n => `\`${esc(n)}\``).join(' / ')
    const owner = r.owner === null ? '**none**'
      : !r.ownerExists ? `\`${r.owner}\` — **does not resolve**`
      : `\`${r.owner}\``
    const found = r.owner === null ? '—'
      : r.kind === 'key'  ? (!r.mentioned ? '**not mentioned**'
                             : weakLiteral(keyLiteral(r.names[0])) ? `mentions \`${esc(keyLiteral(r.names[0]))}\` — weak`
                             : 'mentioned')
      : r.inOwner         ? 'yes'
      : r.reexport        ? `**re-exported from \`${esc(r.reexport)}\`**`
      :                     '**name not found**'
    out.push(`| ${names} | ${owner} | ${found} | ${r.restated || '—'} |`)
  }
  out.push('')

  const unowned = rows.filter(r => r.owner === null && r.kind === 'fn')
  if (unowned.length) {
    out.push('## Stated by nobody')
    out.push('')
    out.push(`${unowned.length} callable seam(s) carry a name and an explanation and no owner. Each is a`)
    out.push('place where *reach for the seam before grepping* cannot be taken.')
    out.push('')
    for (const r of unowned) out.push(`- \`${esc(r.names[0])}\` — ${r.section}`)
    out.push('')
  }

  return out.join('\n')
}
