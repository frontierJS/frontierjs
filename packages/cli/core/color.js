// ─── color.js — the one chalk ─────────────────────────────────────────────────
// A leaf with no dependencies, read on the startup path before a command is
// compiled, and handed to every command body as `chalk` on `$`. One color
// rule for fli's own output and a command's.
//
// The shape is chalk's for the calls this package makes (`chalk.dim(s)`,
// `chalk.hex('#f5a623')(s)`), plus chalk-template's tag for a line that mixes
// styles: chalk`{bold.cyan ${port}} {dim ·} ${what}`. Chained styles as
// properties (`chalk.bold.cyan`) are NOT supported — use the tag, or nest —
// because supporting them costs a proxy, and a chain reads as undefined at
// the call rather than throwing where it is written.

// Match chalk's default rather than picking our own: color when stdout is a
// terminal, honouring NO_COLOR and FORCE_COLOR. A drive that pipes fli's output
// and greps it would otherwise start seeing escape codes it never saw before.
// `FORCE_COLOR=0` is OFF, as chalk reads it — a truthiness test turned it on,
// and CI sets exactly that. An empty one is unset.
const force   = process.env.FORCE_COLOR
const enabled =
  !process.env.NO_COLOR &&
  (!force ? Boolean(process.stdout?.isTTY) : force !== '0' && force !== 'false')

// An inner style's close turns the outer one off too when they share a close
// code — dim and bold both end at 22, every color at 39 — so `dim(… bold(x) …)`
// went undimmed after the x. Reopening the outer style after each inner close
// is chalk's own fix.
const paint = (open, close, s) => {
  const end = `\x1b[${close}m`
  return `\x1b[${open}m${String(s).replaceAll(end, end + `\x1b[${open}m`)}${end}`
}

const wrap = (open, close) => (s) => (enabled ? paint(open, close, s) : String(s))

const styles = {
  red:     wrap(31, 39),
  green:   wrap(32, 39),
  yellow:  wrap(33, 39),
  blue:    wrap(34, 39),
  magenta: wrap(35, 39),
  cyan:    wrap(36, 39),
  white:   wrap(37, 39),
  gray:    wrap(90, 39),
  bold:    wrap(1, 22),
  dim:     wrap(2, 22),
  italic:  wrap(3, 23),
  underline: wrap(4, 24),
}

// Only the literal parts of the template are read as markup. An interpolated
// value is never parsed, so a command line holding a brace prints as itself.
// A `{` opens a style only when a known name and a space follow it, so prose
// braces need no escape; an unclosed one throws, because it is a typo at the
// call and would otherwise style the rest of the line.
const OPEN = /\{([a-z]+(?:\.[a-z]+)*) /y

const template = (strings, ...values) => {
  const stack = [{ names: [], text: '' }]
  strings.forEach((lit, i) => {
    for (let j = 0; j < lit.length; j++) {
      if (lit[j] === '{') {
        OPEN.lastIndex = j
        const m = OPEN.exec(lit)
        const names = m?.[1].split('.')
        if (names?.every(n => Object.hasOwn(styles, n))) {
          stack.push({ names, text: '' })
          j += m[0].length - 1
          continue
        }
      } else if (lit[j] === '}' && stack.length > 1) {
        const { names, text } = stack.pop()
        stack.at(-1).text += names.reduceRight((s, n) => styles[n](s), text)
        continue
      }
      stack.at(-1).text += lit[j]
    }
    if (i < values.length) stack.at(-1).text += String(values[i])
  })
  if (stack.length > 1) throw new Error(`chalk template: {${stack.at(-1).names.join('.')} is never closed`)
  return stack[0].text
}

export const chalk = Object.assign(template, styles, {
  // Truecolor. Callers pass a hex string and get a function back, which is
  // chalk's shape: chalk.hex('#f5a623')('text').
  hex: (value) => {
    const h = value.replace('#', '')
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    return (s) => (enabled ? paint(`38;2;${r};${g};${b}`, 39, s) : String(s))
  },
  // An OSC 8 hyperlink — the text stays what is printed, the url is where a
  // click goes. Off wherever color is, so a pipe never sees the escape.
  link: (text, url) => (enabled ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : String(text)),
  // A click on `file:line`. VS Code's terminal opens a file:// link at line 1,
  // and its own scheme is the one that lands on the line.
  fileLink: (text, path, line) => chalk.link(text, process.env.TERM_PROGRAM === 'vscode'
    ? `vscode://file${path}${line ? `:${line}` : ''}`
    : `file://${path}`),
})

// fli's own color — its name in the banner, and `code` in help prose.
export const amber = chalk.hex('#f5a623')

export const colorEnabled = enabled
