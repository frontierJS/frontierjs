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
// an app is OFFERED is a product decision, and `ui`, `testing`, `email-kit` and
// `toolbelt` are deliberately absent for now. The list lives here rather than in
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
  '@frontierjs/auth':           'latest',
  '@frontierjs/conduit':        'latest',
  '@frontierjs/caravan':        'latest',
  '@frontierjs/notifications':  'latest',
  '@frontierjs/jetty':          'latest',
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

export function appTsconfig({ useWeb = true } = {}) {
  const config = {
    extends:        '@frontierjs/config/tsconfig',
    compilerOptions: useWeb ? { paths: { '@/*': ['./web/src/*'] } } : {},
    include:        useWeb ? ['api/**/*', 'web/**/*'] : ['api/**/*'],
  }
  if (!useWeb) delete config.compilerOptions
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

export function appCheckScripts() {
  return {
    lint:       'biome check --error-on-warnings .',
    'lint:fix': 'biome check --write .',
    typecheck:  'fli typecheck',
    check:      'fli check && bun run lint && bun run typecheck',
  }
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
