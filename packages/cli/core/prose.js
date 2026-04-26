// ─── prose.js — terminal markdown renderer ───────────────────────────────────
// Renders the prose section of a .md command file to the terminal.
// Supports: ## headings, - lists, ```code blocks```, **bold**, `inline code`,
// and {{var}} interpolation from context.vars + arg + flag.
// ─────────────────────────────────────────────────────────────────────────────

import { chalk } from 'zx'
import { readFileSync } from 'fs'

// Extract prose from a raw .md file — strip frontmatter, script, js block
export function extractProse(raw) {
  return raw
    .replace(/^---[\s\S]*?---\s*/, '')          // strip frontmatter
    .replace(/<script[\s\S]*?<\/script>/g, '')   // strip script block
    .replace(/```js[\s\S]*?```/g, '')            // strip js block
    .replace(/```[\s\S]*?```/g, (m) => m)        // keep other code blocks
    .trim()
}

// Interpolate {{key}} tokens from a vars object
function interpolate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key]
    return val !== undefined ? chalk.green(String(val)) : chalk.dim(`{{${key}}}`)
  })
}

// Inline formatting: **bold**, `code`
function inlineFormat(text, vars) {
  text = interpolate(text, vars)
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
  text = text.replace(/`([^`]+)`/g, (_, t) => chalk.hex('#f5a623')(t))
  return text
}

// Render a full prose string to the terminal
export function renderProse(prose, vars = {}) {
  const lines  = prose.split('\n')
  let   inCode = false
  let   codeBuf = []
  const out = []

  for (const raw of lines) {
    // Code block fence
    if (raw.startsWith('```')) {
      if (inCode) {
        // End of block — print buffered code
        for (const cl of codeBuf) {
          out.push('  ' + chalk.dim(interpolate(cl, vars)))
        }
        codeBuf = []
        inCode  = false
      } else {
        inCode = true
      }
      continue
    }
    if (inCode) { codeBuf.push(raw); continue }

    // ## Heading
    if (raw.startsWith('## ')) {
      const title = raw.slice(3).trim()
      out.push('')
      out.push(chalk.cyan(title))
      out.push(chalk.dim('─'.repeat(Math.min(title.length + 2, 50))))
      continue
    }

    // - List item
    if (/^[-*] /.test(raw)) {
      const item = raw.slice(2).trim()
      out.push('  ' + chalk.dim('·') + ' ' + inlineFormat(item, vars))
      continue
    }

    // Blank line
    if (!raw.trim()) {
      out.push('')
      continue
    }

    // Plain paragraph
    out.push(inlineFormat(raw, vars))
  }

  // Print with a leading blank line for breathing room
  process.stdout.write('\n')
  for (const line of out) process.stdout.write(line + '\n')
  process.stdout.write('\n')
}

// Read prose from a file path and render it
export function printPlanFromFile(filePath, vars = {}) {
  const raw   = readFileSync(filePath, 'utf8')
  const prose = extractProse(raw)
  if (prose) renderProse(prose, vars)
}
