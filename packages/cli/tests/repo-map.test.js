// repo-map.test.js — the workspace, read rather than described.
//
// The engine behind `fli ws:map`. What is worth testing here is not the page:
// it is the readers, because each one parses a file that was written for a
// human and may be reshaped by one. A reader that silently returns nothing
// prints a map that is missing a section, which looks like a workspace that
// does not have one.
//
// Determinism gets its own test, because the output is committed and rechecked
// with `--check`: two collects over one tree must render one file, or the check
// fails on a repo nobody touched.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { collect, renderHtml, renderJson } from '../core/repo-map.js'

let ROOT

function tree(name, files) {
  const dir = join(ROOT, name)
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const pkg = (fields) => JSON.stringify(fields, null, 2)

beforeAll(() => { ROOT = mkdtempSync(join(tmpdir(), 'fli-repo-map-')) })
afterAll(()  => { try { rmSync(ROOT, { recursive: true, force: true }) } catch {} })

// ─── packages ─────────────────────────────────────────────────────────────────

describe('packages', () => {

  test('reads members, their sibling deps and their test script', () => {
    const dir = tree('members', {
      'package.json': pkg({ name: 'ws' }),
      'packages/litestone/package.json': pkg({ name: '@x/litestone', version: '1.0.0', scripts: { test: 'bun test' } }),
      'packages/junction/package.json':  pkg({ name: '@x/junction', version: '0.1.0', dependencies: { '@x/litestone': 'workspace:*', zod: '^3' } }),
    })
    const { packages } = collect({ root: dir })

    expect(packages.map(p => p.name)).toEqual(['@x/junction', '@x/litestone'])
    // A dependency outside the workspace is somebody else's business — the
    // column exists to show direction between members.
    expect(packages[0].deps).toEqual(['@x/litestone'])
    expect(packages[1].test).toBe('bun test')
  })

  test('a directory with no package.json is reported, not skipped', () => {
    const dir = tree('claimed', {
      'package.json': pkg({ name: 'ws' }),
      'packages/toolbelt/README.md': '# planned\n',
    })
    const { packages } = collect({ root: dir })
    expect(packages).toEqual([{ folder: 'toolbelt', claimed: true }])
  })

  test('a package carrying a package-lock is reported as npm', () => {
    const dir = tree('npm-member', {
      'package.json': pkg({ name: 'ws' }),
      'packages/ext/package.json': pkg({ name: 'ext', scripts: { test: 'node test.js' } }),
      'packages/ext/package-lock.json': '{}',
    })
    // The runner differs per package and a wrong one produces failures that
    // belong to nothing, so the map may not assume bun.
    expect(collect({ root: dir }).packages[0].manager).toBe('npm')
  })
})

// ─── what a package does ──────────────────────────────────────────────────────

describe('topics and sections', () => {

  test('a docs file is a topic, titled by its own H1', () => {
    const dir = tree('topics', {
      'package.json': pkg({ name: 'ws' }),
      'packages/litestone/package.json': pkg({ name: 'litestone' }),
      'packages/litestone/docs/encryption.md': '# Encryption\n\nColumns marked `@encrypted` are sealed at the boundary.\n',
      'packages/litestone/docs/README.md': '# Index\n\nnot a topic\n',
    })
    const [pkg0] = collect({ root: dir }).packages

    expect(pkg0.topics.map(t => t.title)).toEqual(['Encryption'])
    expect(pkg0.topics[0].claim).toBe('Columns marked @encrypted are sealed at the boundary.')
    expect(pkg0.topics[0].file).toBe('packages/litestone/docs/encryption.md')
  })

  test('the README’s own headings are the second index, minus the boilerplate ones', () => {
    const dir = tree('sections', {
      'package.json': pkg({ name: 'ws' }),
      'packages/x/package.json': pkg({ name: 'x' }),
      'packages/x/README.md': '# x\n\n## Install\n\n## Migrations\n\n## Window functions\n\n## License\n',
    })
    expect(collect({ root: dir }).packages[0].sections.map(s => s.title))
      .toEqual(['Migrations', 'Window functions'])
  })

  // A package with no `docs/` documents itself in one README, and then the
  // heading alone is the whole feature list — which is why the first thing each
  // section says is read, prose or example.
  test('a section carries the first thing it says, and an example when that is all it says', () => {
    const dir = tree('sect-claim', {
      'package.json': pkg({ name: 'ws' }),
      'packages/x/package.json': pkg({ name: 'x' }),
      'packages/x/README.md': [
        '# x', '',
        '## Idempotency-Key', '',
        'A mutating request carrying the header executes once. The repeat replays.', '',
        '## Response helpers', '',
        '```ts', 'ctx.json(data, status?)', 'ctx.noContent()', '```', '',
        '## Config options', '',
        '| key | meaning |', '| --- | --- |', '',
      ].join('\n'),
    })
    const [idem, helpers, config] = collect({ root: dir }).packages[0].sections

    expect(idem.claim).toBe('A mutating request carrying the header executes once.')
    expect(idem.code).toBe('')
    expect(helpers.code).toBe('ctx.json(data, status?)')
    expect(helpers.claim).toBe('')
    // A section that opens on a table says neither, and says so rather than
    // reaching further down for something unrelated.
    expect(config).toMatchObject({ claim: '', code: '' })
  })

  test('the src/ directories are the structural answer, with what is in each', () => {
    const dir = tree('subsys', {
      'package.json': pkg({ name: 'ws' }),
      'packages/x/package.json': pkg({ name: 'x' }),
      'packages/x/src/core/app.ts': 'export const a = 1\n',
      'packages/x/src/core/hooks/run.ts': 'export const b = 2\n',
      'packages/x/src/transport/http.ts': 'export const c = 3\n',
      'packages/x/src/index.ts': 'export * from "./core/app"\n',
    })
    expect(collect({ root: dir }).packages[0].subsystems)
      .toEqual([{ name: 'core', files: 2 }, { name: 'transport', files: 1 }])
  })

  test('no docs and no README is an empty list, not a guess', () => {
    const dir = tree('no-docs', {
      'package.json': pkg({ name: 'ws' }),
      'packages/x/package.json': pkg({ name: 'x' }),
    })
    expect(collect({ root: dir }).packages[0]).toMatchObject({ topics: [], sections: [] })
  })
})

// ─── ceilings, invariants, evidence ───────────────────────────────────────────

describe('typecheck ceilings', () => {

  test('are read per package, and absent is clean rather than unknown', () => {
    const dir = tree('ceilings', {
      'package.json': pkg({ name: 'ws' }),
      'scripts/typecheck-baselines.json': JSON.stringify({
        '//': 'a comment key the file really carries',
        junction: 198,
      }),
      'packages/junction/package.json': pkg({ name: '@x/junction' }),
      'packages/mesa/package.json': pkg({ name: '@x/mesa' }),
    })
    const { packages } = collect({ root: dir })

    expect(packages.find(p => p.folder === 'junction').baseline).toBe(198)
    expect(packages.find(p => p.folder === 'mesa').baseline).toBe(0)
  })
})

describe('invariants and the rules that check them', () => {

  test('reads the numbered list out of the root CLAUDE.md', () => {
    const dir = tree('invariants', {
      'package.json': pkg({ name: 'ws' }),
      'CLAUDE.md': [
        '# Map',
        '',
        '## Invariants',
        '',
        "Don't violate without an explicit decision.",
        '',
        '1. **Dependency direction** — `Litestone ← Junction ← Sierra`, never reverse. Mesa is a leaf.',
        '2. **Model names are PascalCase singular** (`model Lead` → `db.lead`); `@@external` exempt.',
        '',
        '---',
        '',
        '## Something else',
        '',
        '3. **Not an invariant** — this list ended at the rule.',
      ].join('\n'),
    })
    const { invariants } = collect({ root: dir })

    expect(invariants).toHaveLength(2)
    expect(invariants[0]).toEqual({ n: 1, title: 'Dependency direction', blurb: 'Litestone ← Junction ← Sierra, never reverse.' })
  })

  test('the rules come from checks.js itself, each naming its invariant', () => {
    const { checks } = collect({ root: tree('rules', { 'package.json': pkg({ name: 'ws' }) }) })

    expect(checks.length).toBeGreaterThan(0)
    // A rule guarding a live hazard rather than an invariant carries null, and
    // that is a real answer — it is what makes the crossing honest.
    expect(checks.some(r => typeof r.invariant === 'number')).toBe(true)
    expect(checks.every(r => r.id && r.title)).toBe(true)
  })
})

describe('where a row points', () => {

  const register = (detail) => [
    '# Issues',
    '',
    '## S2 — high',
    '',
    '| Id | Pkg | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    `| FJS-1 | litestone | **A defect** | open | 2026-08-14 | ${detail} |`,
    '',
  ].join('\n')

  test('takes the files the Detail column links, without the line fragment', () => {
    const dir = tree('files', {
      'package.json': pkg({ name: 'ws' }),
      'ISSUES.md': register('[client.js:5097](packages/litestone/src/core/client.js#L5097) · [schema.md](packages/litestone/docs/schema.md)'),
    })
    const row = collect({ root: dir }).issues.bySeverity.S2[0]

    expect(row.files).toEqual(['packages/litestone/docs/schema.md', 'packages/litestone/src/core/client.js'])
  })

  test('a cross-reference to another row is not a file, and neither is a URL', () => {
    const dir = tree('files-refs', {
      'package.json': pkg({ name: 'ws' }),
      'ISSUES.md': register('[FJS-095](#) · [FJS-D04](#fjs-d04) · [spec](https://example.com/x.md)'),
    })
    expect(collect({ root: dir }).issues.bySeverity.S2[0].files).toEqual([])
  })
})

// ─── what proves a change ─────────────────────────────────────────────────────

describe('proofs', () => {

  test('reads the drive-per-change table out of the root CLAUDE.md', () => {
    const dir = tree('proofs', {
      'package.json': pkg({ name: 'ws' }),
      'CLAUDE.md': [
        '# Map',
        '',
        '| Changed                | Run                                            |',
        '| ---------------------- | ---------------------------------------------- |',
        '| mesa compiler/runtime  | `example`: `verify` **and** `verify:public`     |',
        '| conduit · notifications | `example`: `verify:notify`                     |',
        '',
        'Prose after the table, which ends it.',
      ].join('\n'),
    })
    const { proofs } = collect({ root: dir })

    expect(proofs).toHaveLength(2)
    expect(proofs[0]).toEqual({ changed: 'mesa compiler/runtime', run: 'example: verify and verify:public' })
  })

  test('no table is an empty list, not a thrown reader', () => {
    const dir = tree('no-proofs', { 'package.json': pkg({ name: 'ws' }), 'CLAUDE.md': '# Map\n\nnothing here\n' })
    expect(collect({ root: dir }).proofs).toEqual([])
  })
})

// ─── commands ─────────────────────────────────────────────────────────────────

describe('commands', () => {

  test('a command is named by its own frontmatter title, not by its path', () => {
    const dir = tree('commands', {
      'package.json': pkg({ name: 'ws' }),
      'packages/cli/commands/db/seed.md': '---\ntitle: db:seed\ndescription: Run the seeder\n---\n\n```js\n```\n',
      'packages/cli/commands/workspace/publish/index.md': '---\ntitle: workspace:publish\ndescription: Publish the workspace\n---\n',
      'packages/cli/commands/db/_module.md': 'namespace prose\n',
      'packages/cli/commands/db/import/_steps/01-x.md': 'a step, not a command\n',
    })
    const { commands } = collect({ root: dir })

    expect(commands.total).toBe(2)
    expect(commands.list.map(c => c.name)).toEqual(['db:seed', 'workspace:publish'])
    expect(commands.list[0].description).toBe('Run the seeder')
  })
})

// ─── ci phases ────────────────────────────────────────────────────────────────

describe('ci phases', () => {

  const CI = `
// ─── phase 1 · hygiene ──────────────────────────────
// Everything here is about the difference between this working copy and a
// fresh clone.

function hygiene() { const from = phase('hygiene') }

// ─── phase 2 · tests ────────────────────────────────
// Each package's own script, with its own runner.

function tests() { phase('tests') }

function main() {
  if (!testsOnly) {
    hygiene()
  }
  if (!fast) {
    tests()
  }
  report()
}
`

  test('reads the phases out of main() in call order, with their tier', () => {
    const dir = tree('ci', { 'package.json': pkg({ name: 'ws' }), 'scripts/ci.mjs': CI })
    const { ci } = collect({ root: dir })

    expect(ci.phases.map(p => p.label)).toEqual(['hygiene', 'tests'])
    expect(ci.phases.map(p => p.tier)).toEqual(['fast', 'full run'])
  })

  test('the description is the phase’s own section comment, dividers dropped', () => {
    const dir = tree('ci-note', { 'package.json': pkg({ name: 'ws' }), 'scripts/ci.mjs': CI })
    const { ci } = collect({ root: dir })

    expect(ci.phases[0].note).toBe('Everything here is about the difference between this working copy and a fresh clone.')
    expect(ci.phases[0].note).not.toContain('─')
  })

  test('no ci script is null, not an empty section', () => {
    const dir = tree('no-ci', { 'package.json': pkg({ name: 'ws' }) })
    expect(collect({ root: dir }).ci).toBeNull()
  })
})

// ─── issues ───────────────────────────────────────────────────────────────────

describe('the open register', () => {

  const ISSUES = `# Issues

## S2 — high

| Id | Pkg | Title | Status | Verified | Detail |
| --- | --- | --- | --- | --- | --- |
| FJS-101 | litestone | **A gate refuses and a policy filters.** Measured on six rows, with \`a | b\` in the evidence | open | 2026-08-14 | [x](y) |

## Needs a decision

| Id | Pkg | Title | Detail |
| --- | --- | --- | --- |
| FJS-D14 | repo | **Four folders are claimed, not built** | [IDEAS](IDEAS/x.md) |

## Closed

| Id | Pkg | Title | Status | Verified | Detail |
| --- | --- | --- | --- | --- | --- |
| FJS-043 | mesa | **Fixed** | closed | 2026-08-10 | — |
`

  test('takes the claim, the severity from its section, and nothing else', () => {
    const dir = tree('issues', { 'package.json': pkg({ name: 'ws' }), 'ISSUES.md': ISSUES })
    const { issues } = collect({ root: dir })

    const row = issues.bySeverity.S2[0]
    expect(row.id).toBe('FJS-101')
    expect(row.pkg).toBe('litestone')
    expect(row.title).toBe('A gate refuses and a policy filters.')
    expect(row.status).toBe('open')
  })

  test('a closed row is counted and never listed — an id resolves in one place', () => {
    const dir = tree('issues-closed', { 'package.json': pkg({ name: 'ws' }), 'ISSUES.md': ISSUES })
    const { issues } = collect({ root: dir })

    expect(issues.open).toBe(2)
    expect(issues.closed).toBe(1)
    expect(JSON.stringify(issues.bySeverity)).not.toContain('FJS-043')
  })

  test('a four-column decision row survives the narrower table', () => {
    const dir = tree('issues-d', { 'package.json': pkg({ name: 'ws' }), 'ISSUES.md': ISSUES })
    const { issues } = collect({ root: dir })

    expect(issues.bySeverity.decision[0].id).toBe('FJS-D14')
    expect(issues.bySeverity.decision[0].status).toBe('needs a ruling')
  })

  test('a ruled decision reads as its ruling, never as the answer it struck out', () => {
    const dir = tree('issues-ruled', {
      'package.json': pkg({ name: 'ws' }),
      'ISSUES.md': [
        '# Issues',
        '',
        '## Needs a decision',
        '',
        '| Id | Pkg | Question | Detail |',
        '| --- | --- | --- | --- |',
        '| FJS-D15 | email-kit | ~~**`@frontierjs/mesa-email` or `@frontierjs/email-kit`?**~~ **Ruled: `@frontierjs/email-kit`** — the directory was already right | [DECISIONS.md](DECISIONS.md) |',
      ].join('\n'),
    })
    const row = collect({ root: dir }).issues.bySeverity.decision[0]

    expect(row.status).toBe('ruled')
    expect(row.title).toBe('Ruled: @frontierjs/email-kit')
    expect(row.title).not.toContain('mesa-email')
  })

  test('no register is null, not zero open items', () => {
    const dir = tree('no-issues', { 'package.json': pkg({ name: 'ws' }) })
    expect(collect({ root: dir }).issues).toBeNull()
  })

  // Half the register leads a row with its own anchor so a ruling can link the
  // id. Matching on a bare `| FJS-` dropped all 26 of them out of this repo's
  // own map, and the failure mode is why it lasted: a row that does not match
  // is not an error, it is a page reporting a smaller register.
  test('a row leading with its link anchor is read, and the anchor is not part of the id', () => {
    const ANCHORED = `# Issues

## S4 — low

| Id | Pkg | Title | Status | Verified | Detail |
| --- | --- | --- | --- | --- | --- |
| <a id="fjs-284"></a>FJS-284 | sierra | **The route table is still called a manifest.** | open | 2026-08-16 | [x](y) |
| FJS-285 | notifications | **\`channel\` means two things.** | open | 2026-08-16 | [x](y) |
`
    const dir = tree('issues-anchored', { 'package.json': pkg({ name: 'ws' }), 'ISSUES.md': ANCHORED })
    const { issues } = collect({ root: dir })

    expect(issues.open).toBe(2)
    expect(issues.bySeverity.S4.map(r => r.id)).toEqual(['FJS-284', 'FJS-285'])
    expect(issues.byPackage.find(p => p.pkg === 'sierra').count).toBe(1)
  })
})

// ─── the other two registers ──────────────────────────────────────────────────
//
// `ISSUES.md` is what is wrong, `DECISIONS.md` is what is settled, `IDEAS/` is
// what is not started. Each is written for people first, so what is worth
// pinning is the parse of the conventions they actually use — a status column
// that says `**defect**` in one row and `~~shipped~~` in the next.

describe('rulings', () => {

  const DECISIONS = [
    '# Decisions',
    '',
    'Dated rulings by the project owner.',
    '',
    '## Naming & vocabulary',
    '',
    '**2026-08-13 · `FJS-D29` — the process a fleet server runs is an OUTPOST.**',
    'Basecamp called it an agent. So does the MCP proposal.',
    '',
    '**2026-08-08 · A resource file is named for its noun.** PascalCase, singular.',
    '',
    '## Open (discussed, not yet ruled)',
    '',
    'Moved to ISSUES.md.',
    '',
  ].join('\n')

  const settled = (name) => {
    const dir = tree(name, { 'package.json': pkg({ name: 'ws' }), 'DECISIONS.md': DECISIONS })
    return collect({ root: dir }).decisions
  }

  test('a ruling is a date, an optional id and the claim, under its domain', () => {
    const one = settled('rule-shape').sections[0].rulings[0]

    expect(one.date).toBe('2026-08-13')
    expect(one.id).toBe('FJS-D29')
    expect(one.claim).toBe('the process a fleet server runs is an OUTPOST.')
    expect(one.section).toBe('Naming & vocabulary')
  })

  test('a ruling with no id is still a ruling', () => {
    expect(settled('rule-noid').sections[0].rulings[1].id).toBeNull()
  })

  test('a section holding no rulings is not a section', () => {
    expect(settled('rule-empty').sections.map(s => s.title)).toEqual(['Naming & vocabulary'])
    expect(settled('rule-empty').count).toBe(2)
  })

  test('no DECISIONS.md is null, not an empty register', () => {
    const dir = tree('rule-none', { 'package.json': pkg({ name: 'ws' }) })
    expect(collect({ root: dir }).decisions).toBeNull()
  })
})

describe('ideas', () => {

  const OVERVIEW = [
    '# Ideas — the overview',
    '',
    '**Status: INDEX. Derived, not authoritative.**',
    '',
    '## How to read the columns',
    '',
    '| Column | Meaning |',
    '| --- | --- |',
    '| **Effort** | S days |',
    '',
    '## Wave 0 — repairs',
    '',
    '| # | Item | Effort | Payoff | Edge | Realms | Status | Source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 0.1 | **Automated CI** — no `.github/` exists | S | ●●●● | stakes | T | idea | `testing-and-ci.md` |',
    '| 0.2 | **Live-store filter leak** — silently wrong | S | ●●●○ | — | A U | **defect** | `live-queries.md` |',
    '| 0.6 | ~~**Boundary watches every async value**~~ — fixed | S | ●●○○ | — | U | ~~`shipped`~~ | `derived-suspense.md` |',
    '| 0.3 | **Audit logger** — disputed | S | ●●●○ | edge | D | `contested` — `ISSUES.md` | `framework-shape.md` 4 |',
    '',
    '## Wave 1 — make the thesis visible',
    '',
    '| # | Item | Effort | Payoff | Edge | Realms | Status | Source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1.1 | **Schema → UI** — nothing consumes it | L | ●●●● | **only** | D U | partial | `framework-shape.md` 1 |',
    '',
  ].join('\n')

  const backlog = (name, extra = {}) => {
    const dir = tree(name, {
      'package.json': pkg({ name: 'ws' }),
      'IDEAS/overview.md': OVERVIEW,
      ...extra,
    })
    return collect({ root: dir }).ideas
  }

  test('a wave carries its rows in the order the overview ranks them', () => {
    const waves = backlog('idea-waves').waves

    expect(waves.map(w => w.title)).toEqual(['Wave 0', 'Wave 1'])
    expect(waves[0].blurb).toBe('repairs')
    expect(waves[0].rows.map(r => r.n)).toEqual(['0.1', '0.2', '0.6', '0.3'])
  })

  test('a column table before the first wave is not a wave', () => {
    expect(backlog('idea-cols').count).toBe(5)
  })

  test('the status column is written four ways and normalises to one', () => {
    const rows = backlog('idea-status').waves[0].rows
    expect(rows.map(r => r.status)).toEqual(['idea', 'defect', 'shipped', 'contested'])
  })

  test('the cell is kept whole beside the normalized word', () => {
    expect(backlog('idea-note').waves[0].rows[3].note).toContain('ISSUES.md')
  })

  test('payoff is counted, so it can be compared', () => {
    expect(backlog('idea-payoff').waves[0].rows.map(r => r.payoff)).toEqual([4, 3, 2, 3])
  })

  test('the source is the file and not the section number after it', () => {
    expect(backlog('idea-source').waves[0].rows[3].source).toBe('framework-shape.md')
  })

  test('a paper introduces itself with its H1, not with the status boilerplate', () => {
    const ideas = backlog('idea-paper', {
      'IDEAS/live-queries.md': '# Idea — Live queries: a subscription scoped to a query\n\n**Status: IDEA + LIVE DEFECT.** Dated 2026-08-04.\n',
    })

    expect(ideas.papers[0].title).toBe('Live queries: a subscription scoped to a query')
    expect(ideas.papers[0].status).toBe('IDEA + LIVE DEFECT')
    expect(ideas.papers.map(p => p.file)).not.toContain('IDEAS/overview.md')
  })

  test('no IDEAS/ is null, not an empty backlog', () => {
    const dir = tree('idea-none', { 'package.json': pkg({ name: 'ws' }) })
    expect(collect({ root: dir }).ideas).toBeNull()
  })
})

// ─── what a register says about itself ────────────────────────────────────────
//
// The claim is quoted, so the only way it can be wrong is by quoting the wrong
// sentence — which is exactly what happened: asking for the first bold run
// anywhere had `DECISIONS.md` introducing itself with a heading from halfway
// down the file.

describe('the opening claim', () => {

  const claimOf = (name, body) => {
    const dir = tree(`claim-${name}`, { 'package.json': pkg({ name: 'ws' }), 'DOC.md': body })
    return collect({ root: dir }).registers.find(r => r.file === 'DOC.md').claim
  }

  test('a bold run leading the opening paragraph is the claim', () => {
    expect(claimOf('bold', '# Doc\n\n**The settled register.** Check before relitigating.\n'))
      .toBe('The settled register.')
  })

  test('a file that opens in plain prose is quoted as it stands', () => {
    expect(claimOf('prose', '# Doc\n\nDated rulings by the project owner. Settled unless reopened.\n'))
      .toBe('Dated rulings by the project owner.')
  })

  test('a bold run further down belongs to its own section, not to the file', () => {
    expect(claimOf('later', '# Doc\n\nWorking document — not permanent.\n\n**code-wrong** — the model is right.\n'))
      .toBe('Working document — not permanent.')
  })

  test('a quote is somebody else’s sentence and a rule is nobody’s', () => {
    expect(claimOf('quoted', '# Doc\n\n---\n\n> **A quoted summary** of the last session.\n\nSession state for picking up cold.\n'))
      .toBe('Session state for picking up cold.')
  })
})

// ─── snapshots and drives ─────────────────────────────────────────────────────

describe('snapshots and drives', () => {

  test('a snapshot carries its generator, its directory and the realm that wrote it', () => {
    const dir = tree('snaps', {
      'package.json': pkg({ name: 'ws' }),
      'db/access.snapshot.md': '<!-- generated by: litestone access --schema schema.lite -->\n',
    })
    const [snap] = collect({ root: dir }).snapshots

    expect(snap.generator).toBe('litestone access --schema schema.lite')
    expect(snap.dir).toBe('db')
    expect(snap.realm).toBe('data')
  })

  test('a drive is any verify script, wherever it is declared', () => {
    const dir = tree('drives', {
      'package.json': pkg({ name: 'ws' }),
      'example/package.json': pkg({ name: 'example', scripts: { verify: 'node test/verify.mjs', 'verify:ui': 'node test/ui.mjs', test: 'bun test' } }),
      'packages/basecamp/package.json': pkg({ name: 'basecamp', scripts: { verify: 'node verify.mjs' } }),
    })
    const { drives } = collect({ root: dir })

    expect(drives.map(d => `${d.where}:${d.script}`))
      .toEqual(['example:verify', 'example:verify:ui', 'packages/basecamp:verify'])
  })
})

// ─── the output ───────────────────────────────────────────────────────────────

describe('the page', () => {

  const workspace = () => tree('page', {
    'package.json': pkg({ name: 'ws', scripts: { ci: 'node scripts/ci.mjs' } }),
    'packages/litestone/package.json': pkg({ name: '@x/litestone', version: '1.0.0', scripts: { test: 'bun test' } }),
    'db/ddl.snapshot.sql': '-- generated by: litestone ddl --schema schema.lite\n',
    'ISSUES.md': '# Issues\n\n## S3 — medium\n\n| Id | Pkg | Title | Status | Verified | Detail |\n| --- | --- | --- | --- | --- | --- |\n| FJS-1 | repo | **A thing** | open | 2026-08-14 | — |\n',
    'README.md': '# ws\n\n**The workspace.** Everything else is downstream.\n',
  })

  test('renders one file for one tree — the map is committed and rechecked', () => {
    const dir = workspace()
    expect(renderHtml(collect({ root: dir }))).toBe(renderHtml(collect({ root: dir })))
  })

  test('names its own generator where the snapshot walker reads it', () => {
    const html = renderHtml(collect({ root: workspace() }))
    // Below the doctype: anything above one puts the browser in quirks mode.
    expect(html.split('\n').slice(0, 2)).toEqual(['<!doctype html>', '<!-- generated by: fli ws:map -->'])
    expect(html.indexOf('generated by: fli ws:map')).toBeLessThan(4096)
  })

  test('carries no date, so it does not go stale by standing still', () => {
    const html = renderHtml(collect({ root: workspace() }))
    // A date the generator invented would differ on every run; one quoted from
    // the register is the register's, and is in the JSON too.
    expect(html.replace(/2026-\d\d-\d\d/g, '')).not.toMatch(/\d{4}-\d\d-\d\d/)
  })

  test('escapes what it quotes — the register is prose somebody wrote', () => {
    const dir = tree('escape', {
      'package.json': pkg({ name: 'ws' }),
      'ISSUES.md': '# Issues\n\n## S2 — high\n\n| Id | Pkg | Title | Status | Verified | Detail |\n| --- | --- | --- | --- | --- | --- |\n| FJS-9 | ui | **A `<script>` tag in a title** | open | 2026-08-14 | — |\n',
    })
    const html = renderHtml(collect({ root: dir }))
    expect(html).toContain('&lt;script&gt;')
  })

  test('the json is the same model the page renders', () => {
    const model = collect({ root: workspace() })
    expect(JSON.parse(renderJson(model)).snapshots[0].generator).toBe('litestone ddl --schema schema.lite')
  })
})
