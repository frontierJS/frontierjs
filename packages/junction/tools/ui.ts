// tools/ui.ts
// Shared terminal UI for the Junction CLI tools (init, setup, repl).
//
// One ANSI palette, one set of line-style helpers, one readline prompter.
// Spacing conventions differ slightly between tools (indent widths,
// separator lengths), so helpers that vary are parameterised and callers
// pass what they need — the rendered bytes stay identical to the old
// per-tool copies.

import * as readline from 'node:readline'

// ─── ANSI palette ─────────────────────────────────────────────────────────

export const c = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  red:      '\x1b[31m',
  cyan:     '\x1b[36m',
  gray:     '\x1b[90m',
  bred:     '\x1b[91m',
  bgreen:   '\x1b[92m',
  byellow:  '\x1b[93m',
  bblue:    '\x1b[94m',
  bmagenta: '\x1b[95m',
  bcyan:    '\x1b[96m',
  bwhite:   '\x1b[97m',
}

export const paint = (col: string, t: string) => `${col}${t}${c.reset}`

// ─── Line styles ──────────────────────────────────────────────────────────
// Two-space indent baked in, matching the tools' output conventions.

export const ok     = (t: string) => `  ${paint(c.bgreen,  '✓')} ${t}`
export const warn   = (t: string) => `  ${paint(c.byellow, '⚠')} ${paint(c.bwhite, t)}`
export const fail   = (t: string) => `  ${paint(c.bred,    '✗')} ${paint(c.bwhite, t)}`
export const note   = (t: string) => `  ${paint(c.bcyan,   '→')} ${paint(c.gray, t)}`
export const header = (t: string) => paint(c.bold + c.bwhite, t)
export const dim    = (t: string) => paint(c.dim + c.gray, t)
export const sep    = (width = 54) => paint(c.gray, `  ${'─'.repeat(width)}`)

// ─── Readline prompting ───────────────────────────────────────────────────

export interface Prompter {
  rl:      readline.Interface
  ask:     (q: string, def?: string) => Promise<string>
  confirm: (q: string, def?: boolean) => Promise<boolean>
  select:  <T extends string>(
    question: string,
    options:  { value: T; label: string; desc?: string }[],
    def?:     number,
  ) => Promise<T>
  multiSelect: (
    question: string,
    options:  { value: string; label: string; desc?: string }[],
  ) => Promise<string[]>
}

export function createPrompter(): Prompter {
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  })

  const ask = (q: string, def = ''): Promise<string> =>
    new Promise(res => {
      const hint = def ? ` ${paint(c.gray, `[${def}]`)}` : ''
      rl.question(`  ${paint(c.bcyan, '?')} ${q}${hint} `, ans => {
        res(ans.trim() || def)
      })
    })

  const confirm = async (q: string, def = false): Promise<boolean> => {
    const label = def ? '[Y/n]' : '[y/N]'
    const ans   = await ask(`${q} ${paint(c.gray, label)}`)
    const t = ans.trim().toLowerCase()
    return t === '' ? def : t === 'y'
  }

  // Single-select from a numbered list
  async function select<T extends string>(
    question: string,
    options:  { value: T; label: string; desc?: string }[],
    def = 0
  ): Promise<T> {
    console.log()
    console.log(`  ${paint(c.bcyan, '?')} ${question}`)
    console.log()
    options.forEach((o, i) => {
      const marker = i === def ? paint(c.bgreen, '◉') : paint(c.gray, '○')
      const label  = i === def ? paint(c.bwhite, o.label) : paint(c.gray, o.label)
      const desc   = o.desc ? `  ${dim(o.desc)}` : ''
      console.log(`    ${marker}  ${i + 1}. ${label}${desc}`)
    })
    console.log()

    while (true) {
      const raw = await ask(`Enter number (default ${def + 1})`, String(def + 1))
      const n   = parseInt(raw, 10) - 1
      if (n >= 0 && n < options.length) return options[n].value
      console.log(`  ${paint(c.byellow, 'Please enter a number between 1 and ' + options.length)}`)
    }
  }

  // Multi-select with spacebar-style toggling (enter numbers separated by spaces)
  async function multiSelect(
    question: string,
    options:  { value: string; label: string; desc?: string }[]
  ): Promise<string[]> {
    console.log()
    console.log(`  ${paint(c.bcyan, '?')} ${question}`)
    console.log(dim('    Enter numbers separated by spaces, or press enter to skip all'))
    console.log()
    options.forEach((o, i) => {
      const desc = o.desc ? `  ${dim(o.desc)}` : ''
      console.log(`    ${paint(c.gray, String(i + 1) + '.')} ${paint(c.bwhite, o.label)}${desc}`)
    })
    console.log()

    const raw  = await ask('Your choices (e.g. 1 3)', '')
    if (!raw) return []
    return raw
      .split(/[\s,]+/)
      .map(s => parseInt(s, 10) - 1)
      .filter(n => n >= 0 && n < options.length)
      .map(n => options[n].value)
  }

  return { rl, ask, confirm, select, multiSelect }
}
