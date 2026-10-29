/*
 * qr.d.ts — the kit's types, hand-written; this package is plain JS.
 * Basecamp's api is TypeScript and reads the SVG string.
 */

/** Rows of booleans, true where a module is dark; no quiet zone. */
export function qrMatrix(text: string): boolean[][]

/** The code as an SVG string, black on a painted white field, two modules of quiet zone. */
export function qrSvg(text: string): string

/** The code in half-block characters with ANSI colors, black on white whatever the terminal's theme. */
export function qrTerminal(text: string): string
