// ─── color.js — the one chalk ─────────────────────────────────────────────────
// A leaf with no dependencies, read on the startup path before a command is
// compiled, and handed to every command body as `chalk` on `$`. One color
// rule for fli's own output and a command's.
//
// The shape is chalk's for the calls this package makes (`chalk.dim(s)`,
// `chalk.hex('#f5a623')(s)`). Chained styles (`chalk.bold.cyan`) are NOT
// supported — nest them, `chalk.bold(chalk.cyan(s))` — because supporting
// them costs a proxy, and a chain reads as undefined at the call rather than
// throwing where it is written.

// Match chalk's default rather than picking our own: color when stdout is a
// terminal, honouring NO_COLOR and FORCE_COLOR. A drive that pipes fli's output
// and greps it would otherwise start seeing escape codes it never saw before.
// `FORCE_COLOR=0` is OFF, as chalk reads it — a truthiness test turned it on,
// and CI sets exactly that. An empty one is unset.
const force   = process.env.FORCE_COLOR
const enabled =
  !process.env.NO_COLOR &&
  (!force ? Boolean(process.stdout?.isTTY) : force !== '0' && force !== 'false')

const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

export const chalk = {
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

  // Truecolor. Callers pass a hex string and get a function back, which is
  // chalk's shape: chalk.hex('#f5a623')('text').
  hex: (value) => {
    const h = value.replace('#', '')
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    return (s) => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s))
  },
}

// fli's own color — its name in the banner, and `code` in help prose.
export const amber = chalk.hex('#f5a623')

export const colorEnabled = enabled
