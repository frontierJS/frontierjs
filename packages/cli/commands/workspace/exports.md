---
title: workspace:exports
description: Write the published-surface snapshot — what each package ships, and whether every declared entry point is inside it
alias: ws:exports
examples:
  - fli ws:exports
  - fli ws:exports --check
  - fli ws:exports --stdout
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the workspace
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is exports.snapshot.md at the workspace root)
    defaultValue: ''
---

<script>
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// ─── packedFiles ──────────────────────────────────────────────────────────────
//
// The tarball's own listing, asked of the packer rather than derived from
// `files:`. npm's glob semantics have their own rules — a bare directory name
// means everything under it, README/LICENSE/package.json are always included,
// `.npmignore` and `.gitignore` both participate — and a second implementation
// of them would disagree with the publish exactly when it mattered.
//
// `--dry-run` writes nothing. Output is one `packed <size> <path>` line per file.

const packedFiles = (dir) => {
  try {
    const out = execFileSync('bun', ['pm', 'pack', '--dry-run'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    })
    const files = out.split('\n')
      .map(l => l.match(/^packed\s+\S+\s+(.+)$/))
      .filter(Boolean)
      .map(m => m[1].trim())
      .sort()
    return { files }
  } catch (err) {
    return { error: err.stderr?.toString().trim() || err.message }
  }
}

// ─── entryTargets ─────────────────────────────────────────────────────────────
//
// Every path a consumer can arrive at: the `exports` map (nested conditions
// included — "import"/"require"/"default" are all real entry points), `bin`,
// and the legacy `main`/`types`. Normalised to a tarball-relative path so
// membership is a string compare against the listing.

const entryTargets = (pkg) => {
  const out = []
  const norm = (p) => String(p).replace(/^\.\//, '')

  const walkExports = (node, subpath) => {
    if (typeof node === 'string') { out.push({ kind: 'exports', name: subpath, file: norm(node) }); return }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      walkExports(value, key.startsWith('.') ? key : `${subpath} (${key})`)
    }
  }

  if (pkg.exports) walkExports(pkg.exports, '.')
  for (const [name, file] of Object.entries(pkg.bin ?? {})) out.push({ kind: 'bin', name, file: norm(file) })
  if (pkg.main)  out.push({ kind: 'main',  name: 'main',  file: norm(pkg.main) })
  if (pkg.types) out.push({ kind: 'types', name: 'types', file: norm(pkg.types) })

  return out
}

// ─── resolveTarget ────────────────────────────────────────────────────────────
//
// A subpath pattern is an entry point too: `"./components/*": "./components/*.mesa"`
// is one declaration standing for every file that matches. A literal compare
// against the tarball listing calls every one of them missing, which is how a
// check that finds ten problems on a healthy workspace gets ignored — so a
// pattern is answered by how many files it reaches, and only zero is a fault.

// A `*` here is Node's subpath pattern, NOT a shell glob: it matches across `/`,
// so `"./components/*": "./components/*.mesa"` reaches
// `components/forms/Form.mesa`. Reading it as a glob calls a correctly published
// package broken, which is the first thing this check did.

const resolveTarget = (file, packed) => {
  if (!file.includes('*')) return { pattern: false, matches: packed.includes(file) ? 1 : 0 }

  const rx = new RegExp('^' + file.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return { pattern: true, matches: packed.filter(f => rx.test(f)).length }
}

// ─── topLevel ─────────────────────────────────────────────────────────────────
//
// Directories and files at depth 1, which is the granularity `files:` operates
// at. Deliberately NOT a file list: a snapshot that moves whenever anyone adds
// a source file is one nobody reads on the commit where it matters.

const topLevel = (files) =>
  [...new Set(files.map(f => f.includes('/') ? `${f.split('/')[0]}/` : f))].sort()

// ─── diffLines ────────────────────────────────────────────────────────────────
// The same first-20-differing-lines form the other snapshot commands print.

const diffLines = (was, now) => {
  const a = was.split('\n'), b = now.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    out.push(`    - ${a[i] ?? '(absent)'}`)
    out.push(`    + ${b[i] ?? '(absent)'}`)
    if (out.length >= 20) { out.push('    …'); break }
  }
  return out.join('\n')
}

// ─── render ───────────────────────────────────────────────────────────────────

const render = ({ sections, problems, wsNames }) => {
  const out = []

  out.push('# Published surface snapshot')
  out.push('')
  // The machine half: scripts/ci.mjs reads this line and reruns the command
  // with --check from this file's own directory.
  out.push('<!-- generated by: fli ws:exports -->')
  out.push('')
  out.push('Generated by `fli ws:exports`. **Do not edit.**')
  out.push('')
  out.push('What each publishable package actually ships, and whether every entry point it')
  out.push('declares is inside that. An app in this repo resolves a sibling to')
  out.push('`packages/<name>/` and never to a `node_modules` path, so nothing here runs the')
  out.push('published shape — `FJS-251` broke every npm install past 836 green tests.')
  out.push('')
  out.push('Top-level entries only, because that is the granularity `files:` works at: a')
  out.push('directory that stops being published is a line that vanished, and adding a')
  out.push('source file inside one changes nothing. Versions are absent on purpose — a')
  out.push('release moves sixteen at once, and a file that changes every release is a file')
  out.push('nobody reads on the release that matters.')
  out.push('')
  out.push('```')
  out.push(`${sections.length} publishable package(s) · ${problems.length} problem(s)`)
  out.push('```')
  out.push('')

  out.push('## Unpublished entry points')
  out.push('')
  out.push('A declared entry point the tarball does not contain is a broken install, and')
  out.push('it is invisible from inside this repo.')
  out.push('')
  if (problems.length) {
    for (const p of problems) out.push(`- **${p}**`)
  } else {
    out.push('None — every `exports`, `bin`, `main` and `types` target is inside its tarball.')
  }
  out.push('')

  for (const { pkg, folder, top, targets } of sections) {
    out.push(`## \`${pkg.name}\``)
    out.push('')
    out.push(`\`packages/${folder}\` · ships ${top.map(t => `\`${t}\``).join(' ')}`)
    out.push('')

    if (targets.length) {
      out.push('| Kind | Name | Target | Published |')
      out.push('| --- | --- | --- | --- |')
      for (const t of targets) {
        const published = t.matches === 0 ? '**NO**'
          : t.pattern    ? `${t.matches} files`
          : 'yes'
        out.push(`| ${t.kind} | \`${t.name}\` | \`${t.file}\` | ${published} |`)
      }
      out.push('')
    } else {
      out.push('Declares no entry point at all — nothing can import it by name.')
      out.push('')
    }

    // Peer ranges naming a sibling. Below 1.0 a caret pins the MINOR, so a
    // stale `^0.1.0` excludes the only published copies — and nothing inside
    // the workspace consults the range at all, because `workspace:*` answers
    // first.
    const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => wsNames.has(name))
    if (peers.length) {
      out.push(`- peers — ${peers.map(([name, range]) => `\`${name}\`: \`${range}\``).join(' · ')}`)
      out.push('')
    }
  }

  return out.join('\n').replace(/\n+$/, '\n')
}
</script>

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const { wsRoot, packages } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

const publishable = packages.filter(p => !p.pkg.private)
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))

if (!publishable.length) { log.error('No publishable package in this workspace'); process.exitCode = 1; return }

const wsNames  = new Set(packages.map(p => p.pkg.name))
const sections = []
const problems = []

for (const { pkg, dir, folder } of publishable) {
  const packed = packedFiles(dir)

  if (packed.error) {
    problems.push(`${pkg.name} — could not pack: ${packed.error}`)
    continue
  }

  const targets = entryTargets(pkg).map(t => ({ ...t, ...resolveTarget(t.file, packed.files) }))

  for (const t of targets.filter(t => t.matches === 0)) {
    problems.push(
      `${pkg.name} — ${t.kind} \`${t.name}\` points at \`${t.file}\`, which \`files:\` ` +
      `${t.pattern ? 'publishes no file matching' : 'does not publish'}`
    )
  }

  sections.push({ pkg, folder, top: topLevel(packed.files), targets })
}

const body = render({ sections, problems, wsNames })

if (flag.stdout) { echo(body); return }

const outPath = flag.out ? resolve(flag.out) : resolve(wsRoot, 'exports.snapshot.md')

if (flag.check) {
  if (!existsSync(outPath)) {
    log.error(`No snapshot at ${outPath} — run \`fli ws:exports\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) { echo(`  ✓  exports.snapshot.md is current`); return }

  echo(`  ✗  exports.snapshot.md does not match the workspace\n`)
  echo(diffLines(committed, body))
  echo('')
  echo('  The published surface changed. Run `fli ws:exports` and review the diff before committing.')
  process.exitCode = 1
  return
}

writeFileSync(outPath, body, 'utf8')
echo(`  ✓  exports.snapshot.md`)
echo(`  ${sections.length} publishable package(s)${problems.length ? ` · ${problems.length} unpublished entry point(s)` : ''}`)
```

## What it writes

`exports.snapshot.md` at the workspace root — for every **publishable** package
(a private one is never published and has no surface):

- **Ships** — the top-level entries of the tarball `files:` produces, asked of
  the packer rather than derived from the globs.
- **Entry points** — every `exports` subpath, `bin`, `main` and `types` target,
  each marked with whether the tarball actually contains it.
- **Peers** — the ranges naming another workspace package.

## Why it is committed

`FJS-251` broke every `npm install` of the framework while 836 Sierra tests
stayed green: an app in this repo resolves a sibling to `packages/<name>/` and
never to a `node_modules` path, so nothing here exercises the published shape.
The `scaffold` CI phase catches that class end to end by packing, installing and
building an app. This is the cheap half — a declared entry point that `files:`
does not publish is decidable from the tarball listing alone, and it is a
broken install every time.

## In CI

```
fli ws:exports --check
```

Exits 1 with the differing lines when the snapshot is stale. The `snapshots`
phase in `scripts/ci.mjs` finds it without being told: the file's header names
the command that regenerates it.
