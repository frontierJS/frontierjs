// checks.test.js — the architecture rules.
//
// Every rule gets two tests: one tree that violates it and one that does not.
// A rule with only the first is a rule that might fire on everything, and a rule
// with only the second is a rule that might fire on nothing — and the second is
// the failure this whole file exists to prevent, because it passes.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { RULES, runChecks, findApps } from '../core/checks.js'

let ROOT

/** Write a tree from a `{ 'a/b.txt': 'contents' }` map, and answer its root. */
function tree(name, files) {
  const dir = join(ROOT, name)
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const SCHEMA = `
model Account { id Int @id  name String }
model Lead    { id Int @id  name String  accountId Int }
`

const resource = (service, opts = '') => `<script module>
  import { createResource } from '@frontierjs/sierra/junction'
  export const ${service} = createResource('${service}'${opts ? `, { ${opts} }` : ''})
</script>
`

/** The shape a passing app has — every rule runs, nothing fires. */
const CLEAN = {
  'db/schema.lite':                     SCHEMA,
  'api/app.ts':                         '// api\n',
  'web/index.html':                     '<!doctype html>\n<body><div id="app"></div></body>\n',
  'web/config/vite.config.js':          'export default { server: { port: 8010, strictPort: true } }\n',
  'web/src/resources/Lead.mesa':        resource('leads'),
  'web/src/resources/Account.mesa':     resource('accounts'),
  // The third surface. It is in the clean app because every rule must RUN
  // here — a rule that only ever skips is the failure this file exists to
  // catch, and `widget-entry-name` skips wherever widgets/ is absent.
  'widgets/config/vite.config.js':      'export default { server: { port: 8200, strictPort: true } }\n',
  'widgets/src/Embeds/Booking.mesa':    '<button>book</button>\n',
  'widgets/src/Embeds/LeadForm/index.mesa': '<form></form>\n',
  'widgets/src/Embeds/LeadForm/Field.mesa': '<input>\n',
}

const only = (root, id, extra = {}) => runChecks({ root, only: [id], ...extra })

beforeAll(() => { ROOT = mkdtempSync(join(tmpdir(), 'fli-checks-')) })
afterAll(()  => { rmSync(ROOT, { recursive: true, force: true }) })

describe('the clean app', () => {
  test('every app rule runs, and none of them fires', () => {
    const root = tree('clean', CLEAN)
    const { findings, ran, skipped } = runChecks({ root })

    expect(findings).toEqual([])
    // The claim that matters: nothing was skipped. A green run over a tree the
    // rules could not see is the result this file is written to make impossible.
    expect(skipped).toEqual([])
    expect(ran.length).toBe(RULES.filter(r => r.scope === 'app').length)
  })
})

describe('model names', () => {
  test('a lowercase model name is an error', () => {
    const root = tree('m-case', { ...CLEAN, 'db/schema.lite': 'model lead { id Int @id }\n' })
    const { findings } = only(root, 'model-name-case')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toMatch(/PascalCase/)
  })

  test('a plural model name is a warning', () => {
    const root = tree('m-plural', { ...CLEAN, 'db/schema.lite': 'model Leads { id Int @id }\n' })
    const { findings } = only(root, 'model-name-plural')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
  })

  test('a singular name ending in s is not a plural', () => {
    // Address, Status, Progress, Analysis. These are why the rule is narrow and
    // an allow-list was refused: the words it would hold are the ones a schema
    // uses, so the list is the maintenance.
    const root = tree('m-ss', {
      ...CLEAN,
      'db/schema.lite': ['Address', 'Status', 'Progress', 'Analysis', 'Business']
        .map(n => `model ${n} { id Int @id }`).join('\n'),
    })
    expect(only(root, 'model-name-plural').findings).toEqual([])
  })

  test('an @@external model is exempt', () => {
    const root = tree('m-ext', {
      ...CLEAN,
      'db/schema.lite': 'model legacy_users {\n  id Int @id\n  @@external\n}\n',
    })
    expect(only(root, 'model-name-case').findings).toEqual([])
  })
})

describe('resources', () => {
  test('a .js in src/resources/ is an error', () => {
    const root = tree('r-js', { ...CLEAN, 'web/src/resources/helpers.js': 'export const x = 1\n' })
    const { findings } = only(root, 'resource-dir-mesa')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/\.mesa file/)
  })

  test('a plain <script> is an error, and so is markup', () => {
    const root = tree('r-script', {
      ...CLEAN,
      'web/src/resources/Account.mesa': '<script>\n  export const accounts = 1\n</script>\n<div>hi</div>\n',
    })
    const { findings } = only(root, 'resource-script')
    expect(findings).toHaveLength(2)
    expect(findings.map(f => f.message).join(' ')).toMatch(/script module/)
    expect(findings.map(f => f.message).join(' ')).toMatch(/no markup/)
  })

  test('a filename that is neither a model nor its own service noun is an error', () => {
    // The rule cannot tell a misnamed file from a legitimate Resource over no
    // model when the service pluralises regularly from the filename — and it
    // should not try, because both are correct shapes. What it CAN say is that
    // this file matches neither.
    const root = tree('r-name', { ...CLEAN, 'web/src/resources/Prospect.mesa': resource('pipeline') })
    const { findings } = only(root, 'resource-file-name')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no model named Prospect/)
    expect(findings[0].message).toMatch(/the service is 'pipeline'/)
  })

  test('a Resource over no model may take its service noun, singularised', () => {
    // basecamp's `Hub.mesa` is `createResource('hub')` and is correct — judging
    // against the schema alone refuses every cross-cutting resource an app has.
    const root = tree('r-noun', { ...CLEAN, 'web/src/resources/Hub.mesa': resource('hub') })
    expect(only(root, 'resource-file-name').findings).toEqual([])
  })

  test('a stated model must match the filename', () => {
    const root = tree('r-stated', {
      ...CLEAN,
      'web/src/resources/Alert.mesa': resource('alerts', `model: 'AlertRule'`),
    })
    const { findings } = only(root, 'resource-file-name')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/named Alert\.mesa/)
  })

  test('a lowercase plural filename says what it should be called', () => {
    const root = tree('r-lower', { ...CLEAN, 'web/src/resources/leads.mesa': resource('leads') })
    const { findings } = only(root, 'resource-file-name')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/should be Lead\.mesa/)
  })

  test('two Resources in one file is an error', () => {
    const root = tree('r-two', {
      ...CLEAN,
      'web/src/resources/Lead.mesa':
        `<script module>\n  import { createResource } from '@frontierjs/sierra/junction'\n` +
        `  export const leads = createResource('leads')\n` +
        `  export const tags  = createResource('tags')\n</script>\n`,
    })
    const { findings } = only(root, 'resource-one-per-file')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/leads, tags/)
  })
})

describe('the silent config hazards', () => {
  test('a vite config with no strictPort is an error', () => {
    const root = tree('v-port', {
      ...CLEAN,
      'web/config/vite.config.js': 'export default { server: { port: 8010 } }\n',
    })
    const { findings } = only(root, 'vite-strict-port')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/hops to the next free port/)
  })

  test('the body tag inside a comment is an error, with the line', () => {
    const root = tree('b-comment', {
      ...CLEAN,
      'web/index.html': '<!doctype html>\n<!--\n  a theme goes on <body>\n-->\n<body></body>\n',
    })
    const { findings } = only(root, 'body-tag-in-comment')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(2)
  })

  test('a body tag outside a comment is fine', () => {
    expect(only(tree('b-ok', CLEAN), 'body-tag-in-comment').findings).toEqual([])
  })
})

describe('what the runner reports about itself', () => {
  test('a rule with nothing to look at is skipped, not passed', () => {
    const root = tree('bare', { 'db/schema.lite': SCHEMA, 'api/app.ts': '// api\n' })
    const { findings, skipped } = runChecks({ root, only: ['vite-strict-port', 'resource-file-name'] })
    expect(findings).toEqual([])
    expect(skipped.map(s => s.rule).sort()).toEqual(['resource-file-name', 'vite-strict-port'])
  })

  test('an allowance moves a finding aside and keeps its reason', () => {
    const root = tree('allowed', {
      ...CLEAN,
      'web/config/vite.config.js': 'export default { server: { port: 8010 } }\n',
    })
    const { findings, allowed, stale } = runChecks({
      root, only: ['vite-strict-port'],
      allow: { 'vite-strict-port:web/config/vite.config.js': 'the drive starts it on a claimed port' },
    })
    expect(findings).toEqual([])
    expect(allowed).toHaveLength(1)
    expect(allowed[0].why).toMatch(/claimed port/)
    expect(stale).toEqual([])
  })

  test('an allowance nothing used is reported as stale', () => {
    const { stale } = runChecks({
      root: tree('stale', CLEAN), only: ['vite-strict-port'],
      allow: { 'vite-strict-port:web/config/vite.config.js': 'fixed long ago' },
    })
    // An exception that outlives the thing it excused is an unenforced rule
    // nobody knows is unenforced.
    expect(stale).toEqual(['vite-strict-port:web/config/vite.config.js'])
  })

  test('findApps finds a schema, and does not descend into node_modules', () => {
    tree('apps/one', CLEAN)
    tree('apps/node_modules/pkg', { 'db/schema.lite': SCHEMA })
    const found = findApps(join(ROOT, 'apps')).map(p => p.replace(ROOT + '/', ''))
    expect(found).toEqual(['apps/one'])
  })
})

describe('the widget surface', () => {
  test('a widgets-only project is a whole project, not a broken one', () => {
    // No api/, no web/. The product is the embeddable scripts; a rule that
    // demands the other two surfaces here would be turned off rather than obeyed.
    const root = tree('w-only', {
      'db/schema.lite':                  SCHEMA,
      'widgets/config/vite.config.js':   'export default { server: { strictPort: true } }\n',
      'widgets/src/Embeds/Booking.mesa': '<button>book</button>\n',
    })
    expect(only(root, 'app-layout').findings).toEqual([])
    expect(only(root, 'widget-entry-name').findings).toEqual([])
  })

  test('widgets inside web/ are a surface in the wrong place', () => {
    // Silent when wrong: they build with the SPA, share its port and its
    // release, and the first symptom is a widget shipping when the app does.
    const root = tree('w-nested', { ...CLEAN, 'web/src/Embeds/Booking.mesa': '<button>b</button>\n' })
    const { findings } = only(root, 'app-layout')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/peer of web\//)
  })

  test('a lowercase widget name is an error, because it is also the tag', () => {
    const root = tree('w-case', { ...CLEAN, 'widgets/src/Embeds/booking.mesa': '<button>b</button>\n' })
    const { findings } = only(root, 'widget-entry-name')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no dash/)
  })

  test('a directory of components with no index builds nothing, and says so', () => {
    // Discovery is per directory. Without an index this is another widget's
    // parts — correct for `Shared/`, and wrong for a widget half-written.
    const root = tree('w-noindex', { ...CLEAN, 'widgets/src/Embeds/Chat/Bubble.mesa': '<p></p>\n' })
    const { findings } = only(root, 'widget-entry-name')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no index\.mesa/)
  })

  test('a widget with parts is one widget', () => {
    // CLEAN already carries LeadForm/index.mesa + Field.mesa. The assertion is
    // that the part does not fire anything — it is not a widget with a bad name.
    expect(only(tree('w-parts', CLEAN), 'widget-entry-name').findings).toEqual([])
  })
})

describe('the extension surface', () => {
  test('an extension-only project is a whole project', () => {
    const root = tree('e-only', {
      'db/schema.lite':                    SCHEMA,
      'extension/config/jetty.config.js':  'export default { name: "x" }\n',
      'extension/src/harbor/index.js':     '// harbor\n',
    })
    expect(only(root, 'app-layout').findings).toEqual([])
  })

  test('an extension inside web/ is a surface in the wrong place', () => {
    // `src/harbor/` is jetty's service worker and belongs to nothing else, so
    // it is the one marker that cannot mean something in another realm.
    const root = tree('e-nested', { ...CLEAN, 'web/src/harbor/index.js': '// harbor\n' })
    const { findings } = only(root, 'app-layout')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/MANIFEST/)
  })
})

describe('the repo scope', () => {
  test('a fifth markdown file at a package root is a WARNING that names it', () => {
    // Ruled 2026-08-14: the four are the standard and a fifth is a question, not
    // a refused build — the rule cannot tell a stray design note from the next
    // thing everyone needs at the root, and it was refusing both. The severity
    // is the assertion here: as an error this stopped CI for a generated
    // snapshot file, which is how the ruling got asked for.
    const root = tree('repo', {
      'packages/thing/package.json': '{}',
      'packages/thing/README.md':    '#\n',
      'packages/thing/CLAUDE.md':    '#\n',
      'packages/thing/NOTES.md':     '#\n',
    })
    const { findings } = runChecks({ root, scope: 'repo' })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toMatch(/NOTES\.md/)
  })

  test('a generated *.snapshot.md at a package root says nothing at all', () => {
    // Gated output, not documentation. It cannot move — CI reruns each
    // snapshot's generator from the file's own directory — so warning about it
    // every run would be a permanent note nobody can act on.
    const root = tree('repo-snap', {
      'packages/thing/package.json':    '{}',
      'packages/thing/README.md':       '#\n',
      'packages/thing/routes.snapshot.md': '#\n',
    })
    expect(runChecks({ root, scope: 'repo' }).findings).toEqual([])
  })

  test('the four named ones are not', () => {
    const root = tree('repo-ok', {
      'packages/thing/package.json':     '{}',
      'packages/thing/README.md':        '#\n',
      'packages/thing/CLAUDE.md':        '#\n',
      'packages/thing/PROJECT_STATE.md': '#\n',
      'packages/thing/CHANGES.md':       '#\n',
      'packages/thing/docs/DEPTH.md':    '#\n',
    })
    expect(runChecks({ root, scope: 'repo' }).findings).toEqual([])
  })
})
