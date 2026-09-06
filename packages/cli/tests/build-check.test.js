// ─── build-check.test.js — can this image be promoted, or only deployed? ────
//
// Phase 1c. `core/image.js` made a deploy able to say WHICH bytes it ran; this
// is whether those bytes mean anything in a second environment. Every rule here
// rests on a measurement against a real daemon, recorded in the module header —
// the tests themselves are pure, because a suite that needs Docker is a suite
// that stops running.
//
// The trace was graded against `docker build` on four shapes (wholesale
// `COPY --from=build /app /app`, a subtree copy, a single-stage `COPY api ./api`
// and a `**/.env` exclusion), two files each, at two depths: 8 of 8 agreed.
// Those eight are reproduced below as the cases that must not drift.

import { describe, test, expect } from 'bun:test'
import {
  inspectBuild, parseDockerfile, parseDockerignore, ignoreDecision,
  traceToFinalImage, compileGlob, joinPath, isEnvFile, isStateFile,
  refuses, summarize, gather, walkContextFiles,
  STATE_EXTENSIONS, CONTEXT_FIND, classifyContextFile,
} from '../core/build-check.js'

const findingsFor = (opts) => inspectBuild(opts).map(f => `${f.level}:${f.rule}`)
const ruleFor     = (opts, rule) => inspectBuild(opts).find(f => f.rule === rule)

// ─── .dockerignore ───────────────────────────────────────────────────────────

describe('.dockerignore, as Docker actually reads it', () => {
  // The measured asymmetry: `*` does not cross a separator, so an ignore file
  // written for the context root leaves every subdirectory copied — and looks
  // like protection.
  test('a bare pattern reaches the root only', () => {
    const p = parseDockerignore('.env\n.env.*\n')
    expect(ignoreDecision('.env.production',     p)).toBe('ignored')
    expect(ignoreDecision('api/.env.production', p)).toBe('included')
  })

  test('** crosses separators', () => {
    const p = parseDockerignore('**/.env\n**/.env.*\n')
    expect(ignoreDecision('.env.production',         p)).toBe('ignored')
    expect(ignoreDecision('api/.env.production',     p)).toBe('ignored')
    expect(ignoreDecision('a/b/c/.env.production',   p)).toBe('ignored')
  })

  // `**/x` has to match a bare `x`, or the two-line idiom above is wrong.
  test('**/ may match nothing at all', () => {
    expect(compileGlob('**/.env').test('.env')).toBe(true)
  })

  test('the LAST matching pattern decides, which is what makes ! work', () => {
    const p = parseDockerignore('**/.env*\n!.env.example\n')
    expect(ignoreDecision('.env.production', p)).toBe('ignored')
    expect(ignoreDecision('.env.example',    p)).toBe('included')
  })

  test('a negation the other way round loses', () => {
    const p = parseDockerignore('!.env.example\n**/.env*\n')
    expect(ignoreDecision('.env.example', p)).toBe('ignored')
  })

  test('an excluded DIRECTORY takes its contents with it', () => {
    const p = parseDockerignore('node_modules\n')
    expect(ignoreDecision('node_modules/x/.env', p)).toBe('ignored')
  })

  test('comments, blanks, ./ and trailing slashes are all the same pattern', () => {
    for (const text of ['db/\n', './db\n', '# c\n\ndb\n']) {
      expect(ignoreDecision('db/shop.db', parseDockerignore(text))).toBe('ignored')
    }
  })

  // Three answers rather than two, for toolbelt's `match` reason: a matcher
  // forced to return a boolean has to guess, and both guesses are silent — one
  // hides a baked secret, the other refuses a correct app.
  test('a pattern that cannot be compiled answers unknown, not a guess', () => {
    const p = parseDockerignore('.env\n[bad\n')
    expect(p.find(x => x.pattern === '[bad').re).toBeNull()
    expect(ignoreDecision('.env', p)).toBe('unknown')
  })

  test('no ignore file at all includes everything', () => {
    expect(ignoreDecision('.env', parseDockerignore(null))).toBe('included')
  })
})

// ─── the Dockerfile ──────────────────────────────────────────────────────────

describe('reading a Dockerfile', () => {
  // The form this repo's own template writes. A line-at-a-time reader sees half.
  test('a continuation is one instruction', () => {
    const df = parseDockerfile('FROM alpine\nENV NODE_ENV=production \\\n    PORT=3000\n')
    expect(df.envs.map(e => e.key)).toEqual(['NODE_ENV', 'PORT'])
    expect(df.envs[1].value).toBe('3000')
  })

  test('the legacy space form parses, values with spaces included', () => {
    const df = parseDockerfile('FROM alpine\nENV GREETING hello there\n')
    expect(df.envs[0]).toMatchObject({ key: 'GREETING', value: 'hello there' })
  })

  test('a quoted value keeps its spaces and loses its quotes', () => {
    const df = parseDockerfile('FROM alpine\nENV A="one two" B=three\n')
    expect(df.envs.map(e => e.value)).toEqual(['one two', 'three'])
  })

  test('a FROM naming an earlier stage is not a base image', () => {
    const df = parseDockerfile('FROM alpine:1 AS build\nFROM build AS test\n')
    expect(df.froms.map(f => f.stageRef)).toEqual([false, true])
  })

  test('a --platform flag does not become the image name', () => {
    const df = parseDockerfile('FROM --platform=linux/amd64 alpine:3.19\n')
    expect(df.froms[0]).toMatchObject({ image: 'alpine', tag: '3.19' })
  })

  test('a digest is read as a digest, not as part of the tag', () => {
    const df = parseDockerfile(`FROM alpine:3.19@sha256:${'a'.repeat(64)}\n`)
    expect(df.froms[0]).toMatchObject({ image: 'alpine', tag: '3.19', digest: `sha256:${'a'.repeat(64)}` })
  })

  test('WORKDIR applies to the COPYs after it, and compounds', () => {
    const df = parseDockerfile('FROM alpine\nWORKDIR /app\nCOPY a .\nWORKDIR sub\nCOPY b .\n')
    expect(df.copies.map(c => c.workdir)).toEqual(['/app', '/app/sub'])
  })

  test('COPY --from is separated from a context copy', () => {
    const df = parseDockerfile('FROM alpine AS b\nFROM alpine\nCOPY --from=b /app /app\nCOPY . .\n')
    expect(df.copies.map(c => c.from)).toEqual(['b', null])
  })

  test('the JSON array form parses', () => {
    const df = parseDockerfile('FROM alpine\nCOPY ["src", "dest"]\n')
    expect(df.copies[0]).toMatchObject({ sources: ['src'], dest: 'dest' })
  })
})

// ─── does it reach the final image ───────────────────────────────────────────
//
// The eight cases graded against a real `docker build`. Getting this wrong is
// wrong in BOTH directions — the first version of the module refused every
// multi-stage build in this repo, and a version without the trace at all would
// miss the wholesale copy that genuinely ships.

// Pinned by digest so the base-image rules contribute nothing: a fixture that
// also trips `unpinned-base` cannot show that a context rule fired ALONE.
const BASE = `alpine:3.19@sha256:${'a'.repeat(64)}`

const WHOLE = `FROM ${BASE} AS build
WORKDIR /app
COPY . .
FROM ${BASE}
WORKDIR /app
COPY --from=build /app /app
`
const SUBTREE = `FROM ${BASE} AS build
WORKDIR /app
COPY . .
FROM ${BASE}
WORKDIR /app
COPY --from=build /app/dist ./dist
`
const SINGLE = `FROM ${BASE}
WORKDIR /app
COPY api ./api
`

describe('tracing a context file to the final image', () => {
  test.each([
    ['wholesale copy ships the root file',   WHOLE,   '.env',     true,  '/app/.env'],
    ['wholesale copy ships a nested file',   WHOLE,   'api/.env', true,  '/app/api/.env'],
    ['a subtree copy ships neither',         SUBTREE, '.env',     false, null],
    ['a subtree copy ships neither (nested)',SUBTREE, 'api/.env', false, null],
    ['COPY api does not reach the root',     SINGLE,  '.env',     false, null],
    ['COPY api ships what is under api',     SINGLE,  'api/.env', true,  '/app/api/.env'],
  ])('%s', (_label, dockerfile, file, ships, at) => {
    const t = traceToFinalImage(parseDockerfile(dockerfile), file)
    expect(t.ships).toBe(ships)
    if (at) expect(t.at).toBe(at)
  })

  // Docker copies the CONTENTS of a directory source, never the directory.
  test('COPY . . lands a file at the workdir, keeping its path', () => {
    const t = traceToFinalImage(parseDockerfile('FROM alpine\nWORKDIR /srv\nCOPY . .\n'), 'api/.env')
    expect(t.at).toBe('/srv/api/.env')
  })

  test('an absolute dest is not joined to the workdir', () => {
    const t = traceToFinalImage(parseDockerfile('FROM alpine\nWORKDIR /app\nCOPY . /opt/x\n'), '.env')
    expect(t.at).toBe('/opt/x/.env')
  })

  test('a stage can be named by index as well as by name', () => {
    const t = traceToFinalImage(parseDockerfile('FROM alpine\nWORKDIR /app\nCOPY . .\nFROM alpine\nCOPY --from=0 /app /app\n'), '.env')
    expect(t.ships).toBe(true)
  })

  test('--from an EXTERNAL image carries nothing of this context', () => {
    const t = traceToFinalImage(parseDockerfile('FROM alpine AS b\nWORKDIR /app\nCOPY . .\nFROM alpine\nCOPY --from=nginx:alpine /etc /etc\n'), '.env')
    expect(t.ships).toBe(false)
    expect(t.stagesHolding).toEqual([0])
  })

  test('a file nothing copies reaches no stage at all', () => {
    const t = traceToFinalImage(parseDockerfile(SINGLE), 'web/.env')
    expect(t).toMatchObject({ ships: false, stagesHolding: [] })
  })

  test('joinPath normalizes .. and duplicate separators', () => {
    expect(joinPath('/app', './x/../y')).toBe('/app/y')
    expect(joinPath('/app/', '/abs')).toBe('/app/abs')
  })
})

// ─── the rules ───────────────────────────────────────────────────────────────

describe('configuration in the bytes', () => {
  const ctx = { dockerfile: WHOLE, contextFiles: ['.env.production', 'src/app.js'] }

  test('a value file that ships is a refusal', () => {
    const f = ruleFor(ctx, 'context-config')
    expect(f.level).toBe('error')
    expect(f.title).toContain('.env.production')
    expect(refuses(inspectBuild(ctx))).toBe(true)
  })

  // The measurement that made this a warning rather than an error: two trees
  // whose .env differed built a byte-identical final image.
  test('a value file left in a build stage is a warning, and says why', () => {
    const f = ruleFor({ dockerfile: SUBTREE, contextFiles: ['.env'] }, 'build-stage-config')
    expect(f.level).toBe('warn')
    expect(f.detail).toContain('--target')
    expect(refuses(inspectBuild({ dockerfile: SUBTREE, contextFiles: ['.env'] }))).toBe(false)
  })

  test('excluding it clears the finding entirely', () => {
    expect(findingsFor({ ...ctx, dockerignore: '**/.env*\n' })).toEqual([])
  })

  // The whole point of .env.example is to declare keys with no values, and step
  // 01b compares the server against it.
  test('.env.example is not configuration', () => {
    expect(isEnvFile('.env.example')).toBe(false)
    expect(findingsFor({ dockerfile: WHOLE, contextFiles: ['.env.example'] })).toEqual([])
  })

  test('a live database is the same mistake in its sharpest form', () => {
    expect(isStateFile('db/shop.db')).toBe(true)
    expect(ruleFor({ dockerfile: WHOLE, contextFiles: ['db/shop.db'] }, 'context-config').level).toBe('error')
  })

  test('the hint names the ** form when an ignore file already exists', () => {
    const f = ruleFor({ ...ctx, dockerignore: 'node_modules\n' }, 'context-config')
    expect(f.hint).toContain('**/.env.production')
  })

  test('an unreadable ignore pattern is reported, not resolved either way', () => {
    const f = ruleFor({ ...ctx, dockerignore: '[bad\n' }, 'unreadable-build')
    expect(f.level).toBe('warn')
    expect(refuses(inspectBuild({ ...ctx, dockerignore: '[bad\n' }))).toBe(false)
  })
})

describe('configuration written into the image', () => {
  test('an ENV the app declares in .env.example is a refusal', () => {
    const f = ruleFor({
      dockerfile:   'FROM alpine\nENV DATABASE_URL=/db/stage.db\n',
      declaredKeys: ['DATABASE_URL'],
    }, 'env-config')
    expect(f.level).toBe('error')
  })

  test('the same ENV with nothing declared is left alone', () => {
    expect(findingsFor({ dockerfile: 'FROM alpine:1\nENV DATABASE_URL=/db/x.db\n' }))
      .toEqual(['warn:unpinned-base'])
  })

  // These describe the ARTEFACT rather than a deployment of it.
  test.each(['NODE_ENV', 'PATH', 'TZ'])('%s is a role, not a binding', (key) => {
    expect(findingsFor({ dockerfile: `FROM alpine:1\nENV ${key}=x\n`, declaredKeys: [key] }))
      .toEqual(['warn:unpinned-base'])
  })

  test('an ENV that only forwards a build arg is not a baked value', () => {
    expect(findingsFor({ dockerfile: 'FROM alpine:1\nARG V\nENV APP_SECRET=$V\n' }))
      .toEqual(['warn:unpinned-base'])
  })

  test('an ENV with no value declares a name and binds nothing', () => {
    expect(findingsFor({ dockerfile: 'FROM alpine:1\nENV JWT_SECRET=\n' })).toEqual(['warn:unpinned-base'])
  })
})

describe('credentials', () => {
  test.each(['JWT_SECRET', 'DB_PASSWORD', 'API_TOKEN', 'ENCRYPTION_KEY', 'SENTRY_DSN'])(
    'ENV %s with a value is a refusal', (key) => {
      expect(ruleFor({ dockerfile: `FROM alpine:1\nENV ${key}=hunter2\n` }, 'build-secret').level).toBe('error')
    })

  // A public key is published on purpose; a SITE_URL is not a credential. One
  // regex cannot tell a DATABASE_URL from a SITE_URL, so `_URL` is graded by
  // what the app DECLARES instead of by its spelling.
  test.each(['PUBLIC_KEY', 'VITE_API_KEY', 'SITE_URL', 'PUBLISHABLE_KEY'])(
    '%s is not treated as a credential', (key) => {
      expect(findingsFor({ dockerfile: `FROM alpine:1\nENV ${key}=x\n` })).toEqual(['warn:unpinned-base'])
    })

  // Measured: one --build-arg left the value in two `docker history` lines.
  test('an ARG naming a credential warns about the history, not the process', () => {
    const f = ruleFor({ dockerfile: 'FROM alpine:1\nARG JWT_SECRET\n' }, 'build-secret')
    expect(f.level).toBe('warn')
    expect(f.detail).toContain('docker history')
  })
})

describe('the base image', () => {
  test.each([
    ['no tag',   'FROM alpine\n'],
    ['latest',   'FROM alpine:latest\n'],
  ])('%s is a refusal', (_label, dockerfile) => {
    expect(ruleFor({ dockerfile }, 'unpinned-base').level).toBe('error')
  })

  // A version tag is what this repo's own template writes, and a check that
  // refuses `fli make:deploy`'s output is a default whose first use is red.
  test('a version tag warns and does not refuse', () => {
    const f = ruleFor({ dockerfile: 'FROM oven/bun:1\n' }, 'unpinned-base')
    expect(f.level).toBe('warn')
    expect(refuses(inspectBuild({ dockerfile: 'FROM oven/bun:1\n' }))).toBe(false)
  })

  test.each([
    ['a digest',        `FROM alpine:3.19@sha256:${'a'.repeat(64)}\n`],
    ['scratch',         'FROM scratch\n'],
    ['a stage',         'FROM alpine:1 AS b\nFROM b\n'],
    ['an ARG image',    'FROM $BASE\n'],
  ])('%s is not flagged', (_label, dockerfile) => {
    expect(inspectBuild({ dockerfile }).filter(f => f.rule === 'unpinned-base' && f.level === 'error')).toEqual([])
  })
})

describe('the report', () => {
  test('a clean build says what it is claiming', () => {
    expect(summarize([])).toContain('promotable')
    expect(refuses([])).toBe(false)
  })

  test('warnings alone still read as promotable', () => {
    expect(summarize(inspectBuild({ dockerfile: 'FROM oven/bun:1\n' }))).toContain('promotable')
  })

  test('findings are ordered by line, so the report follows the file', () => {
    const lines = inspectBuild({
      dockerfile: WHOLE + 'ENV JWT_SECRET=x\n',
      contextFiles: ['.env'],
    }).map(f => f.line)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
  })

  test('every finding names a rule the catalogue declares', async () => {
    const { RULES } = await import('../core/build-check.js')
    const all = inspectBuild({
      dockerfile: 'FROM alpine\nWORKDIR /app\nCOPY . .\nENV JWT_SECRET=x\n',
      contextFiles: ['.env'], dockerignore: '[bad\n',  // every rule at once
    })
    for (const f of all) expect(Object.keys(RULES)).toContain(f.rule)
  })

  test('an empty call answers nothing rather than throwing', () => {
    expect(inspectBuild()).toEqual([])
  })
})

// ─── gathering ───────────────────────────────────────────────────────────────
//
// Three callers assemble the same four inputs — the deploy step over ssh, and
// `deploy:local` / `deploy:doctor` off this tree — so the assembly is one
// function and only the reading differs. These are the shapes that would break
// the remote caller silently.

// ─── the finder and the classifier are one list ──────────────────────────────

describe('which files can bake a deployment into an image', () => {
  // Two lists for one fact, and they disagreed: `CONTEXT_FIND` looked for `*.db`
  // and not `*.db-wal`, so SQLite's own sidecars were invisible to the check
  // that exists to catch them. Every deploy after the first shipped the running
  // app's write-ahead log into the image, and moved the digest with it — which
  // is what made an unchanged redeploy mint a new Release.
  test('every extension the classifier grades is one the finder looks for', () => {
    for (const ext of STATE_EXTENSIONS) {
      expect(isStateFile(`db/app.${ext}`)).toBe(true)
      expect(CONTEXT_FIND).toContain(`-name '*.${ext}'`)
    }
  })

  test("SQLite's sidecars are state, not incidental files", () => {
    expect(isStateFile('db/app.db-wal')).toBe(true)
    expect(isStateFile('db/app.db-shm')).toBe(true)
    expect(classifyContextFile('db/app.db-wal')).toBe('state')
  })

  test('the finder still looks for env files, which are the other half', () => {
    expect(CONTEXT_FIND).toContain(`-name '.env'`)
    expect(CONTEXT_FIND).toContain(`-name '.env.*'`)
  })

  // The pattern the scaffold used to write. `*` does not cross a separator
  // (FJS-555) and it never covered the sidecars either.
  test('db/*.db protects neither the subtree nor the sidecars', () => {
    const pats = parseDockerignore('db/*.db')
    expect(ignoreDecision('db/app.db', pats)).toBe('ignored')
    expect(ignoreDecision('db/app.db-wal', pats)).toBe('included')
    expect(ignoreDecision('db/nested/app.db', pats)).toBe('included')
  })

  test('the pattern the scaffold writes now covers both', () => {
    const pats = parseDockerignore('**/*.db\n**/*.db-wal\n**/*.db-shm')
    expect(ignoreDecision('db/app.db', pats)).toBe('ignored')
    expect(ignoreDecision('db/app.db-wal', pats)).toBe('ignored')
    expect(ignoreDecision('db/nested/app.db', pats)).toBe('ignored')
    expect(ignoreDecision('app.db-shm', pats)).toBe('ignored')
  })
})

describe('gathering the four inputs', () => {
  const files = {
    'deploy/Dockerfile': SINGLE,
    '.dockerignore':     '**/.env\n',
    '.env.example':      '# keys\nJWT_SECRET=\nPORT=\n\n',
  }
  const read = (rel) => files[rel] ?? null

  test('it reads all four and strips ./ off the listing', () => {
    const g = gather({ read, list: () => ['./api/.env', '', './db/x.db'] })
    expect(g.contextFiles).toEqual(['api/.env', 'db/x.db'])
    expect(g.declaredKeys).toEqual(['JWT_SECRET', 'PORT'])
    expect(g.dockerignore).toBe('**/.env\n')
  })

  // The step reports and returns rather than refusing: no Dockerfile is not a
  // build that bakes anything, it is a question this check cannot be asked.
  test('an absent Dockerfile answers `missing` rather than an empty parse', () => {
    expect(gather({ read: () => null, list: () => [] })).toEqual({ missing: 'deploy/Dockerfile' })
  })

  test('a configured dockerfile path is honored and reported when absent', () => {
    expect(gather({ read, list: () => [], dockerfile: 'infra/Dockerfile' }).missing).toBe('infra/Dockerfile')
    expect(gather({ read, list: () => [], dockerfile: 'deploy/Dockerfile' }).missing).toBeUndefined()
  })

  // An absent .dockerignore and an empty one mean the same thing; an absent
  // Dockerfile and an empty one do not. Only the second distinction matters, and
  // `parseDockerignore` has to survive the first either way.
  test('a null dockerignore parses to no patterns rather than throwing', () => {
    const g = gather({ read: (r) => (r === 'deploy/Dockerfile' ? SINGLE : null), list: () => [] })
    expect(g.dockerignore).toBeNull()
    expect(parseDockerignore(g.dockerignore)).toEqual([])
  })

  test('an app declaring no keys gathers an empty list, not undefined', () => {
    expect(gather({ read: (r) => (r === 'deploy/Dockerfile' ? SINGLE : null), list: () => [] }).declaredKeys).toEqual([])
  })
})

describe('walking a tree', () => {
  // A fake fs, so the walk is tested without fixtures on disk — the same reason
  // the rules take text rather than paths.
  const tree = {
    '/app':               ['deploy', 'node_modules', 'db', '.env', 'README.md'],
    '/app/deploy':        ['Dockerfile'],
    '/app/node_modules':  ['.env'],
    '/app/db':            ['shop.db', 'schema.lite', 'nested'],
    '/app/db/nested':     ['deep.db'],
  }
  const fs = {
    readdirSync: (dir) => (tree[dir] ?? []).map(name => ({
      name, isDirectory: () => Boolean(tree[`${dir}/${name}`]),
    })),
  }

  test('it finds config and state at any depth', () => {
    expect(walkContextFiles('/app', { fs })).toEqual(['.env', 'db/nested/deep.db', 'db/shop.db'].sort())
  })

  test('node_modules is not walked — a real app root makes that the whole run', () => {
    expect(walkContextFiles('/app', { fs })).not.toContain('node_modules/.env')
  })

  test('it stops at the limit rather than growing without bound', () => {
    expect(walkContextFiles('/app', { fs, limit: 1 })).toHaveLength(1)
  })

  test('an unreadable directory is skipped, not thrown from', () => {
    const angry = { readdirSync: () => { throw new Error('EACCES') } }
    expect(walkContextFiles('/app', { fs: angry })).toEqual([])
  })
})
