// checks.test.js — the architecture rules.
//
// Every rule gets two tests: one tree that violates it and one that does not.
// A rule with only the first is a rule that might fire on everything, and a rule
// with only the second is a rule that might fire on nothing — and the second is
// the failure this whole file exists to prevent, because it passes.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { RULES, runChecks, findApps, applyFixes,
         BASELINE_FILE, readBaseline, gradeBaseline, writeBaseline } from '../core/checks.js'

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

// `Lead` carries a state machine so `transition-methods` RUNS over the clean
// tree — a rule that only ever skips is what this file exists to catch. Both
// moves are UNGATED deliberately: a transition `@gate(N)` is a level
// `declaredGates()` counts, and one here would move what `gate-unreachable`
// reports as the worst level in every other test in this file.
const SCHEMA = `
// Declared row tenancy, so \`service-as-system\` RUNS on the clean tree rather
// than skipping — a rule that only ever skips is the failure this file exists to
// prevent, and it is the strategy under which asSystem() can cross a tenant at
// all. Both models carry the column, which is what the declaration requires.
tenancy { strategy row  column workspaceId  claim workspaceId }

enum LeadStatus { new qualified closed }

// Declares the grid with a FLAT gate, so \`capability-ladder\` RUNS on the clean
// tree rather than skipping, and finds nothing — which is the shape a model
// graded by capability is meant to be in: the ladder at the read floor, the
// authority in the grant.
model Account {
  id          Int    @id
  name        String
  workspaceId Int
  @@gate("2")
  @@capabilities
}
model Lead {
  id          Int    @id
  name        String
  accountId   Int
  workspaceId Int
  status      LeadStatus @default(new)
  @@gate(read: READER, write: USER, delete: ADMINISTRATOR)
  @@transitions(status,
    qualify: new              -> qualified,
    close:   [new, qualified] -> closed)
}

// A polymorphic pair, declared the way the rule asks for, so
// \`polymorphic-subject\` RUNS on the clean tree rather than skipping — and finds
// nothing, which is the shape an open target set is meant to be in: no foreign
// key, and the one column that CAN carry a rule carrying one.
enum NoteSubject { Account Lead }

model Note {
  id          Int         @id
  workspaceId Int
  subjectType NoteSubject
  subjectId   Int
  @@gate("2")
  @@index([subjectType, subjectId])
}
`

const resource = (service, opts = '') => `<script module>
  import { createResource } from '@frontierjs/sierra/junction'
  export const ${service} = createResource('${service}'${opts ? `, { ${opts} }` : ''})
</script>
`

/** The shape a passing app has — every rule runs, nothing fires. */
const CLEAN = {
  // The schema PLUS a logger database, so `log-db-unbound` RUNS on the clean
  // tree rather than skipping — a rule that only ever skips is the failure this
  // file exists to prevent — and finds nothing, because the path is written as
  // an `env()` and the key file declares the variable. That pair is the shape
  // an app with a trail is meant to be in: the deploy binds it under the volume
  // it mounts, and the trail survives the swap that replaces the container.
  'db/schema.lite':
    SCHEMA + '\ndatabase audit { path env("AUDIT_PATH", "./db/audit/") driver logger retention 90d }\n',
  'frontier.config.js': "export default { deploy: { server: 'x.test', path: '/apps/x' } }\n",
  '.env.example':       'AUDIT_PATH=/db/audit/\n',
  // A dependency that ships a schema fragment, and no copy of its model here.
  // Present so `package-model-drift` RUNS on the clean tree rather than skipping
  // — a rule that only ever skips is the failure this file exists to prevent —
  // and its absence of findings is the shape an app is meant to be in: import
  // the file, declare nothing twice.
  'package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/kit': '*', '@acme/skin': '*' } }),
  // A dependency that ships CSS, so `css-token-undefined` RUNS on the clean tree
  // rather than skipping. The token below is the one the clean page reads.
  'node_modules/@acme/skin/package.json':
    JSON.stringify({ name: '@acme/skin', exports: { './index.css': './src/index.css' } }),
  'node_modules/@acme/skin/src/index.css':
    ':root { --gap: 1rem; --rule: #ddd; }\n',
  'node_modules/@acme/kit/package.json':
    JSON.stringify({ name: '@acme/kit', exports: { './schema.lite': './db/kit.lite' } }),
  'node_modules/@acme/kit/db/kit.lite':
    'model Token {\n  id String @id @default(uuid())\n}\n',
  // Invariant 3, both halves. Configuration in config/, because junction
  // resolves that directory whether or not the app meant it to, so absent means
  // a path that goes nowhere. And source in src/, with only the ENTRY beside
  // it — the file a runner is pointed at, which starts the app that app.ts
  // assembles without starting.
  'api/index.ts':                       "import app from './src/app.ts'\nawait app.start()\n",
  'api/src/app.ts':                     '// api\n',
  'api/config/junction.config.js':      'export default {}\n',
  'web/index.html':                     '<!doctype html>\n<body><div id="app"></div></body>\n',
  'web/config/vite.config.js':          'export default { server: { port: 8010, strictPort: true } }\n',
  // A `const` local read, so `detail-read-dead` RUNS over the clean tree rather
  // than skipping — a rule that only ever skips is what this file exists to
  // catch — and finds nothing, because a one-shot read is not the defect.
  // The style block reads a token the dependency above declares and one the file
  // declares itself, which is the shape `css-token-undefined` must stay quiet on.
  'web/src/pages/lead.mesa':            "<script>\n  async function label(id) {\n" +
                                        "    const row = await leads.service.get(id)\n" +
                                        "    return row.name\n  }\n</script>\n" +
                                        "<style>\n  .card { --pad: 4px; gap: var(--gap); padding: var(--pad) }\n</style>\n",
  'web/src/resources/Lead.mesa':        resource('leads'),
  'web/src/resources/Account.mesa':     resource('accounts'),
  // The third surface. It is in the clean app because every rule must RUN
  // here — a rule that only ever skips is the failure this file exists to
  // catch, and `widget-entry-name` skips wherever widgets/ is absent.
  'widgets/config/vite.config.js':      'export default { server: { port: 8200, strictPort: true } }\n',
  'widgets/src/Embeds/Booking.mesa':    '<button>book</button>\n',
  'widgets/src/Embeds/LeadForm/index.mesa': '<form></form>\n',
  'widgets/src/Embeds/LeadForm/Field.mesa': '<input>\n',
  // The deploy pair, here for the same reason the third surface is: every rule
  // must RUN over this tree. `migration-history` only applies to an app whose
  // container replays migrations on boot, so without a Dockerfile naming
  // `db:migrate` it would skip — and a rule that only ever skips is what this
  // file exists to catch.
  'deploy/Dockerfile':                  'FROM oven/bun\nCMD ["sh","-c","bun run db:migrate && bun run start"]\n',
  'db/migrations/20260101000000_init.sql': 'CREATE TABLE "lead" ("id" INTEGER);\n',
  // And the service, for the same reason: `service-model` skips an app with no
  // `*.service.*` file in it, so without one here the rule would only ever skip.
  // It also drives both of `Lead`'s declared moves, one by NAME and one by the
  // state it moves to — the two spellings `transition-methods` accepts, so the
  // clean tree exercises both branches of its reachability test.
  'api/src/services/leads.service.ts':
    "import { createBaseService } from '@frontierjs/junction'\n" +
    "export default () => createBaseService({})\n" +
    "export const qualify = () => $.db.lead.transition($.id, 'qualify')\n" +
    "export const close   = () => $.db.lead.update({ where: {}, data: { status: 'closed' } })\n",
  // The resolver, for the third time: SCHEMA declares a delete gate at
  // ADMINISTRATOR(5), which nothing can reach without one — so `gate-unreachable`
  // runs here and is answered. It is its own file rather than a line in app.ts
  // because the `api()` helper below replaces app.ts wholesale, and a comment
  // would not do: readCode blanks those before a rule sees them.
  'api/src/core/gate.ts':
    "import { sessionGateLevel } from '@frontierjs/junction'\nexport const getLevel = (u) => sessionGateLevel(u)\n",
  // The fourth surface, for the same reason as the third: both static rules skip
  // an app with no `target: 'static'` config, and a rule that only ever skips is
  // what this file exists to catch. It wires `db`, which is the thing the
  // publish check taps, and declares no `publishes:`.
  'site/config/sierra.config.js':
    "export default {\n  target: 'static',\n  routesDir: 'src/routes',\n  db: '../api/src/core/db.ts',\n}\n",
  'site/src/routes/index.mesa':   '---\nrender: static\n---\n<h1>catalogue</h1>\n',
  'site/src/routes/index.meta.js': 'export async function load() { return { products: [] } }\n',
}

const only = (root, id, extra = {}) => runChecks({ root, only: [id], ...extra })

/**
 * CLEAN without a whole directory — `without('api/')`.
 *
 * Named rather than destructured, because a test that lists the files it is
 * removing breaks the day CLEAN grows one, and it breaks by ASSERTING THE WRONG
 * THING rather than by failing to compile.
 */
const without = (prefix, extra = {}) => ({
  ...Object.fromEntries(Object.entries(CLEAN).filter(([path]) => !path.startsWith(prefix))),
  ...extra,
})

// ─── migration-history ────────────────────────────────────────────────────────

describe('migration-history', () => {
  const DOCKER = 'FROM oven/bun\nCMD ["sh","-c","bun run db:migrate && bun run start"]\n'

  test('an app that migrates on boot with no migration to replay is an error', () => {
    // The measured shape of FJS-345: the image builds, starts, answers /health
    // and 500s on the first write, because `migrate apply` had no files.
    const root = tree('mh-none', {
      'db/schema.lite': SCHEMA, 'deploy/Dockerfile': DOCKER,
    })
    const { findings } = only(root, 'migration-history')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/no migration to replay/)
  })

  test('a migration one directory deep counts — a multi-database schema keeps them there', () => {
    const root = tree('mh-nested', {
      'db/schema.lite': SCHEMA, 'deploy/Dockerfile': DOCKER,
      'db/migrations/main/20260101000000_init.sql': 'CREATE TABLE "lead" ("id" INTEGER);\n',
    })
    expect(only(root, 'migration-history').findings).toEqual([])
  })

  test('an app with no Dockerfile is skipped, not passed', () => {
    const root = tree('mh-nodocker', { 'db/schema.lite': SCHEMA })
    const { findings, skipped } = only(root, 'migration-history')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  test('an entrypoint that does not migrate is skipped', () => {
    // basecamp runs its migrations inside app.ts and has no db:migrate script,
    // on purpose (FJS-417). Asserting the script unconditionally blocked a
    // deploy that works.
    const root = tree('mh-noboot', {
      'db/schema.lite': SCHEMA,
      'deploy/Dockerfile': 'FROM oven/bun\nCMD ["bun","run","start"]\n',
    })
    const { findings, skipped } = only(root, 'migration-history')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

// ─── surface-config ───────────────────────────────────────────────────────────

describe('surface-config', () => {
  const withApi = (extra) => ({ 'db/schema.lite': SCHEMA, 'api/app.ts': '// api\n', ...extra })

  test('an api/ with no config/ is a finding', () => {
    const root = tree('sc-none', withApi({}))
    const { findings } = only(root, 'surface-config')
    expect(findings.length).toBe(1)
    expect(findings[0].message).toMatch(/no config\//)
  })

  test('a config file at the surface root is the sharper finding', () => {
    const root = tree('sc-stray', withApi({ 'api/junction.config.js': 'export default {}\n' }))
    const { findings } = only(root, 'surface-config')
    expect(findings.length).toBe(1)
    expect(findings[0].message).toMatch(/sits at the surface root/)
  })

  test('a config file BESIDE a config/ names the ambiguity', () => {
    const root = tree('sc-both', withApi({
      'api/junction.config.js':        'export default {}\n',
      'api/config/junction.config.js': 'export default {}\n',
    }))
    const { findings } = only(root, 'surface-config')
    expect(findings.length).toBe(1)
    expect(findings[0].message).toMatch(/sits beside/)
  })

  test('config/ present is clean, even holding nothing this rule knows', () => {
    const root = tree('sc-ok', withApi({ 'api/config/junction.config.js': 'export default {}\n' }))
    expect(only(root, 'surface-config').findings).toEqual([])
  })

  test('a surface directory with no source in it is not judged', () => {
    // A directory somebody made is not a surface yet. Scolding it is how a rule
    // gets turned off.
    const root = tree('sc-empty', { 'db/schema.lite': SCHEMA, 'api/notes.md': 'later\n',
                                    'web/config/vite.config.js': 'export default {}\n',
                                    'web/src/main.js': '// x\n' })
    expect(only(root, 'surface-config').findings).toEqual([])
  })

  test('a schema with no surface beside it skips rather than fires', () => {
    const root = tree('sc-fixture', { 'db/schema.lite': SCHEMA })
    expect(only(root, 'surface-config').skipped.length).toBe(1)
  })
})

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

describe('package-model-drift', () => {

  // A package that ships a `.lite` and an app that declares one of its models
  // anyway. Both halves happen legitimately — `@frontierjs/auth` ships one file
  // to be IMPORTED and one to be appended and grown — so the copy itself decides
  // nothing and the rule is about the columns the package declares.

  const DEP = (files) => Object.fromEntries(Object.entries(files)
    .map(([k, v]) => [`node_modules/@acme/kit/${k}`, v]))

  const KIT = {
    ...DEP({
      'package.json': JSON.stringify({ name: '@acme/kit', exports: { './schema.lite': './db/kit.lite' } }),
      'db/kit.lite': [
        'model Token {',
        '  id      String  @id @default(uuid())',
        '  secret  String  @secret',
        '  label   String?',
        '}',
      ].join('\n'),
    }),
    'package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/kit': '*', '@acme/skin': '*' } }),
  // A dependency that ships CSS, so `css-token-undefined` RUNS on the clean tree
  // rather than skipping. The token below is the one the clean page reads.
  'node_modules/@acme/skin/package.json':
    JSON.stringify({ name: '@acme/skin', exports: { './index.css': './src/index.css' } }),
  'node_modules/@acme/skin/src/index.css':
    ':root { --gap: 1rem; --rule: #ddd; }\n',
  }

  const withModel = (body) => ({ ...CLEAN, ...KIT, 'db/schema.lite': SCHEMA + '\n' + body })

  test('a column declared differently from the package is a warning naming both', () => {
    // The measured case: `@secret` becomes `@guarded` in the copy, so the
    // column stops being encrypted and the package goes on writing to it.
    const root = tree('pmd-drift', withModel([
      'model Token {',
      '  id      String  @id @default(uuid())',
      '  secret  String  @guarded',
      '  label   String?',
      '}',
    ].join('\n')))

    const { findings } = only(root, 'package-model-drift')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toContain('@secret')       // what the package says
    expect(findings[0].message).toContain('@guarded') // what this says
    expect(findings[0].message).toContain('@acme/kit')
  })

  test('a column the package declares and the copy omits is a warning too', () => {
    // The package's code still writes to it; the copy has no column to take it.
    const root = tree('pmd-missing', withModel([
      'model Token {',
      '  id      String  @id @default(uuid())',
      '  secret  String  @secret',
      '}',
    ].join('\n')))

    const { findings } = only(root, 'package-model-drift')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/missing its column 'label'/)
  })

  // ── and the half that makes it a rule rather than a tripwire ───────────────

  test('a column the APP added is not a finding', () => {
    // This is what an app does to a model a package ships to be extended —
    // auth's `User` grows a dozen. A rule that fired here would fire on every
    // correct install, which is why it is keyed on the package's columns alone.
    const root = tree('pmd-added', withModel([
      'model Token {',
      '  id        String    @id @default(uuid())',
      '  secret    String    @secret',
      '  label     String?',
      '  ownerId   String?',
      '  createdAt DateTime  @default(now())',
      '}',
    ].join('\n')))

    expect(only(root, 'package-model-drift').findings).toEqual([])
  })

  test('a model-level attribute the app added is not a finding', () => {
    // `@@tenant(none)`, `@@log(audit)` and the app's own policies are the app's
    // business by construction — they are the three things a package cannot know.
    const root = tree('pmd-attrs', withModel([
      'model Token {',
      '  id      String  @id @default(uuid())',
      '  secret  String  @secret',
      '  label   String?',
      '  @@tenant(none)',
      '  @@log(audit)',
      '  @@allow(\'read\', ownerId == auth().id)',
      '}',
    ].join('\n')))

    expect(only(root, 'package-model-drift').findings).toEqual([])
  })

  test('realigning a column is not a change to it', () => {
    // The declaration is compared with runs of whitespace collapsed, because
    // this house aligns columns and a formatter pass is not a schema change.
    const root = tree('pmd-align', withModel([
      'model Token {',
      '  id String @id @default(uuid())',
      '  secret        String   @secret',
      '  label   String?   // what a person calls it',
      '}',
    ].join('\n')))

    expect(only(root, 'package-model-drift').findings).toEqual([])
  })

  test('a model the app does not declare at all is silent — that is the import', () => {
    // The whole point: import the file and the rule has nothing to compare,
    // because there is no second declaration to disagree with the first.
    const root = tree('pmd-imported', { ...CLEAN, ...KIT })
    expect(only(root, 'package-model-drift').findings).toEqual([])
  })

  // Two rules pulling against each other, reconciled here. `polymorphic-subject`
  // asks an app to constrain exactly this kind of column, and a package cannot
  // ship the constraint because it cannot know the app's set — so an app that
  // takes the advice must not be reported for having taken it.
  describe('a bare scalar tightened into a declared set', () => {
    const LOOSE = {
      ...DEP({
        'package.json': JSON.stringify({ name: '@acme/kit', exports: { './schema.lite': './db/kit.lite' } }),
        'db/kit.lite': [
          'model Event {',
          '  id           String  @id @default(uuid())',
          '  subjectType  String?',
          '}',
        ].join('\n'),
      }),
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/kit': '*' } }),
    }
    const app = (name, line) => tree(`pmd-narrow-${name}`, {
      ...CLEAN, ...LOOSE,
      'db/schema.lite': SCHEMA +
        '\nenum Subject { Order Invoice }\n\nmodel Event {\n  id           String  @id @default(uuid())\n' +
        line + '\n}\n',
    })

    test('an enum in place of the package’s String is not drift', () => {
      expect(only(app('enum', '  subjectType  Subject?'), 'package-model-drift').findings).toEqual([])
    })

    test('but dropping the ? is, because it refuses a write the package makes', () => {
      const { findings } = only(app('required', '  subjectType  Subject'), 'package-model-drift')
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain('subjectType')
    })

    test('and a different scalar is a change rather than a narrowing', () => {
      expect(only(app('scalar', '  subjectType  Int?'), 'package-model-drift').findings).toHaveLength(1)
    })

    test('an attribute the package declares still has to survive the narrowing', () => {
      // The narrowing is about the TYPE alone. Everything after it is compared
      // as before, or an attribute could be dropped by spelling the type as an
      // enum.
      expect(only(app('attr', '  subjectType  Subject? @default("Order")'), 'package-model-drift').findings).toHaveLength(1)
    })
  })

  test('a dependency that ships no .lite is skipped by name', () => {
    const root = tree('pmd-none', {
      ...CLEAN,
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/plain': '*' } }),
      'node_modules/@acme/plain/package.json': JSON.stringify({ name: '@acme/plain', exports: { '.': './index.js' } }),
    })
    expect(only(root, 'package-model-drift').skipped).toBeTruthy()
  })
})

describe('resources', () => {
  test('a .js in src/resources/ is an error', () => {
    const root = tree('r-js', { ...CLEAN, 'web/src/resources/helpers.js': 'export const x = 1\n' })
    const { findings } = only(root, 'resource-dir-mesa')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/\.mesa file/)
  })

  test('a resource with only a plain <script> is an error', () => {
    const root = tree('r-script', {
      ...CLEAN,
      'web/src/resources/Account.mesa': '<script>\n  export const accounts = 1\n</script>\n<div>hi</div>\n',
    })
    const { findings } = only(root, 'resource-script')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/script module/)
  })

  // Invariant 18 as amended (`FJS-D112`): the markup IS the model's default
  // form, so a resource that carries one must not be a finding. This is the
  // case the rule used to fail, and it is the shape every scaffolded page is
  // about to be written against.
  test('markup and an instance <script> beside the module script are fine', () => {
    const root = tree('r-form', {
      ...CLEAN,
      'web/src/resources/Account.mesa':
        "<script module>\n  import { createResource } from '@frontierjs/sierra/junction'\n" +
        "  export const accounts = createResource('accounts')\n</script>\n" +
        '<script>\n  let record = {}\n</script>\n<Form resource={accounts} {record} />\n',
    })
    expect(only(root, 'resource-script').findings).toEqual([])
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

  test('a commented body tag ABOVE the real one is an error, at the mention', () => {
    const root = tree('b-comment', {
      ...CLEAN,
      'web/index.html': '<!doctype html>\n<!--\n  a theme goes on <body>\n-->\n<body></body>\n',
    })
    const { findings } = only(root, 'body-tag-in-comment')
    expect(findings).toHaveLength(1)
    // The mention, not the comment it sits in — that is the token to delete.
    expect(findings[0].line).toBe(3)
  })

  test('a body tag outside a comment is fine', () => {
    expect(only(tree('b-ok', CLEAN), 'body-tag-in-comment').findings).toEqual([])
  })

  // `FJS-329`. Vite injects at the FIRST textual match, so a mention below the
  // real tag is already too late to do harm — and flagging it made this rule
  // fire on a file that documents its own markup. A check that cries wolf is
  // the failure the engine exists to prevent.
  test('a commented body tag BELOW the real one is not a finding', () => {
    const root = tree('b-below', {
      ...CLEAN,
      'web/index.html':
        '<!doctype html>\n<body>\n<!--\n  the scripts below are inside <body>, so the shell renders into a div\n-->\n<div id="app"></div>\n</body>\n',
    })
    expect(only(root, 'body-tag-in-comment').findings).toEqual([])
  })

  test('a file whose ONLY body tag is commented is still an error', () => {
    const root = tree('b-only', {
      ...CLEAN,
      'web/index.html': '<!doctype html>\n<!--\n  <body> goes here eventually\n-->\n<div id="app"></div>\n',
    })
    expect(only(root, 'body-tag-in-comment').findings).toHaveLength(1)
  })

  test('a closing tag is not the injection point, so it is not a match', () => {
    const root = tree('b-closing', {
      ...CLEAN,
      'web/index.html': '<!doctype html>\n<!--\n  everything before </body>\n-->\n<body></body>\n',
    })
    expect(only(root, 'body-tag-in-comment').findings).toEqual([])
  })
})

// ─── surface-src ──────────────────────────────────────────────────────────────

describe('surface-src', () => {
  test('a surface with every file at its root is a finding', () => {
    // `example`'s measured shape: api/app.ts, api/db.ts, api/gate.ts and the
    // rest beside them, with no src/ and no entry. It passed `app-layout` and
    // `surface-config` — both of which it satisfies — for as long as it existed.
    const root = tree('ss-flat', without('api/', {
      'api/config/junction.config.js': 'export default {}\n',
      'api/app.ts':                    '// api\n',
      'api/db.ts':                     '// db\n',
    }))
    const { findings } = only(root, 'surface-src')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/api\/ has no src\//)
    // The names are in the message: "no src/" is a shape, and what the reader
    // needs is which files it is talking about.
    expect(findings[0].message).toMatch(/app\.ts/)
  })

  test('a stray module beside src/ is a finding, and the entry is not', () => {
    const root = tree('ss-stray', { ...CLEAN, 'api/seed.ts': '// seed\n' })
    const { findings } = only(root, 'surface-src')
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toMatch(/api\/seed\.ts$/)
  })

  test('a config file at the surface root belongs to surface-config, not here', () => {
    // Two rules pointing at one file teaches the reader to skip both.
    const root = tree('ss-config', {
      ...CLEAN,
      'web/vite.config.js': 'export default { server: { strictPort: true } }\n',
    })
    expect(only(root, 'surface-src').findings).toEqual([])
    expect(only(root, 'surface-config').findings).toHaveLength(1)
  })

  test('a surface entered through index.html has no root script and does not fire', () => {
    // web/ and widgets/ are two of the four surfaces and neither has an entry
    // script. A rule that read "no entry beside src/" as a finding would fire
    // on the normal case for half of them.
    expect(only(tree('ss-html', CLEAN), 'surface-src').findings).toEqual([])
  })

  test('a surface directory with nothing in it is skipped, not passed', () => {
    const root = tree('ss-empty', { 'db/schema.lite': SCHEMA, 'web/.keep': '' })
    const { findings, skipped } = only(root, 'surface-src')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
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

describe('the site surface', () => {
  test('a site-only project is a whole project', () => {
    // db/ + api/ + site/ and no SPA: a project whose whole product is a public
    // site with live islands is a normal FrontierJS project.
    const root = tree('s-only', {
      'db/schema.lite':             SCHEMA,
      'site/config/sierra.config.js': "export default { target: 'static' }\n",
      'site/config/vite.config.js':   'export default { server: { strictPort: true } }\n',
      'site/src/routes/index.mesa':   '<h1>hi</h1>\n',
    })
    expect(only(root, 'app-layout').findings).toEqual([])
    expect(only(root, 'surface-config').findings).toEqual([])
  })

  test("a `target: 'static'` config inside web/ is a surface in the wrong place", () => {
    // The one folded surface that reads as reasonable while it is written: a
    // second config beside the first looks like two targets of one app. Four
    // answers differ, and the OUTPUT is the decisive one — one Vite root means
    // the site's dist/ sits inside the SPA's, and `vite build` empties outDir.
    const root = tree('s-nested', {
      ...CLEAN,
      'web/config/sierra.static.config.js':
        "export default { target: 'static', routesDir: 'src/public-site' }\n",
    })
    const { findings } = only(root, 'app-layout')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/prerendered site inside web\//)
    expect(findings[0].message).toMatch(/empties outDir/)
  })

  test('the SPA\'s own config is not a static site, whatever else it says', () => {
    // The rule reads `target:` and nothing else. A config mentioning the word
    // static in a comment or a path must not fire it, or the rule is noise.
    const root = tree('s-spa', {
      ...CLEAN,
      'web/config/sierra.config.js':
        "// static assets live in public/\nexport default { target: 'spa' }\n",
    })
    expect(only(root, 'app-layout').findings).toEqual([])
  })

  test('site/ keeps its configuration in config/, like every other surface', () => {
    const root = tree('s-stray', {
      'db/schema.lite':             SCHEMA,
      'site/sierra.config.js':      "export default { target: 'static' }\n",
      'site/src/routes/index.mesa': '<h1>hi</h1>\n',
    })
    const { findings } = only(root, 'surface-config')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/site\/config\//)
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
      'packages/thing/package.json':     '{}',
      'packages/thing/README.md':        '#\n',
      'packages/thing/CLAUDE.md':        '#\n',
      'packages/thing/PROJECT_STATE.md': '#\n',
      'packages/thing/CHANGES.md':       '#\n',
      'packages/thing/NOTES.md':         '#\n',
    })
    const { findings } = runChecks({ root, scope: 'repo' })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toMatch(/NOTES\.md/)
  })

  test('a MISSING one of the four is a finding that names it', () => {
    // The other half of the same rule, and the half that was never reported:
    // building `allowed` and reporting what is not in it catches a fifth file
    // and can never catch an absent fourth. Seven packages were short a
    // standard file with this check green over all of them (FJS-309).
    const root = tree('repo-short', {
      'packages/thing/package.json': '{}',
      'packages/thing/README.md':    '#\n',
      'packages/thing/CLAUDE.md':    '#\n',
    })
    const { findings } = runChecks({ root, scope: 'repo' })
    expect(findings.map(f => f.message).join(' ')).toMatch(/PROJECT_STATE\.md is missing/)
    expect(findings.map(f => f.message).join(' ')).toMatch(/CHANGES\.md is missing/)
    expect(findings).toHaveLength(2)
  })

  test('a missing file is allowed by its own PATH, not by its package', () => {
    // The finding points at the absent file rather than at the directory,
    // because an allowance is keyed by path: excusing a package its fifth file
    // would otherwise excuse it every missing one too.
    const root = tree('repo-allow', {
      'packages/thing/package.json':     '{}',
      'packages/thing/README.md':        '#\n',
      'packages/thing/CLAUDE.md':        '#\n',
      'packages/thing/PROJECT_STATE.md': '#\n',
      'packages/thing/NOTES.md':         '#\n',
    })
    const { findings, allowed } = runChecks({
      root, scope: 'repo',
      allow: { 'package-root-md:packages/thing': 'NOTES.md belongs at the root' },
    })
    expect(allowed).toHaveLength(1)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/CHANGES\.md is missing/)
  })

  test('a generated *.snapshot.md at a package root says nothing at all', () => {
    // Gated output, not documentation. It cannot move — CI reruns each
    // snapshot's generator from the file's own directory — so warning about it
    // every run would be a permanent note nobody can act on.
    const root = tree('repo-snap', {
      'packages/thing/package.json':       '{}',
      'packages/thing/README.md':          '#\n',
      'packages/thing/CLAUDE.md':          '#\n',
      'packages/thing/PROJECT_STATE.md':   '#\n',
      'packages/thing/CHANGES.md':         '#\n',
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


describe('drive-preamble', () => {

  // `CLAUDE.md`'s *Start first* column is now read: `runnables.js` puts it on the
  // drive's row so one button runs the whole thing. Which makes a renamed script
  // worse than it was — the advice is no longer only read by a person who can
  // see it is wrong, it is pressed.

  const withTable = (cell) => ({
    'package.json':          '{"name":"ws"}',
    'shop/db/schema.lite':   'model Order {\n  id Int @id\n}\n',
    'shop/api/index.ts':     '',
    'shop/package.json':     JSON.stringify({ name: 'shop', scripts: { api: 'x', 'db:seed': 'y', 'verify:live': 'z' } }),
    'CLAUDE.md': [
      '| Drive | Start first | Covers |', '| --- | --- | --- |',
      `| \`shop\`: \`verify:live\` | ${cell} | x |`, '',
    ].join('\n'),
  })

  test('a step the directory does not declare is an error naming both', () => {
    const root = tree('dp-gone', withTable('`bun run db:reseed`'))
    const { findings } = only(root, 'drive-preamble', { scope: 'repo' })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('error')
    expect(findings[0].message).toMatch(/db:reseed/)
    expect(findings[0].message).toMatch(/shop declares no such script/)
  })

  test('a step that resolves is not', () => {
    const root = tree('dp-ok', withTable('`bun run db:seed`, then `bun run api`'))
    expect(only(root, 'drive-preamble', { scope: 'repo' }).findings).toEqual([])
  })

  test('prose after the em-dash is not graded as a step', () => {
    // The rule inherits the parser's guard, and without it every parenthetical
    // in the real table is an error against a script nobody meant to name.
    const root = tree('dp-prose', withTable('`bun run api` — it also starts `bun run nonsense` on 8112'))
    expect(only(root, 'drive-preamble', { scope: 'repo' }).findings).toEqual([])
  })

  test('a project with no drive table skips rather than passing', () => {
    // A rule that silently passes where it cannot see anything is a rule that
    // reads as green over a workspace it never ran on.
    const root = tree('dp-none', { 'package.json': '{"name":"ws"}' })
    const { skipped } = only(root, 'drive-preamble', { scope: 'repo' })
    expect(skipped.map(s => s.rule)).toContain('drive-preamble')
  })

})


describe('dev-host-unique', () => {

  // A dev name is derived from the package name and the surface, so two
  // packages whose names reduce to one label take one name — and whichever
  // started first answers it. `strictPort`'s failure one layer up, and silent
  // in the same way: the page works, and it is the wrong app.

  const app = (dir, name) => ({
    [`${dir}/db/schema.lite`]: 'model A {\n  id Int @id\n}\n',
    [`${dir}/web/src/main.js`]: '',
    [`${dir}/package.json`]: JSON.stringify({ name, scripts: { web: 'vite' } }),
  })

  test('two packages whose names reduce to one label are an error naming both', () => {
    // The directories are `example` and `basecamp` so the two get DIFFERENT
    // ports off the ports table — two apps sharing a name and a port is a port
    // collision, which `strictPort` already refuses loudly, and not the silent
    // one this rule is about.
    const root = tree('host-clash', {
      'package.json': '{"name":"ws"}',
      ...app('example', '@a/shop'),
      ...app('basecamp', '@b/shop'),
    })
    const { findings } = only(root, 'dev-host-unique', { scope: 'repo' })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('error')
    expect(findings[0].message).toMatch(/shop\.localhost/)
    expect(findings[0].message).toMatch(/surface:example\/web/)
    expect(findings[0].message).toMatch(/surface:basecamp\/web/)
  })

  test('two apps with distinct names are not', () => {
    const root = tree('host-ok', {
      'package.json': '{"name":"ws"}',
      ...app('example', 'shop'),
      ...app('basecamp', 'admin'),
    })
    expect(only(root, 'dev-host-unique', { scope: 'repo' }).findings).toEqual([])
  })

})


// ─── the source hazards ───────────────────────────────────────────────────────
//
// Five rules that read a line of an app's own JavaScript. Each gets the pair
// this file demands — a tree that violates it and one that does not — plus, for
// three of them, the case that decides whether the rule is usable at all: the
// same words written in a COMMENT, which is how this repo's own api/ files
// describe every one of these hazards.

const api = (body) => ({ ...CLEAN, 'api/src/app.ts': body })

describe('raw-route-param', () => {
  test('a :name segment in a raw route is an error', () => {
    const root = tree('rr-colon', api("app.get('/orders/:id', h)\n"))
    const { findings } = only(root, 'raw-route-param')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toMatch(/'\/orders\/\{id\}'/)
  })

  test('the router beneath the shortcuts is the same matcher', () => {
    const root = tree('rr-router', api("app.http.router.post('/hooks/:provider', h)\n"))
    expect(only(root, 'raw-route-param').findings).toHaveLength(1)
  })

  test('{id} is the spelling and is not reported', () => {
    const root = tree('rr-brace', api("app.get('/orders/{id}', h)\napp.post('/orders', h)\n"))
    expect(only(root, 'raw-route-param').findings).toEqual([])
  })

  test('a route written inside a comment is not a route', () => {
    const root = tree('rr-comment', api("// app.get('/orders/:id', h) is the shape that 404s\n"))
    expect(only(root, 'raw-route-param').findings).toEqual([])
  })
})

describe('ctx-params', () => {
  test('reading ctx.params is an error', () => {
    const root = tree('cp-read', api('export const guard = ctx => ctx.params.user.isAdmin\n'))
    const { findings } = only(root, 'ctx-params')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/does not exist/)
  })

  test('the four that do exist are not reported', () => {
    const root = tree('cp-real', api(
      'export const guard = ctx => ctx.auth.user && ctx.route.id && ctx.client.ip && ctx.locals.db\n'))
    expect(only(root, 'ctx-params').findings).toEqual([])
  })

  test('a comment saying there is no ctx.params is not a use of it', () => {
    // basecamp's api/src/core/hooks.ts says exactly this, in these words.
    const root = tree('cp-comment', api('/* There is NO ctx.params: the previous version read it. */\n'))
    expect(only(root, 'ctx-params').findings).toEqual([])
  })
})

describe('set-auth-discarded', () => {
  test('calling $setAuth as a statement is an error', () => {
    const root = tree('sa-bare', api('db.$setAuth(user)\nawait db.lead.create({ data })\n'))
    const { findings } = only(root, 'set-auth-discarded')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toMatch(/const scoped = db\.\$setAuth/)
  })

  test('an await in front changes nothing — the client is still dropped', () => {
    const root = tree('sa-await', api('await db.$setAuth(user);\n'))
    expect(only(root, 'set-auth-discarded').findings).toHaveLength(1)
  })

  test('keeping the answer, either way, is the correct shape', () => {
    const root = tree('sa-kept', api(
      'const scoped = db.$setAuth(as("admin", { workspaceId }))\n' +
      'await db.$setAuth(user).lead.create({ data })\n' +
      'return db.$setAuth(user)\n'))
    expect(only(root, 'set-auth-discarded').findings).toEqual([])
  })

  test('a call spanning two lines is left alone rather than guessed at', () => {
    const root = tree('sa-multiline', api('db.$setAuth(\n  user,\n)\n'))
    expect(only(root, 'set-auth-discarded').findings).toEqual([])
  })
})

describe('call-header-declared', () => {
  const CART = "export const CART_HEADER = 'x-cart-token'\n"
  const sets = "getClient().setCallHeader(CART_HEADER, token)\n"

  test('a per-call header the API never declared is an error', () => {
    const root = tree('ch-missing', {
      ...CLEAN,
      'api/src/core/cart.ts': CART,
      'web/src/cart.js':      CART + sets,
    })
    const { findings } = only(root, 'call-header-declared')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/'x-cart-token' is set per call/)
    expect(findings[0].message).toMatch(/callHeaders/)
  })

  test('both halves resolve through a shared constant, which is how apps write it', () => {
    const root = tree('ch-declared', {
      ...CLEAN,
      'api/src/core/cart.ts': CART,
      'api/src/app.ts':       "import { CART_HEADER } from './core/cart.ts'\n" +
                              'export const config = { http: { callHeaders: [CART_HEADER] } }\n',
      'web/src/cart.js':      CART + sets,
    })
    expect(only(root, 'call-header-declared').findings).toEqual([])
  })

  test('a // inside a string does not blank the declaration after it', () => {
    // The failure this guards is the expensive direction: blanking from the
    // `//` in an origin URL to the end of the line hides the callHeaders beside
    // it, and the rule then reports a correctly-declared header as undeclared.
    const root = tree('ch-url', {
      ...CLEAN,
      'api/src/app.ts':  "export const config = { http: { cors: { origin: 'http://localhost:8010' }, " +
                         "callHeaders: ['x-cart-token'] } }\n",
      'web/src/cart.js': "getClient().setCallHeader('x-cart-token', t)\n",
    })
    expect(only(root, 'call-header-declared').findings).toEqual([])
  })

  test('a declaration this rule cannot read is skipped, not treated as absent', () => {
    const root = tree('ch-opaque', {
      ...CLEAN,
      'api/src/app.ts':  'export const config = { http: { callHeaders: HEADERS } }\n' +
                         "export const other = { callHeaders: [...BASE, 'x-a'] }\n",
      'web/src/cart.js': "getClient().setCallHeader('x-cart-token', token)\n",
    })
    const { findings, skipped } = only(root, 'call-header-declared')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  test('an app with no api/ surface is skipped — the server is somebody else’s', () => {
    const root = tree('ch-noapi', without('api/', { 'web/src/cart.js': "c.setCallHeader('x-a', 1)\n" }))
    const { findings, skipped } = only(root, 'call-header-declared')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

describe('service-model', () => {
  const SCHEMA2 = SCHEMA + 'model ProductVariant { id Int @id }\nmodel Person { id Int @id }\n'
  const base = (body = '{}') =>
    `import { createBaseService } from '@frontierjs/junction'\nexport default () => createBaseService(${body})\n`

  test('a hyphenated service name resolves to no model and is an error', () => {
    const root = tree('sm-kebab', {
      ...CLEAN, 'db/schema.lite': SCHEMA2,
      'api/src/services/product-variants.service.ts': base(),
    })
    const { findings } = only(root, 'service-model')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/product-variant/)
    expect(findings[0].message).toMatch(/fails open/)
  })

  test('stating the model is the fix, and it is checked against the schema', () => {
    const root = tree('sm-stated', {
      ...CLEAN, 'db/schema.lite': SCHEMA2,
      'api/src/services/product-variants.service.ts': base("{ model: 'ProductVariant' }"),
    })
    expect(only(root, 'service-model').findings).toEqual([])
  })

  test('a model: naming nothing in the schema is the same failure, stated', () => {
    const root = tree('sm-bogus', {
      ...CLEAN, 'db/schema.lite': SCHEMA2,
      'api/src/services/variants.service.ts': base("{ model: 'Varient' }"),
    })
    const { findings } = only(root, 'service-model')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/names no model/)
  })

  test('an irregular plural resolves — the singular has one owner and this asks it', () => {
    // `people` → `person` comes from @frontierjs/toolbelt/inflect, the module
    // litestone derives a table name with. A rule with its own rules here would
    // grade an app by an inflection the app does not run (Invariant 2).
    const root = tree('sm-irregular', {
      ...CLEAN, 'db/schema.lite': SCHEMA2,
      'api/src/services/people.service.ts': base(),
    })
    expect(only(root, 'service-model').findings).toEqual([])
  })

  test('a service over no model is judged on nothing', () => {
    // A hub, a webhook receiver, a payment callback. It asks for no derived
    // layer, so there is nothing for a missing model to switch off.
    const root = tree('sm-custom', {
      ...CLEAN, 'db/schema.lite': SCHEMA2,
      'api/src/services/hub.service.ts':
        "import { createService } from '@frontierjs/junction'\nexport default () => createService({ find: () => [] })\n",
    })
    expect(only(root, 'service-model').findings).toEqual([])
  })
})


// ─── the cross-realm hazards ──────────────────────────────────────────────────
//
// Four more source rules. Two of them are the same question asked twice — *does
// this name reach a model* — from the API realm and the UI realm, which is why
// they share one resolver rather than one regex each.

// A row a screen KEEPS is watched, not fetched once. `service.get(id)` answers a
// plain object and nothing can reach one — not a push, not a job, not another
// tab — so the screen is stale with nothing said (`FJS-518`, `FJS-D138`).
//
// The heuristic is *bare assignment*, and the negative controls are what make it
// usable: a `const` local is a genuinely one-shot read, and a comparison is not
// an assignment at all. A rule that flagged either would be answered by turning
// it off.

describe('detail-read-dead', () => {
  const screen = (body) => ({ ...CLEAN, 'web/src/pages/x.mesa': body })

  test('a bare assignment keeps the row, so it is reported', () => {
    const root = tree('drd-bare', screen(
      "<script>\n  let order = null\n  async function load() {\n" +
      "    order = await orders.service.get(page.params.id)\n  }\n</script>\n"))
    const { findings } = only(root, 'detail-read-dead')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/orders\.record\(id\)/)
    expect(findings[0].message).toMatch(/`order` keeps a row/)
  })

  test('a wrapped ternary is the same read — the assignment is a line up', () => {
    const root = tree('drd-ternary', screen(
      "<script>\n  let customer = null\n  async function load() {\n" +
      "    customer = order?.customerId\n" +
      "      ? await customers.service.get(order.customerId).catch(() => null)\n" +
      "      : null\n  }\n</script>\n"))
    expect(only(root, 'detail-read-dead').findings).toHaveLength(1)
  })

  test('a const local is a one-shot read and is left alone', () => {
    const root = tree('drd-const', screen(
      "<script>\n  async function label(id) {\n" +
      "    const row = await orders.service.get(id)\n    return row.reference\n  }\n</script>\n"))
    expect(only(root, 'detail-read-dead').findings).toEqual([])
  })

  test('a comparison is not an assignment', () => {
    const root = tree('drd-compare', screen(
      "<script>\n  async function same(id) {\n" +
      "    return current == await orders.service.get(id)\n  }\n</script>\n"))
    expect(only(root, 'detail-read-dead').findings).toEqual([])
  })

  test('watching it is what silences the rule', () => {
    const root = tree('drd-record', screen(
      "<script>\n  let order = null\n  const row = orders.record(page.params.id)\n" +
      "  row.subscribe(v => { order = v })\n</script>\n"))
    expect(only(root, 'detail-read-dead').findings).toEqual([])
  })

  test('a surface with no service.get() at all is SKIPPED, not passed', () => {
    // A rule that found nothing because there was nothing to look at has not
    // run, and reporting the two as one number is how coverage quietly stops.
    // CLEAN carries a legitimate `service.get()` so the rule runs there, so
    // this tree has to drop the whole surface and rebuild the part it needs.
    const root = tree('drd-none', without('web/src/pages/',
      { 'web/src/pages/x.mesa': "<script>\n  let x = 1\n</script>\n" }))
    const res = only(root, 'detail-read-dead')
    expect(res.findings).toEqual([])
    expect(res.ran).not.toContain('detail-read-dead')
    expect(res.skipped.map(s => s.rule)).toContain('detail-read-dead')
  })

  test('it reads the client surfaces, not the API', () => {
    const root = tree('drd-api', {
      ...CLEAN,
      'api/src/services/x.ts': "let row\nrow = await orders.service.get(1)\n",
    })
    expect(only(root, 'detail-read-dead').findings).toEqual([])
  })
})

describe('resource-model-miss', () => {
  const withVariant = (body) => ({
    ...CLEAN,
    'db/schema.lite':      SCHEMA + '\nmodel ProductVariant { id Int @id }\n',
    'web/src/pages/x.mesa': body,
  })

  test('a name that reaches no model, where the model plainly exists, is an error', () => {
    const root = tree('rm-kebab', withVariant("<script module>\n" +
      "export const variants = createResource('product-variants')\n</script>\n"))
    const { findings } = only(root, 'resource-model-miss')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/model: 'ProductVariant'/)
  })

  test('stating the model answers it, even three lines down', () => {
    const root = tree('rm-stated', withVariant("<script module>\n" +
      "export const variants = createResource('product-variants', {\n" +
      "  idField: 'id',\n  model: 'ProductVariant',\n})\n</script>\n"))
    expect(only(root, 'resource-model-miss').findings).toEqual([])
  })

  test('a resource over no model is judged on nothing', () => {
    // `createResource('hub')` with no model Hub is a whole kind of resource.
    // Reporting it is how a rule gets turned off.
    const root = tree('rm-none', withVariant("<script module>\n" +
      "export const hub = createResource('hub')\n</script>\n"))
    expect(only(root, 'resource-model-miss').findings).toEqual([])
  })

  test('a name that resolves is silent — including an irregular', () => {
    const root = tree('rm-ok', {
      ...CLEAN,
      'db/schema.lite':       SCHEMA + '\nmodel Person { id Int @id }\n',
      'web/src/pages/x.mesa': "<script module>\nexport const people = createResource('people')\n" +
                              "export const leads = createResource('leads')\n</script>\n",
    })
    expect(only(root, 'resource-model-miss').findings).toEqual([])
  })
})

describe('service-as-system', () => {
  // FJS-519. `asSystem()` keeps the tenant it is standing in — so which client
  // is elevated decides whether the answer is scoped at all. The app-level
  // client cannot be named positively (`app.claim(<any name>, db)`), so the
  // rule tests the other direction.
  // CLEAN already declares row tenancy. `tenancy` REPLACES that block, so ''
  // is an app that declares none.
  const svc = (body, tenancy = null) => ({
    ...CLEAN,
    'db/schema.lite': tenancy === null
      ? CLEAN['db/schema.lite']
      : CLEAN['db/schema.lite'].replace(/^tenancy \{[^}]*\}\n/m, tenancy),
    'api/src/services/leads.service.ts':
      "import { createService } from '@frontierjs/junction'\n" + body,
  })

  test('the app client elevated inside a service is a warning', () => {
    const root = tree('sas-app', svc('export default (app) => createService({\n' +
      '  find: () => app.data.asSystem().lead.findMany({ where: {} }),\n})\n'))
    const { findings } = only(root, 'service-as-system')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
    expect(findings[0].message).toMatch(/app\.data\.asSystem\(\)/)
    expect(findings[0].message).toMatch(/EVERY tenant/)
  })

  test('a cast does not hide the receiver', () => {
    // Three of basecamp's sites are spelled this way.
    const root = tree('sas-cast', svc('export default (app) => createService({\n' +
      '  find: () => (app.data as any).asSystem().lead.findMany({ where: {} }),\n})\n'))
    const { findings } = only(root, 'service-as-system')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/^app\.data\.asSystem/)
  })

  test('the request client, either spelling, is the correct shape', () => {
    const root = tree('sas-scoped', svc('export default () => createService({\n' +
      '  find: () => $.db.asSystem().lead.findMany({ where: {} }),\n' +
      '  get:  (ctx) => ctx.locals.db.asSystem().lead.findFirst({ where: {} }),\n})\n'))
    expect(only(root, 'service-as-system').findings).toEqual([])
  })

  test('a local bound to the request client is the same shape', () => {
    const root = tree('sas-local', svc('export default () => createService({\n' +
      '  find: (ctx) => {\n    const db = ctx.locals.db\n' +
      '    return db.asSystem().lead.findMany({ where: {} })\n  },\n})\n'))
    expect(only(root, 'service-as-system').findings).toEqual([])
  })

  test('no tenancy block means there is no claim to lose', () => {
    const root = tree('sas-none', svc('export default (app) => createService({\n' +
      '  find: () => app.data.asSystem().lead.findMany({ where: {} }),\n})\n', ''))
    const { findings, skipped } = only(root, 'service-as-system')
    expect(findings).toEqual([])
    expect(skipped[0].why).toMatch(/no tenancy block/)
  })

  test('strategy database is skipped — one client is one file', () => {
    // The hazard is physical there: a system context cannot reach a second
    // tenant's database, so every finding would be noise. `example` is this.
    const root = tree('sas-db', svc('export default (app) => createService({\n' +
      '  find: () => app.data.asSystem().lead.findMany({ where: {} }),\n})\n',
      'tenancy { strategy database  dir "./shops" }\n'))
    const { findings, skipped } = only(root, 'service-as-system')
    expect(findings).toEqual([])
    expect(skipped[0].why).toMatch(/strategy database/)
  })

  test('a doc comment naming the block is not the block', () => {
    // This repo's own schema says *declared once in the `tenancy { }` block
    // below*, and an unblanked match reads that empty pair as the declaration
    // and skips the whole app.
    const root = tree('sas-comment', svc('export default (app) => createService({\n' +
      '  find: () => app.data.asSystem().lead.findMany({ where: {} }),\n})\n',
      '/// scoped by the `tenancy { }` block below\n' +
      'tenancy { strategy row  column workspaceId  claim workspaceId }\n'))
    expect(only(root, 'service-as-system').findings).toHaveLength(1)
  })
})

describe('service-module-db', () => {
  const svc = (body) => ({
    ...CLEAN,
    'api/src/services/leads.service.ts':
      "import { db } from '../core/db.ts'\nimport { createService } from '@frontierjs/junction'\n" + body,
  })

  test('the module client inside a service is an error', () => {
    const root = tree('md-module', svc('export default () => createService({\n' +
      '  find: () => db.lead.findMany({ where: {} }),\n})\n'))
    const { findings } = only(root, 'service-module-db')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(4)
    expect(findings[0].message).toMatch(/carries no principal/)
  })

  test('the request-scoped client, either spelling, is the correct shape', () => {
    const root = tree('md-scoped', svc('export default () => createService({\n' +
      '  find:   () => $.db.lead.findMany({ where: {} }),\n' +
      '  get:    (ctx) => ctx.locals.db.lead.findFirst({ where: {} }),\n})\n'))
    expect(only(root, 'service-module-db').findings).toEqual([])
  })

  test('asSystem() off the module client is the deliberate bypass', () => {
    // It says which client it means, in the one word that means it. The shape
    // this rule is for is the one that says nothing.
    const root = tree('md-system', svc('export default () => createService({\n' +
      '  find: () => db.asSystem().lead.findMany({ where: {} }),\n})\n'))
    expect(only(root, 'service-module-db').findings).toEqual([])
  })

  test('a local binding off ctx is not the module client', () => {
    const root = tree('md-local', {
      ...CLEAN,
      'api/src/services/leads.service.ts':
        "import { createService } from '@frontierjs/junction'\n" +
        'export default () => createService({\n' +
        '  find: (ctx) => { const db = ctx.locals.db; return db.lead.findMany({ where: {} }) },\n})\n',
    })
    expect(only(root, 'service-module-db').findings).toEqual([])
  })
})

describe('scheduler-dispatch', () => {
  test('a timer that dispatches into the queue is an error', () => {
    const root = tree('sd-inline', api(
      "app.scheduler.every('5m', () => app.jobs.dispatch(sweep, { at: 1 }))\n"))
    const { findings } = only(root, 'scheduler-dispatch')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/every replica/)
  })

  test('the callback is read whole, not the line it opened on', () => {
    const root = tree('sd-multiline', api(
      "app.scheduler.cron('*/5 * * * *', async () => {\n" +
      '  const rows = await pending()\n' +
      '  for (const r of rows) await dispatch(bookCourier, r)\n' +
      '})\n'))
    expect(only(root, 'scheduler-dispatch').findings).toHaveLength(1)
  })

  test('the queue owning its own schedule is the fix, and is silent', () => {
    const root = tree('sd-jobs', api(
      "app.jobs.schedule('sweep', '*/5 * * * *', () => dispatch(sweep, {}))\n"))
    expect(only(root, 'scheduler-dispatch').findings).toEqual([])
  })

  test('a timer with no row behind it is what app.scheduler is for', () => {
    const root = tree('sd-cache', api("app.scheduler.every('1m', () => cache.sweep())\n"))
    expect(only(root, 'scheduler-dispatch').findings).toEqual([])
  })
})

describe('transition-methods', () => {
  // A machine plus the code that drives it. `moves` replaces the schema's
  // clause list; `drives` replaces the service body.
  const app = (moves, drives) => ({
    ...CLEAN,
    'db/schema.lite': CLEAN['db/schema.lite'].replace(
      /@@transitions\(status,[\s\S]*?\)\n/,
      `@@transitions(status,\n    ${moves})\n`),
    'api/src/services/leads.service.ts':
      "import { createBaseService } from '@frontierjs/junction'\n" +
      'export default () => createBaseService({})\n' + drives,
  })

  test('the clean tree drives every move it declares', () => {
    const root = tree('tm-clean', CLEAN)
    const { findings, skipped } = only(root, 'transition-methods')
    expect(skipped).toHaveLength(0)
    expect(findings).toHaveLength(0)
  })

  test('a move nothing names, by either spelling, is a warning', () => {
    const root = tree('tm-dead', app(
      'qualify: new -> qualified,\n    close: qualified -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n"))
    const { findings } = only(root, 'transition-methods')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toMatch(/Lead\.close -> closed/)
    // Reported where the declaration is — the service has nothing to point at.
    expect(findings[0].file).toMatch(/schema\.lite$/)
  })

  test('naming the state it moves TO counts as driving it', () => {
    // `update({ data: { status: 'closed' } })` is the same move litestone
    // enforces, spelled by its target. A rule asking only for the move name
    // reports eleven of basecamp's nineteen and is wrong about eight.
    const root = tree('tm-by-state', app(
      'qualify: new -> qualified,\n    close: qualified -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n" +
      "export const c = () => $.db.lead.update({ where: {}, data: { status: 'closed' } })\n"))
    expect(only(root, 'transition-methods').findings).toHaveLength(0)
  })

  test('a comment naming the move does not count as driving it', () => {
    // readCode blanks comments before any rule sees them. Without that, a file
    // documenting its own machine would silence the rule about it.
    const root = tree('tm-comment', app(
      'qualify: new -> qualified,\n    close: qualified -> closed',
      "// close: qualified -> closed, and the string 'closed' is in this comment\n" +
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n"))
    expect(only(root, 'transition-methods').findings).toHaveLength(1)
  })

  test('a transition() naming no declared move is the other direction', () => {
    const root = tree('tm-undeclared', app(
      'qualify: new -> qualified,\n    close: [new, qualified] -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n" +
      "export const c = () => $.db.lead.transition($.id, 'close')\n" +
      "export const x = () => $.db.lead.transition($.id, 'archive')\n"))
    const { findings } = only(root, 'transition-methods')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/'archive'\) names no move/)
    expect(findings[0].message).toMatch(/qualify, close/)
    expect(findings[0].file).toMatch(/leads\.service\.ts$/)
  })

  test("the state a move lands on is not a name transition() accepts", () => {
    // The two spellings are not interchangeable in both directions, and this
    // test exists because writing it the other way is what caught it. An
    // `update({ data: { status: 'closed' } })` makes the move; a
    // `transition(id, 'closed')` throws, because transition() resolves a move
    // NAME and this one is called `close`. Only an UNNAMED move is reachable by
    // its target, which is the case below this one.
    const root = tree('tm-target-name', app(
      'qualify: new -> qualified,\n    close: [new, qualified] -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n" +
      "export const c = () => $.db.lead.transition($.id, 'closed')\n"))
    const { findings } = only(root, 'transition-methods')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/'closed'\) names no move/)
  })

  test('a from-LIST is one clause, and the move keeps its name', () => {
    // The parse that costs the most: `close: [new, qualified] -> closed` splits
    // on a top-level comma only. Split naively it becomes two clauses, the name
    // is lost, and the move is reported as `closed` — which is also a legal
    // spelling of it, so the bug hides.
    const root = tree('tm-fromlist', app(
      'qualify: new -> qualified,\n    close: [new, qualified] -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualify')\n" +
      "export const c = () => $.db.lead.transition($.id, 'close')\n"))
    expect(only(root, 'transition-methods').findings).toHaveLength(0)
  })

  test('an unnamed move is named after the state it moves to', () => {
    // `new -> qualified` names itself `qualified`, which is the spelling
    // transition() then has to use.
    const root = tree('tm-unnamed', app(
      'new -> qualified,\n    close: qualified -> closed',
      "export const q = () => $.db.lead.transition($.id, 'qualified')\n" +
      "export const c = () => $.db.lead.transition($.id, 'close')\n"))
    expect(only(root, 'transition-methods').findings).toHaveLength(0)
  })

  test('a schema with no machine skips rather than passing', () => {
    const root = tree('tm-none', {
      ...CLEAN,
      'db/schema.lite': CLEAN['db/schema.lite'].replace(/@@transitions\(status,[\s\S]*?\)\n/, ''),
    })
    const { skipped, findings } = only(root, 'transition-methods')
    expect(findings).toHaveLength(0)
    expect(skipped[0].why).toMatch(/no @@transitions/)
  })

  test('an app with no api/ source skips — the machine is driven elsewhere', () => {
    const root = tree('tm-noapi', without('api/'))
    expect(only(root, 'transition-methods').skipped[0].why).toMatch(/no api\/ source/)
  })
})

describe('polymorphic-subject', () => {
  // The clean tree already carries a correctly-declared pair (`Note`), so these
  // add the shapes that are NOT one, and the two spellings that answer it.
  const withModel = (body) => ({ ...CLEAN, 'db/schema.lite': SCHEMA + body })

  test('a bare String discriminator is reported', () => {
    const root = tree('ps-bare', withModel(`
model Comment {
  id          Int    @id
  workspaceId Int
  subjectType String
  subjectId   Int
}
`))
    const { findings } = only(root, 'polymorphic-subject')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/Comment\.subjectType names what subjectId points at/)
    expect(findings[0].message).toMatch(/make subjectType an enum/)
  })

  // The line has to be the FIELD's, not the model's — a schema is long and a
  // finding that points at the top of a model is a finding nobody can act on.
  test('it points at the discriminator, not the model', () => {
    const root = tree('ps-line', withModel(`
model Comment {
  id          Int    @id
  workspaceId Int
  body        String
  subjectType String
  subjectId   Int
}
`))
    const { findings } = only(root, 'polymorphic-subject')
    const line = readFileSync(join(root, 'db/schema.lite'), 'utf8').split('\n')[findings[0].line - 1]
    expect(line).toMatch(/^\s+subjectType\s/)
  })

  test('@@check naming the column is the other answer, and it is accepted', () => {
    const root = tree('ps-check', withModel(`
model Comment {
  id          Int    @id
  workspaceId Int
  subjectType String
  subjectId   Int
  @@check("subjectType IN ('Account', 'Lead')")
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  // A declared set enforced at the Data boundary. That it is not also a table
  // CHECK is `@values`' own trade, not this rule's question.
  test('@values is a declared set and is accepted', () => {
    const root = tree('ps-values', withModel(`
model Comment {
  id          Int    @id
  workspaceId Int
  subjectType String @values(SubjectSet, open)
  subjectId   Int
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  // A real foreign key is not this shape — the relation already names the table.
  test('a column a @relation owns is not a pair', () => {
    const root = tree('ps-relation', withModel(`
model Comment {
  id          Int     @id
  workspaceId Int
  accountType String
  accountId   Int
  account     Account @relation(fields: [accountId], references: [id])
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  test('a type column with no id beside it is not a pair', () => {
    const root = tree('ps-lonely', withModel(`
model Comment {
  id          Int    @id
  workspaceId Int
  subjectType String
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  // The spelling the population this rule is FOR actually uses. A schema read
  // out of somebody's existing database keeps the database's names — `litestone
  // introspect --no-camel`, a Rails `subject_type`/`subject_id` — and matching
  // camelCase alone reported every one of those as having no pair at all.
  test('a snake_case pair is the same pair', () => {
    const root = tree('ps-snake', withModel(`
model ActivityLog {
  id           Int    @id
  workspaceId  Int
  subject_type String
  subject_id   Int
}
`))
    const { findings } = only(root, 'polymorphic-subject')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/ActivityLog\.subject_type names what subject_id points at/)
  })

  test('and @@check answers it in that spelling too', () => {
    const root = tree('ps-snake-check', withModel(`
model ActivityLog {
  id           Int    @id
  workspaceId  Int
  subject_type String
  subject_id   Int
  @@check("subject_type IN ('Account', 'Lead')")
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  // The control that keeps the two spellings apart: a snake_case discriminator
  // whose id is spelled the OTHER way is not a pair, and reporting it would be
  // the fix over-reaching rather than working.
  test('a snake_case type with a camelCase id beside it is not a pair', () => {
    const root = tree('ps-mixed', withModel(`
model ActivityLog {
  id           Int    @id
  workspaceId  Int
  subject_type String
  subjectId    Int
}
`))
    expect(only(root, 'polymorphic-subject').findings).toEqual([])
  })

  test('an app with no schema is skipped rather than passed', () => {
    const root = tree('ps-noschema', without('db/'))
    const { findings, skipped } = only(root, 'polymorphic-subject')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

describe('gate-unreachable', () => {
  // Everything but the resolver: the app declares the gate and has nothing that
  // can grade a caller up to it.
  const app5 = (extra = {}) => without('api/src/core/', extra)

  test('a gate at ADMINISTRATOR with nothing that can reach it is a warning', () => {
    const root = tree('gu-named', app5())
    const { findings } = only(root, 'gate-unreachable')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toMatch(/never interprets a role STRING/)
  })

  test('the compact spelling is the same declaration', () => {
    const root = tree('gu-compact', app5({
      'db/schema.lite': 'model Lead {\n  id Int @id\n  @@gate("0.4.4.5")\n}\n',
    }))
    expect(only(root, 'gate-unreachable').findings).toHaveLength(1)
  })

  test('a standing column the shipped resolver reads answers it', () => {
    const root = tree('gu-column', app5({
      'db/schema.lite': SCHEMA + '\nmodel User {\n  id Int @id\n  isAdmin Boolean?\n}\n',
    }))
    expect(only(root, 'gate-unreachable').findings).toEqual([])
  })

  test('a getLevel of the app’s own answers everything below it', () => {
    expect(only(tree('gu-resolver', CLEAN), 'gate-unreachable').findings).toEqual([])
  })

  test('8 and 9 are deliberate and are not reported at all', () => {
    // `8` means nothing outside asSystem() has anything to say to this model —
    // the identity models ship that way — and `9` is locked. Neither is a level
    // a resolver was supposed to reach.
    const root = tree('gu-eight', app5({
      'db/schema.lite': 'model Session {\n  id Int @id\n  @@gate("8")\n}\n',
    }))
    const { findings, skipped } = only(root, 'gate-unreachable')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})


// ─── --fix ────────────────────────────────────────────────────────────────────
//
// The assertion that matters for every one of these is not the bytes — it is
// that the RULE IS QUIET AFTERWARDS, checked from disk. A fix that satisfies the
// test and not the rule is the failure mode, and a byte comparison is exactly
// how you would not notice.

describe('applyFixes', () => {
  const fixAll = (root, id) => {
    const first  = only(root, id)
    const result = applyFixes(first.findings)
    return { ...result, before: first.findings, after: only(root, id).findings }
  }
  const read = (root, path) => readFileSync(join(root, path), 'utf8')

  test('a raw route is rewritten in the quotes it was written in, and the rule goes quiet', () => {
    const root = tree('fx-route', api(
      "app.get('/orders/:id', h)\n" +
      'app.post("/orders/:id/lines/:line", h)\n' +
      "// app.get('/left/:alone') — a comment stays one\n"))

    const { fixed, after } = fixAll(root, 'raw-route-param')
    expect(fixed).toHaveLength(2)
    expect(after).toEqual([])

    const src = read(root, 'api/src/app.ts')
    expect(src).toContain("app.get('/orders/{id}', h)")
    expect(src).toContain('app.post("/orders/{id}/lines/{line}", h)')
    expect(src).toContain("// app.get('/left/:alone')")
  })

  test('an empty options object takes the key and no comma', () => {
    const root = tree('fx-empty', {
      ...CLEAN,
      'db/schema.lite': SCHEMA + '\nmodel ProductVariant { id Int @id }\n',
      'api/src/services/product-variants.service.ts':
        "import { createBaseService } from '@frontierjs/junction'\n" +
        'export default () => createBaseService({})\n',
    })
    const { after } = fixAll(root, 'service-model')
    expect(after).toEqual([])
    expect(read(root, 'api/src/services/product-variants.service.ts'))
      .toContain("createBaseService({ model: 'ProductVariant' })")
  })

  test('an object opened on its own line takes a line, indented like its neighbor', () => {
    // The alternative is one canonical form, which reformats somebody's file to
    // add a missing key — how a --fix gets a reputation.
    const root = tree('fx-block', {
      ...CLEAN,
      'db/schema.lite': SCHEMA + '\nmodel ProductVariant { id Int @id }\n',
      'api/src/services/product-variants.service.ts':
        "import { createBaseService } from '@frontierjs/junction'\n" +
        'export default () => createBaseService({\n' +
        "    channel: 'variants',\n" +
        '  })\n',
    })
    const { after } = fixAll(root, 'service-model')
    expect(after).toEqual([])
    expect(read(root, 'api/src/services/product-variants.service.ts'))
      .toContain("createBaseService({\n    model: 'ProductVariant',\n    channel: 'variants',\n  })")
  })

  test('a resource with no options gets the whole option, one with options gets the key', () => {
    const root = tree('fx-resource', {
      ...CLEAN,
      'db/schema.lite': SCHEMA + '\nmodel ProductVariant { id Int @id }\n',
      'web/src/pages/x.mesa': '<script module>\n' +
        "export const a = createResource('product-variants')\n" +
        "export const b = createResource('product-variants', { idField: 'id' })\n</script>\n",
    })
    const { fixed, after } = fixAll(root, 'resource-model-miss')
    expect(fixed).toHaveLength(2)
    expect(after).toEqual([])

    const src = read(root, 'web/src/pages/x.mesa')
    expect(src).toContain("createResource('product-variants', { model: 'ProductVariant' })")
    expect(src).toContain("createResource('product-variants', { model: 'ProductVariant', idField: 'id' })")
  })

  test('two fixes in one file both land — the later one is applied first', () => {
    // Back to front, or the second edit is written at an offset the first one
    // moved. Two on ONE line is the sharp case.
    const root = tree('fx-order', api("app.get('/a/:id', h); app.get('/b/:key', h)\n"))
    const { after } = fixAll(root, 'raw-route-param')
    expect(after).toEqual([])
    expect(read(root, 'api/src/app.ts')).toBe("app.get('/a/{id}', h); app.get('/b/{key}', h)\n")
  })

  test('a file that changed since the check is refused, not written at a stale offset', () => {
    const root = tree('fx-stale', api("app.get('/orders/:id', h)\n"))
    const { findings } = only(root, 'raw-route-param')
    writeFileSync(join(root, 'api/src/app.ts'), "// moved\napp.get('/orders/:id', h)\n")

    const { fixed, failed } = applyFixes(findings)
    expect(fixed).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0].why).toMatch(/has changed/)
    expect(read(root, 'api/src/app.ts')).toBe("// moved\napp.get('/orders/:id', h)\n")
  })

  test('a finding with no fix is left alone — and most of them have none', () => {
    // set-auth-discarded is the argument: `const scoped = …` would silence the
    // rule and leave every write below it going through the unscoped client.
    const root = tree('fx-nofix', api('db.$setAuth(user)\nexport const g = ctx => ctx.params.user\n'))
    const findings = [...only(root, 'set-auth-discarded').findings, ...only(root, 'ctx-params').findings]
    expect(findings).toHaveLength(2)
    expect(findings.every(f => !f.edit)).toBe(true)

    const { fixed, failed } = applyFixes(findings)
    expect(fixed).toEqual([])
    expect(failed).toEqual([])
    expect(read(root, 'api/src/app.ts')).toBe('db.$setAuth(user)\nexport const g = ctx => ctx.params.user\n')
  })

  test('running it twice changes nothing the second time', () => {
    const root = tree('fx-idempotent', api("app.get('/orders/:id', h)\n"))
    fixAll(root, 'raw-route-param')
    const src = read(root, 'api/src/app.ts')

    const second = fixAll(root, 'raw-route-param')
    expect(second.fixed).toEqual([])
    expect(read(root, 'api/src/app.ts')).toBe(src)
  })
})


// ─── the baseline ─────────────────────────────────────────────────────────────
//
// Invariant 14's ratchet, applied to a second kind of count. The two tests that
// matter are the two that are not about arithmetic: `--update` must be unable to
// raise, and a rule that did not RUN must not be read as a rule that improved.

describe('the baseline', () => {
  const run  = (root, ids) => runChecks({ root, only: ids })
  const file = (root) => JSON.parse(readFileSync(join(root, BASELINE_FILE), 'utf8'))

  const dirty = (extra = {}) => api(
    "app.get('/orders/:id', h)\nexport const g = ctx => ctx.params.user\n", extra)

  test('an absent file is not an empty one, and both mean clean', () => {
    const root = tree('bl-absent', CLEAN)
    const baseline = readBaseline(root)
    expect(baseline.present).toBe(false)
    expect(baseline.counts).toEqual({})
  })

  test('a `//` key is a comment, not a rule', () => {
    const root = tree('bl-comment', { ...CLEAN, [BASELINE_FILE]: '{ "//": "why", "ctx-params": 2 }' })
    expect(readBaseline(root).counts).toEqual({ 'ctx-params': 2 })
  })

  test('above is a regression, below is an improvement, equal is neither', () => {
    const root = tree('bl-grade', { ...dirty(), [BASELINE_FILE]:
      '{ "raw-route-param": 0, "ctx-params": 1, "set-auth-discarded": 3 }' })
    const ids  = ['raw-route-param', 'ctx-params', 'set-auth-discarded']
    const grade = gradeBaseline(run(root, ids), readBaseline(root))

    expect(grade.regressions).toEqual([{ rule: 'raw-route-param', count: 1, ceiling: 0 }])
    expect(grade.improvements).toEqual([{ rule: 'set-auth-discarded', count: 0, ceiling: 3 }])
    expect(grade.ok).toBe(false)
  })

  test('a rule that did not RUN is held, not improved', () => {
    // It reports 0 findings, which is what a fixed rule reports. Ratcheting it
    // to nothing locks in a baseline no later run can meet — the same doctrine
    // as `skipped` in the summary, one layer along.
    const root = tree('bl-held', without('web/', { [BASELINE_FILE]: '{ "resource-file-name": 2 }' }))
    const result = run(root, ['resource-file-name'])
    expect(result.skipped).toHaveLength(1)

    const grade = gradeBaseline(result, readBaseline(root))
    expect(grade.held).toEqual([{ rule: 'resource-file-name', ceiling: 2 }])
    expect(grade.improvements).toEqual([])
    expect(grade.ok).toBe(true)

    writeBaseline(root, { counts: grade.counts, ran: result.ran, baseline: readBaseline(root) })
    expect(file(root)['resource-file-name']).toBe(2)
  })

  test('a ceiling for a rule that no longer exists is reported, like a stale allowance', () => {
    const root = tree('bl-unknown', { ...CLEAN, [BASELINE_FILE]: '{ "rule-we-deleted": 4 }' })
    const grade = gradeBaseline(run(root, ['ctx-params']), readBaseline(root))
    expect(grade.unknown).toEqual([{ rule: 'rule-we-deleted', ceiling: 4 }])
  })

  test('--update cannot raise a number', () => {
    // The whole ratchet. One flag that both locks in a fix and records a
    // regression is how a ceiling goes up with nobody deciding to raise it.
    const root = tree('bl-noraise', { ...dirty(), [BASELINE_FILE]: '{ "ctx-params": 0 }' })
    const result = run(root, ['ctx-params'])
    const grade  = gradeBaseline(result, readBaseline(root))

    writeBaseline(root, { counts: grade.counts, ran: result.ran, baseline: readBaseline(root) })
    // Not 1. A zero is not written at all, since it says what an absent key says.
    expect(file(root)['ctx-params']).toBeUndefined()
  })

  test('--adopt does raise, which is why it is its own verb', () => {
    const root = tree('bl-adopt', dirty())
    const result = run(root, ['ctx-params', 'raw-route-param'])
    const grade  = gradeBaseline(result, readBaseline(root))

    writeBaseline(root, { counts: grade.counts, ran: result.ran, baseline: readBaseline(root), mode: 'adopt' })
    expect(file(root)['ctx-params']).toBe(1)
    expect(file(root)['raw-route-param']).toBe(1)

    // And the app is now green against what it just recorded.
    expect(gradeBaseline(run(root, ['ctx-params', 'raw-route-param']), readBaseline(root)).ok).toBe(true)
  })

  test('a rule that ran clean loses its entry rather than keeping a ceiling nobody needs', () => {
    const root = tree('bl-clear', { ...CLEAN, [BASELINE_FILE]: '{ "ctx-params": 3 }' })
    const result = run(root, ['ctx-params'])
    const grade  = gradeBaseline(result, readBaseline(root))

    writeBaseline(root, { counts: grade.counts, ran: result.ran, baseline: readBaseline(root) })
    expect(file(root)['ctx-params']).toBeUndefined()
  })

  test('the written file carries its own instructions and is sorted', () => {
    const root = tree('bl-header', dirty())
    const result = run(root, ['ctx-params', 'raw-route-param', 'set-auth-discarded'])
    const grade  = gradeBaseline(result, readBaseline(root))
    writeBaseline(root, { counts: grade.counts, ran: result.ran, baseline: readBaseline(root), mode: 'adopt' })

    const keys = Object.keys(file(root))
    expect(keys[0]).toBe('//')
    expect(file(root)['//']).toMatch(/may never rise/)
    expect(keys.slice(1)).toEqual([...keys.slice(1)].sort())
  })
})


// ─── the build-time half ──────────────────────────────────────────────────────
//
// Sierra proves a prerendered page at BUILD time — reads tapped around the
// route's companion, graded against @@gate, fail-closed — and no text rule can
// replace that. What text can see is whether the proof is switched on, and both
// rules below were measured by running `checkRoute` rather than read off the
// source: `publishes: 0` turns two refusals into passes.

describe('log-db-unbound', () => {
  const DEPLOY = "export default { deploy: { server: 'x.test', path: '/apps/x' } }\n"
  const LOGGER = (path) => SCHEMA + `\ndatabase audit { path ${path} driver logger retention 90d }\n`

  test('a literal path cannot be pointed at the volume, and that is certain', () => {
    // basecamp's real shape. The app root is /app and the volume is /db, so the
    // trail is written into the image and the next swap takes it — with the app
    // working perfectly throughout, which is why nothing has ever noticed.
    const root = tree('ldu-literal', {
      'db/schema.lite': LOGGER('"./db/audit/"'), 'frontier.config.js': DEPLOY,
    })
    const { findings } = only(root, 'log-db-unbound')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/cannot be pointed at the mounted volume/)
    expect(findings[0].message).toMatch(/AUDIT_PATH/)   // it names the way out
  })

  test('an env() nothing declares is reported, because the env check will not require it', () => {
    const root = tree('ldu-undeclared', {
      'db/schema.lite': LOGGER('env("AUDIT_PATH", "./db/audit/")'),
      'frontier.config.js': DEPLOY,
      '.env.example': 'DATABASE_URL=\n',
    })
    const { findings } = only(root, 'log-db-unbound')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/nothing in this app declares AUDIT_PATH/)
  })

  test('an env() the key file declares is clean', () => {
    const root = tree('ldu-declared', {
      'db/schema.lite': LOGGER('env("AUDIT_PATH", "./db/audit/")'),
      'frontier.config.js': DEPLOY,
      '.env.example': '# the trail lives on the volume\nAUDIT_PATH=/db/audit/\n',
    })
    expect(only(root, 'log-db-unbound').findings).toEqual([])
  })

  test('.env.keys counts too — an app may declare keys without example values', () => {
    const root = tree('ldu-keys', {
      'db/schema.lite': LOGGER('env("AUDIT_PATH", "./db/audit/")'),
      'frontier.config.js': DEPLOY,
      '.env.keys': 'AUDIT_PATH\n',
    })
    expect(only(root, 'log-db-unbound').findings).toEqual([])
  })

  test('a sqlite-only schema is skipped, not passed', () => {
    // The rule must not fire on the app that has no trail to lose; `fli new`
    // scaffolds exactly this.
    const root = tree('ldu-sqlite', { 'db/schema.lite': SCHEMA, 'frontier.config.js': DEPLOY })
    const { findings, skipped } = only(root, 'log-db-unbound')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  test('no deploy block is skipped — nothing mounts a volume to be outside of', () => {
    const root = tree('ldu-nodeploy', { 'db/schema.lite': LOGGER('"./db/audit/"') })
    const { findings, skipped } = only(root, 'log-db-unbound')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

describe('static-publish-db', () => {
  const site = (config, extra = {}) => ({
    ...CLEAN,
    'site/config/sierra.config.js': config,
    ...extra,
  })

  test('a static surface that loads data and wires no client is an error', () => {
    const root = tree('sp-nodb', site("export default { target: 'static', routesDir: 'src/routes' }\n"))
    const { findings } = only(root, 'static-publish-db')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/publish check taps that client/)
  })

  test('a static surface with no companion reads nothing and needs no client', () => {
    // Nothing to observe, so nothing to prove. Scolding it is how a rule gets
    // turned off by the app that had it right.
    const { 'site/src/routes/index.meta.js': _c, ...rest } = CLEAN
    const root = tree('sp-nodata', {
      ...rest,
      'site/config/sierra.config.js': "export default { target: 'static', routesDir: 'src/routes' }\n",
    })
    expect(only(root, 'static-publish-db').findings).toEqual([])
  })

  test('an SPA is not a prerendered site', () => {
    const root = tree('sp-spa', without('site/'))
    const { findings, skipped } = only(root, 'static-publish-db')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  test('db: wired is the answer, and CLEAN carries it', () => {
    expect(only(tree('sp-ok', CLEAN), 'static-publish-db').findings).toEqual([])
  })
})

describe('static-publishes-0', () => {
  test('publishes: 0 in a route’s frontmatter is a warning', () => {
    const root = tree('pz-mesa', {
      ...CLEAN,
      'site/src/routes/index.mesa': '---\nrender: static\npublishes: 0\n---\n<h1>x</h1>\n',
    })
    const { findings } = only(root, 'static-publishes-0')
    expect(findings).toHaveLength(1)
    // The line in the FILE, not in the frontmatter block — and the keyword's
    // line, not the newline the match opens on.
    expect(findings[0].line).toBe(3)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toMatch(/turn off the two refusals/)
  })

  test('a companion exporting the word is not a declaration', () => {
    // The build reads `r.meta.publishes`, which is the page's own frontmatter.
    // A companion export of that name is a variable nothing consults, and
    // reporting it would be this rule inventing a mechanism.
    const root = tree('pz-meta', {
      ...CLEAN,
      'site/src/routes/index.meta.js': 'export const publishes = 0\nexport async function load() { return {} }\n',
    })
    expect(only(root, 'static-publishes-0').findings).toEqual([])
  })

  test('a declared LEVEL is the mechanism working and is not reported', () => {
    const root = tree('pz-level', {
      ...CLEAN,
      'site/src/routes/index.mesa': '---\nrender: static\npublishes: 4\n---\n<h1>x</h1>\n',
    })
    expect(only(root, 'static-publishes-0').findings).toEqual([])
  })

  test('the word in a comment or in prose is not a declaration', () => {
    const root = tree('pz-prose', {
      ...CLEAN,
      'site/src/routes/index.mesa':
        '---\nrender: static\n---\n<!-- There is no publishes: 0 here, which is a claim -->\n',
      'site/src/routes/index.meta.js': 'export async function load() { return {} }\n',
    })
    expect(only(root, 'static-publishes-0').findings).toEqual([])
  })
})


// ─── test-files-run ───────────────────────────────────────────────────────────
//
// Found its own first case: `packages/cli`'s `tests/pipe.test.js` pins FJS-379
// and had never been run by `bun run test`. A green suite, a rising count, and
// the unlisted file is the one written last — which is the one written for the
// defect just fixed.

describe('test-files-run', () => {
  // Labeled explicitly: deriving the directory name from the file list made two
  // trees collide, and a stale file from the first one failed the second — a
  // fixture leak, which reads exactly like a rule that over-fires.
  const pkg = (label, scripts, files) => tree('tf-' + label, {
    'packages/thing/package.json': JSON.stringify({ name: 'thing', scripts }),
    ...Object.fromEntries(Object.entries(files).map(([f, body]) => [`packages/thing/${f}`, body])),
  })
  const check = (root) => runChecks({ root, scope: 'repo', only: ['test-files-run'] })

  test('a file no script names is an error', () => {
    const root = pkg('missing', { test: 'bun test tests/a.test.js tests/b.test.js' },
      { 'tests/a.test.js': '//\n', 'tests/b.test.js': '//\n', 'tests/c.test.js': '//\n' })
    const { findings } = check(root)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/tests\/c\.test\.js/)
  })

  test('a complete list is silent', () => {
    const root = pkg('complete', { test: 'node test/a.test.js && node test/b.test.js' },
      { 'test/a.test.js': '//\n', 'test/b.test.js': '//\n' })
    expect(check(root).findings).toEqual([])
  })

  test('another test:* script naming it counts — the question is whether ANYTHING runs it', () => {
    const root = pkg('other-script', { test: 'bun test tests/a.test.js tests/b.test.js',
                       'test:browser': 'node tests/drive.test.js' },
      { 'tests/a.test.js': '//\n', 'tests/b.test.js': '//\n', 'tests/drive.test.js': '//\n' })
    expect(check(root).findings).toEqual([])
  })

  test('a runner that walks the directory cannot forget a file, so it is not graded', () => {
    // vitest, jest, `node --test`, and `bun test` pointed at a directory. The
    // whole rule is about a script that names its files one at a time.
    for (const [i, script] of ['vitest run', 'bun test test/', 'node --test'].entries()) {
      const root = tree(`tf-walk-${i}`, {
        'packages/thing/package.json': JSON.stringify({
          name: 'thing', scripts: { test: script, 'test:one': 'bun test test/a.test.js', 'test:two': 'bun test test/b.test.js' } }),
        'packages/thing/test/a.test.js': '//\n',
        'packages/thing/test/b.test.js': '//\n',
        'packages/thing/test/c.test.js': '//\n',
      })
      expect(check(root).findings).toEqual([])
    }
  })

  test('a :watch script is not read — it is the bare runner by nature', () => {
    // Reading it would make every hand-listing package look like it discovers,
    // which is how this rule would quietly stop covering anything.
    const root = pkg('watch', { test: 'bun test tests/a.test.js tests/b.test.js', 'test:watch': 'bun test --watch' },
      { 'tests/a.test.js': '//\n', 'tests/b.test.js': '//\n', 'tests/c.test.js': '//\n' })
    expect(check(root).findings).toHaveLength(1)
  })

  // The fixture used to leave `stub.js` unreferenced, which does not model what
  // this case is called: support code is support code because a test IMPORTS
  // it. Unimported and unrun, it is indistinguishable from a dead harness —
  // which is exactly what jetty's two `.mjs` HMR files were (`FJS-481`).
  test('a harness beside the tests is support code, not an unrun test', () => {
    const root = pkg('harness', { test: 'node test/a.test.js && node test/b.test.js' },
      { 'test/a.test.js': "import './stub.js'\n", 'test/b.test.js': '//\n', 'test/stub.js': '//\n' })
    expect(check(root).findings).toEqual([])
  })

  test('a file no script runs and no test imports is dead, whatever it is called', () => {
    const root = pkg('dead', { test: 'node test/a.test.js && node test/b.test.js' },
      { 'test/a.test.js': '//\n', 'test/b.test.js': '//\n', 'test/hmr-fullflow.mjs': '//\n' })
    const { findings } = check(root)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('test/hmr-fullflow.mjs')
  })

  test('a repo where nobody hand-lists is skipped, not passed', () => {
    const root = pkg('nolist', { test: 'vitest run' }, { 'tests/a.test.js': '//\n' })
    const { findings, skipped } = check(root)
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

describe('a styled value names a token the stylesheets define', () => {
  // The declaration is dropped WHOLE, so this is not a wrong color — it is no
  // border at all, with the stylesheet present in the bundle and every selector
  // matching. It took this repo's own storefront apart while its drive stayed
  // green, because a drive asserts what a page says.
  const styled = (css) => ({ ...CLEAN, 'web/src/pages/panel.mesa': `<style>\n  .p { ${css} }\n</style>\n` })

  test('a token nothing declares is reported, naming it', () => {
    const root = tree('token-bad', styled('gap: var(--space-4)'))
    const { findings } = only(root, 'css-token-undefined')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/var\(--space-4\)/)
    expect(findings[0].line).toBe(2)
  })

  test('a token the dependency declares is not', () => {
    const root = tree('token-dep', styled('gap: var(--gap)'))
    expect(only(root, 'css-token-undefined').findings).toEqual([])
  })

  test('a token the file itself declares is not', () => {
    const root = tree('token-local', styled('--mine: 2px; gap: var(--mine)'))
    expect(only(root, 'css-token-undefined').findings).toEqual([])
  })

  // The line between a defect and a knob. A fallback is an author saying the
  // token may be absent, and it is what a component's own knob looks like from
  // outside — `var(--cp-accent, var(--color-primary))`. Nothing is dropped.
  test('an undeclared token carrying a fallback is not', () => {
    const root = tree('token-fallback', styled('gap: var(--knob, 1rem)'))
    expect(only(root, 'css-token-undefined').findings).toEqual([])
  })

  test('one finding per token per file, not one per use', () => {
    const root = tree('token-dedupe', styled('gap: var(--space-4); padding: var(--space-4)'))
    expect(only(root, 'css-token-undefined').findings).toHaveLength(1)
  })

  test('an app whose dependencies ship no CSS is skipped, not passed', () => {
    const bare = { ...CLEAN }
    delete bare['node_modules/@acme/skin/package.json']
    delete bare['node_modules/@acme/skin/src/index.css']
    bare['package.json'] = JSON.stringify({ name: 'app', dependencies: { '@acme/kit': '*' } })
    const root = tree('token-nocss', { ...bare, 'web/src/pages/panel.mesa': '<style>\n  .p { gap: var(--nope) }\n</style>\n' })
    const { findings, skipped } = only(root, 'css-token-undefined')
    expect(findings).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

describe('a model graded by capability is not also graded by ladder', () => {
  // `FJS-D146`: the grid and the gate are ANDed, with the gate as the floor. That
  // is what keeps standing that crosses tenants available — and it means a write
  // level above the read level is the ladder answering what the grid was declared
  // to answer, so every grant is silently narrowed by it. The shape is a model
  // moved onto capabilities with its old gate left behind.
  const grid = (gate) => ({
    ...CLEAN,
    'db/schema.lite': SCHEMA + `\nmodel Invoice {\n  id Int @id\n  workspaceId Int\n  ${gate}\n  @@capabilities\n}\n`,
  })

  test('a laddered gate on a grid model is reported, naming the operations', () => {
    const root = tree('cap-ladder', grid('@@gate("2.5.5.6")'))
    const { findings } = only(root, 'capability-ladder')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/create, update, delete need level 5\/5\/6 where read needs 2/)
    expect(findings[0].message).toMatch(/ANDed/)
  })

  test('a flat gate is the shape it is asking for, and says nothing', () => {
    const root = tree('cap-flat', grid('@@gate("2")'))
    expect(only(root, 'capability-ladder').findings).toEqual([])
  })

  test('a laddered gate on a model with no grid is untouched', () => {
    const root = tree('cap-nogrid', {
      ...CLEAN,
      'db/schema.lite': SCHEMA + '\nmodel Plain {\n  id Int @id\n  workspaceId Int\n  @@gate("2.5.5.6")\n}\n',
    })
    expect(only(root, 'capability-ladder').findings).toEqual([])
  })

  test('it reads the NAMED gate form too, which is what this repo writes', () => {
    // Reading only `@@gate("2.5.5.6")` would make the rule silent on every schema
    // that spells its gate by name — `example` and `basecamp` both do — so it
    // would have been dead exactly where it matters.
    const root = tree('cap-named', {
      ...CLEAN,
      'db/schema.lite': SCHEMA +
        '\nmodel Invoice {\n  id Int @id\n  workspaceId Int\n' +
        '  @@gate(read: READER, write: USER, delete: ADMINISTRATOR)\n  @@capabilities\n}\n',
    })
    const { findings } = only(root, 'capability-ladder')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/create, update, delete need level 4\/4\/5 where read needs 2/)
  })

  test('a named gate that is flat says nothing', () => {
    const root = tree('cap-named-flat', {
      ...CLEAN,
      'db/schema.lite': SCHEMA +
        '\nmodel Invoice {\n  id Int @id\n  workspaceId Int\n  @@gate(all: READER)\n  @@capabilities\n}\n',
    })
    expect(only(root, 'capability-ladder').findings).toEqual([])
  })

  test('it skips rather than passing when no model declares the grid', () => {
    // A rule reporting nothing because it found nothing to look at has not
    // passed, and this file is written to keep the two apart.
    const root = tree('cap-none', { ...CLEAN, 'db/schema.lite': 'model Lead { id Int @id }\n' })
    const { skipped } = runChecks({ root, only: ['capability-ladder'] })
    expect(skipped).toHaveLength(1)
  })
})

describe('schema-in-memory', () => {

  // An app that hands `createClient` a schema STRING while `db/schema.lite`
  // exists is running models no tool can read — every schema tool takes a path.
  // The cost is not documentation: `release:check` compares release surfaces, so
  // a contract on a model absent from both grades as an expand.
  //
  // Measured on `example`, which appended auth's fragments at boot: 39 models
  // ran and 32 were in each of the four committed artefacts, the identity model
  // and the credential store among the seven missing (`FJS-626`).

  test('a schema: string beside a schema.lite is a warning naming the artefacts', () => {
    const root = tree('sim-inline', {
      ...CLEAN,
      'api/src/db.ts': [
        "import { createClient } from '@frontierjs/litestone'",
        "export const db = await createClient({",
        "  path:   './db/schema.lite',",
        "  schema: appSchema + authSchemaFragments('main'),",
        "})",
      ].join('\n'),
    })

    const { findings } = only(root, 'schema-in-memory')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('warn')
    expect(findings[0].message).toContain('createClient')
    expect(findings[0].message).toContain('release:check')
    // The way out, spelled: a path is read with parseFile, which resolves imports.
    expect(findings[0].message).toContain('parseFile')
  })

  test('createTenantRegistry is the same call and is named as itself', () => {
    const root = tree('sim-registry', {
      ...CLEAN,
      'api/src/db.ts': [
        "import { createTenantRegistry } from '@frontierjs/litestone'",
        "const registry = await createTenantRegistry({ schema: full, path: FILE })",
      ].join('\n'),
    })

    const { findings } = only(root, 'schema-in-memory')
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('createTenantRegistry')
  })

  // The three controls. Each is a legitimate shape that an over-eager version of
  // this rule reports, and the first two are how it would get switched off.

  test('a TEST states its own schema inline, and that is how a test is written', () => {
    // Found by running the rule over basecamp, where its only finding was
    // `db/test/schema.test.ts`.
    const root = tree('sim-test', {
      ...CLEAN,
      'db/test/schema.test.ts': "await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })\n",
      'api/src/thing.spec.ts':  "await createClient({ schema: 'model Y { id Int @id }' })\n",
    })
    expect(only(root, 'schema-in-memory').findings).toHaveLength(0)
  })

  test('the word in a COMMENT is prose, because this rule describes its own hazard', () => {
    const root = tree('sim-comment', {
      ...CLEAN,
      'api/src/db.ts': [
        '// Never pass createClient({ schema: … }) here — see FJS-626.',
        "export const db = await createClient({ path: './db/schema.lite' })",
      ].join('\n'),
    })
    expect(only(root, 'schema-in-memory').findings).toHaveLength(0)
  })

  test('an app handed a path alone is what the rule is for, and is silent', () => {
    const root = tree('sim-clean', {
      ...CLEAN,
      'api/src/db.ts': "export const db = await createClient({ path: './db/schema.lite' })\n",
    })
    expect(only(root, 'schema-in-memory').findings).toHaveLength(0)
  })

  test('no db/schema.lite is a skip, not a pass — an app may declare none', () => {
    const files = { ...CLEAN }
    delete files['db/schema.lite']
    const root = tree('sim-noschema', {
      ...files,
      'api/src/db.ts': "await createClient({ schema: 'model X { id Int @id }' })\n",
    })
    expect(only(root, 'schema-in-memory').skipped).toBeTruthy()
  })
})
