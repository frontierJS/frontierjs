/*
 * template.js — what a `@generated` backtick template produces from a row.
 *
 * `{name}` is a column and everything else is literal text, and a NULL column
 * takes the separator beside it rather than leaving a hole. Litestone compiles
 * the template into SQL for the generated column; a screen answers it here for
 * a draft that has not been written yet (`FJS-D1112`). `templateShape` is what
 * both read, so the server's string and the preview cannot be shaped two ways.
 *
 * Two shapes, because SQLite has an exact answer for the common one:
 *
 *   uniform  every gap between fields is the same text and nothing sits
 *            outside them — SQL's `concat_ws(sep, …)`, which drops a NULL
 *            argument and the separator that would have followed it
 *   pairs    mixed or outer literals: each field carries the text in front of
 *            it, the pair vanishes together, and the whole is trimmed of
 *            spaces, because a leading literal has no field to go with
 */

/**
 * @param {string} tpl the text between the backticks
 * @returns {{ kind: 'uniform', sep: string, fields: string[] }
 *         | { kind: 'pairs', parts: { lit: string, field: string|null }[] }}
 */
export function templateShape(tpl) {
  const segs = []
  const re   = /\{([^}]*)\}/g
  let last = 0, m
  while ((m = re.exec(tpl)) !== null) {
    if (m.index > last) segs.push({ lit: tpl.slice(last, m.index) })
    const name = m[1]
    if (!/^\w+$/.test(name))
      throw new Error(`'{${name}}' is not a field name — a template reference is {fieldName}, and everything outside the braces is literal text`)
    segs.push({ field: name })
    last = re.lastIndex
  }
  if (last < tpl.length) segs.push({ lit: tpl.slice(last) })

  const fields = segs.filter(s => s.field).map(s => s.field)
  if (!fields.length)
    throw new Error(`the template \`${tpl}\` names no field, so it is a constant — a column that is the same for every row belongs in @default`)

  const outerLit = !segs[0].field || !segs[segs.length - 1].field
  const gaps     = segs.filter(s => s.lit !== undefined).map(s => s.lit)
  if (!outerLit && gaps.length === fields.length - 1 && new Set(gaps).size <= 1)
    return { kind: 'uniform', sep: gaps[0] ?? ' ', fields }

  const parts = []
  let pending = ''
  for (const seg of segs) {
    if (seg.lit !== undefined) { pending += seg.lit; continue }
    parts.push({ lit: pending, field: seg.field })
    pending = ''
  }
  if (pending) parts.push({ lit: pending, field: null })
  return { kind: 'pairs', parts }
}

// SQLite's text of a stored value: a boolean is stored as 1 or 0. A REAL that
// is whole prints as `3.0` there and `3` here, which a draft cannot tell apart.
const text = (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
const read = (record, name) => (record && Object.hasOwn(record, name) ? record[name] ?? null : null)

/**
 * The string the generated column will hold for this record.
 *
 * @param {string} tpl
 * @param {object} record
 * @returns {string}
 */
export function formatTemplate(tpl, record) {
  const shape = templateShape(tpl)
  if (shape.kind === 'uniform')
    return shape.fields.map(f => read(record, f)).filter(v => v !== null).map(text).join(shape.sep)
  let out = ''
  for (const { lit, field } of shape.parts) {
    if (field === null) { out += lit; continue }
    const v = read(record, field)
    if (v !== null) out += lit + text(v)
  }
  // SQLite's trim() takes spaces and nothing else.
  return out.replace(/^ +| +$/g, '')
}
