// ─── checks/data.js — the Data realm's rules ──────────────────────────────────
//
// What a `.lite` schema, a migration or a database path declares, against what
// the app's own code does with it. One slice of the rule bodies `core/checks.js`
// runs — the table, the runner and the baseline stay there, and a rule's id is
// the key. Same constraints as the entry: plain ESM on node, `@frontierjs/toolbelt`
// and this package's own modules, nothing else.

import { readdirSync, readFileSync, existsSync }       from 'fs'
import { join, relative, dirname, resolve, basename }  from 'path'
import { spawnSync }                                   from 'child_process'
import { modelName }                                   from '@frontierjs/toolbelt/inflect'
import { dockerfileScripts }                           from '../utils.js'
import { binCommand }                                  from '../snapshots.js'
import { declaredLogDatabases, declaredDatabasePaths } from '../db-preflight.js'
import { ignoredByGit }                                from '../gitignore.js'
import { shippedSchemas }                              from '../app-schema.js'
import {
  schemaFile, models, looksPlural, walk, sources, readCode, scripts,
  CLIENT_SURFACES, lineOf, servingServices, spanFrom, bodyOf, withoutComments,
} from './lib.js'

export const CHECKS = {

  // Invariant 2. Three resolvers agree that `model Lead` is `db.lead` and the
  // service `leads`; a name that is not PascalCase singular disagrees with one of
  // them, and which one it disagrees with is not stated anywhere.
  'model-name-case': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    return { findings: models(schema).filter(m => !/^[A-Z][A-Za-z0-9]*$/.test(m.name)).map(m => ({
      file: schema.path, line: m.line,
      message: `model ${m.name} — a model name is PascalCase. \`db.<accessor>\`, the service name and the ` +
               `JSON Schema \`$defs\` key are all derived from it, and they do not all derive the same way.`,
    })) }
  },

  // A warning, not an error, because English is not decidable. The plural
  // endings below are the ones that are; a false positive is answered by
  // renaming or by ignoring one line, and the alternative — saying nothing — is
  // how `model Servers` reaches the point where renaming it moves a migration.
  'model-name-plural': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    return { findings: models(schema).filter(m => looksPlural(m.name)).map(m => ({
      file: schema.path, line: m.line,
      message: `model ${m.name} — a model name is singular (\`model Lead\` → \`db.lead\` → service \`leads\`). ` +
               `If this really is singular, this line is a false positive; if not, rename it now, because ` +
               `later it moves a migration too.`,
    })) }
  },

  // Vite injects the built <script> at the first TEXTUAL match for the body tag
  // and does not skip comments. Mention it in one ABOVE the real tag and the
  // build succeeds, dist/index.html looks right, and the page loads no
  // JavaScript.
  //
  // FIRST is the whole rule (`FJS-329`). A mention below the real <body> is
  // harmless — Vite has already matched — and flagging it made this rule fire on
  // a file that documents its own markup, which is `packages/css/guide`. A check
  // that cries wolf is the failure this engine exists to prevent, and it is
  // worse in a rule an app runs than in one only this repo does.
  // A `File` column's LOCAL provider writes objects into a directory and
  // something has to serve them; if that something is a `static` mount, the
  // handler is serving bytes a stranger uploaded and cannot tell (`FJS-D314`).
  // `untrusted: true` is the answer and it is a flag somebody forgets — so this
  // is the rule that fires when it is absent, which is the whole reason A was
  // ruled over a mechanism that needed no flag.
  //
  // An S3/R2 provider is not in this path: the bucket serves the bytes. Only a
  // LOCAL one is, which is what this looks for.
  'untrusted-upload-root': ({ root }) => {
    const sources = []
    walk(root, 5, dir => {
      for (const name of readdirSync(dir)) {
        if (/\.[cm]?[jt]s$/.test(name)) sources.push(join(dir, name))
      }
    })

    let localStorage = null      // { file, ident }  — the provider and what it points at
    const mounts     = []        // { file, ident, marked }

    for (const path of sources) {
      const src = readFileSync(path, 'utf8')
      if (/\bFileStorage\s*\(/.test(src) && /provider\s*:\s*['"]local['"]/.test(src)) {
        const m = src.match(/localPath\s*:\s*([A-Za-z_$][\w$]*)/)
        localStorage = { file: path, ident: m?.[1] ?? null }
      }
      // `static:` inside an http block. The root is read as an identifier
      // because that is how the two halves are linked without evaluating the
      // config, and a literal path is left to the coexistence case below.
      for (const block of src.match(/static\s*:\s*\{[^}]*\}/g) ?? []) {
        const m = block.match(/root\s*:\s*([A-Za-z_$][\w$]*)/)
        mounts.push({ file: path, ident: m?.[1] ?? null, marked: /untrusted\s*:\s*true/.test(block) })
      }
    }

    if (!localStorage)   return { skipped: 'no local FileStorage provider' }
    if (!mounts.length)  return { skipped: 'no static mount' }

    const findings = []
    for (const mount of mounts) {
      if (mount.marked) continue
      const same = localStorage.ident && mount.ident && localStorage.ident === mount.ident
      findings.push({
        file: mount.file,
        message: same
          ? `this static mount and the local FileStorage both point at \`${mount.ident}\`, so it serves bytes ` +
            `a stranger uploaded — and an SVG served from it runs in this app's own origin. Add ` +
            `\`untrusted: true\` to the static block: anything outside the inline allow-list is then an ` +
            `attachment, and an image is unaffected.`
          : `a local FileStorage is configured (${relative(root, localStorage.file) || localStorage.file}) and ` +
            `this static mount does not say whether its bytes came from strangers. If it serves the ` +
            `uploads, add \`untrusted: true\`; if it serves only the app's own files, record the ` +
            `allowance — an SVG from an upload root runs in this origin.`,
      })
    }
    return { findings }
  },

  // A `File` column holds a storage reference, and FileStorage is what turns an
  // upload into one. `fli new` does not install it — it throws at boot outside
  // development with no provider configured, so an app with no `File` column
  // would pay for it in production — and an app that then declares one parses,
  // migrates and passes everything else until its first upload is refused
  // (`FJS-1898`). A warning: the scan sees a `FileStorage(` call in the app's own
  // source, and a client assembled by a package it imports is invisible to it.
  'file-column-storage': ({ root }) => {
    const columns = []
    for (const file of sources(root, ['.lite'], 'db')) {
      const lines = readCode(file).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([A-Za-z_][\w]*)\s+File(\[\])?\??(?=\s|$)/)
        if (m) columns.push({ file, line: i + 1, name: m[1], type: `File${m[2] ?? ''}` })
      }
    }
    if (!columns.length) return { skipped: 'no File column in db/' }

    let stored = false
    walk(root, 5, dir => {
      for (const name of readdirSync(dir)) {
        if (stored || !/\.[cm]?[jt]s$/.test(name)) continue
        const src = readCode(join(dir, name))
        if (/\bFileStorage\s*\(/.test(src) || /fieldType\s*=\s*['"]File['"]/.test(src)) stored = true
      }
    })
    if (stored) return { findings: [] }

    return { findings: columns.map(c => ({
      file: c.file, line: c.line,
      message: `${c.name} is a ${c.type} column and nothing in this app installs FileStorage, so the first ` +
               `upload into it is refused. Add \`FileStorage({ provider: 'local' })\` beside the gate in the ` +
               `client's \`plugins\` (api/src/core/db.ts in an app \`fli new\` made). \`local\` writes to this ` +
               `machine's disk; \`r2\` or \`s3\` is the provider for an app that is deployed.`,
    })) }
  },

  // Invariant 3's second half: configuration lives in `config/`.
  //
  // This is the silent-when-broken class those rules exist for. Nothing fails
  // when the directory is missing — a loader treats an absent config file as an
  // optional miss, which is right — so an app boots on framework defaults
  // looking configured. `basecamp` read `api/config` for its whole life without
  // that directory existing, and its CORS was `*` for everyone as a result
  // (`FJS-415`).
  //
  // Judged per SURFACE, and a surface with no source in it is skipped rather
  // than scolded — a directory somebody made is not a surface yet, and a rule
  // that scolds every fixture in a repo is a rule people turn off. `db/` is
  // exempt by name (Invariant 3 says so) and is not in the list.
  //
  // Three findings, in descending sharpness: a config file BESIDE a config/,
  // where one of the two is read and nobody can tell which; a config file at
  // the surface root with no config/ at all, which is read by nothing; and the
  // bare absence, which is basecamp's case and the one worth arguing about.
  //
  // The absence IS a finding, rather than "this surface declares nothing on
  // purpose", because the framework resolves that path whether or not the app
  // meant it to: `createApp({ root })` reads `../config` beside the root unconditionally.
  // An app that genuinely wants the defaults writes a config file saying so in
  // one line, which costs nothing and is the difference between a decision and
  // an accident.
  // The migration history must build the schema.
  //
  // `fli db:push` writes tables and no file; a deploy replays files. An app
  // that has only ever pushed deploys, starts, answers /health and 500s on the
  // first write — measured on this repo's own `example`, which had no
  // `db/migrations/` at all (`FJS-345`, `FJS-388`). A model added to the schema
  // with no migration is the same fault one table at a time, and `bun run
  // check` passed over it (`FJS-1640`).
  //
  // Two halves. A Dockerfile whose entrypoint replays migrations over a
  // `db/migrations/` holding no `.sql` is answered here without litestone, so
  // it holds on a tree with nothing installed. Every other app is asked of
  // `litestone migrate check`, which replays the files into memory and diffs
  // them against the schema; it is the same question `fli deploy:doctor` and
  // `migrate apply` ask, so there is one implementation of it (`FJS-D123`).
  // An app that migrates inside its own boot (basecamp, `FJS-417`) has the
  // semantic half and not the structural one.
  'migration-history': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const dir   = join(root, 'db', 'migrations')
    const files = existsSync(dir) ? walkSql(dir) : []

    const dockerfile = ['Dockerfile', join('deploy', 'Dockerfile')]
      .map(p => join(root, p)).find(p => existsSync(p))
    if (dockerfile && !files.length) {
      // Exec form and shell form are `dockerfileScripts`'s to read; a script an
      // ENTRYPOINT/CMD hands off to is read here, since the Dockerfile alone
      // cannot say what it runs.
      const text = readFileSync(dockerfile, 'utf8')
      let replays = dockerfileScripts(text).includes('db:migrate')
      if (!replays) {
        for (const line of text.split('\n')) {
          if (!/^\s*(CMD|ENTRYPOINT)\b/.test(line)) continue
          for (const m of line.matchAll(/[\w./-]+\.(?:sh|bash)\b/g)) {
            const script = [join(root, m[0]), join(dirname(dockerfile), m[0])].find(p => existsSync(p))
            if (script && /\bbun\s+run\s+db:migrate\b/.test(readFileSync(script, 'utf8'))) replays = true
          }
        }
      }
      if (replays) return { findings: [{
        file: 'db/migrations/',
        message: 'the container runs `bun run db:migrate` and there is no migration to replay, so it will '
               + 'start over an empty database and fail on the first write. Write one: `fli db:migrate`',
      }] }
    }

    const command = binCommand('litestone', root)
    if (!command) return { skipped: '@frontierjs/litestone is not installed where the app can reach it to replay the history' }

    const run = spawnSync(`${command} migrate check --schema ${JSON.stringify(schema.path)}`, {
      cwd: root, shell: true, encoding: 'utf8', timeout: 120_000,
    })
    if (run.status === 0) return { findings: [] }

    // The gap is the indented block between the verdict line and the advice;
    // the rest is the CLI's own decoration.
    const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    const from  = lines.findIndex(l => /does not build the schema/.test(l))
    const gap   = (from < 0 ? lines : lines.slice(from + 1))
      .map(l => l.trim()).filter(l => l && !/^(A deploy replays|and the container refuses|Write it)/.test(l)).join('; ')
    return { findings: [{
      file: 'db/migrations/',
      message: `the migration history does not build db/schema.lite: ${gap || `litestone migrate check exited ${run.status}`}. `
             + 'A deploy replays files and `fli db:push` writes none. Write the migration: `fli db:migrate`',
    }] }
  },

  // `$setAuth(user)` ANSWERS a scoped client; it does not mutate the one it was
  // called on. Called as a statement it scopes nothing, the next write goes
  // through the root client as anonymous, and every row policy compares against
  // a null principal — a read that matches nothing and a write that belongs to
  // nobody, neither of which raises.
  //
  // Only a whole statement is judged. `const scoped = db.$setAuth(u)` and
  // `db.$setAuth(u).order.create(…)` both keep the answer, and a call spanning
  // two lines is left alone rather than guessed at.
  'set-auth-discarded': ({ root }) => {
    const files = scripts(root, 'api', 'db', ...CLIENT_SURFACES)
    if (!files.length) return { skipped: 'no source' }

    const findings = []
    for (const path of files) {
      const lines = readCode(path).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const at   = line.indexOf('.$setAuth(')
        if (at < 0) continue

        let depth = 0, end = -1
        for (let j = at; j < line.length; j++) {
          if (line[j] === '(') depth++
          else if (line[j] === ')' && --depth === 0) { end = j; break }
        }
        if (end < 0) continue                                        // spans lines — not judged
        if (line.slice(end + 1).replace(/[;\s]/g, '')) continue       // the answer is used

        const before = line.slice(0, at).trim().replace(/^await\s+/, '')
        if (!/^[A-Za-z_$][\w$.\[\]'"]*$/.test(before)) continue       // an argument, not a statement

        findings.push({
          file: path, line: i + 1,
          message: `the scoped client is discarded. $setAuth ANSWERS a client and mutates nothing, so ` +
                   `the writes after this line go through the unscoped one as anonymous: every row ` +
                   `policy compares against a null principal, which matches no rows and raises nothing. ` +
                   `const scoped = ${before}.$setAuth(…)`,
        })
      }
    }
    return { findings }
  },

  // `FJS-519`: `asSystem()` means no PERMISSION rules. It does not mean no
  // scope — it keeps row tenancy — but it can only keep a tenant that is in
  // scope, and the claim comes from the principal. So which client you elevate
  // decides whether the result is scoped at all:
  //
  //   $.db.asSystem()            the caller's tenant, gate and policies crossed
  //   app.withDb(db => db.asSystem())   the same, in the tenant runAs named
  //   app.data.asSystem()        no principal, no claim, every tenant
  //
  // The app-level client cannot be named positively — it is `app.own(<any
  // name>, db)`, and basecamp calls it `app.data` — so the test runs the other
  // way: a receiver that is not the request's client. That is also where the
  // fix is.
  //
  // A WARNING and not an error, because the unscoped client is exactly right
  // for a cross-tenant admin tier. What is wrong is reaching for it by habit
  // inside a request, where the symptom is silent: rows from every tenant with
  // a 200.
  'service-as-system': ({ root }) => {
    // Under `strategy database` one client IS one file, so a system context
    // physically cannot reach a second tenant — the hazard does not exist and
    // every finding would be noise. `example` is that case.
    //
    // With no tenancy block there is no claim for any client to keep, so the
    // request's own client is no safer than the app's: every elevation in a
    // service crosses every user, and is reported whichever client it names.
    // Generated apps declare none (their scoping is membership policies), and
    // skipping them left every elevation in them unseen.
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    // Comments blanked first. basecamp's own schema explains the feature in a
    // doc comment — *declared once in the `tenancy { }` block below* — and a
    // raw match reads that empty pair as the declaration and skips the app.
    const block = readCode(schema.path).match(/\btenancy\s*\{[^}]*\}/s)
    const untenanted = !block
    if (block && !/\bstrategy\s+row\b/.test(block[0])) return { skipped: 'strategy database — one client is one tenant' }

    // Everything under `services/`, not just `*.service.*`. A helper module
    // beside a service runs in the same call scope and carries the identical
    // hazard — basecamp's `api-keys/scopes.ts` reaches for the app client from
    // inside a hook — so a filename filter made two real sites invisible. The
    // directory is the principled boundary: a job handler lives in `jobs/`,
    // is NOT inside a call, and is where the app client is the right reach.
    const files = scripts(root, 'api').filter(p => /[/\\]services[/\\]/.test(p))
    if (!files.length) return { skipped: 'no api/**/services/** source' }

    const REQUEST = /^\$\.db$/
    const BOUND   = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\.db\b/g
    const WITH_DB = /\.withDb\s*\(\s*(?:async\s+)?(?:(?:function\s*[\w$]*\s*)?\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>)/g

    // The receiver of a `.asSystem()`, read backwards so a cast survives:
    // `(app.data as any).asSystem()` is the spelling three of basecamp's use.
    const receiverAt = (code, dot) => {
      let i = dot - 1
      while (i >= 0 && /\s/.test(code[i])) i--
      if (code[i] === ')') {
        let depth = 1
        i--
        while (i >= 0 && depth) {
          if (code[i] === ')') depth++
          else if (code[i] === '(') depth--
          i--
        }
        return code.slice(i + 2, dot).replace(/\)\s*$/, '').replace(/\s+as\s+[\w<>\[\]|]+\s*$/, '').trim()
      }
      let j = i
      while (j >= 0 && /[\w$.]/.test(code[j])) j--
      return code.slice(j + 1, dot).trim()
    }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      if (!code.includes('.asSystem')) continue

      // Names this file binds to the request's client — `const db = $.db`.
      const local = new Set()
      for (const m of code.matchAll(BOUND)) local.add(m[1])
      // `app.withDb(fn)` enters a call and hands `fn` that call's client, so its
      // first parameter stays in the tenant `runAs` named — the identifier is
      // not `$.db`, the client it names is.
      for (const m of code.matchAll(WITH_DB)) local.add(m[1] ?? m[2])

      const seen = new Set()
      for (const m of code.matchAll(/\.asSystem\s*\(/g)) {
        const recv = receiverAt(code, m.index)
        if (!recv) continue
        if (!untenanted && (REQUEST.test(recv) || local.has(recv))) continue

        const line = lineOf(code, m.index)
        if (seen.has(line)) continue
        seen.add(line)
        if (untenanted) {
          findings.push({
            file: path, line,
            message: `${recv}.asSystem() lifts the caller's gate and every row policy, and this app ` +
                     `declares no row tenancy, so nothing keeps the result inside the caller's rows: it ` +
                     `reads and writes EVERY user's, with a 200. If the step is bounded and meant — a ` +
                     `write on the caller's own behalf that their grade cannot make — this is correct and ` +
                     `this warning is the place to say so. Otherwise read through the caller's own client ` +
                     `with the policies on, and elevate the one step that needs it.`,
          })
          continue
        }
        findings.push({
          file: path, line,
          message: `${recv}.asSystem() elevates a client that carries no principal, so it carries no ` +
                   `tenant claim either — under row tenancy it reads and writes EVERY tenant, with a 200. ` +
                   `The request's own client is the one to elevate: $.db.asSystem(), ` +
                   `which crosses the gate and every policy and stays in the caller's tenant. If crossing ` +
                   `tenants is what you mean — a hub or admin tier — this is correct and this warning is ` +
                   `the place to say so.`,
        })
      }
    }
    return { findings }
  },

  // A level nothing in this app can reach. The shipped resolver grades standing
  // from `isAdmin` / `isOwner` / `isSystemAdmin` and **never interprets a role
  // string** — 'admin' means whatever an app decides it means, and guessing
  // would hand out level 5 on a string match — so a schema declaring
  // ADMINISTRATOR(5) or above, with none of those columns and no getLevel of its
  // own, has declared an operation nobody but asSystem() can perform.
  //
  // It is not a fail-open, which is why it is a warning: the app is more closed
  // than it meant to be, and the symptom is a 403 that reads as *this caller is
  // not an admin yet* rather than as *no caller ever will be*.
  //
  // 8 and 9 are excluded by name. `8` means nothing outside asSystem() has
  // anything to say to this model and `9` is locked; both are deliberate, and
  // the identity models ship that way.
  // A model that declares the grid AND grades writes by ladder. The two are
  // ANDed with the gate as the floor (`FJS-D146`), which is what keeps standing
  // that crosses tenants available — but a write level ABOVE the read level is
  // the ladder answering the question the grid was declared to answer, and both
  // have to pass, so the ladder silently narrows every grant.
  //
  // The shape it catches is a model moved onto capabilities with its old gate
  // left in place: a billing clerk holding `Invoice.create` is refused because
  // the clerk grades USER(4) and creates want ADMINISTRATOR(5) — a 403 that
  // reads as *not senior enough* about a person who was deliberately granted the
  // capability. `@@gate(2)` flat at the read floor is the usual answer.
  //
  // A warning rather than an error: two authorities in front of one operation is
  // legitimate where the ladder is guarding something the grid does not model,
  // and this cannot tell that from a leftover.
  //
  // 8 and 9 are excluded, as `gate-unreachable` excludes them: nobody CLIMBS to
  // SYSTEM or LOCKED. An operation there is the application's alone, which the
  // grid cannot say — a grid only grants, and an owner holding every
  // capability could grant one — so the ladder is the only word for it, not a
  // leftover narrowing a grant.
  'capability-ladder': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const models = capabilityModels(schema)
    if (!models.length) return { skipped: 'no model declares @@capabilities' }

    const findings = []
    for (const m of models) {
      if (!m.gate) continue
      const above = ['create', 'update', 'delete'].filter(op => m.gate[op] > m.gate.read && m.gate[op] < 8)
      if (!above.length) continue
      findings.push({
        file: schema.path, line: m.gateLine,
        message: `${m.name} declares @@capabilities and @@gate(${m.gateSource}) — ` +
                 `${above.join(', ')} need${above.length > 1 ? '' : 's'} level ` +
                 `${above.map(o => m.gate[o]).join('/')} where read needs ${m.gate.read}. The grid and ` +
                 `the ladder are ANDed, so a caller granted a capability on this model is still refused ` +
                 `unless they also climb — which is the ladder answering what the grid was declared to ` +
                 `answer. A model graded by capability usually wants its gate flat at the read floor.`,
      })
    }
    return { findings }
  },

  'gate-unreachable': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const gates = declaredGates(schema).filter(g => g.level >= 5 && g.level <= 7)
    if (!gates.length) return { skipped: 'no @@gate above USER(4)' }

    // A resolver of the app's own answers everything below.
    const api = scripts(root, 'api')
    if (api.some(p => /\bgetLevel\b/.test(readCode(p)))) return { findings: [] }
    if (!api.length) return { skipped: 'no api/ source — the resolver is elsewhere' }

    // The three columns the shipped resolver reads. Declared anywhere in the
    // seed is enough: this rule cannot see which model the session is built
    // from, and reporting an app that has them would be the wolf-crying case.
    if (/^\s*(isAdmin|isOwner|isSystemAdmin)\s+Boolean/m.test(schema.text)) return { findings: [] }

    const worst = gates.reduce((a, b) => (a.level >= b.level ? a : b))
    return { findings: [{
      file: schema.path, line: worst.line,
      message: `${worst.what} requires level ${worst.level}, and nothing in this app can grade a caller ` +
               `above 4. The shipped resolver reads isAdmin / isOwner / isSystemAdmin — none of which this ` +
               `schema declares — and it never interprets a role STRING, because 'admin' means whatever an ` +
               `app decides it means. ${gates.length > 1 ? `${gates.length} declarations are above 4. ` : ''}` +
               `Either add the column, or install your own: ` +
               `GatePlugin({ getLevel: (u) => u?.role === 'admin' ? 5 : sessionGateLevel(u) }).`,
    }] }
  },

  // ─── log-db-unbound ────────────────────────────────────────────────────────
  // A `driver jsonl` / `driver trail` database is a DIRECTORY beside the app,
  // and the deploy mounts one volume at `/db` while the app root is `/app`. So
  // a declared `./db/audit/` is written inside the container and goes with it on
  // the next swap — silently, because the app works perfectly without its own
  // audit trail and nothing reads the directory afterwards.
  //
  // `core/db-preflight.js` skips these deliberately (no rows means nothing about
  // a directory of jsonl), which is correct there and is why nothing looks here.
  //
  // A warning rather than an error, and the two findings differ in how sure they
  // are: a path with no `env()` at all CANNOT be redirected without editing the
  // schema, which is certain from the tree; a path with one that no key file
  // declares is a variable the deploy's own env check will not require, which is
  // strong evidence and not proof — the server may bind it anyway.
  'log-db-unbound': ({ root }) => {
    if (!existsSync(join(root, 'db', 'schema.lite'))) return { skipped: 'no db/schema.lite' }

    const logDbs = declaredLogDatabases(join(root, 'db'))
    if (!logDbs.length) return { skipped: 'no jsonl or trail database declared' }

    // No deploy block is no volume, so there is nothing for a path to be outside
    // of. An app run from a directory keeps its trail wherever it declared it.
    const conf = ['frontier.config.js', 'frontier.config.mjs']
      .map(f => join(root, f)).find(f => existsSync(f))
    if (!conf || !/\bdeploy\s*:/.test(readFileSync(conf, 'utf8')))
      return { skipped: 'no deploy block — nothing mounts a volume' }

    // What the deploy's own env check reads. A key here is one the pipeline
    // will refuse to deploy without, which is what "bound" means from a laptop.
    const declared = new Set()
    for (const f of ['.env.example', '.env.keys']) {
      const p = join(root, f)
      if (!existsSync(p)) continue
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const key = line.trim().split('=')[0].trim()
        if (key && !key.startsWith('#')) declared.add(key)
      }
    }

    const findings = []
    for (const db of logDbs) {
      const where = `db/schema.lite`
      if (!db.envVar) {
        findings.push({ file: where, message:
          `database '${db.name}' is 'driver ${db.driver}' with a literal path (${db.path ?? 'unset'}), so it ` +
          `cannot be pointed at the mounted volume without editing the schema — the deploy writes it inside ` +
          `the container and the next swap takes it. Write it as ` +
          `\`path env("${db.name.toUpperCase()}_PATH", "${db.path ?? './db/' + db.name + '/'}")\` and bind that ` +
          `variable to a path under the volume.` })
      } else if (!declared.has(db.envVar)) {
        findings.push({ file: where, message:
          `database '${db.name}' falls back to ${db.path} unless ${db.envVar} is set, and nothing in this app ` +
          `declares ${db.envVar} — no .env.example, no .env.keys — so a deploy has no way to know it is ` +
          `needed and the trail is written inside the container, which the next swap takes. Declare ` +
          `${db.envVar} and point it under the volume the deploy mounts.` })
      }
    }
    return { findings }
  },

  // ─── db-path-committed ─────────────────────────────────────────────────────
  // A database file holds rows, and a trail or jsonl directory holds every write
  // with who made it. `git add .` takes whichever the app's `.gitignore` does not
  // name, and nothing complains: the app runs the same either way.
  'db-path-committed': ({ root }) => {
    const dbs = declaredDatabasePaths(join(root, 'db'))
    if (!dbs.length) return { skipped: 'no database declared in db/schema.lite' }

    const findings = []
    let graded = 0
    for (const db of dbs) {
      // Absolute, outside the app, or not a file at all: not this tree's to commit.
      if (!db.path || db.path === ':memory:' || db.path.startsWith('/') || db.path.startsWith('..')) continue
      const isDir = db.driver !== 'sqlite' || db.path.endsWith('/')
      const verdict = ignoredByGit(root, resolve(root, db.path), isDir)
      if (verdict === null) continue
      graded++
      if (verdict) continue

      findings.push({
        file: 'db/schema.lite',
        message: `database '${db.name}' writes ${db.path}, which no .gitignore covers, so the first ` +
                 `\`git add .\` commits ${isDir ? 'every row it holds' : 'the data'}` +
                 `${db.driver === 'sqlite' ? '' : ' — the audit trail, with who made each write —'}. ` +
                 `Add \`${db.path.replace(/^\.\//, '')}\` to .gitignore.`,
      })
    }
    return graded || findings.length ? { findings } : { skipped: 'no .gitignore applies to a declared database path' }
  },

  // Invariant 17. Repo scope: an app root is the developer's own, but a package
  // published from this tree keeps three files at its root and puts the rest in
  // docs/.
  //
  // **A warning, not an error.** The three are the standard and a fourth file is
  // worth a conversation, not a refused build — the rule cannot know whether the
  // new file is a stray design note or the next thing everyone needs at the root.
  // So it names what it found and leaves the decision to a person; an allowance
  // under "structure" in scripts/ci-allowances.json is where that decision gets
  // written down once it is made.
  //
  // The rule reports the CEILING and the FLOOR, and only the ceiling needs that
  // judgement. A file that is missing needs none: the three are named in the
  // invariant, so an absent one is decidable from the listing. Reporting only
  // what was NOT in `allowed` could catch a fifth file and could never catch a
  // missing fourth, which left seven packages short a standard file with the
  // check green over all of them.
  // A model a package SHIPS, declared here as well.
  //
  // Two ways a package's `.lite` reaches an app and they are not the same: some
  // files are IMPORTED, and some are appended into the app's own schema to be
  // extended — `@frontierjs/auth` ships one of each, because `User` is the model
  // an app grows columns on and `Credential` is not. So the presence of a copy
  // decides nothing, and a rule keyed on it would fire on every correct install.
  //
  // What is decidable is a column THE PACKAGE DECLARES that this copy declares
  // differently. Adding a column is what an app is for; adding `@@tenant(none)`
  // or a policy is the app's business too. Changing the package's own column is
  // the class that costs something, and it is silent by construction: the
  // package's code goes on writing to a column whose declaration it no longer
  // recognizes, and nothing anywhere compares a copy to its original.
  //
  // Measured: basecamp's copy of `Credential` had `@guarded` where auth
  // writes `@secret` on the two OAuth token columns, so turning OAuth on there
  // would have stored every provider access and refresh token unencrypted. Its
  // 137 tests were green either side of the divergence (`FJS-483`).
  //
  // A WARNING, because a deviation can be right: maidtech's `role` is written
  // by an owner where auth's is written by an admin. So both declarations are
  // printed and the reader judges — the same
  // reasoning `model-name-plural` is a warning for. `check-baseline.json` is how
  // an app accepts the ones it has argued for.
  //
  // No parser and no installed litestone: a line scan over a file in
  // node_modules, like every other rule here.
  // ─── transition-methods ─────────────────────────────────────────────────
  //
  // A named move is written in two places that never meet: `@@transitions` in
  // the seed, and the code that makes the move. Both directions fail quietly.
  //
  // **A move nothing can reach** is the silent one. It is not an error — the
  // machine is still enforced — it is a declaration nobody drives, which reads
  // exactly like a feature somebody has not got round to. Its first run found
  // three: basecamp's `Deployment` declares `push -> pushing`,
  // `release -> deploying` and `rollback -> rolled_back @gate(5)`, and the
  // pipeline goes pending → building → success. All three states appear in the
  // UI's tone maps, so three screens render a color for a state that cannot
  // occur, and one of them carries an authority level for a move nothing makes.
  //
  // **A move that is not declared** throws `TransitionNotFoundError` (400) the
  // first time a caller asks for it — a named error, found by a user rather
  // than by a build.
  //
  // ── Reachable means EITHER spelling, and that is the whole of the accuracy ──
  //
  // `db.order.transition(id, 'cancel')` names the move; `update({ data: {
  // status: 'cancelled' } })` makes the same move by naming its target, and
  // litestone enforces the machine on both. A rule asking only for the move
  // name reports eleven of basecamp's nineteen and is wrong about all but three
  // — measured, which is why it asks for either.
  //
  // The whole of `api/` is searched rather than the model's own service: a job
  // driving a pipeline is the ordinary case, and `deploy-run.job.ts` is where
  // `Deployment`'s machine actually moves. Comments are blanked first, so a
  // move named only in a comment about it does not count as driving it.
  //
  // ── A service over the model is a third spelling ──
  //
  // Junction serves every declared move as a method named for it on any
  // service over the model (`FJS-1255`), so a one-line generated service
  // reaches all of them and a `methods:` list reaches the moves it names. A
  // model with NO service under api/ is graded on nothing: the schema is
  // written first and the generator writes the service after it, so a rule
  // that reported the gap between the two refused every machine until code
  // existed, and the only schema-side reply was deleting the machine
  // (`FJS-1778`, 12 of 21 corpus schemas).
  'transition-methods': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const moves = declaredTransitions(schema)
    if (!moves.length) return { skipped: 'no @@transitions in db/schema.lite' }

    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source — the machine is driven elsewhere' }

    const code     = files.map(p => readCode(p))
    const all      = code.join('\n')
    const literal  = (word) => new RegExp(`['"\`]${word}['"\`]`).test(all)
    // A move a @@commitment owes is made by junction's commitments(), which no
    // file under api/ names — a reminder's `remind` has no other caller.
    const owed     = new Set(declaredCommitments(schema).map(c => `${c.target}.${c.move}`))
    const findings = []
    const served   = servingServices(root, files, code, schema)

    for (const m of moves) {
      if (owed.has(`${m.model}.${m.move}`)) continue
      if (literal(m.move) || literal(m.to)) continue
      const over = served.get(m.model)
      if (!over) continue
      if (over.some(svc => svc.servesAll)) continue
      const gate = m.gate ? ` @gate(${m.gate})` : ''
      findings.push({
        file: schema.path, line: m.line,
        message: `${m.model}.${m.move} -> ${m.to}${gate} is declared, nothing under api/ names either ` +
                 `the move or the state it moves to, and the methods: list of ` +
                 `${over.map(svc => basename(svc.path)).join(', ')} leaves it out — so no caller can reach ` +
                 `it. Name it in methods: to serve it by its own name. A declared move nobody ` +
                 `drives is not an error — the machine is still enforced — it reads as a feature nobody ` +
                 `got round to, and a screen rendering '${m.to}' is rendering a state that cannot occur.`,
      })
    }

    // The other direction: a literal handed to transition() that the seed does
    // not declare. Matched on the CALL rather than on any string, because a
    // service naming its methods after its moves would otherwise report every
    // one of them.
    const declared = new Set(moves.map(m => m.move))
    for (let i = 0; i < files.length; i++) {
      for (const call of code[i].matchAll(/\.transition\s*\(\s*[^,()]+,\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
        if (declared.has(call[1])) continue
        findings.push({
          file: files[i], line: lineOf(code[i], call.index),
          message: `transition(…, '${call[1]}') names no move any model declares in db/schema.lite. ` +
                   `Litestone resolves the name against @@transitions and throws TransitionNotFoundError ` +
                   `(400) — so this is a call that has never worked, found by whoever asks for it first. ` +
                   `Declared moves: ${[...declared].join(', ') || 'none'}.`,
        })
      }
    }

    return { findings }
  },

  // ─── commitment-swept ───────────────────────────────────────────────────
  //
  // `@@commitment` hands a move to junction's `commitments()`, which makes it
  // once, at each row's due time (`FJS-D353`, `FJS-D358`). A job still making
  // the same move is a second owner of it and nothing says so: the from-state
  // lock turns whichever runs second into a quiet no-op, so both look like they
  // work while the job's cron, cutoff and zone decide when rows move rather
  // than the declaration every screen reads its date off.
  //
  // **The job this was written against used none of the obvious spellings.**
  // `abandon` was declared after the sweep existed, and the sweep made
  // `cancel` — another move of `Order` from `pending` into the same
  // `cancelled`. So a file makes the committed move if it names that move, any
  // move of the same model sharing a from-state and the to-state, or the
  // to-state itself (`transition-methods`' either-spelling argument). It must
  // also name the MODEL, by accessor or by a service resolving to it, or every
  // job mentioning `'cancelled'` would be one. A name that is compared, listed
  // for `.includes` or filtered on in `where:` is a read, not the move: the
  // grader of rows a commitment lands guards on the to-state (`readsState`).
  //
  // Job files only: a service making the move is somebody asking for it early,
  // and a commitment hook runs inside the fire. A warning, because a job may
  // make the move for a reason that is not the clock — a webhook, an operator's
  // re-run — and the baseline is where an app says so.
  'commitment-swept': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const owed = declaredCommitments(schema)
    if (!owed.length) return { skipped: 'no @@commitment in db/schema.lite' }

    const files = scripts(root, 'api').filter(p => /\.job\.[cm]?[jt]s$/.test(p))
    if (!files.length) return { skipped: 'no *.job.* under api/' }

    const moves    = declaredTransitions(schema)
    const findings = []

    for (const path of files) {
      const code     = readCode(path)
      const services = [...code.matchAll(/\bservice\s*\(\s*['"`]([A-Za-z0-9_-]+)['"`]/g)].map(m => modelName(m[1]))

      for (const c of owed) {
        const move = moves.find(m => m.model === c.target && m.move === c.move)
        if (!move) continue

        const accessor = c.target[0].toLowerCase() + c.target.slice(1)
        if (!new RegExp(`\\.${accessor}\\b`).test(code) && !services.includes(c.target)) continue

        const same  = moves.filter(m => m.model === c.target && m.to === move.to &&
                                        m.from.some(f => f === '*' || move.from.includes(f)))
        // The move's name before its target, so the line reported is the call
        // rather than the status filter that picked the rows. A literal that
        // only READS the state moves nothing.
        const quoted = (words) => [...code.matchAll(new RegExp(`['"\`](${words.join('|')})['"\`]`, 'g'))]
          .find(m => !readsState(code, m.index, m[0].length))
        const hit    = quoted(same.map(m => m.move)) ?? quoted([move.to])
        if (!hit) continue

        const declared = c.relation ? `${c.relation}.${c.move}` : c.move
        findings.push({
          file: path, line: lineOf(code, hit.index),
          message: `This job makes ${c.target}.${c.move} (it names '${hit[1]}'), and ${c.model} declares ` +
                   `@@commitment(${declared}) at db/schema.lite:${c.line} — so commitments() already makes ` +
                   `that move at each row's due time. Two owners of one move both look like they work: the ` +
                   `from-state lock turns whichever runs second into a no-op, and this job's own schedule ` +
                   `decides when rows move instead of the declaration the screens read the date off. Delete ` +
                   `the sweep; an effect the move owes belongs in commitments({ hooks }). A job that makes ` +
                   `the move for a reason that is not the clock is a warning to keep: fli check --adopt.`,
        })
      }
    }

    return { findings }
  },

  // ── schema-runs ────────────────────────────────────────────────────────────
  //
  // Every other rule reads the schema as text, so a schema litestone refuses to
  // open passes them all: `@hashed @guarded` on one column, a `@@gate` ladder
  // out of order, a `@@unique` over an optional column. `bun run check` then
  // goes green, `migrate create` may even write the migration, and the app
  // throws at boot (`FJS-1242`).
  //
  // Litestone owns the question. `litestone advise` loads the file the way the
  // app does and builds the client over memory, so it needs no database and
  // answers the same in CI, where `app.db` does not exist — `litestone validate`
  // reads STORED rows and answers a different question. This rule runs it and
  // reports a nonzero exit; it re-implements nothing.
  'schema-runs': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const command = binCommand('litestone', root)
    if (!command) return { skipped: '@frontierjs/litestone is not installed where the app can reach it' }

    const run = spawnSync(`${command} advise --schema ${JSON.stringify(schema.path)} --json`, {
      cwd: root, shell: true, encoding: 'utf8', timeout: 120_000,
    })
    if (run.status === 0) return { findings: [] }

    // The refusal is a block of prose on stderr, wrapped in the CLI's own
    // decoration; strip the escape codes and keep the words.
    const said = `${run.stderr ?? ''}${run.stdout ?? ''}`
      .replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim())
      .filter(l => l && !/^\(run with --debug/.test(l)).join(' ')
    return { findings: [{
      file: schema.path,
      message: `litestone refuses this schema: ${said || `exit ${run.status}`} — the app will not boot ` +
               `over it, and every other rule here read it as text. \`fli advise\` prints the same refusal.`,
    }] }
  },

  // ── schema-in-memory ───────────────────────────────────────────────────────
  //
  // Every schema tool takes a PATH. An app that assembles its schema in memory —
  // appending a package's shipped fragment to the file's text at boot — runs
  // models no tool can read, and the four committed artefacts then describe a
  // schema that is not the one running.
  //
  // It is not a documentation gap. `release:check` compares release SURFACES, so
  // a contract on a model absent from both is graded EXPAND and the deploy reads
  // as reversible; `access --from --strict` cannot see a `@@gate` move on one.
  // Measured on `example`: 39 models ran and 32 were in `access.snapshot.md`,
  // `release.snapshot.md`, `ddl.snapshot.sql` and `jsonschema.snapshot.md` — the
  // identity model and the credential store among the seven (`FJS-626`). The
  // `snapshots` CI phase passed throughout, because it re-runs the same command
  // from the same directory and gets the same incomplete answer.
  //
  // **It carries no list of fragment-exporting function names.** A list goes
  // stale the first time a package adds one, and the signal that matters is not
  // which function was called: it is that the app DEPENDS on a package shipping
  // models and its schema file reaches none of them. That is decidable from the
  // file and the dependency alone.
  //
  // A warning rather than an error, because an app may legitimately not use a
  // package's schema at all — which is why the finding requires the app's own
  // source to import the package before it fires.
  'schema-in-memory': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const findings = []
    for (const file of scripts(root, 'api', 'db')) {
      // A test states its own schema inline and that is how a test is written —
      // it says nothing about what the app runs, which is the only thing this
      // rule is about. Found by running the rule over basecamp, where the only
      // finding was `db/test/schema.test.ts`.
      if (/(^|[\\/])(tests?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/.test(relative(root, file))) continue
      // `readCode` blanks comments to spaces, so every offset still names the
      // real bytes — and this file's own prose describes the hazard it checks
      // for, which is exactly what a raw read would match on.
      const text = readCode(file)
      if (!text) continue

      for (const m of text.matchAll(/\b(createClient|createTenantRegistry)\s*\(/g)) {
        const body = spanFrom(text, m.index + m[0].length - 1)
        if (!/(^|[\s{,])schema\s*:/.test(body)) continue
        // A schema that is DATA — a Source row's landing schema, a tenant's
        // model — is not the app's schema assembled in memory. litestone's
        // `untrusted: true` holds it to the one file it is handed and refuses
        // any database, import or extend that could reach the app's, so no
        // committed artefact was ever meant to describe it (FJS-1644).
        if (/(^|[\s{,])untrusted\s*:\s*true\b/.test(body)) continue

        findings.push({
          file,
          line: text.slice(0, m.index).split('\n').length,
          message: `${m[1]} is handed a \`schema:\` string while db/schema.lite exists. Whatever that ` +
            `string adds to the file — a package's shipped fragment, an \`extend model\`, a second ` +
            `database block — the app RUNS it and no tool can READ it: \`litestone access\`, \`release\`, ` +
            `\`ddl\` and \`jsonschema\` each take a PATH, so all four committed artefacts describe a ` +
            `schema that is not the one serving, and the snapshots CI phase passes because it re-runs the ` +
            `same command from the same directory and gets the same incomplete answer. The cost is not ` +
            `documentation: \`release:check\` compares release surfaces, so a contract on a model absent ` +
            `from both grades as an EXPAND and the deploy reads as reversible. Hand it \`path:\` alone — ` +
            `litestone reads a path with \`parseFile\`, which resolves \`import\` — and put what the ` +
            `string added into the file (\`fli auth:install\` and \`fli outbox:install\` write the import ` +
            `lines; an \`extend model\` goes in a sibling .lite the schema imports).`,
        })
      }
    }

    return { findings }
  },

  'package-model-drift': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const shipped = shippedSchemas(root)
    if (!shipped.length) return { skipped: 'no dependency ships a .lite file' }

    const mine     = declaredColumns(schema.text)
    const findings = []

    for (const dep of shipped) {
      for (const [name, theirs] of declaredColumns(dep.text)) {
        const ours = mine.get(name)
        if (!ours) continue          // imported, or this app does not use it

        for (const [column, declared] of theirs.columns) {
          const here = ours.columns.get(column)
          if (here === declared) continue
          if (here !== undefined && narrowsScalar(declared, here)) continue

          findings.push({
            file: schema.path,
            line: ours.columnLines.get(column) ?? ours.line,
            message: here === undefined
              ? `model ${name} is a copy of ${dep.pkg}'s and is missing its column '${column}' ` +
                `(${declared}). That package's own code still writes to it. Add the column — or, ` +
                `where the package means its model to be imported rather than copied, import it ` +
                `and put what is yours in an \`extend model\`.`
              : `model ${name} is a copy of ${dep.pkg}'s and declares '${column}' differently — ` +
                `the package says \`${declared}\`, this says \`${here}\`. If the deviation is ` +
                `deliberate, say so here and baseline this rule; if it is drift, it is silent ` +
                `until that package's code meets the column.`,
          })
        }
      }
    }

    return { findings }
  },

  // Invariant 13. A `var(--x)` naming a token nothing defines is invalid at
  // computed-value time, so the WHOLE declaration is dropped — not the value,
  // the line. `gap: var(--space-4)` on a design system whose ladder is
  // `--space-2xl` is no gap at all, and there is no console message, no build
  // warning and no failing selector: the stylesheet is in the bundle and is
  // being ignored one declaration at a time. It cost this repo's own storefront
  // every border, gap and radius on the page while `verify:site` stayed green,
  // because a drive asserts what a page SAYS and none of this changes that.
  //
  // A `var()` carrying a FALLBACK is not a finding and that is the whole of
  // where the line sits: a fallback is an author saying the token may be absent,
  // and it is also what a component's own knob looks like from outside
  // (`var(--cp-accent, var(--color-primary))`). Only the bare form drops.
  //
  // The token table is read from the DEPENDENCIES rather than listed here —
  // whatever CSS this app installs is the answer, so an app on a design system
  // this file has never heard of is graded against its own.
  // ─── the polymorphic pair, and the one thing it can still be told ───────────
  //
  // `(subjectType, subjectId)` is the honest answer when the target set is OPEN
  // (`references/Tag.lite` argues all three), and it is ruled: no foreign key, no
  // cascade, no `include`, and the target is not an input to the access-control
  // compiler. None of that is in scope here.
  //
  // What IS in scope is that the discriminator usually has no constraint at all.
  // `subjectType String` accepts `'Ordr'` — a row that will never join, forever,
  // and nothing refuses it, so a migration, a seed and `asSystem()` write it too.
  // Two spellings already fix that and neither is a new feature: an `enum`, which
  // emits a CHECK *and* reaches the browser as a set a picker can render, or
  // `@@check("col IN (…)")` where the values are not identifiers.
  //
  // **Measured on seven real applications**: ERPNext declares the target set for
  // 17 of its 78 polymorphic fields and leaves 61 unconstrained — and the split
  // is not domain, it is whether the author bothered. `party_type` is declared
  // CLOSED twice (Customer/Supplier/Employee) and OPEN sixteen times in the same
  // codebase; `invoice_type`, `voucher_type`, `reference_type` and `document_type`
  // all do the same. So most open sets are knowable, which is why this asks.
  //
  // A warning, and the exemption is real: a set that grows with every model — an
  // audit trail keyed by service name — legitimately stays a String, because an
  // enum there refuses the first row a new service writes. Say so with a
  // `check-baseline.json` entry rather than by making the rule quieter.
  //
  // Shape detection is a line scan here rather than litestone's own
  // `src/import/polymorphic.js`, which finds the same pairs to ask a DIFFERENT
  // question — *which of the three answers did you mean* — and would make this
  // engine, which must run in a client app with only @frontierjs/cli installed,
  // import a framework package to answer a question about text.
  'polymorphic-subject': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }

    const lines    = schema.text.split('\n')
    const findings = []

    for (const model of models(schema)) {
      const body   = bodyOf(lines, model.line - 1)
      const fields = [...body.matchAll(/^\s{2,}([a-z][A-Za-z0-9_]*)\s+(\w+)(\[\])?(\??)(.*)$/gm)]
        .map(m => ({ name: m[1], type: m[2], array: !!m[3], rest: m[5] ?? '' }))
      const byName = new Map(fields.map(f => [f.name, f]))

      // Columns a real relation already owns — those are foreign keys, not a pair.
      const owned = new Set()
      for (const r of body.matchAll(/@relation\([^)]*fields:\s*\[([^\]]*)\]/g))
        for (const c of r[1].split(',')) owned.add(c.trim())

      for (const f of fields) {
        // Both spellings, because the population this rule is FOR is the one
        // that spells it the other way: a pair with no foreign key arrives in a
        // schema read out of somebody's existing database (`litestone
        // introspect --no-camel`, a Rails `subject_type`/`subject_id`), and a
        // match on camelCase alone reported every one of those as having no
        // pair at all.
        const camel = f.name.match(/^(.*?)(?:Type|Kind|Class)$/)?.[1]
        const snake = f.name.match(/^(.*?)_(?:type|kind|class)$/)?.[1]
        const base  = camel ?? snake
        // A String and only a String — an enum-typed one is already answered,
        // which is the whole of what this rule asks for.
        if (!base || f.type !== 'String' || f.array) continue

        const id = camel
          ? (byName.get(`${base}Id`) ?? byName.get(`${base}ID`))
          : (byName.get(`${base}_id`) ?? byName.get(`${base}_ID`))
        if (!id || owned.has(id.name) || !SCALARS.has(id.type)) continue

        // A pair's id points at a subject many rows share; one that is unique
        // by itself is a delivery's or an event's own key, and its `*Type`
        // names a kind of event rather than a model (a receiver's dedupe key).
        if (/@unique\b/.test(id.rest)) continue

        // Already told what it may hold. `@values` counts: it is a declared set
        // enforced at the Data boundary, which is the question being asked —
        // that it is not also a table CHECK is `@values`' own trade.
        if (/@values\s*\(/.test(f.rest)) continue
        if (new RegExp(`@@check\\([^)]*\\b${f.name}\\b`).test(body)) continue

        findings.push({
          file: schema.path,
          line: model.line + body.split('\n').findIndex(l => new RegExp(`^\\s+${f.name}\\s`).test(l)),
          message: `${model.name}.${f.name} names what ${id.name} points at, and it is a bare String — so ` +
                   `nothing refuses a value that names nothing, and not a migration, a seed or asSystem() ` +
                   `either. There is no foreign key on a pair like this by design, which is exactly why the ` +
                   `one column that CAN be constrained should be: make ${f.name} an enum and it emits a ` +
                   `CHECK and reaches the browser as a set a picker renders, or @@check("${f.name} IN (…)") ` +
                   `where the values are not identifiers. Leave it where the set genuinely grows with every ` +
                   `model — an audit trail keyed by service name — and baseline this rule to say so.`,
        })
      }
    }
    return { findings }
  },
}

// Migration files, one directory deep — a schema declaring `database` blocks
// keeps them under db/migrations/<name>/.
function walkSql(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walkSql(join(dir, e.name)))
    else if (e.name.endsWith('.sql') || e.name.endsWith('.js')) out.push(e.name)
  }
  return out
}

// The built-in column types. A field typed by anything else is an enum, a
// relation or a `type` — which is how `polymorphic-subject` tells a key column
// from a relation field standing beside it.
const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Bytes', 'Json', 'File'])

// model name → { line, columns: Map<name, everything after it>, columnLines }
//
// A line scan for the same reason `models()` is one. What a column's
// DECLARATION is, for comparison, is everything after the field name with runs
// of whitespace collapsed — so realigning a column of attributes is not a
// finding and adding one is. A `//` comment is cut, because a comment is not
// part of what the column means.
// A package's bare `String` tightened by the app into a declared set — an enum
// or a `@values` — is not drift, and reporting it would be two rules pulling
// against each other: `polymorphic-subject` asks an app to constrain exactly
// this kind of column, and a package cannot ship the constraint because it
// cannot know the app's set. Both store TEXT, so the column the package writes
// is the column it declared; what the app took on is that a value outside its
// own set is refused, which is what it asked for.
//
// NULLABILITY is not narrowing and is still reported: `String?` → `String`
// makes a write the package makes legal fail, which is the drift this rule is
// for. A different scalar is not narrowing either.
const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Decimal', 'BigInt', 'Bytes'])

function narrowsScalar(theirs, ours) {
  const split = (d) => {
    const [type, ...rest] = d.split(' ')
    return { base: type.replace(/[?[\]]/g, ''), optional: type.includes('?'), list: type.includes('[]'), rest: rest.join(' ') }
  }
  const t = split(theirs)
  const o = split(ours)

  if (!SCALAR_TYPES.has(t.base)) return false     // only a bare scalar can be narrowed
  if (SCALAR_TYPES.has(o.base)) return false      // scalar → scalar is a change, not a narrowing
  if (t.optional !== o.optional || t.list !== o.list) return false
  return t.rest === o.rest
}

function declaredColumns(text) {
  const lines  = text.split('\n')
  const models = new Map()
  let current  = null
  let depth    = 0

  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    // The braces are counted on the STRIPPED line, which is the half that
    // matters here: this scan closes a model when depth reaches zero, so a `}`
    // inside a note — `// e.g. { "a": 1 }` — ends it early and every field
    // after it is invisible to the rule. Measured: four columns become two.
    const [raw, still] = withoutComments(lines[i], inBlock)
    inBlock = still

    const open = raw.match(/^\s*model\s+([A-Za-z_]\w*)/)
    if (open && depth === 0) {
      current = { name: open[1], line: i + 1, columns: new Map(), columnLines: new Map() }
      models.set(open[1], current)
    }

    depth += (raw.match(/{/g) ?? []).length
    depth -= (raw.match(/}/g) ?? []).length
    if (!current) continue
    if (depth <= 0) { current = null; continue }

    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('@@')) continue

    // A field line is `name Type …`. A relation field is one too and is compared
    // like any other — a package that declares one means it.
    const field = trimmed.match(/^([a-zA-Z_]\w*)\s+(\S.*)$/)
    if (!field) continue

    const declaration = field[2].replace(/\s*\/\/.*$/, '').replace(/\s+/g, ' ').trim()
    current.columns.set(field[1], declaration)
    current.columnLines.set(field[1], i + 1)
  }

  return models
}

// The level scale, as the @@gate grammar spells it. Litestone owns the numbers;
// this is the reading of a declaration, not a second definition of the scale.
const GATE_LEVELS = {
  STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3, USER: 4,
  ADMINISTRATOR: 5, OWNER: 6, SYSADMIN: 7, SYSTEM: 8, LOCKED: 9,
}

/**
 * Every level a schema requires — `@@gate(0.4.4.5)`, plus the `@gate(N)` a
 * `@@transitions` clause hangs on one move.
 *
 * A line scan like `models()`, for its reason: this must answer with no
 * database, no migration and no installed litestone.
 */
// Models declaring `@@capabilities`, with the gate each one carries. A text scan
// like declaredGates beside it — `fli check` runs on an app's tree with no client
// built, so the schema is read as text rather than parsed.
function capabilityModels({ text }) {
  const out   = []
  const lines = text.split('\n')
  let current = null
  let inBlock = false

  for (let i = 0; i < lines.length; i++) {
    // `withoutComments` rather than skipping a line that STARTS with one: this
    // scan tests for `@@capabilities` anywhere in the line, so a note about the
    // grid would put a model in it.
    const [line, still] = withoutComments(lines[i], inBlock)
    inBlock = still
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { current = { name: m[1], gate: null, gateSource: null, gateLine: 0, grid: false }; out.push(current); continue }
    if (!current) continue

    if (/@@capabilities\b/.test(line)) current.grid = true

    // One spelling (`FJS-D239`). The named form used to be read here too, on
    // the stated grounds that `example` and `basecamp` wrote their gates that
    // way — which was not true of either, and had not been true of any app: the
    // named form reached five declarations in litestone's own example and
    // nothing else, against 320 written as digits.
    const compact = line.match(/@@gate\s*\(\s*([\d.]+)\s*\)/)
    if (compact) {
      // "R.C.U.D" with inheritance: a position not stated takes the one before it.
      const [r = 0, c = r, u = c, d = u] = compact[1].split('.').map(Number)
      current.gate       = { read: r, create: c, update: u, delete: d }
      current.gateSource = compact[1]
      current.gateLine   = i + 1
    }
  }
  return out.filter(m => m.grid)
}

function declaredGates({ text }) {
  const out   = []
  const lines = text.split('\n')
  let model   = null

  const level = (token) => {
    const t = token.trim().replace(/^['"`]|['"`]$/g, '')
    if (/^\d$/.test(t)) return Number(t)
    return GATE_LEVELS[t.toUpperCase()] ?? null
  }

  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    // The comment goes before the match rather than the line being skipped when
    // it STARTS with one: a trailing `// was @@gate(7) once` is a level this
    // schema does not declare, and `gate-unreachable` then reports a rung
    // nobody can reach that nobody wrote.
    const [line, still] = withoutComments(lines[i], inBlock)
    inBlock = still
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { model = m[1]; continue }

    const where = model ? `model ${model}'s` : 'a'

    for (const g of line.matchAll(/@@gate\s*\(([^)]*)\)/g)) {
      const compact = g[1].match(/^\s*([\d.]+)\s*$/)
      const levels  = compact ? compact[1].split('.').map(Number) : []
      for (const n of levels)
        if (n != null && !Number.isNaN(n)) out.push({ level: n, line: i + 1, what: `${where} @@gate` })
    }

    // Single `@` — a transition's own gate, which is the only place a level
    // above the model's own appears in most schemas.
    for (const g of line.matchAll(/(?<!@)@gate\s*\(\s*(['"`]?[A-Za-z0-9_]+['"`]?)\s*\)/g)) {
      const n = level(g[1])
      if (n != null) out.push({ level: n, line: i + 1, what: `${where} transition @gate` })
    }
  }
  return out
}

/**
 * Every named move a schema declares — `{ model, move, to, gate, line }`.
 *
 * A line scan like `models()` and `declaredGates()`, for their reason: this must
 * answer with no database, no migration and no installed litestone.
 *
 * Two things about the grammar cost more than they look. **The clause list is
 * split on TOP-LEVEL commas**, because a from-list is itself comma-separated —
 * `cancel: [pending, paid] -> cancelled` is one clause, and splitting naively
 * loses the name and reports the target instead. And **the name is optional**:
 * `pending -> paid` names itself after the target state, which is the spelling
 * `db.<model>.transition(id, 'paid')` then has to use.
 *
 * The enum's own `transitions { }` block is NOT read. It desugars onto every
 * model using that enum, so resolving it means resolving field types — and no
 * schema in this repo uses it. A model whose machine arrives that way is
 * invisible here, which is a rule that misses rather than one that misfires.
 */
// Every `@@commitment` and the model its move is made ON — the declaring model
// for `close`, the relation's type for `subscription.lapse`. A line scan like
// `declaredTransitions`, reading the relation's type off the field that names it.
function declaredCommitments({ text }) {
  const out    = []
  const fields = {}
  const lines  = text.split('\n')
  let model    = null, inBlock = false

  for (let i = 0; i < lines.length; i++) {
    const [line, still] = withoutComments(lines[i], inBlock)
    inBlock = still
    const m = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { model = m[1]; fields[model] = {}; continue }
    if (!model) continue

    const f = line.match(/^\s*([a-z][A-Za-z0-9_]*)\s+([A-Z][A-Za-z0-9_]*)[?\[\]]*(\s|$)/)
    if (f) fields[model][f[1]] = f[2]

    const c = line.match(/@@commitment\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/)
    if (c) out.push({ model, relation: c[2] ? c[1] : null, move: c[2] ?? c[1], line: i + 1 })
  }

  for (const c of out) c.target = c.relation ? fields[c.model]?.[c.relation] ?? null : c.model
  return out.filter(c => c.target)
}

function declaredTransitions({ text }) {
  const out   = []
  const lines = text.split('\n')
  let model   = null

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) { model = m[1]; continue }

    const at = lines[i].indexOf('@@transitions')
    if (at === -1 || lines[i].trim().startsWith('//')) continue

    // To the balanced close — the block spans as many lines as it likes.
    //
    // Comments are dropped AS THEY ARE READ, and that is not tidiness. The
    // clause split below is on top-level commas, so one comma inside a `//`
    // note splits a move in half: the name is lost and the fragments either
    // side arrive as moves nobody declared. Measured on basecamp, whose
    // `loseContact` sits under a six-line comment carrying three commas — the
    // move went missing from the declared set and this rule reported a working
    // call as one that "has never worked", while listing a STATE among the
    // moves it thought were declared.
    //
    // They go before the balance scan rather than after it because a `(` or a
    // `)` inside a comment breaks that scan the same way. What counts as a
    // comment is `withoutComments`, which `declaredGates` reads by too — the
    // same mistake was in both, one function apart.
    let depth = 0, body = '', open = false, j = i, inBlock = false
    scan: for (; j < lines.length; j++) {
      // Sliced first, then stripped: on the opening line `at` indexes the
      // ORIGINAL text, so removing a comment before taking the slice would
      // move the offset out from under it.
      const [src, still] = withoutComments(j === i ? lines[j].slice(at) : lines[j], inBlock)
      inBlock = still
      for (const c of src) {
        if (c === '(') { depth++; open = true }
        if (open) body += c
        if (c === ')' && --depth === 0) break scan
      }
      body += '\n'
    }

    const parts = []
    let cur = '', bracket = 0
    for (const c of body.slice(1, -1)) {
      if (c === '[') bracket++
      if (c === ']') bracket--
      if (c === ',' && bracket === 0) { parts.push(cur); cur = '' } else cur += c
    }
    parts.push(cur)

    // parts[0] is the FIELD the machine is on, not a clause.
    for (const clause of parts.slice(1)) {
      if (!clause.includes('->')) continue
      const to = clause.match(/->\s*([A-Za-z_][A-Za-z0-9_]*)/)
      if (!to) continue
      const named = clause.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)
      const gate  = clause.match(/@gate\s*\(\s*['"`]?([A-Za-z0-9_]+)['"`]?\s*\)/)
      const from  = clause.slice(named ? clause.indexOf(':') + 1 : 0, clause.indexOf('->'))
        .match(/[A-Za-z_*][A-Za-z0-9_]*|\*/g) ?? []
      out.push({ model, move: named ? named[1] : to[1], from, to: to[1], gate: gate ? gate[1] : null, line: i + 1 })
    }
    i = j
  }
  return out
}

// A quoted state at [index, index + length) that is compared, listed for
// `.includes`, or sitting in a `where:` filter picks rows in that state and
// moves none. `commitment-swept` reads a job working on the rows a
// commitment lands, which names the to-state to refuse or select it.
const readsState = (code, index, length) => {
  const before = code.slice(0, index)
  const after  = code.slice(index + length)
  if (/[!=]==?\s*$/.test(before) || /^\s*[!=]==?/.test(after)) return true
  if (/^[^\]\n]*\]\s*\.\s*includes\s*\(/.test(after)) return true
  const where = [...before.matchAll(/\bwhere\s*:\s*\{/g)].pop()
  if (!where) return false
  let depth = 1
  for (const ch of before.slice(where.index + where[0].length)) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return false
  }
  return true
}
