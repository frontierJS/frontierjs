/**
 * three-way.js — which columns two writers actually contend over.
 *
 * `@@sync(field)`'s whole mechanism (`FJS-D334`). A held write arrives carrying
 * the row as the device READ it; the row as it stands now is read here; the
 * patch is what the device wants to say. Three versions of one row, compared a
 * column at a time, which is the only comparison that can tell *we both edited
 * this row* from *we both edited this column*.
 *
 * ── Why a revision alone cannot do this ──────────────────────────────────────
 *
 * `@version` is a counter. It says the row moved and can never say which
 * columns moved, so `@@sync(refuse)` can only refuse the whole write — correct,
 * and it throws away the information that two people editing different columns
 * are not in conflict at all.
 *
 * ── The four outcomes ────────────────────────────────────────────────────────
 *
 *   unchanged   the patch names the column and its value equals the base: the
 *               writer did not touch it, whatever the form submitted. Dropped,
 *               so a full-row patch cannot clobber a column nobody edited
 *   taken       the writer changed it and nobody else did. Applied
 *   agreed      both changed it and to the same value. Dropped — there is
 *               nothing to decide and nothing to overwrite
 *   conflicted  both changed it and to different values. The only case a person
 *               has to answer, and the only one that reaches the caller
 *
 * `unchanged` is what makes this safe against the way forms actually submit.
 * Sierra sends the fields the form holds rather than the fields somebody typed
 * in, so without it every save would claim every column and a merge would be a
 * last-write-wins with extra steps.
 *
 * ── The base is INPUT and never authority ────────────────────────────────────
 *
 * It arrives from the device and is not read back from anywhere. A forged or
 * stale base can only make the sender's own write look unconflicted, which is
 * what `@@sync(server)` does for every column already; the gate, the row
 * policies and the constraints all run afterwards regardless.
 */

/**
 * Do two stored values mean the same thing?
 *
 * Raw column values, as the engine hands them back — so numbers, strings, null
 * and the odd `Uint8Array`. `Json` columns arrive as TEXT and compare as text,
 * which is exact rather than semantic: two objects written with their keys in a
 * different order read as a conflict, and that is the honest answer here, since
 * nothing at this layer knows the column holds an object rather than a string.
 */
function sameValue(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

/**
 * Compare a patch against the row it was made against and the row as it stands.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} opts.base    the row as the writer read it
 * @param {Record<string, unknown>} opts.local   the patch — only the keys it names are candidates
 * @param {Record<string, unknown>} opts.remote  the row as it stands now
 * @returns {{ apply: Record<string, unknown>, conflicts: Array<{ column: string, base: unknown, local: unknown, remote: unknown }>, outcomes: Record<string, 'unchanged'|'taken'|'agreed'|'conflicted'> }}
 */
export function threeWay({ base, local, remote }) {
  const apply     = {}
  const conflicts = []
  const outcomes  = {}
  for (const column of Object.keys(local ?? {})) {
    const want = local[column]
    const was  = base?.[column]
    const now  = remote?.[column]
    // A column the base does not mention cannot be compared, so it is taken at
    // face value — a device sending a partial base narrows what this can
    // decide and never what it can overwrite.
    const localChanged  = !(base && column in base) || !sameValue(want, was)
    if (!localChanged) { outcomes[column] = 'unchanged'; continue }
    const remoteChanged = !sameValue(now, was)
    if (!remoteChanged)          { outcomes[column] = 'taken';  apply[column] = want; continue }
    if (sameValue(want, now))    { outcomes[column] = 'agreed'; continue }
    outcomes[column] = 'conflicted'
    conflicts.push({ column, base: was, local: want, remote: now })
  }
  return { apply, conflicts, outcomes }
}
