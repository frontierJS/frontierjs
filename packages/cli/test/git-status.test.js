// The grouping is cosmetic; the COUNT is not. A role rule that stops matching,
// or a place rule that claims a path twice, would quietly drop a file from a
// listing somebody is reading to decide what to commit — and a dropped row and
// a clean file look identical. Every test here is ultimately that one question.

import { test, expect } from 'bun:test'
import { buildStatus, collapse, zoneOf, roleOf, ROLE_ORDER } from '../core/git-status.js'

const z = (lines) => lines.map(l => l + '\0').join('')

test('every path in, exactly once out', () => {
  const paths = [
    'packages/litestone/src/core/engine.js',
    'packages/litestone/CHANGES.md',
    'example/db/schema.lite',
    'example/web/src/routes/people/index.mesa',
    'example/CHANGES.md',
    'IDEAS/geo.md',
    'CLAUDE.md',
    'exports.snapshot.md',
    'scripts/ci.mjs',
    '.github/workflows/ci.yml',
    'website/site/src/main.js',
    'some/unclaimed/path.txt',
  ]
  const model = buildStatus({ porcelain: z(paths.map(p => ` M ${p}`)) })
  const seen = model.zones.flatMap(zone => zone.files.map(f => f.path))
  expect(seen.sort()).toEqual([...paths].sort())
  expect(model.total.files).toBe(paths.length)
})

test('a place name is trimmed by its PATH, not by its own spelling', () => {
  const model = buildStatus({ porcelain: z([' M packages/litestone/src/core/engine.js']) })
  expect(model.zones[0].zone).toBe('litestone')
  expect(model.zones[0].files[0].rel).toBe('src/core/engine.js')
})

test('every role a rule can answer is in the print order', () => {
  // A role the renderer never reaches prints nothing, and the file vanishes
  // from its place while the header still counts it.
  const probes = ['a/x.lite', 'a/x.ts', 'a/x.mesa', 'a/test/x.ts', 'a/config/x.js',
                  'a/deploy/x.sh', 'a/x.snapshot.md', 'a/CHANGES.md', 'a/notes.md']
  for (const p of probes) expect(ROLE_ORDER).toContain(roleOf(p))
})

test('untracked is one state, not staged AND dirty', () => {
  const model = buildStatus({ porcelain: z(['?? packages/cli/core/git-status.js']) })
  const f = model.zones[0].files[0]
  expect(f.untracked).toBe(true)
  expect(f.index).toBe(null)
  expect(model.total.staged).toBe(0)
  expect(model.total.dirty).toBe(0)
  expect(model.total.untracked).toBe(1)
})

test('a rename carries two NUL fields and consumes both', () => {
  // Read as one field, the OLD path becomes a phantom entry of its own.
  const model = buildStatus({ porcelain: z(['R  a/new.ts', 'a/old.ts', ' M a/other.ts']) })
  const files = model.zones.flatMap(zone => zone.files)
  expect(files.map(f => f.path).sort()).toEqual(['a/new.ts', 'a/other.ts'])
  expect(files.find(f => f.path === 'a/new.ts').from).toBe('a/old.ts')
})

test('a path with a space survives -z', () => {
  const model = buildStatus({ porcelain: z([' M packages/cli/a file.js']) })
  expect(model.zones[0].files[0].path).toBe('packages/cli/a file.js')
})

test('churn sums the staged and the unstaged half of one file', () => {
  const model = buildStatus({
    porcelain: z(['MM packages/cli/core/x.js']),
    staged:   'ative\t0\tpackages/cli/core/x.js\n'.replace('ative', '10'),
    unstaged: '5\t2\tpackages/cli/core/x.js\n',
  })
  expect(model.zones[0].added).toBe(15)
  expect(model.zones[0].deleted).toBe(2)
})

test('a binary file is marked, never counted as zero churn silently', () => {
  const model = buildStatus({ porcelain: z([' M a/logo.png']), unstaged: '-\t-\ta/logo.png\n' })
  expect(model.zones[0].files[0].binary).toBe(true)
})

test('a conflict outranks any amount of churn', () => {
  const model = buildStatus({
    porcelain: z(['UU packages/auth/src/a.ts', ' M packages/litestone/src/b.js']),
    unstaged: '900\t900\tpackages/litestone/src/b.js\n',
  })
  expect(model.zones[0].zone).toBe('auth')
})

test('collapse pays for a directory once and loses no entry', () => {
  const files = [
    { rel: 'src/domain/a.ts', role: 'src' },
    { rel: 'src/domain/b.ts', role: 'src' },
    { rel: 'src/app.ts',      role: 'src' },
  ]
  const rows = collapse(files)
  expect(rows.map(r => r.dir)).toEqual(['src/', 'src/domain/'])
  expect(rows.flatMap(r => r.entries).length).toBe(3)
  expect(rows[1].entries.map(e => e.base)).toEqual(['a.ts', 'b.ts'])
})

test('an untracked DIRECTORY keeps a name', () => {
  // git collapses an untracked directory into one entry ending in `/`. Cutting
  // at the last separator gave it an empty basename, so the row printed its
  // glyph and nothing else.
  const model = buildStatus({ porcelain: z(['?? packages/toolbelt/src/mime/']) })
  const [row] = collapse(model.zones[0].files)
  expect(row.dir).toBe('src/')
  expect(row.entries[0].base).toBe('mime/')
  expect(row.entries[0].folder).toBe(true)
})

test('blast reaches a file through the reader, and 0 is not null', () => {
  // The two must stay distinguishable at the model: *nothing names this* is a
  // fact about the file, *nothing read this* is a fact about the tally, and a
  // renderer that saw 0 for both would mark a hub as safe on the run where the
  // index failed to build.
  const index = { 'packages/cli/core/checks.js': { usedBy: 24, band: 3 },
                  'packages/cli/core/lonely.js': { usedBy: 0,  band: 0 } }
  const model = buildStatus({
    porcelain: z([' M packages/cli/core/checks.js', ' M packages/cli/core/lonely.js', ' M packages/cli/CHANGES.md']),
    blastOf: (p) => index[p] ?? null,
  })
  const by = Object.fromEntries(model.zones[0].files.map(f => [f.rel, f.blast]))
  expect(by['core/checks.js']).toEqual({ usedBy: 24, band: 3 })
  expect(by['core/lonely.js']).toEqual({ usedBy: 0, band: 0 })
  expect(by['CHANGES.md']).toBe(null)
})

test('with no reader every file reads null rather than 0', () => {
  // The default. A caller that does not pay for the scan must not produce a
  // model that says every file is named by nobody.
  const model = buildStatus({ porcelain: z([' M packages/cli/core/checks.js']) })
  expect(model.zones[0].files[0].blast).toBe(null)
})

test('an unclaimed path lands at the root rather than nowhere', () => {
  expect(zoneOf('stray.md')).toMatchObject({ zone: '(root)', prefix: '' })
})

test('an app checked out on its own groups by surface rather than into the root', () => {
  const model = buildStatus({ porcelain: z([
    ' M api/src/services/mailer/mailer.class.js',
    ' M api/config/default.json',
    ' M web/src/core/preload.js',
    ' M db/schema.lite',
    ' M package.json',
  ]) })
  expect(model.zones.map(z => z.zone).sort()).toEqual(['(root)', 'api', 'db', 'web'])
  const api = model.zones.find(z => z.zone === 'api')
  expect(api.group).toBe('surface')
  expect(Object.fromEntries(api.files.map(f => [f.rel, f.role]))).toEqual({
    'src/services/mailer/mailer.class.js': 'src',
    'config/default.json':                 'config',
  })
})

test('an app inside a workspace groups by its surfaces, a package stays whole', () => {
  expect(zoneOf('example/web/src/app.js')).toMatchObject({ zone: 'example/web', prefix: 'example/web/' })
  expect(zoneOf('example/CHANGES.md')).toMatchObject({ zone: 'example', prefix: 'example/' })
  expect(zoneOf('packages/basecamp/web/src/x.mesa')).toMatchObject({ zone: 'basecamp', prefix: 'packages/basecamp/' })
  expect(zoneOf('IDEAS/ontology.md')).toMatchObject({ zone: 'IDEAS', group: 'repo' })
})

test('an untracked directory keeps its name rather than becoming a nameless place', () => {
  expect(zoneOf('web/')).toMatchObject({ zone: '(root)', prefix: '' })
  expect(zoneOf('example/site/')).toMatchObject({ zone: 'example', prefix: 'example/' })
})
