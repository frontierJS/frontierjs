// ─── color.js — the ANSI subset the startup path uses ────────────────────────
// A leaf with no dependencies, and that is the entire point: it exists so that
// `fli list`, `fli help`, `?` and completion do not import zx.
//
// zx is ~85ms of a ~200ms invocation and the only thing the read-only paths
// wanted from it was `chalk`. A command body still gets the real one — a
// compiled shim imports `zx/globals` itself — so nothing a command author
// writes changes.
//
// API-compatible with the chalk calls this package makes (`chalk.dim(s)`,
// `chalk.hex('#f5a623')(s)`), so a call site reads the same after the swap.
// Chained styles (`chalk.bold.underline`) are NOT supported; nothing here uses
// them and supporting them costs the proxy this file exists to avoid.

// Match chalk's default rather than picking our own: colour when stdout is a
// terminal, honouring NO_COLOR and FORCE_COLOR. A drive that pipes fli's output
// and greps it would otherwise start seeing escape codes it never saw before.
const enabled =
  !process.env.NO_COLOR &&
  (Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout?.isTTY))

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

export const colorEnabled = enabled
