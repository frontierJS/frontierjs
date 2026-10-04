// @frontierjs/toolbelt/cells — one cell of text, read as a column's type or a reason it cannot be.

export type CellKind = 'string' | 'int' | 'float' | 'scaled' | 'boolean' | 'datetime' | 'enum' | 'json'

/** The value, or why there is none. A reason never quotes the cell. */
export type CellResult = { value: unknown; reason?: undefined } | { reason: string; value?: undefined }

export function parseCell(
  text: string,
  kind: CellKind,
  opts?: { scale?: number; values?: readonly string[] },
): CellResult
