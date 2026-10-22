// src/lib/study/plan.js — `/go` and `/next`, the workbench's Go and Next in a
// study tab (`FJS-D966`–`FJS-D969`): a plan's first open box as the line the
// tab sends. Go sends it into the tab, Next into a fresh tab with the plan's
// path and the last reply handed over, refused while a `Q` is unruled.
//
// The plan is read and the prompt written by the checkout's own `fli`
// (`packages/cli/core/plan.js`, `ask-claude.js`), imported off the path, so
// the study says what the workbench says and Haven takes no dependency on
// the CLI. A study outside a checkout has no `fli`, and refuses.
//
// Terminal only, like `session.js`.
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const core = (cwd, file) => join(cwd, 'packages', 'cli', 'core', file)

/**
 * The line `/go` (or `/next`, with `next` true) sends for the plan at `path`
 * under `cwd`: `{ step, title, prompt }`, or `{ refused }` saying why not.
 * `lastResult` is the reply Next hands over.
 */
export async function planLine(cwd, path, { next = false, lastResult = '' } = {}) {
  if (!existsSync(core(cwd, 'plan.js'))) return { refused: `no fli in ${cwd} — /go reads a plan with the checkout's own` }
  const file = resolve(cwd, path)
  if (!existsSync(file)) return { refused: `no plan at ${path}` }
  const rel = relative(cwd, file)
  const [{ parsePlan, phaseOf }, { stepPrompt, nextHandoff }] = await Promise.all([
    import(pathToFileURL(core(cwd, 'plan.js')).href),
    import(pathToFileURL(core(cwd, 'ask-claude.js')).href),
  ])
  const plan = parsePlan(readFileSync(file, 'utf8'), { file: rel })
  if (!plan.phases.length) return { refused: `${rel} holds no \`### Phase N\` heading — not a plan` }
  const step = plan.next
  if (!step) return { refused: `every step of ${rel} is done` }
  const phase = phaseOf(plan, step)
  if (!next) return { step: step.id, title: step.title, prompt: stepPrompt({ path: rel, step, phase }) }
  const open = plan.blocking
  if (open.length) return { refused: `${rel} has ${open.length === 1 ? 'an open question' : `${open.length} open questions`} — rule ${open.length === 1 ? 'it' : 'them'} before /next: ${open[0].question}` }
  return { step: step.id, title: step.title, prompt: nextHandoff({ path: rel, step, phase, lastResult }) }
}
