// bootstrap.js — fli's command-resolution + help/list/search entry point.
// Notably, this file does NOT import 'zx/globals'. Compiled commands import
// zx/globals themselves; bootstrap only needs chalk + minimist as named
// imports. Skipping zx/globals here saves ~100ms on read-only invocations
// (fli list, fli help, search).
import { chalk, minimist } from 'zx'
import { resolve } from 'path'
import { homedir } from 'os'
import { logger, loadEnv } from './utils.js'
import { printPlanFromFile } from './prose.js'
import { Command } from './runtime.js'
import { buildRegistry, uniqueCommands, getModule } from './registry.js'
import { loadConfig } from './config.js'

// ─── .fli.json + .env — load both from project root ──────────────────────────
loadConfig()

// Global env (~/.config/fli/.env) — loaded first; provides defaults.
loadEnv(resolve(homedir(), '.config', 'fli', '.env'))
// Project env — explicitly overrides globals so per-project .env wins.
loadEnv(resolve(global.projectRoot, '.env'), { override: true })



// ─── Internal flags hidden from help/listing ─────────────────────────────────
// These are added by the runtime (defaultFlags) for cross-cutting behavior;
// users don't pass them by name in command help so we hide them from listings.
const INTERNAL_FLAGS = new Set(['dry', 'test', 'step', 'debug', '_spec'])

// ─── printSearch() — keyword search across all commands ──────────────────────
function printSearch(q, all) {
  const dim    = (s) => chalk.dim(s)
  const green  = (s) => chalk.green(s)
  const yellow = (s) => chalk.yellow(s)
  const cyan   = (s) => chalk.cyan(s)
  const amber  = (s) => chalk.hex('#f5a623')(s)

  const scored = all.map(m => {
    const title = m.title.toLowerCase()
    const alias = (m.alias || '').toLowerCase()
    const desc  = (m.description || '').toLowerCase()
    const [ns, name = ''] = title.split(':')
    let score = 0
    if (ns === q)                          score = 100
    if (alias === q)                       score = Math.max(score, 95)
    if (title.startsWith(q + ':'))         score = Math.max(score, 90)
    if (ns.startsWith(q))                  score = Math.max(score, 85)
    if (alias.startsWith(q))               score = Math.max(score, 75)
    if (title.includes(':' + q))           score = Math.max(score, 65)
    if (title.includes(q))                 score = Math.max(score, 55)
    if (name.includes(q))                  score = Math.max(score, 45)
    if (alias.includes(q))                 score = Math.max(score, 35)
    if (desc.split(' ').some(w => w.startsWith(q))) score = Math.max(score, 25)
    return { meta: m, score }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  if (!scored.length) {
    process.stdout.write('\n')
    process.stdout.write(`  ${dim('No commands matched')} ${amber(q)}\n\n`)
    return
  }

  // Group by namespace for readability
  const byNs = {}
  for (const { meta: m } of scored) {
    const ns = m.title.split(':')[0]
    ;(byNs[ns] = byNs[ns] || []).push(m)
  }

  process.stdout.write('\n')
  process.stdout.write(`  ${dim('Search:')} ${amber(q)}  ${dim('·')}  ${dim(scored.length + ' result' + (scored.length !== 1 ? 's' : ''))}\n\n`)

  for (const [ns, commands] of Object.entries(byNs)) {
    process.stdout.write(`  ${yellow(ns)}\n`)
    for (const m of commands) {
      const alias = m.alias ? dim(` · ${m.alias}`) : ''
      const desc  = m.description ? dim(`  — ${m.description}`) : ''
      process.stdout.write(`    ${green(m.title)}${alias}${desc}\n`)
    }
    process.stdout.write('\n')
  }
}

// ─── printNamespace() — pretty-print all commands in a namespace ──────────────
async function printNamespace(ns, commands, verbose = false) {
  const dim    = (s) => chalk.dim(s)
  const green  = (s) => chalk.green(s)
  const red    = (s) => chalk.red(s)
  const yellow = (s) => chalk.yellow(s)
  const cyan   = (s) => chalk.cyan(s)
  const amber  = (s) => chalk.hex('#f5a623')(s)

  process.stdout.write('\n')
  const mod = getModule(ns)
  const hasModule = mod && (mod.prose || mod.meta?.requires?.length)

  process.stdout.write(`  ${yellow(ns)}  ${dim('namespace')}  ${dim('·')}  ${dim(commands.length + ' command' + (commands.length !== 1 ? 's' : ''))}`)
  if (hasModule && !verbose) process.stdout.write(dim('  · fli ' + ns + ' --verbose for setup docs'))
  process.stdout.write('\n\n')

  // Show module docs if --verbose or if requires are unmet
  if (verbose && mod) {
    if (mod.meta?.requires?.length) {
      const unmet = mod.meta.requires.filter(k => !process.env[k])
      process.stdout.write(`  ${dim('requires')}\n`)
      for (const k of mod.meta.requires) {
        const set = process.env[k]
        const indicator = set ? green('✓') : red('✗')
        process.stdout.write(`    ${indicator}  ${k}${set ? dim('  set') : ''}\n`)
      }
      process.stdout.write('\n')
    }
    if (mod.meta?.description) {
      process.stdout.write(`  ${dim(mod.meta.description)}\n\n`)
    }
    if (mod.prose) {
      const { renderProse } = await import('./prose.js')
      renderProse(mod.prose, {})
    }
  }

  for (const m of commands) {
    const alias = m.alias ? dim(` · ${m.alias}`) : ''

    // Title line
    process.stdout.write(`  ${green(m.title)}${alias}\n`)

    // Description
    if (m.description) {
      process.stdout.write(`  ${dim(m.description)}\n`)
    }

    // Args
    const args = (m.args || []).filter(a => a.name)
    if (args.length) {
      const argStr = args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')
      process.stdout.write(`  ${dim('args   ')} ${cyan(argStr)}\n`)
    }

    // Flags (skip internal ones)
    const flags = Object.entries(m.flags || {})
      .filter(([k]) => !INTERNAL_FLAGS.has(k))
    if (flags.length) {
      for (const [name, def] of flags) {
        const short   = def.char ? dim(`-${def.char}, `) : dim('    ')
        const type    = def.type && def.type !== 'boolean' ? dim(` (${def.type})`) : ''
        const defVal  = def.defaultValue !== undefined && def.defaultValue !== '' && def.defaultValue !== false
          ? dim(` [${def.defaultValue}]`) : ''
        const desc    = def.description ? dim(`  ${def.description}`) : ''
        process.stdout.write(`  ${dim('       ')} ${short}${amber('--' + name)}${type}${defVal}${desc}\n`)
      }
    }

    // Examples
    const examples = Array.isArray(m.examples) ? m.examples : m.examples ? [m.examples] : []
    if (examples.length) {
      process.stdout.write(`  ${dim('eg.    ')} ${dim(examples[0])}\n`)
    }

    process.stdout.write('\n')
  }
}

// ─── printHelp() — pretty-print a command's metadata ─────────────────────────
function printHelp(meta, filePath) {
  logger(`${meta.title}`, 'info')
  if (meta.description) {
    logger(`  ${meta.description}`, 'info')
  }

  // Usage line — built from metadata only, never from parsed argv
  const argNames = (meta.args || []).map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')
  const flagHint = Object.keys(meta.flags || {}).length ? '[--flags]' : ''
  const usageLine = [`fli ${meta.title}`, argNames, flagHint].filter(Boolean).join(' ')
  logger(`\n  Usage: ${usageLine}`, 'info')

  // Aliases
  if (meta.alias) {
    logger(`  Alias: fli ${meta.alias}`, 'info')
  }

  // Args
  if (meta.args?.length) {
    logger('\n  Arguments:', 'info')
    for (const arg of meta.args) {
      const required = arg.required ? chalk.yellow(' (required)') : ''
      const def      = arg.defaultValue !== undefined ? chalk.dim(` [default: ${arg.defaultValue}]`) : ''
      logger(`    ${arg.name.padEnd(20)} ${arg.description ?? ''}${required}${def}`, 'info')
    }
  }

  // Flags — skip internal ones
  const flags = Object.entries(meta.flags || {}).filter(([k]) => !INTERNAL_FLAGS.has(k))
  if (flags.length) {
    logger('\n  Flags:', 'info')
    for (const [name, def] of flags) {
      const short = def.char ? `-${def.char}, ` : '    '
      const type  = def.type ? chalk.dim(` (${def.type})`) : ''
      const def_  = def.defaultValue !== undefined ? chalk.dim(` [default: ${def.defaultValue}]`) : ''
      logger(`    ${short}--${name.padEnd(18)} ${def.description ?? ''}${type}${def_}`, 'info')
    }
  }

  // Examples
  const examples = Array.isArray(meta.examples) ? meta.examples : meta.examples ? [meta.examples] : []
  if (examples.length) {
    logger('\n  Examples:', 'info')
    for (const ex of examples) {
      logger(`    ${ex}`, 'info')
    }
  }

  if (filePath) {
    try { printPlanFromFile(filePath, {}) } catch {}
  }
}

// ─── run() ────────────────────────────────────────────────────────────────────
// Errors thrown here (or from inside Command()) propagate up to bin/fli.js,
// which prints clean error messages and supports --debug for full stacks.
export async function run(process) {
  const argv = minimist(process.argv.slice(2), { boolean: ['help', 'h', 'dry', 'd'] })
  let { _: [cmd, ...rawArgs], ...flag } = argv
  // Treat `?` as an alias for `help`
  if (cmd === '?') { cmd = 'help' }

  // fli --help or fli (no command) — show usage
  if (!cmd || flag.help || flag.h) {
    const line  = (s) => process.stdout.write(s + '\n')
    const dim   = (s) => chalk.dim(s)
    const green = (s) => chalk.green(s)
    const cyan  = (s) => chalk.cyan(s)
    const amber = (s) => chalk.hex('#f5a623')(s)
    line('')
    line(`  ${amber('fli')}  ${dim('·  frontier cli')}`)
    line('')
    line(`  ${dim('Usage:')}`)
    line(`    ${cyan('fli')} ${green('<command>')} ${dim('[args] [--flags]')}`)
    line(`    ${cyan('fli')} ${green('<namespace>')}            ${dim('show all commands in a namespace')}`)
    line(`    ${cyan('fli')} ${green('<command>')} ${dim('--help')}        ${dim('detailed help for a command')}`)
    line(`    ${cyan('fli')} ${dim('help')} ${green('<command>')}          ${dim('same as --help')}`)
    line(`    ${cyan('fli')} ${dim('?')} ${green('<query>')}               ${dim('search commands by keyword')}`)
    line(`    ${cyan('fli')} ${dim('list')}                    ${dim('all commands grouped by namespace')}`)
    line('')
    line(`  ${dim('Examples:')}`)
    line(`    ${dim('fli git:commit')}`)
    line(`    ${dim('fli github')}                  ${dim('→ shows github namespace')}`)
    line(`    ${dim('fli ? deploy')}                ${dim('→ search for deploy commands')}`)
    line(`    ${dim('fli git:push --help')}`)
    line('')
    return
  }

  // fli help <command>  or  fli ? <command>  — delegate to --help path
  if (cmd === 'help' && rawArgs.length) {
    // handled below after registry is built
  }

  // fli list
  if (cmd === 'list') {
    const registry = buildRegistry()
    const commands = uniqueCommands(registry)

    // --json: machine-readable output
    if (flag.json) {
      process.stdout.write(JSON.stringify(commands, null, 2) + '\n')
      return
    }

    const core    = commands.filter(m => m._source === 'core')
    const project = commands.filter(m => m._source === 'project')

    if (!core.length && !project.length) {
      logger('No commands found.', 'warn')
      logger('Run `fli init` to scaffold cli/src/routes/ in this project.', 'info')
      return
    }

    // Layout constants
    const titleW = 20
    const aliasW = 12

    // Colour helpers
    const dim    = (s) => chalk.dim(s)
    const green  = (s) => chalk.green(s)
    const yellow = (s) => chalk.yellow(s)
    const cyan   = (s) => chalk.cyan(s)
    const bold   = (s) => chalk.bold(s)
    const grey   = (s) => chalk.dim(s)
    const line   = () => process.stdout.write('\n')

    const printRow = (title, alias, desc) => {
      const t = green(title.padEnd(titleW))
      const a = alias ? dim(alias.padEnd(aliasW)) : ' '.repeat(aliasW)
      const d = dim(desc || '')
      process.stdout.write(`  ${t}  ${a}  ${d}\n`)
    }

    const printNsHeader = (ns) => {
      process.stdout.write(`  ${yellow(ns)}\n`)
    }

    const groupByNs = (cmds) => {
      const groups = {}
      for (const m of cmds) {
        const ns = m.title.split(':')[0]
        ;(groups[ns] = groups[ns] || []).push(m)
      }
      return groups
    }

    // Header
    line()
    process.stdout.write(`  ${bold('FLI')}  ${dim('v0.1.0')}  ${dim('·')}  ${dim(commands.length + ' commands')}\n`)
    line()
    process.stdout.write(`  ${dim('Usage:')}  ${cyan('fli')} ${green('<command>')} ${dim('[args] [--flags]')}\n`)
    line()
    process.stdout.write(`  ${dim('─'.repeat(58))}\n`)
    process.stdout.write(`  ${dim('command'.padEnd(titleW))}  ${dim('alias'.padEnd(aliasW))}  ${dim('description')}\n`)
    line()

    // Core commands grouped by namespace
    if (core.length) {
      const groups = groupByNs(core)
      const nsEntries = Object.entries(groups)
      nsEntries.forEach(([ns, cmds], i) => {
        if (i > 0) line()
        printNsHeader(ns)
        for (const m of cmds) printRow(m.title, m.alias || '', m.description || '')
      })
    }

    // Project commands
    if (project.length) {
      line()
      process.stdout.write(`  ${dim('─'.repeat(58))}\n`)
      process.stdout.write(`  ${dim('project')}  ${grey(global.projectRoot)}\n`)
      line()
      const groups = groupByNs(project)
      Object.entries(groups).forEach(([ns, cmds], i) => {
        if (i > 0) line()
        printNsHeader(ns)
        for (const m of cmds) printRow(m.title, m.alias || '', m.description || '')
      })
    }

    // Footer
    line()
    process.stdout.write(`  ${dim('─'.repeat(58))}\n`)
    process.stdout.write(`  ${dim('Run')} ${cyan('fli')} ${green('<command>')} ${dim('--help')} ${dim('for detailed usage')}\n`)
    line()

    return
  }

  // fli ? <query>  or  fli help <command> — handle before entry lookup
  if (cmd === 'help' || cmd === '?') {
    const registry = buildRegistry()
    const target = rawArgs[0] ? registry.get(rawArgs[0]) : null
    if (rawArgs[0] && target) {
      printHelp(target.meta, target.filePath)
      return
    }
    if (rawArgs[0]) {
      // Not an exact command — treat as search query
      const { uniqueCommands } = await import('./registry.js')
      const all = uniqueCommands(registry)
      printSearch(rawArgs[0].toLowerCase(), all)
      return
    }
    // bare `fli help` or `fli ?` — show usage
    process.stdout.write('\n')
    process.stdout.write(chalk.hex('#f5a623')('  fli') + chalk.dim('  ·  frontier cli') + '\n\n')
    process.stdout.write(chalk.dim('  Run ') + chalk.cyan('fli list') + chalk.dim(' to see all commands') + '\n')
    process.stdout.write(chalk.dim('  Run ') + chalk.cyan('fli ? <query>') + chalk.dim(' to search') + '\n')
    process.stdout.write(chalk.dim('  Run ') + chalk.cyan('fli <namespace>') + chalk.dim(' to see a namespace') + '\n\n')
    return
  }

  const registry = buildRegistry()
  const entry    = registry.get(cmd)

  if (!entry) {
    // ── Suggestion engine ────────────────────────────────────────────────────
    // Collect all unique commands and score them against the input.
    // Strategy (in priority order):
    //   1. namespace match     fli github  →  github:create, github:clone
    //   2. partial title       fli cr      →  github:create, gh:create
    //   3. alias substring     fli gc      →  git:commit (alias gc)
    //   4. description keyword fli deploy  →  api:deploy, web:deploy, deploy:all
    const { uniqueCommands } = await import('./registry.js')
    const all = uniqueCommands(registry)
    const q   = cmd.toLowerCase()

    const scored = all.map(m => {
      const title = m.title.toLowerCase()
      const alias = (m.alias || '').toLowerCase()
      const desc  = (m.description || '').toLowerCase()
      const [ns, name = ''] = title.split(':')

      let score = 0
      if (ns === q)                      score = 100  // exact namespace match
      else if (alias === q)              score = 95   // exact alias
      else if (title.startsWith(q + ':')) score = 90  // fli github:c...
      else if (ns.startsWith(q))         score = 85   // namespace prefix: ws→workspace
      else if (alias.startsWith(q))      score = 75   // alias prefix
      else if (title.includes(':' + q))  score = 65   // q is the command name part
      else if (title.includes(q))        score = 55   // partial anywhere in title
      else if (name.includes(q))         score = 45   // name part of title
      else if (alias.includes(q))        score = 35   // alias substring
      else if (desc.split(' ').includes(q)) score = 25 // whole word in description

      return { meta: m, score }
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 6)

    // ── Exact namespace match → show full namespace help ─────────────────────
    const nsMatches = all.filter(m => m.title.split(':')[0] === q)

    if (nsMatches.length) {
      await printNamespace(q, nsMatches, flag.verbose || false)
      return
    }

    // ── Partial match → suggestions ────────────────────────────────────────
    logger(`Command ${chalk.italic(cmd)} not found`, 'error')

    if (scored.length) {
      process.stdout.write('\n')
      process.stdout.write(chalk.dim('  Did you mean?') + '\n\n')
      for (const { meta: m } of scored) {
        const alias = m.alias ? chalk.dim(`  ${m.alias}`) : ''
        const desc  = m.description ? chalk.dim(`  — ${m.description}`) : ''
        process.stdout.write(`  ${chalk.green(m.title)}${alias}${desc}\n`)
      }
      process.stdout.write('\n')
    } else {
      process.stdout.write('\n')
      process.stdout.write(chalk.dim('  Run ') + chalk.cyan('fli list') + chalk.dim(' to see all available commands') + '\n\n')
    }

    return
  }

  // fli <command> --help  or  fli help <command>
  if (flag.help || flag.h || (cmd === 'help' && rawArgs[0])) {
    const target = (cmd === 'help') ? registry.get(rawArgs[0]) : entry
    if (!target) {
      logger(`Command "${rawArgs[0]}" not found`, 'error')
      return
    }
    printHelp(target.meta, target.filePath)
    return
  }

  // Strip internal bootstrap flags before passing to the command.
  // --debug is consumed by bin/fli.js for the clean-error path; stripping it
  // here avoids it bleeding into commands that don't expect a debug flag.
  const { help: _help, h: _h, debug: _debug, ...cmdFlag } = flag
  const command = await Command({ file: entry.filePath, arg: rawArgs, flag: cmdFlag })
  return command()
}
