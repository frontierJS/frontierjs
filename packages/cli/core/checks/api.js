// ─── checks/api.js — the API realm's rules ────────────────────────────────────
//
// A service, a raw route, a plugin, a job and the image the API ships in — what
// junction will run without a word of complaint and still get wrong. One slice of
// the rule bodies `core/checks.js` runs; the table, the runner and the baseline
// stay there. Plain ESM on node, `@frontierjs/toolbelt` and this package only.

import { join, extname, basename, relative }         from 'path'
import { existsSync, readdirSync, readFileSync }     from 'fs'
import { camel, singularize, pluralize }             from '@frontierjs/toolbelt/inflect'
import { importedAs }                                from '../utils.js'
import { shippedSchemas, appSchemaModels }           from '../app-schema.js'
import { imageNeeds, installsChrome, carriesWebSrc } from '../deploy-image.js'
import {
  isAppRoot, scripts, readCode, lineOf, CLIENT_SURFACES, schemaFile,
  modelResolver, spanFrom, models,
} from './lib.js'

// True when a `methods: [...]` array states `gate:` on every entry. A count of
// `method:` keys against `gate:` keys, so one ungated entry fails it.
function everyMethodGated(code) {
  const open = code.match(/\bmethods\s*:\s*\[/)
  if (!open) return false
  let depth = 1, i = open.index + open[0].length
  for (; i < code.length && depth; i++) depth += code[i] === '[' ? 1 : code[i] === ']' ? -1 : 0
  const entries = code.slice(open.index + open[0].length, i)
  const methods = (entries.match(/\bmethod\s*:/g) || []).length
  return methods > 0 && (entries.match(/\bgate\s*:/g) || []).length === methods
}

export const CHECKS = {

  'surface-config': ({ root }) => {
    if (!isAppRoot(root)) return { skipped: 'not an app root' }

    const CONFIGS = {
      api:       ['junction.config.js', 'junction.config.ts'],
      web:       ['sierra.config.js', 'vite.config.js', 'sierra.config.ts', 'vite.config.ts'],
      widgets:   ['sierra.config.js', 'vite.config.js'],
      site:      ['sierra.config.js', 'vite.config.js'],
      extension: ['jetty.config.js', 'vite.config.js'],
      desktop:   ['desktop.config.js', 'sierra.config.js', 'vite.config.js'],
    }

    const findings = []
    let looked = 0

    for (const [surface, names] of Object.entries(CONFIGS)) {
      const dir = join(root, surface)
      if (!existsSync(dir)) continue
      // A surface with no source is a directory somebody made, not a surface.
      const hasSource = existsSync(join(dir, 'src')) ||
        readdirSync(dir).some(f => extname(f) === '.ts' || extname(f) === '.js')
      if (!hasSource) continue
      looked++

      const stray = names.filter(n => existsSync(join(dir, n)))

      if (existsSync(join(dir, 'config'))) {
        // The directory is there AND a config file sits beside it. Whichever
        // one the loader resolves, the other is read by nobody.
        if (stray.length) findings.push({
          file: join(dir, stray[0]),
          message: `${surface}/${stray[0]} sits beside ${surface}/config/. One of the two is read ` +
                   `and the other is not, and which depends on the loader — move it in.`,
        })
        continue
      }

      findings.push({
        file: stray.length ? join(dir, stray[0]) : dir,
        message: stray.length
          ? `${surface}/${stray[0]} sits at the surface root; configuration lives in ` +
            `${surface}/config/. Loaders resolve the DIRECTORY, so a config file here is read by ` +
            `nothing and the surface boots on defaults looking configured.`
          : `${surface}/ has no config/. Configuration lives there and the ` +
            `framework looks there unprompted — junction's default is ${surface}/config/ — so an ` +
            `absent directory is not "this surface declares nothing", it is a path the loader ` +
            `resolves to nowhere. Nothing fails when it is missing, which is why this is a rule: ` +
            `basecamp read api/config for its whole life without that directory existing, and its ` +
            `CORS was '*' for everyone as a result.`,
      })
    }

    if (!looked) return { skipped: 'no surface with source in it' }
    return { findings }
  },

  // ─── the source hazards ──────────────────────────────────────────────────────
  //
  // The rules below read a line of an app's own JavaScript rather than its place
  // in the tree. Same membership test, and each of them is silent for one
  // reason: the wrong spelling is a LEGAL spelling of something else, so nothing
  // downstream has anything to object to. Text, never an AST — `fli check` runs
  // on node with no build, and a parser here would be a second one to keep in
  // step with the compiler this repo already ships.

  // `:id` registers as a LITERAL segment. The route then matches the path
  // `/orders/:id` as typed and nothing else, so every real request 404s forever
  // and no line of code is wrong enough to raise anything. Express and Feathers
  // both spell it this way, which is where it arrives from.
  'raw-route-param': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const ROUTE = /\bapp(?:\.http\.router)?\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`\n]*)\2/g
    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(ROUTE)) {
        if (!/(^|\/):[A-Za-z_]/.test(m[3])) continue
        // The path literal alone — the quotes stay, so a template literal or a
        // double-quoted path is rewritten in the spelling it was written in.
        const start = m.index + m[0].length - 1 - m[3].length
        findings.push({
          file: path, line: lineOf(code, m.index),
          edit: { start, end: start + m[3].length, was: m[3],
                  replacement: m[3].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}') },
          message: `${m[1].toUpperCase()} ${m[3]} — a raw route's capture is written {id}: ` +
                   `'${m[3].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}'. A :name segment is matched ` +
                   `literally, so this route answers the path exactly as typed and 404s on every real ` +
                   `request. Nothing objects at registration or at match time.`,
        })
      }
    }
    return { findings }
  },

  // There is no `ctx.params` in Junction. A ServiceContext splits into `auth`
  // (the principal), `caller`, `route` (path captures) and `locals` (per-call
  // scratch) — so `ctx.params.user` is undefined and a role check written
  // against it admits everyone. The name is Feathers's and survives in older
  // notes, which is exactly how it gets written a second time. `ctx.client` is
  // the same trap from this framework's own notes (`FJS-D392`): a rate limit
  // keyed on `ctx.client.ip` puts every caller in one bucket.
  'ctx-params': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bctx\.(params|client)\b/g)) findings.push({
        file: path, line: lineOf(code, m.index),
        message: `ctx.${m[1]} does not exist. A ServiceContext is auth (the principal — frozen, and it ` +
                 `propagates), caller (ip, userAgent, headers), route (path captures alone) and locals ` +
                 `(per-call scratch, where the scoped db is). This reads undefined, so a check written ` +
                 `on it passes for every caller.`,
      })
    }
    return { findings }
  },

  // A header the caller varies per call must be declared, or it works until the
  // socket connects. Over HTTP it is an ordinary header; a WebSocket frame has
  // no headers of its own, so the value rides meta.headers and the server merges
  // only the names the app DECLARED — undeclared, it is simply absent, and
  // whatever reads it sees nothing: an empty list with a 200, or a 404 on every
  // call. The same declaration is what gets it past a cross-origin preflight.
  //
  // Cross-surface, which is why nothing else can see it: both halves are correct
  // in the file they are written in.
  'call-header-declared': ({ root }) => {
    if (!existsSync(join(root, 'api'))) return { skipped: 'no api/ surface — the server is elsewhere' }
    const client = scripts(root, ...CLIENT_SURFACES)
    if (!client.length) return { skipped: 'no client surface' }
    const api = scripts(root, 'api')

    // Neither half is written as a literal in a real app — both sides name a
    // shared constant — so a rule reading literals alone reads nothing. A name
    // holding two different values in one app resolves to nothing: a wrong
    // answer here is worse than no answer.
    const consts = new Map()
    for (const path of [...api, ...client]) {
      for (const m of readCode(path).matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g)) {
        if (consts.has(m[1]) && consts.get(m[1]) !== m[3]) consts.set(m[1], null)
        else if (!consts.has(m[1]))                        consts.set(m[1], m[3])
      }
    }
    // biome-ignore lint/suspicious/noShadowRestrictedNames: a local helper; the global of this name is not used here
    const valueOf = (token) => {
      const t   = token.trim()
      const lit = t.match(/^(['"`])([^'"`]*)\1$/)
      return lit ? lit[2] : (consts.get(t) ?? null)
    }

    const declared = new Set()
    let opaque = null
    for (const path of api) {
      for (const m of readCode(path).matchAll(/callHeaders\s*:\s*\[([^\]]*)\]/g)) {
        for (const token of m[1].split(',').map(t => t.trim()).filter(Boolean)) {
          const value = valueOf(token)
          if (value === null) opaque ??= token
          else declared.add(value.toLowerCase())
        }
      }
    }
    // A declaration this rule cannot read is not an absent declaration.
    if (opaque) return { skipped: `http.callHeaders names ${opaque}, which this rule cannot resolve to a string` }

    const findings = []
    for (const path of client) {
      const code = readCode(path)
      for (const m of code.matchAll(/\.setCallHeader\s*\(\s*([^,)]+)/g)) {
        const name = valueOf(m[1])
        if (name === null || declared.has(name.toLowerCase())) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `'${name}' is set per call and is not in the API's callHeaders. Over HTTP it is ` +
                   `an ordinary header and this works; a WebSocket frame carries none of its own, so the ` +
                   `server merges only declared names and the header is absent the moment the socket ` +
                   `connects — an empty list with a 200, or a 404, depending on what reads it. Declare ` +
                   `it in junction.config.js as middleware: { callHeaders: ['${name}'] } ` +
                   `(createApp's config spells the same key http: { callHeaders }).`,
        })
      }
    }
    return { findings }
  },

  // Invariant 2, at the seam it was written for. A service resolves its model by
  // NAME — the literal spelling, then the singular of it — and a miss serves
  // nothing: getTable throws, so each CRUD call answers 500 naming the model
  // (FJS-1252). What goes ungraded is a custom method, which finds no @@gate to
  // take as its floor, and autoValidate, which finds no schema.
  //
  // The name judged is the one junction's registry gives the file —
  // `product-variants.service.ts` registers `productVariants` — and the
  // derivation is `singularize` from @frontierjs/toolbelt/inflect, the module
  // litestone derives a table name with, so an irregular resolves too. Judging
  // the raw file name reported every multi-word service as open when it was
  // gated (FJS-1218).
  //
  // A service with no `model:` and no CRUD base is judged on nothing: a service
  // over no model is a whole kind of service — a hub, a webhook receiver — and
  // not a fault.
  'service-model': ({ root }) => {
    const schema = schemaFile(root)
    if (!schema) return { skipped: 'no db/schema.lite' }
    const files = scripts(root, 'api').filter(p => /\.service\.[cm]?[jt]s$/.test(basename(p)))
    if (!files.length) return { skipped: 'no *.service.* under api/' }

    const { resolves } = modelResolver(schema, root)

    const findings = []
    for (const path of files) {
      const code    = readCode(path)
      const service = camel(basename(path).replace(/\.service\.[cm]?[jt]s$/, ''))
      const stated  = code.match(/\bmodel\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/)

      if (stated) {
        if (resolves(stated[1])) continue
        findings.push({
          file: path, line: lineOf(code, stated.index),
          message: `model: '${stated[1]}' names no model in db/schema.lite, so every CRUD call on ` +
                   `this service answers 500 naming the model. A custom method on it has no @@gate ` +
                   `as its floor and autoValidate has no schema to check.`,
        })
        continue
      }

      // Only a definition that writes no function at all leaves its whole
      // surface to the base, and the base reads the model. One with a method of
      // its own — a hub, a webhook receiver, a report — asks for a derived layer
      // over nothing, so a missing model switches nothing off. A hook is a
      // function too, which leaves that service unjudged rather than wrongly
      // reported.
      const call = code.match(/\bcreateService\s*\(/)
      if (!call) continue
      if (/=>|\bfunction\b|\basync\b|\b\w+\s*\([^)]*\)\s*\{/.test(code.slice(call.index + call[0].length))) continue
      // `model: null` is junction's word for "there is none" (FJS-D628): the
      // derived layer is the method gates alone, so there is no @@gate to miss.
      if (/\bmodel\s*:\s*null\b/.test(code)) continue
      // Over no model a declared `gate:` on every method is the whole grade
      // (FJS-D408), so there is no @@gate to miss.
      if (everyMethodGated(code)) continue
      if (resolves(service)) continue

      // No edit: a model the schema holds under this name would have resolved,
      // so there is nothing to name.
      findings.push({
        file: path, line: lineOf(code, call.index),
        message: `createService with no model:, and '${service}' resolves to none — it singularizes ` +
                 `to '${singularize(service)}', and no model has that accessor. Every CRUD call on it ` +
                 `answers 500 naming the model, and no @@gate or field schema is found to grade it. ` +
                 `State it — model: '<Model>', naming one in db/schema.lite, or model: null if there is none.`,
      })
    }
    return { findings }
  },

  // `auth()` registers six services, and `start()` refuses an app that
  // already has one of the same name. The name an app's own service for a model
  // takes is the model's plural, so `model Connection` (a third-party grant)
  // derives `connections`, which is auth's list of linked sign-in providers. The
  // refusal at boot is clear, but the collision is decidable from the schema and
  // the plugin call, before any service is written (`FJS-2237`).
  //
  // A WARNING: a model with no service of its own collides with nothing. The
  // models auth ships are exempt, since `sessions` is the service over `Session`.
  // The names are auth's `DEFAULT_SERVICE_NAMES`, held equal by a test, because
  // this package depends on no auth.
  'auth-service-collision': ({ root }) => {
    if (!schemaFile(root)) return { skipped: 'no db/schema.lite' }

    let call = null
    for (const path of scripts(root, 'api')) {
      const code = readCode(path)
      const local = importedAs(code, 'auth', '@frontierjs/auth')
      const m = local && code.match(new RegExp(`\\b${local}\\s*\\(`))
      if (m) { call = spanFrom(code, m.index + m[0].length - 1); break }
    }
    if (call === null) return { skipped: "no auth() from '@frontierjs/auth' under api/" }
    if (/\bservices\s*:\s*false\b/.test(call)) return { findings: [] }

    const ships = new Set()
    for (const dep of shippedSchemas(root)) {
      if (dep.pkg === '@frontierjs/auth') for (const m of models(dep)) ships.add(m.name)
    }

    const findings = []
    for (const model of appSchemaModels(root)) {
      if (model.external || model.origin !== 'app' || ships.has(model.name)) continue
      const derived = camel(pluralize(model.name))
      for (const [key, service] of Object.entries(AUTH_SERVICES)) {
        if (camel(service) !== derived) continue
        if (new RegExp(`\\b${key}\\s*:\\s*(false|['"\`])`).test(call)) continue
        findings.push({
          file: join(root, model.file), line: model.line,
          message: `model ${model.name} derives the service name '${derived}', which auth() ` +
                   `already registers, and start() refuses an app holding two. Name your own service ` +
                   `differently, or give auth's another name or none: auth({ auth, ` +
                   `services: { ${key}: false } }).`,
        })
      }
    }
    return { findings }
  },

  // `FJS-D1079`: `createService(def)` returns the definition and a service file
  // `export default`s it; the registry builds it and the loader reads nothing
  // else. A file that exports a `create*Service` factory, default-exports a
  // function, or still names `createBaseService` registers nothing, so its name
  // answers 404 and the only sign is the loader's report at start.
  //
  // Only files under a `services/` directory are judged: a helper beside a
  // service may legitimately build one (a plugin's `createXServices`).
  'service-definition': ({ root }) => {
    const files = scripts(root, 'api')
      .filter(p => /[/\\]services[/\\]/.test(p) && /\.service\.[cm]?[jt]s$/.test(basename(p)))
    if (!files.length) return { skipped: 'no *.service.* under api/**/services/' }

    const SHAPES = [
      [/\bcreateBaseService\b/,                                   'names createBaseService, which no longer exists'],
      [/\bexport\s+(?:async\s+)?function\s+create\w*Service\b/,   'exports a create*Service factory'],
      [/\bexport\s+(?:const|let)\s+create\w*Service\b/,           'exports a create*Service factory'],
      [/\bexport\s+default\s+(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/, 'default-exports a function'],
    ]

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      const hit  = SHAPES.map(([re, what]) => ({ m: code.match(re), what })).find(h => h.m)
      if (!hit) continue
      findings.push({
        file: path, line: lineOf(code, hit.m.index),
        message: `${basename(path)} ${hit.what}. The autoloader reads the DEFAULT export and it must be a ` +
                 `definition -- export default createService({ … }) -- so this file registers nothing and ` +
                 `'${basename(path).replace(/\.service\.[cm]?[jt]s$/, '')}' answers 404. What a factory ` +
                 `closed over is reached at call time as ctx.app or $.app; per-app state goes in a ` +
                 `WeakMap keyed by the app (FJS-D1079).`,
      })
    }
    return { findings }
  },

  // A page's entry is virtual:sierra: the boot, then src/main.js, then
  // src/App.mesa mounted into #app (FJS-D1085). The build refuses an index.html
  // naming main.js; a main.js that still mounts is a second copy of the app on
  // the page, and nothing refuses that.
  'app-entry': ({ root }) => {
    if (!isAppRoot(root)) return { skipped: 'not an app root' }

    const findings = []
    let looked = 0
    for (const surface of ['web', 'site', 'desktop']) {
      const dir = join(root, surface)
      if (!existsSync(join(dir, 'config', 'sierra.config.js'))) continue
      looked++

      const html = join(dir, 'index.html')
      const page = existsSync(html) ? readFileSync(html, 'utf8') : ''
      const named = page.search(/<script[^>]*\ssrc=["']\/?src\/main\.js["']/)
      if (named !== -1) findings.push({
        file: html, line: lineOf(page, named),
        message: `${surface}/index.html loads /src/main.js. The page's entry is virtual:sierra, which ` +
                 `imports src/main.js after its boot and mounts src/App.mesa -- ` +
                 `<script type="module" src="virtual:sierra"></script> (FJS-D1085). The build refuses this page.`,
      })

      const main = join(dir, 'src', 'main.js')
      if (!existsSync(main)) continue
      const code = readCode(main)
      const mounted = code.match(/\bimport\s+App\s+from\s*['"]\.\/App\.mesa['"]|\bimport\s*\{[^}]*\bRouterView\b[^}]*\}\s*from\s*['"]@frontierjs\/sierra\/router['"]/)
      if (mounted && /\bmount\s*\(/.test(code)) findings.push({
        file: main, line: lineOf(code, mounted.index),
        message: `${surface}/src/main.js mounts the app, and virtual:sierra mounts it after importing this ` +
                 `file, so the page holds two. main.js is side-effect imports; delete the mount (FJS-D1085).`,
      })
    }
    if (!looked) return { skipped: 'no surface with config/sierra.config.js' }
    return { findings }
  },

  'service-module-db': ({ root }) => {
    const files = scripts(root, 'api').filter(p => /\.(service|job)\.[cm]?[jt]s$/.test(basename(p)))
    if (!files.length) return { skipped: 'no *.service.* or *.job.* under api/' }

    // Only where `db` is an IMPORT. `const db = $.db` is the correct
    // shape and cannot coexist with an imported binding of that name — that is
    // a duplicate declaration — so the import is the whole test.
    const IMPORTS_DB = /import\s+(?:db\s+,?\s*(?:{[^}]*})?\s+from|{[^}]*?(?<![\w])db\s*(?:,[^}]*)?}\s*from)/
    const USES_DB    = /(?<![\w.$])db\.[a-z][A-Za-z0-9_]*\./g

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      if (!IMPORTS_DB.test(code)) continue
      if (/\bdb\s+as\s+\w/.test(code)) continue          // renamed on import — not this binding

      const seen = new Set()
      for (const m of code.matchAll(USES_DB)) {
        const line = lineOf(code, m.index)
        if (seen.has(line)) continue
        seen.add(line)
        const scoped = /\.job\./.test(basename(path))
          ? '`ctx.app.withDb((db) => …)`: a job has no request, and the module client reads as ' +
            'STRANGER(0), so every fire fails on the first gated model (FJS-3089)'
          : '`$.db`'
        findings.push({
          file: path, line,
          message: `${m[0]}… reads the module client, which carries no principal. The scoped one ` +
                   `is ${scoped}: through the module one auth() is null, so every row policy ` +
                   `matches nothing — an empty list with a 200 — and a write belongs to nobody in the ` +
                   `audit trail. asSystem() is the deliberate bypass and is not this.`,
        })
      }
    }
    return { findings }
  },

  // `FJS-D36`: caravan owns the clock. `app.scheduler` is a bare in-process
  // timer — no persistence, no retry, no principal, gone with the process — so
  // firing a queue dispatch from one buys the clock with none of the queue's
  // durability while looking like it has it, and it runs in EVERY replica, so
  // two processes do the work twice. `app.jobs.schedule(name, expr, fn)` is the
  // same line with caravan's clock under it: a cron fire is dispatched under
  // `cron:<job>:<minute>`, so the second replica's fire is a no-op.
  'scheduler-dispatch': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bapp\.scheduler\.([A-Za-z]+)\s*\(/g)) {
        const call = spanFrom(code, m.index + m[0].length - 1)
        const hit  = call.match(/\bdispatch\s*\(/)
        if (!hit) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `app.scheduler.${m[1]}() dispatches into the queue. That is the queue's schedule and ` +
                   `belongs to it — app.jobs.schedule(name, expr, fn) — because this timer has no ` +
                   `persistence, no retry and no principal, and it runs in every replica, so two ` +
                   `processes queue the same work twice. Caravan's clock fires under ` +
                   `cron:<job>:<minute>, where the second fire is a no-op.`,
        })
      }
    }
    return { findings }
  },

  // `FJS-D198`: a Queue's verbs split in two. `handle`, `dispatch` and
  // `schedule` are the app's; `pause`, `resume`, `drain` and `purge` are an operator's,
  // run from a console during an incident. Over HTTP caravan refuses them below
  // ADMINISTRATOR, and that gate is the one thing a call from a service or a job
  // does not pass through — the handle is a plain function, so a service method
  // any USER can reach is a pause any USER can make. Read in the two kinds of
  // file that run on somebody else's behalf, and nowhere else: a console script
  // or a deploy hook calling one is what the verb is for.
  // `FJS-D219`: Conduit's rule is that a secret is named and resolved at send
  // time, so it stays out of closures, registries and hooks. The mailer's raw
  // `apiKey` stays accepted, and nothing says an app still holds the secret
  // for the life of the process unless this does.
  'battery-raw-secret': ({ root }) => {
    const files = scripts(root, 'api')
    if (!files.length) return { skipped: 'no api/ source' }

    const findings = []
    for (const path of files) {
      const code = readCode(path)
      for (const m of code.matchAll(/\bcreateResendMailer\s*\(/g)) {
        const call = spanFrom(code, m.index + m[0].length - 1)
        if (!/[{,\s]apiKey\s*(?::|[,}])/.test(call)) continue
        findings.push({
          file: path, line: lineOf(code, m.index),
          message: `createResendMailer({ apiKey }) holds the secret in a closure for the life of the ` +
                   `process, where Conduit resolves a credential by reference at send time. Pass ` +
                   `{ credentials: { get: ref => process.env[ref] }, apiKeyRef: 'RESEND_API_KEY' } — ` +
                   `or a Conduit resolver in place of the object — so the key is read per send.`,
        })
      }
    }
    return { findings }
  },

  'queue-operator-verb':({ root }) => {
    const files = scripts(root, 'api').filter(p => /\.(service|job)\.[cm]?[jt]s$/.test(p))
    if (!files.length) return { skipped: 'no *.service.* or *.job.* under api/' }

    const findings = []
    const say = (path, code, index, verb, target = 'queue(…)') => findings.push({
      file: path, line: lineOf(code, index),
      message: `${target}.${verb}() in a ${/\.job\./.test(path) ? 'job' : 'service'} file. Pausing, resuming, ` +
               `draining and purging a queue are operator verbs (FJS-D198): over HTTP caravan requires ADMINISTRATOR ` +
               `for them, and a call from here skips that gate — whoever can reach this code can stop ` +
               `work every tenant is waiting on. Run it from a console or the admin route instead.`,
    })

    for (const path of files) {
      const code = readCode(path)
      // Every queue at once: app.jobs.pause() — the one a deploy runs (FJS-D262)
      for (const m of code.matchAll(/\.jobs\s*\.(pause|resume|drain|purge)\s*\(/g))
        say(path, code, m.index, m[1], 'jobs')
      // Chained: app.jobs.queue('mail').pause()
      for (const m of code.matchAll(/\.queue\s*\([^)]*\)\s*\.(pause|resume|drain|purge)\s*\(/g))
        say(path, code, m.index, m[1])
      // Bound: const q = app.jobs.queue('mail') … q.pause()
      for (const b of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.queue\s*\(/g))
        for (const m of code.matchAll(new RegExp(`\\b${b[1].replace(/\$/g, '\\$')}\\.(pause|resume|drain|purge)\\s*\\(`, 'g')))
          say(path, code, m.index, m[1])
    }
    return { findings }
  },

  // ─── deploy-image-needs ────────────────────────────────────────────────────
  // make:deploy writes the image an app needs on the day it runs, and skips a
  // Dockerfile that exists. An app that started printing after that day keeps
  // an image with no Chrome, or one whose .dockerignore drops the template the
  // API renders, and the first sight of either is a release that will not
  // start or a PDF that fails (FJS-2269). core/deploy-image.js says what is
  // needed; this grades the Dockerfile against it, and names a browser driver
  // it cannot read rather than passing the image that lacks its browser. A warning: an image built
  // FROM one that already holds a Chrome is correct and invisible here.
  'deploy-image-needs': ({ root }) => {
    const dockerfile = ['Dockerfile', join('deploy', 'Dockerfile')]
      .map(p => join(root, p)).find(p => existsSync(p))
    if (!dockerfile) return { skipped: 'no Dockerfile — not deployed this way' }

    const needs = imageNeeds(root)
    if (!needs.chrome && !needs.webSrc && !needs.offRoad.length) return { skipped: 'the API needs nothing beyond api/ and db/' }

    const text = readFileSync(dockerfile, 'utf8')
    const ignorePath = join(root, '.dockerignore')
    const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
    const file = relative(root, dockerfile)

    const findings = []
    if (needs.chrome && !installsChrome(text)) findings.push({ file, message:
      (needs.chrome === '@frontierjs/print-kit'
        ? 'the app depends on @frontierjs/print-kit and this image installs no Chrome, so printer() ' +
          'refuses to boot and the release does not start. '
        : 'the API imports @frontierjs/mesa/drive and this image installs no Chrome, so its first ' +
          'openChrome() throws in production. ') +
      'Install chromium in the runtime stage, or point $FJS_CHROME at a binary the image holds — ' +
      'fli make:deploy writes the lines for a new Dockerfile' })
    for (const name of needs.offRoad) findings.push({ file, message:
      `the app depends on ${name}, which brings its own pinned browser build that nothing here reads, so ` +
      `this image is graded without it and the first launch fails in the container. An app drives a ` +
      `browser through @frontierjs/print-kit for a document and @frontierjs/mesa/drive for anything ` +
      `else (FJS-D1214) — move the call onto one of them, or to devDependencies if only tests drive it` })
    if (needs.webSrc && !carriesWebSrc(text, ignore)) findings.push({ file, message:
      'the API reads a template from web/src and the image does not carry it — no COPY names it, or ' +
      '.dockerignore drops web/ whole — so the first render fails in production. COPY web/src into the ' +
      'image and write web/* then !web/src in .dockerignore' })
    return { findings }
  },
}

// The services `auth()` registers, by the option key that renames or
// drops each. `auth-service-collision` reads it; a test holds it to auth's own.
export const AUTH_SERVICES = {
  account: 'account', sessions: 'sessions', apiKeys: 'api-keys',
  connections: 'connections', accountRecovery: 'account-recovery', people: 'people',
}
