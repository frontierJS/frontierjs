// ─── app-config ───────────────────────────────────────────────────────────────
//
// What a scaffolded FrontierJS application is given, besides its own source.
// `fli new` writes every file below; nothing else decides any of it.
//
// The generated package.json and config files are the framework's real opinion
// about tooling — far more people will read them than will ever read this repo,
// and every one of these defaults is nearly impossible to change afterwards.
// So they live in one module with the reasoning attached, rather than as string
// literals scattered through a 1400-line command.
//
// ─── the rule the shapes follow ──────────────────────────────
//
// **The config is a dependency the app extends in a line, not a file copied
// into it.** A copy is frozen at the moment it was written; a dependency
// improves for every app that already exists. `@frontierjs/config` holds the
// two extensible ones.
//
// `.editorconfig` is the exception and the only one: EditorConfig has no
// extends mechanism, so the text has to be written into the app. That makes it
// a hand copy of `packages/config/editorconfig`, and `packages/config/test`
// asserts the two are byte-identical rather than trusting anyone to remember.

// ─── .editorconfig ────────────────────────────────────────────────────────────
// Byte-identical to packages/config/editorconfig. Change one, change both — the
// test names this file when they diverge.

export const EDITORCONFIG = `# FrontierJS house style, in the one file every editor reads without a plugin.
#
# This is the exception to "config is a dependency, not a copy": EditorConfig
# has no extends mechanism, so the scaffold writes this text into the app. The
# copy in @frontierjs/config is the original, and packages/config/test asserts
# the two are byte-identical — a drift is a failing test rather than a slow
# divergence.
#
# Indentation and quotes are all it says. Column alignment — the rule that
# refuses a formatter — is not expressible here and stays a matter of reading
# the file you are in.

root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
`

// ─── the dev dependencies an app is given ─────────────────────────────────────
// `latest` matches how the framework packages themselves are pinned while this
// is pre-alpha. Biome is a peer of @frontierjs/config and optional there, so an
// app that deletes biome.json can drop it without a broken install.

// `@frontierjs/cli` is here rather than assumed on PATH. A globally installed
// fli of a different vintage generating files for this app's framework version
// is the drift that pinning removes, and it is what makes `bun run check` work
// on a clone with nothing installed.

// ─── the framework packages an app can be given ───────────────────────────────
// The runtime half of the same decision. `fli new` writes a subset of these,
// chosen by the surfaces asked for. It is not every publishable package: what
// an app is OFFERED is a product decision, and `testing` and `email-kit` are
// deliberately absent for now.
//
// **A package a GENERATOR imports is not a product decision.** `ui` is IN
// because every CRUD page `fli scaffold` and `fli admin:generate` write is
// built on it — `<Form {resource} />` with no children is the generated form —
// so a scaffold without it produces pages that cannot resolve their own
// imports. `toolbelt` was on the absent list while the same sentence had become
// true of it: the generated list page imports `encodeQueryString` and
// `directiveParams`, and `bun run build` exited 1 on a freshly scaffolded app
// (`FJS-1045`). Adding a generator import is therefore a change to this list. The list lives here rather than in
// the command because the `registry` CI phase asks the npm registry whether it
// can serve every name in it — a scaffold that installs a package nobody
// published is an app that cannot start, and nothing else in the repo compares
// the two.
//
// `latest` while the framework is pre-alpha: a fresh install should pull the
// most recent published version, and pinning sixteen ranges by hand is how a
// scaffold ends up installing a set that was never released together.

export const FJS_PACKAGES = {
  '@frontierjs/junction':       'latest',
  '@frontierjs/sierra':         'latest',
  '@frontierjs/mesa':           'latest',
  '@frontierjs/litestone':      'latest',
  '@frontierjs/css':            'latest',
  '@frontierjs/ui':             'latest',
  '@frontierjs/auth':           'latest',
  '@frontierjs/conduit':        'latest',
  '@frontierjs/caravan':        'latest',
  '@frontierjs/notifications':  'latest',
  '@frontierjs/jetty':          'latest',
  '@frontierjs/toolbelt':       'latest',
}

export const APP_DEV_DEPS = {
  '@frontierjs/cli':    'latest',
  '@frontierjs/config': 'latest',
  '@biomejs/biome':     '^2.5.0',
  'bun-types':          'latest',
  'typescript':         '^5.0.0',
}

// ─── tsconfig.json ────────────────────────────────────────────────────────────
// One line of extends plus what is genuinely about this app's layout. Everything
// else — target, lib, strict, allowImportingTsExtensions — is in the dependency,
// where it can be corrected later.

export function appTsconfig({
  useWeb = true, useSite = false, useWidgets = false, useExtension = false, useApi = true,
} = {}) {
  // `@` is the SURFACE's own src/, and Sierra resolves it against the Vite root
  // — so it means a different directory in web/ than it does in site/. tsc has
  // one program and no notion of a Vite root, so `paths` lists every surface the
  // app has and the FIRST that exists wins. That is exact for an app with one
  // UI surface and a guess for an app with two: `@/cart.js` in a site/ file
  // resolves against web/src for the editor while Vite resolves it against
  // site/src. It costs nothing at runtime — `checkJs` is off and tsc cannot read
  // a .mesa at all — and the alternative is a tsconfig per surface, which is
  // four programs to typecheck what is one app.
  const surfaces = [
    useWeb       && 'web',
    useSite      && 'site',
    useWidgets   && 'widgets',
    useExtension && 'extension',
  ].filter(Boolean)

  const config = {
    extends: '@frontierjs/config/tsconfig',
    ...(surfaces.length
      ? { compilerOptions: { paths: { '@/*': surfaces.map((s) => `./${s}/src/*`) } } }
      : {}),
    include: [
      ...(useApi ? ['api/**/*'] : []),
      ...surfaces.map((s) => `${s}/**/*`),
    ],
  }
  return JSON.stringify(config, null, 2) + '\n'
}

// ─── biome.json ───────────────────────────────────────────────────────────────
// Linter only. The formatter is off in the shared config and the reason is in
// its README: this house aligns columns, and no formatter can express that, so
// the first format run would rewrite the app the scaffold had just written.

export function appBiomeJson() {
  return JSON.stringify({ extends: ['@frontierjs/config/biome'] }, null, 2) + '\n'
}

// ─── the scripts ──────────────────────────────────────────────────────────────
// `check` is the app's whole gate, and the ORDER in it is the decision: `fli
// check` runs first because it is the half a linter cannot reach. Biome reads
// neither .mesa nor .lite, which is where an FJS app's real mistakes live — a
// model name that is not PascalCase singular, a resource file named for its
// service, a vite config without strictPort.
//
// `--error-on-warnings` because a warning nobody fails on is a warning nobody
// reads.
//
// `typecheck` is `fli typecheck` and not a bare `tsc --noEmit`, which does not
// work here and cannot be made to: every @frontierjs package ships TypeScript
// SOURCE, so tsc follows those imports and checks the framework as part of the
// app's own program. A freshly scaffolded app gets several hundred diagnostics
// from inside node_modules and none of its own. `core/typecheck.js` reports the
// ones that belong to the app and counts the rest.
//
// `test` runs last, because it is the slowest and a type error explains a
// failing test better than the other way round. It exists only where a test
// was written: `bun test` over a directory holding none exits non-zero, so a
// `check` naming it would fail every app scaffolded without one.

export function appCheckScripts({ tests = false } = {}) {
  const scripts = {
    lint:       'biome check --error-on-warnings .',
    'lint:fix': 'biome check --write .',
    typecheck:  'fli typecheck',
    check:      'fli check && bun run lint && bun run typecheck',
  }
  if (tests) {
    scripts.test   = 'bun test api/test'
    scripts.check += ' && bun run test'
  }
  return scripts
}

// ─── .github/workflows/ci.yml ─────────────────────────────────────────────────
// An app gets a workflow, because the alternative is that it never gets one.
// It calls `bun run check` and nothing else, for the same reason this repo's
// own workflow calls `scripts/ci.mjs` and nothing else: a gate that only exists
// inside a CI provider cannot be run before pushing.
//
// It installs and runs; it does not deploy, because where an app deploys is not
// something the scaffold can know.

export function appWorkflow({ name = 'ci' } = {}) {
  return `# ${name} — the same gate you can run locally with \`bun run check\`.
#
# Nothing lives in this file but the call. A check that only exists inside a CI
# provider cannot be run before pushing, which is how a red main branch happens.

name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run check
`
}

// ─── AGENTS.md and CLAUDE.md ──────────────────────────────────────────────────
// Much of an app is now written by a program somebody asked, and that program
// arrives knowing the ecosystem and not this framework: a role check in a hook,
// `Decimal(10,2)`, a resource file named for its service. Each is a legal
// spelling of something wrong, and nothing in a fresh scaffold says otherwise.
//
// `AGENTS.md` is the framework's half and `CLAUDE.md` is the app's. The second
// imports the first, so what the developer writes about their own app is never
// mixed into text the framework owns — and `AGENTS.md` is the name every other
// agent tool converged on, which is why the framework's half is not CLAUDE.md.
//
// It restates no package's reference (`FJS-D163`). Every line either points at
// a file the installed tarball carries or names the `fli check` rule that grades
// it, and `tests/app-config.test.js` holds both to their source: the pointers
// to `exports.snapshot.md`, the rule ids to `RULES`, the commands to the
// registry. The `scaffold` CI phase asks the installed app whether each pointer
// resolves, which is the only place the published bytes are read.

// The packages whose TARBALL carries an AGENTS.md, and what else it ships that
// the file tells a reader to open. Asserted against the packer's own listing in
// both directions — a package that starts shipping one and is missing here is a
// reference no app is pointed at.
export const AGENT_DOCS = {
  '@frontierjs/litestone': { covers: '`db/schema.lite` and every query',                beside: ['catalog.snapshot.md'] },
  '@frontierjs/junction':  { covers: 'services, hooks, `$` and raw routes',              beside: [] },
  '@frontierjs/sierra':    { covers: 'routes, resources, forms and prerendered pages', beside: [] },
  '@frontierjs/mesa':      { covers: 'the `.mesa` component language',                  beside: [] },
  '@frontierjs/ui':        { covers: 'the component kit — forms, tables, overlays',     beside: [] },
  '@frontierjs/css':       { covers: 'markup and styling',                              beside: ['vocabulary.json'] },
}

// A rule is written here only when a generic habit breaks it. `needs` is the
// package whose presence makes it true of this app; `rules` are the `fli check`
// ids that grade it, and an empty list says so on the line rather than implying
// a gate that is not there.
const AGENT_RULES = [
  { needs: null, rules: ['app-layout', 'surface-config', 'surface-src'],
    text: '`db/` sits at the app root and each surface — `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/` — '
        + 'is a directory beside it with its own `config/` and `src/`. A surface folded into another inherits '
        + 'that one\'s build, and a `site/` inside `web/` is deleted by the next SPA build.' },
  { needs: '@frontierjs/litestone', rules: ['model-name-case', 'model-name-plural'],
    text: 'Model names are PascalCase singular. `model Lead` is `db.lead` and the `leads` service, each derived '
        + 'from the other, so `model Leads` disconnects the API and the UI from the table.' },
  { needs: '@frontierjs/litestone', rules: [],
    text: 'Access is declared in the schema — `@@gate`, `@@allow`, `@guarded`, `@@transitions` — and never '
        + 'checked in a service hook. A hook guards the callers that pass through it; the schema guards every '
        + 'one, including a job, a seed and a migration.' },
  { needs: '@frontierjs/junction', rules: ['service-module-db'],
    text: 'A service reads the request-scoped client, `$.db` (`import { $ } from \'@frontierjs/junction\'`). '
        + 'The app\'s own imported client carries no principal, so every row policy sees `auth()` as null.' },
  { needs: '@frontierjs/litestone', rules: ['set-auth-discarded'],
    text: '`db.$setAuth(user)` returns a scoped client and changes nothing: `const userDb = db.$setAuth(user)`.' },
  { needs: '@frontierjs/litestone', rules: ['migration-history'],
    text: 'A schema change ships as a migration file, `fli db:migrate`. `fli db:push` changes the local tables '
        + 'and writes no file, and a deploy replays only files.' },
  { needs: '@frontierjs/sierra', rules: ['resource-dir-mesa', 'resource-script', 'resource-file-name', 'resource-one-per-file'],
    text: 'A Resource is a `.mesa` file in `src/resources/`, one per file and named for its model (`Lead.mesa`). '
        + 'Its `<script module>` calls `createResource`; its markup, when present, is the model\'s default form.' },
  { needs: '@frontierjs/css', rules: ['css-token-undefined'],
    text: 'Style with what a thing is and what is true about it — `class="btn outlined danger"` — never with a '
        + 'color, a size or a spacing value.' },
]

// Generators before hand-writing, because each one writes the file every rule
// above expects. `needs` as above.
const AGENT_GENERATORS = [
  { needs: '@frontierjs/sierra',    what: 'a model with its service, resource and pages', run: 'fli scaffold Lead --fields "name:string email:email"' },
  { needs: '@frontierjs/litestone', what: 'a model alone',                                run: 'fli make:model Lead' },
  { needs: '@frontierjs/sierra',    what: 'a Resource',                                   run: 'fli make:resource Lead' },
  { needs: '@frontierjs/sierra',    what: 'a page, wired to a Resource',                  run: 'fli make:route leads --resource Lead' },
  { needs: '@frontierjs/sierra',    what: 'a component',                                  run: 'fli make:component LeadCard' },
]

/** The framework's guidance for an agent writing code in this app.
 *  @param {{ name: string, packages: string[] }} o  every package the manifest names, dev half included */
export function appAgentsMd({ name, packages }) {
  const has   = new Set(packages)
  const wants = (row) => row.needs === null || has.has(row.needs)

  const docs = Object.entries(AGENT_DOCS).filter(([pkg]) => has.has(pkg))
  const docLines = docs.flatMap(([pkg, { covers, beside }]) => [
    `- \`node_modules/${pkg}/AGENTS.md\` — ${covers}`,
    ...beside.map(f => `  - \`node_modules/${pkg}/${f}\` beside it`),
  ])

  const ruleLines = AGENT_RULES.filter(wants).map(r =>
    `- ${r.text} ${r.rules.length ? `[${r.rules.map(id => `\`${id}\``).join(', ')}]` : '[not graded]'}`)

  const genLines = AGENT_GENERATORS.filter(wants).map(g => `| ${g.what} | \`${g.run}\` |`)

  return `# ${name} — for agents

A FrontierJS app. \`fli new\` wrote this file for a program writing code here;
\`README.md\` is the same app for a person, and \`CLAUDE.md\` is the app's own.

## The model

Everything derives from \`db/schema.lite\`: **Data (Model) → API (Service) → UI
(Resource)**. A rule declared in the schema reaches the API, the validators, the
forms and the migrations at once; the same rule written in code reaches one
caller. Change the schema first, then let a generator write what follows from it.

## Read before writing
${docLines.length ? `
${docLines.join('\n')}
` : ''}
A framework package added later ships its own at \`node_modules/<package>/AGENTS.md\`
when it has one. Never guess a schema word — \`fli db:explain @guarded\` answers
one live off the parser.
${genLines.length ? `
## Generate before hand-writing

| To add | Run |
| --- | --- |
${genLines.join('\n')}
` : ''}
## What a generic habit gets wrong here

The rule id in brackets is the \`fli check\` rule that reports a violation.

${ruleLines.join('\n')}

## After every change

\`\`\`bash
bun run check     # fli check, then lint, then typecheck — the same gate CI runs
\`\`\`

Fix what it reports before moving on. \`fli check --list\` prints every rule, and
\`fli check --fix\` applies the ones whose rewrite is the whole fix.
`
}

/** The app's own agent file. It imports the framework's and holds nothing else yet. */
export function appClaudeMd({ name }) {
  return `# ${name}

@AGENTS.md

\`AGENTS.md\` is the framework's guidance. This file is the app's: what it is for,
who uses it, and the decisions the schema does not hold.
`
}
