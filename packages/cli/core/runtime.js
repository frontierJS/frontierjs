import { chalk } from 'zx'
import { execSync, spawn } from 'child_process'
import { pathToFileURL } from 'url'
import { compileCli, extractFrontmatter } from './compiler.js'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync } from 'fs'
import { resolve, dirname, basename, join } from 'path'
import { fileURLToPath } from 'url'
import { logger } from './utils.js'
import { getModule } from './registry.js'
import { printPlanFromFile } from './prose.js'

const env = process.env

// ─── Temp file registry — guaranteed cleanup on exit ─────────────────────────
// Compiled command bodies are written as .mjs shims so we can `import()` them
// (Node ESM loaders only resolve real files, not in-memory strings). They have
// to live somewhere that can resolve 'zx/globals' (and any other node_modules
// imports compiled commands need) — which means under fliRoot, where the
// node_modules tree is.
//
// Subdirectory choice: <fliRoot>/.fli-tmp/<pid>/. Hidden from typical
// dev-tooling walks, easy to add to .gitignore, and a single rmSync at exit
// handles the whole session. PID-keyed subdirs mean concurrent fli processes
// don't step on each other; a startup sweep reaps dirs from runs that crashed
// before cleanup. Previous fliRoot/.__fli_*.mjs sprinkled untracked files
// directly in the project root; this layout is much tidier.
//
// Lazy-init: we don't create the dir or register handlers until first temp
// file is needed, so importing this module before `global.fliRoot` is set
// (e.g. tests that import directly) doesn't crash.
let _sessionDir = null
let _cleanupRegistered = false

const _ensureSession = () => {
  if (_sessionDir) return _sessionDir
  if (!global.fliRoot) {
    throw new Error('runtime: global.fliRoot is not set — bin/fli.js must initialize globals before commands run')
  }
  _sessionDir = join(global.fliRoot, '.fli-tmp', String(process.pid))
  mkdirSync(_sessionDir, { recursive: true })

  // Sweep stale session dirs from previous runs that didn't clean up.
  // Best-effort, never throws.
  try {
    const tmpRoot = join(global.fliRoot, '.fli-tmp')
    for (const name of readdirSync(tmpRoot)) {
      const pid = parseInt(name)
      if (!pid || pid === process.pid) continue
      // process.kill(pid, 0) throws ESRCH if the process is gone
      try {
        process.kill(pid, 0)
        // still alive — leave it
      } catch (err) {
        if (err.code === 'ESRCH') {
          try { rmSync(join(tmpRoot, name), { recursive: true, force: true }) } catch {}
        }
      }
    }
  } catch {}

  if (!_cleanupRegistered) {
    process.on('exit', _cleanupTmp)
    process.on('SIGINT',  () => { _cleanupTmp(); process.exit(130) })
    process.on('SIGTERM', () => { _cleanupTmp(); process.exit(143) })
    _cleanupRegistered = true
  }
  return _sessionDir
}

const _cleanupTmp = () => {
  if (!_sessionDir) return
  try { rmSync(_sessionDir, { recursive: true, force: true }) } catch {}
}

const _tmpFile = () => join(
  _ensureSession(),
  `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}.mjs`
)

// ─── Module cache ─────────────────────────────────────────────────────────────
// Keyed by "filePath:mtimeMs" — skips recompiling and temp file writes for
// commands invoked more than once per session (workspace loops, step files, etc).
// Each entry holds { run, metadata } from the compiled module.
// The mtime component means edits are always picked up — no stale cache risk.
//
// Bounded LRU: long-running GUI sessions can accumulate entries when files
// are edited (each mtime gets its own key, prior entries linger). We evict
// the oldest entry when count exceeds MAX. Map preserves insertion order;
// re-insertion on hit moves an entry to "most recent".
const _moduleCache = new Map()
const MODULE_CACHE_MAX = 256

function _cacheGet(key) {
  if (!_moduleCache.has(key)) return undefined
  const v = _moduleCache.get(key)
  // Touch — move to the end of the iteration order
  _moduleCache.delete(key)
  _moduleCache.set(key, v)
  return v
}

function _cacheSet(key, value) {
  if (_moduleCache.size >= MODULE_CACHE_MAX && !_moduleCache.has(key)) {
    // Evict oldest
    const oldest = _moduleCache.keys().next().value
    _moduleCache.delete(oldest)
  }
  _moduleCache.set(key, value)
}

const dirs = {
  web:       env.WEB_DIR       || 'web',
  api:       env.API_DIR       || 'api',
  site:      env.SITE_DIR      || 'site',
  mobile:    env.MOBILE_DIR    || 'mobile',
  extension: env.EXTENSION_DIR || 'extension',
  tests:     env.TESTS_DIR     || 'tests',
  db:        env.DB_DIR        || 'db',
  wiki:      env.WIKI_DIR      || 'wiki',
  cli:       env.CLI_DIR       || 'cli',
}

// ─── Command() ────────────────────────────────────────────────────────────────
// emit: optional async (event) => void for web/SSE runs
//   event shapes: { type: 'log', level, text } | { type: 'output', text }
export async function Command({ file, arg, flag, emit }) {
  let run, metadata, mod = null
  if (file.endsWith('.md')) {
    const template = readFileSync(file, 'utf8')
    // Load namespace module if one exists
    const ns = (extractedMeta => extractedMeta?.title?.split(':')?.[0])(extractFrontmatter(template))
    mod      = ns ? getModule(ns) : null

    // ── Module cache check ────────────────────────────────────────────────────
    // Skip compilation and temp file entirely on cache hit.
    // Cache key includes mtime so edits are always reflected immediately.
    let cacheKey = null
    try {
      const stat = statSync(file)
      cacheKey = `${file}:${stat.mtimeMs}`
      const cached = _cacheGet(cacheKey)
      if (cached) {
        ;({ run, metadata } = cached)
      }
    } catch { /* can't stat — fall through to compile */ }

    if (!run) {
      const source = compileCli(template, mod?.script || '', file)
      const tmpFile = _tmpFile()
      try {
        writeFileSync(tmpFile, source)
        ;({ run, metadata } = await import(pathToFileURL(tmpFile)))
      } catch (err) {
        // Re-throw with the actual command file path so users see what's broken,
        // not the disposable temp shim path.
        const wrapped = new Error(`${file}:\n  ${err.message}`)
        wrapped.cause = err
        wrapped.signal = err.signal
        throw wrapped
      }
      // No per-file unlink — the session dir is wiped on process exit.
      // (Per-file sync unlink would also work, but the dir-sweep is simpler
      // and lets us survive a crash without needing every code path to clean up.)
      if (cacheKey) _cacheSet(cacheKey, { run, metadata })
    }
  } else {
    ;({ run, metadata } = await import(pathToFileURL(file)))
  }

  if (!metadata) {
    const msg = `Command at [ ${file} ] is missing frontmatter metadata`
    if (emit) await emit({ type: 'log', level: 'error', text: msg })
    else logger(msg, 'error')
    throw new Error('Command not configured')
  }

  // ── Module: merge defaults then check requires ───────────────────────────────
  if (mod) {
    // Merge module-level flag defaults (env vars interpolated at parse time)
    if (mod.meta?.defaults?.flags) {
      for (const [flagName, flagDef] of Object.entries(mod.meta.defaults.flags)) {
        if (!metadata.flags) metadata.flags = {}
        if (!metadata.flags[flagName]) metadata.flags[flagName] = {}
        const def = flagDef.defaultValue || ''
        // Interpolate ${ENV_VAR} at parse time
        const resolved = def.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '')
        metadata.flags[flagName].defaultValue ??= resolved
      }
    }

    // Check requires — block execution if any required env var is missing
    if (mod.meta?.requires?.length) {
      const missing = mod.meta.requires.filter(k => !process.env[k])
      if (missing.length) {
        const ns = mod.meta.namespace || metadata.title?.split(':')?.[0]
        const msgs = [
          `${ns} namespace requires: ${missing.join(', ')}`,
          ...missing.map(k => `  Set with:  fli eset ${k} <value> --global`),
          `  Or run:    fli ${ns} --verbose  for setup instructions`,
        ]
        if (emit) {
          for (const m of msgs) await emit({ type: 'log', level: 'error', text: m })
        } else {
          for (const m of msgs) logger(m, 'error')
        }
        throw new Error('Missing required environment variables')
      }
    }
  }

  const config = getConfig(metadata, arg, flag)

  // ── Validate required args ────────────────────────────────────────────────
  const missing = config.args.find((a) => a.required && !a.value)
  if (missing) {
    const msg = `arg [ ${missing.name} ] is required!`
    if (emit) await emit({ type: 'log', level: 'error', text: msg })
    else logger(msg, 'error')
    throw new Error('command cancelled')
  }

  // ── Validate required flags ───────────────────────────────────────────────
  // A flag with required: true must have a value — either from the user or a
  // defaultValue. A flag with both required and a default is always satisfied
  // because defaultValue fills it in before this check runs.
  const missingFlagEntry = Object.entries(config.flags || {})
    .find(([key, def]) => def.required && (config.flag[key] === undefined || config.flag[key] === null || config.flag[key] === ''))

  if (missingFlagEntry) {
    const msg = `flag [ --${missingFlagEntry[0]} ] is required!`
    if (emit) await emit({ type: 'log', level: 'error', text: msg })
    else logger(msg, 'error')
    throw new Error('command cancelled')
  }

  config.run   = run.bind(config)
  config.paths = buildPaths()
  config.env   = process.env
  config.env.browser ??= env.BROWSER || 'firefox'

  // log — chalk output for CLI, structured events for web
  config.log = emit
    ? {
        error:   (text) => emit({ type: 'log', level: 'error',   text }),
        warn:    (text) => emit({ type: 'log', level: 'warn',    text }),
        info:    (text) => emit({ type: 'log', level: 'info',    text }),
        success: (text) => emit({ type: 'log', level: 'success', text }),
        dry:     (text) => emit({ type: 'log', level: 'dry',     text }),
        debug:   (text) => emit({ type: 'log', level: 'debug',   text }),
      }
    : terminalLog

  // echo: injected into context so the compiled run() can shadow the ZX global.
  // This avoids patching globalThis.echo, making concurrent web requests safe.
  config.echo = emit
    ? (...args) => {
        const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ') + '\n'
        emit({ type: 'output', text })
      }
    : undefined  // CLI: compiled run() falls back to the ZX global echo

  // ─── context.exec — synchronous shell execution ────────────────────────────
  // Use for short-lived commands where output is not needed live (git, rsync,
  // quick docker commands). Respects --dry automatically.
  //
  // SIGINT/SIGTERM (e.g. user hits Ctrl+C while a long-running child is going)
  // is not an error — it's the user telling us to stop. We swallow the throw
  // and exit cleanly with the matching exit code (130 for SIGINT, 143 for
  // SIGTERM) instead of bubbling a stack trace.
  config.exec = ({ command, dry, ...opts }) => {
    if (dry ?? config.flag.dry) {
      const msg = command
      return emit ? emit({ type: 'log', level: 'dry', text: msg }) : logger(msg, 'dry')
    }
    try {
      return execSync(command, { stdio: 'inherit', ...opts })
    } catch (err) {
      if (err.signal === 'SIGINT' || err.signal === 'SIGTERM') {
        const code = err.signal === 'SIGINT' ? 130 : 143
        const note = err.signal === 'SIGINT' ? 'aborted (Ctrl+C)' : 'terminated'
        if (emit) emit({ type: 'log', level: 'warn', text: note })
        else logger(note, 'warn')
        process.exit(code)
      }
      throw err
    }
  }

  config.execute = (actions) => actions.forEach((action) => config.exec(action))

  // ─── context.stream — async streaming shell execution ─────────────────────
  // Use for long-running commands where live output matters: docker build,
  // deploy:logs --follow, bun dev, etc. Respects --dry automatically.
  //
  // CLI mode:  stdout/stderr inherit directly — output appears as it arrives.
  // Web/SSE:   stdout/stderr piped and emitted line-by-line as SSE events.
  //
  // Usage:  await context.stream({ command: `ssh ${host} "docker logs -f ${c}"` })
  // Returns a Promise that resolves on exit code 0, rejects on non-zero.
  config.stream = ({ command, dry, ...opts } = {}) => {
    if (dry ?? config.flag.dry) {
      const msg = command
      if (emit) return emit({ type: 'log', level: 'dry', text: msg })
      logger(msg, 'dry')
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      // CLI: inherit gives live output with no buffering.
      // SSE: pipe stdout/stderr so we can emit each chunk as it arrives.
      const stdio = emit
        ? ['inherit', 'pipe', 'pipe']
        : 'inherit'

      const child = spawn(command, { shell: true, stdio, ...opts })

      if (emit) {
        child.stdout?.on('data', chunk => emit({ type: 'output', text: chunk.toString() }))
        child.stderr?.on('data', chunk => emit({ type: 'output', text: chunk.toString() }))
      }

      child.on('close', (code, signal) => {
        // Signal-based exit (Ctrl+C, kill) is not an error — user asked to stop.
        if (signal === 'SIGINT' || signal === 'SIGTERM') {
          const note = signal === 'SIGINT' ? 'aborted (Ctrl+C)' : 'terminated'
          if (emit) emit({ type: 'log', level: 'warn', text: note })
          else logger(note, 'warn')
          const exitCode = signal === 'SIGINT' ? 130 : 143
          process.exit(exitCode)
          return
        }
        if (code !== 0) reject(new Error(`Command failed (exit ${code}): ${command}`))
        else resolve()
      })
      child.on('error', reject)
    })
  }

  // ─── context.git — git utility helpers ────────────────────────────────────
  // Available in every command as `context.git.*`
  // All methods accept an optional `dir` — defaults to projectRoot
  config.git = buildGitUtils(config.paths.root)

  // ─── context.wsRoot — lazy workspace root resolver ────────────────────────
  // Returns $WORKSPACE_DIR from env, or prompts once and caches the answer.
  // Usage in any command: const wsRoot = await context.wsRoot()
  config.wsRoot = (() => {
    let cached = null
    return async () => {
      if (cached) return cached
      let root = process.env.WORKSPACE_DIR || null
      if (!root) {
        const { createInterface } = await import('readline')
        const answer = await new Promise(resolve => {
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          rl.question('Workspace root path (or set WORKSPACE_DIR in .env): ', ans => {
            rl.close()
            resolve(ans)
          })
        })
        root = answer.trim().replace(/^~/, process.env.HOME || '')
      }
      if (root) cached = root
      return root || null
    }
  })()

  // ─── context.vars + context.printPlan — prose interpolation ────────────────
  // Commands populate context.vars with runtime values, then call
  // context.printPlan() on --dry to render the prose section interpolated.
  config.vars       = {}
  config.filePath   = file
  config.printPlan  = () => printPlanFromFile(file, {
    ...config.vars,
    ...config.arg,
    ...config.flag,
  })

  // ─── _steps/ discovery ────────────────────────────────────────────────────
  // If the command has a _steps/ folder alongside it, run its steps in sequence.
  // The orchestrator's own run() body executes first (use it to populate context.config
  // from flags), then each step runs in order sharing the same context.
  //
  // The orchestrator may set context.config.stepsDir to redirect to a different
  // steps folder (e.g. '_steps-docker'). Discovery is deferred until after the
  // orchestrator runs so this override takes effect before steps are loaded.
  const defaultStepsDir = file.endsWith('.md')
    ? resolve(dirname(file), '_steps')
    : null

  if (defaultStepsDir && existsSync(defaultStepsDir)) {
    // Return a function that runs the orchestrator then all steps
    const runSteps = async () => {
      // Shared mutable config object — steps read and write to this
      config.config = {}

      // Run the orchestrator's own body first (sets up context.config from flags)
      await config.run(config)

      // Re-resolve stepsDir — orchestrator may have set context.config.stepsDir
      // to redirect to a different folder (e.g. '_steps-docker').
      // Falls back to _steps/ if not set.
      const stepsDir = config.config?.stepsDir
        ? resolve(dirname(file), config.config.stepsDir)
        : defaultStepsDir

      if (!existsSync(stepsDir)) {
        const msg = `Steps folder not found: ${config.config.stepsDir} (resolved to ${stepsDir})`
        if (emit) await emit({ type: 'log', level: 'error', text: msg })
        else logger(msg, 'error')
        throw new Error(msg)
      }

      const allStepFiles = readdirSync(stepsDir)
        .filter(f => f.endsWith('.md') && /^\d/.test(f))
        .sort()
        .map(f => resolve(stepsDir, f))

      if (allStepFiles.length === 0) return

      // ── Step ordering validation ────────────────────────────────────────────
      // Warn if two step files share the same numeric prefix — their relative
      // order is lexicographic and could be surprising if names are not careful.
      const prefixCounts = new Map()
      for (const f of allStepFiles) {
        const prefix = basename(f).match(/^(\d+)/)?.[1]
        if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
      }
      for (const [prefix, count] of prefixCounts) {
        if (count > 1) {
          config.log.warn(`  Warning: ${count} step files share numeric prefix "${prefix}" — ordering is lexicographic, verify it is correct`)
        }
      }

      // --step N selects a single step (1-based)
      const stepFilter = config.flag.step
      const stepFiles  = stepFilter
        ? allStepFiles.filter((_, i) => i + 1 === stepFilter)
        : allStepFiles

      if (stepFilter && stepFiles.length === 0) {
        const msg = `Step ${stepFilter} not found — this command has ${allStepFiles.length} step(s)`
        if (emit) await emit({ type: 'log', level: 'error', text: msg })
        else logger(msg, 'error')
        throw new Error(msg)
      }

      // ── Step execution ──────────────────────────────────────────────────────
      // Steps with parallel: true in their frontmatter run concurrently with
      // adjacent parallel steps. A non-parallel step is a serial checkpoint —
      // all previous parallel steps must complete before it starts.
      //
      // Parallel steps share the same context.config object. They should write
      // to distinct keys; concurrent writes to the same key are a race condition.

      // Helper: compile and run a single step file, returns a Promise.
      // stepTemplate is passed in — the caller already has it from the group
      // builder, so we avoid reading the file twice.
      const runOneStep = async (stepFile, stepTemplate) => {
        const stepNum    = allStepFiles.indexOf(stepFile) + 1
        const totalSteps = allStepFiles.length
        const stepName   = basename(stepFile, '.md')

        const stepMeta = extractFrontmatter(stepTemplate)

        // Evaluate skip predicate if defined
        if (stepMeta.skip) {
          try {
            const shouldSkip = new Function('flag', 'context', `return ${stepMeta.skip}`)(config.flag, config)
            if (shouldSkip) {
              config.log.info(`  [${stepNum}/${totalSteps}] ${stepName} — skipped`)
              return
            }
          } catch (err) {
            // skip predicate threw — warn loudly so users notice typos.
            // Falling through to run the step is the safer default; a typo
            // shouldn't silently disable a step.
            config.log.warn(`  [${stepNum}/${totalSteps}] ${stepName} — skip predicate error: ${err.message} (running step anyway)`)
          }
        }

        config.log.info(`  [${stepNum}/${totalSteps}] ${stepName}`)
        if (emit) await emit({ type: 'step:start', id: stepName, index: stepNum, total: totalSteps })
        const stepStartMs = Date.now()

        try {
          // Load and run the step — check cache first, same as Command()
          let stepRun
          let stepCacheKey = null
          try {
            const stat = statSync(stepFile)
            stepCacheKey = `${stepFile}:${stat.mtimeMs}`
            const cached = _cacheGet(stepCacheKey)
            if (cached) {
              ;({ run: stepRun } = cached)
            }
          } catch {}

          if (!stepRun) {
            const stepSource = compileCli(stepTemplate, '', stepFile)
            const tmpStep = _tmpFile()
            try {
              writeFileSync(tmpStep, stepSource)
              ;({ run: stepRun } = await import(pathToFileURL(tmpStep)))
            } catch (err) {
              const wrapped = new Error(`${stepFile}:\n  ${err.message}`)
              wrapped.cause = err
              wrapped.signal = err.signal
              throw wrapped
            }
            if (stepCacheKey) _cacheSet(stepCacheKey, { run: stepRun, metadata: stepMeta })
          }

          // Build step context — inherits parent flags + shared config
          const stepContext = {
            ...config,
            config: config.config,  // shared mutable state
            arg:    {},
            flag:   config.flag,
          }
          stepContext.run  = stepRun.bind(stepContext)
          stepContext.echo = config.echo
          await stepContext.run(stepContext)

          if (emit) await emit({ type: 'step:done', id: stepName, status: 'success', elapsed_ms: Date.now() - stepStartMs })
        } catch (err) {
          if (stepMeta.optional) {
            config.log.warn(`  [${stepNum}/${totalSteps}] ${stepName} — failed (optional, continuing)`)
            config.log.warn(`  ${err.message}`)
            if (emit) await emit({ type: 'step:done', id: stepName, status: 'warn', elapsed_ms: Date.now() - stepStartMs, error: err.message })
          } else {
            if (emit) await emit({ type: 'step:done', id: stepName, status: 'failed', elapsed_ms: Date.now() - stepStartMs, error: err.message })
            throw err
          }
        }
      }

      // Build execution groups — consecutive parallel steps form a group,
      // serial steps each stand alone. Each group runs atomically.
      // Pre-read templates here so runOneStep doesn't need to read them again.
      const groups = []
      let parallelBatch = []

      for (const stepFile of stepFiles) {
        const template = readFileSync(stepFile, 'utf8')
        const meta = extractFrontmatter(template)
        const entry = { file: stepFile, template }
        if (meta.parallel) {
          parallelBatch.push(entry)
        } else {
          if (parallelBatch.length > 0) {
            groups.push({ type: 'parallel', entries: parallelBatch })
            parallelBatch = []
          }
          groups.push({ type: 'serial', entries: [entry] })
        }
      }
      if (parallelBatch.length > 0) {
        groups.push({ type: 'parallel', entries: parallelBatch })
      }

      // Execute groups in order — parallel groups use Promise.all
      for (const group of groups) {
        if (group.type === 'serial') {
          const { file, template } = group.entries[0]
          await runOneStep(file, template)
        } else {
          const names = group.entries.map(e => basename(e.file, '.md')).join(', ')
          config.log.info(`  [parallel] ${names}`)

          // Wrap config.config in a Proxy that tracks how many times each key
          // is written during this parallel group. If a key is written more
          // than once, two steps probably collided — warn so the user notices
          // the race condition. (Tracking which step did the writing requires
          // AsyncLocalStorage which we don't yet plumb through; this is the
          // best-effort signal.)
          const realConfig = config.config
          const writeCount = new Map()
          const proxied = new Proxy(realConfig, {
            set(target, key, value, receiver) {
              writeCount.set(key, (writeCount.get(key) || 0) + 1)
              return Reflect.set(target, key, value, receiver)
            }
          })
          config.config = proxied

          try {
            await Promise.all(group.entries.map(({ file, template }) => runOneStep(file, template)))
          } finally {
            config.config = realConfig
            // Report any keys written more than once
            for (const [key, n] of writeCount) {
              if (n > 1) {
                config.log.warn(`  [parallel] race: context.config.${String(key)} written ${n} times — use serial steps for shared state`)
              }
            }
          }
        }
      }
    }

    runSteps._stepRunner = true
    return runSteps
  }

  // echo is set on config above — compiled run() shadows the ZX global
  // via `if (context.echo !== undefined) { var echo = context.echo }`.
  // No globalThis patching — concurrent web requests are safe.
  return () => config.run(config)
}

// ─── Default flags ────────────────────────────────────────────────────────────

const defaultFlags = {
  dry: {
    type: 'boolean',
    char: 'd',
    description: 'Show actions that will run without executing them'
  },
  test: {
    type: 'boolean',
    char: 't',
    options: { true: 'NODE_ENV=test', false: '' }
  },
  step: {
    type: 'number',
    description: 'Re-run a single step by number (1-based) when using _steps/'
  },
  debug: {
    type: 'boolean',
    description: 'Show full stack traces on errors instead of clean messages'
  }
}

export function getConfig(metadata, rawArg, flag) {
  // Deep-clone metadata so repeated calls (registry lookups, help display)
  // don't see .value properties written by previous runs on the same cached module.
  // Crucially, defaultFlags is also cloned per-entry — without this, setting
  // .value on (e.g.) defaultFlags.step during one call leaks into all
  // subsequent calls across the entire process. That bit us in zz-steps.test
  // where scenario 7 sets --step 99, and scenario 8 inherits the leftover
  // step:99 even though it passed flag:{}.
  const meta = {
    ...metadata,
    args:  (metadata.args  || []).map(a => ({ ...a })),
    flags: {
      ...Object.fromEntries(Object.entries(defaultFlags).map(([k, v]) => [k, { ...v }])),
      ...Object.fromEntries(Object.entries(metadata.flags || {}).map(([k, v]) => [k, { ...v }])),
    }
  }

  // Clone the flag object so we don't mutate the caller's input — bootstrap
  // and tests both pass in objects that survive the call and could carry
  // surprising mutations otherwise.
  flag = { ...flag }

  const rawArgArray = rawArg
  let arg = rawArgArray.reduce((acc, value, index) => {
    const def = meta.args[index]
    if (!def) return acc
    if (def.variadic) value = rawArgArray.slice(index).join(' ')
    def.value = value
    acc[def.name] = def.value || def.defaultValue
    return acc
  }, {})
  // Apply defaultValues for args not supplied at all
  meta.args.forEach((def) => {
    if (arg[def.name] === undefined && def.defaultValue !== undefined) {
      arg[def.name] = def.defaultValue
    }
  })

  Object.entries(flag).forEach(([key, value]) => {
    if (key.length === 1) {
      const found = Object.entries(meta.flags).find(([, { char }]) => char === key)
      if (!found) { logger(`[-${key}] unrecognized short flag, ignoring`, 'warn'); delete flag[key]; return }
      delete flag[key]
      // Only promote short char if the full-name flag isn't already explicitly set
      // and the value is truthy (minimist sets unpasssed short booleans to false)
      if (flag[found[0]] === undefined) {
        key = found[0]
        flag[key] = value
      } else {
        return // full-name flag takes precedence
      }
    }

    const flagData = meta.flags[key]

    if (!flagData) {
      if (meta.mode === 'strict') {
        logger(`[${key}] flag not defined [strict mode]`, 'error')
        throw new Error('Cancelling action.')
      }
      logger(`[${key}] flag not defined — ignoring`, 'warn')
      return
    }

    if (flagData.type && typeof value !== flagData.type) {
      logger(`[${key}] must be type ${flagData.type}`, 'error')
      throw new Error('Cancelling action.')
    }

    if (flagData.options) {
      if (!flagData.options[value]) {
        logger(`[${key}] must be one of: [ ${Object.keys(flagData.options).join(', ')} ]`, 'error')
        throw new Error('Cancelling action.')
      }
      flagData.value = flagData.options[value]?.value ?? flagData.options[value]
    } else {
      flagData.value = value ?? flagData.defaultValue
    }
  })

  Object.entries(meta.flags).forEach(([key, v]) => {
    const setValue = v.value ?? v.defaultValue
    if (setValue !== undefined) flag[key] = setValue
  })

  return { ...meta, flag, arg }
}

// ─── Git utilities ────────────────────────────────────────────────────────────
// Returns a git helper object scoped to a default directory.
// All methods accept an optional `dir` override.
function buildGitUtils(defaultDir) {
  const run = (cmd, dir) => {
    try {
      return execSync(cmd, {
        cwd: dir || defaultDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim()
    } catch { return '' }
  }

  return {
    // Current branch name — empty string if not in a git repo
    branch: (dir) => run('git branch --show-current', dir),

    // Porcelain status — returns array of changed file lines
    status: (dir) => run('git status --porcelain', dir).split('\n').filter(Boolean),

    // true if there are any uncommitted changes
    isDirty: (dir) => run('git status --porcelain', dir).trim().length > 0,

    // Most recent tag — empty string if no tags
    lastTag: (dir) => run('git describe --tags --abbrev=0', dir),

    // true if there are commits/changes since a given tag (or any changes if no tag)
    hasChangesSince: (tag, dir) => {
      const ref = tag ? `${tag}..HEAD` : 'HEAD'
      return run(`git diff --name-only ${ref}`, dir).trim().length > 0
    },

    // Convenience: true if this package has changes since its last tag
    // Combines lastTag + hasChangesSince — use for --affected logic
    isAffected: (dir) => {
      const tag = run('git describe --tags --abbrev=0', dir)
      const ref = tag ? `${tag}..HEAD` : 'HEAD'
      return run(`git diff --name-only ${ref}`, dir).trim().length > 0
    },

    // Short log of commits since a tag (or all commits if no tag)
    // Returns array of { hash, subject, author }
    log: (tag, dir) => {
      const range = tag ? `${tag}..HEAD` : ''
      const out   = run(`git log ${range} --format="%h|%s|%an" --no-merges`.trim(), dir)
      return out.split('\n').filter(Boolean).map(line => {
        const [hash, subject, author] = line.split('|')
        return { hash, subject, author }
      })
    },

    // Remote URL for origin
    remote: (dir) => run('git remote get-url origin', dir),

    // Commits ahead/behind the upstream tracking branch
    ahead:  (dir) => parseInt(run('git rev-list --count @{u}..HEAD', dir)) || 0,
    behind: (dir) => parseInt(run('git rev-list --count HEAD..@{u}', dir)) || 0,
  }
}

function buildPaths() {
  const r = global.projectRoot
  const d = dirs
  return {
    root:          resolve(r),
    wiki:          resolve(r, d.wiki),
    tests:         resolve(r, d.tests),
    cli:           resolve(r, d.cli),
    api:           resolve(r, d.api),
    db:            resolve(r, d.db),
    web:           resolve(r, d.web),
    webPages:      resolve(r, d.web, 'src/routes'),
    webComponents: resolve(r, d.web, 'src/components'),
    webResources:  resolve(r, d.web, 'src/resources'),
    site:          resolve(r, d.site),
    siteContent:   resolve(r, d.site, 'content'),
    siteMedia:     resolve(r, d.site, 'content/media'),
    mobile:        resolve(r, d.mobile),
    extension:     resolve(r, d.extension),
  }
}

const terminalLog = {
  error:   (text) => logger(text, 'error'),
  warn:    (text) => logger(text, 'warn'),
  info:    (text) => logger(text, 'info'),
  success: (text) => logger(text, 'success'),
  dry:     (text) => logger(text, 'dry'),
  debug:   (text) => logger(text, 'debug'),
}
