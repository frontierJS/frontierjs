// core/vector.js — what a vector IS, and the JS half of comparing two.
//
// `FJS-1193` builds `Bytes @vector(n)` (`FJS-D332`) with retrieval as an
// `orderBy` on `findMany` (`FJS-D333`). This file is the part that is the same
// on both engines: how the bytes are laid out, which writes are refused, and
// the distance computed in JavaScript.
//
// ─── Why there are two implementations of one comparison ──────────────────
//
// `FJS-D331`: the extension is an optional accelerator and never the mechanism.
// A server that installed `sqlite-vec` compiles the ordering to
// `vec_distance_cosine`; everything else scores here. That is not a preference —
// SQLite's own wasm build is compiled with `SQLITE_OMIT_LOAD_EXTENSION` (the
// string is in the binary's compile-option list, beside `ENABLE_FTS5`), so the
// browser engine cannot load an extension at any version and the JS path is its
// only answer.
//
// Two implementations of one comparison is the shape `@@allow` already runs
// (`compileSql` against `evalJs`), and that pairing is held together by an
// oracle test rather than by care. The same oracle is the condition on this
// file existing: `test/vector.test.ts` grades `cosineDistance()` against
// `vec_distance_cosine` over the same bytes.
//
// ─── The measurements that shaped it ──────────────────────────────────────
//
// Taken 2026-09-20, 1536 dimensions, and written up in `IDEAS/embedding.md`:
//
//   • the extension is ~2x, not an order of magnitude, and what it buys is not
//     faster arithmetic — it is arithmetic that never materializes the blob
//     into JS.
//   • on the browser engine the read dominates the scoring 5.4-5.9x, so the
//     only real lever there is narrowing the candidate set before the scan.
//   • a prefilter therefore PAYS for itself rather than costing: a quarter of
//     the rows measured 2.3x faster in Chrome and 3-4x on Bun. Every gate and
//     row policy in front of the read is that saving.

// A vector is float32, which is what `sqlite-vec` reads and what every model
// that produces one emits. Four bytes a dimension is the whole layout.
export const BYTES_PER_DIM = 4

// The name the computed distance is stamped under (`FJS-D329`), and the reason
// it is a constant is that three things write it: the SQL path's SELECT alias,
// `scoreByDistance` below, and the parser rule that refuses a model declaring
// both `@vector` and a field of this name. `search()`'s `_rank` is the
// precedent the ruling cites.
export const DISTANCE_FIELD = '_distance'

// ─── what a stored vector looks like ──────────────────────────────────────

/**
 * Read a stored blob back as floats, without copying.
 *
 * `byteOffset` is passed through rather than assumed to be 0: a driver may hand
 * back a view into a larger buffer, and `new Float32Array(bytes.buffer)` then
 * reads the wrong bytes with no error — a silently wrong distance, which is the
 * failure this whole file is careful about.
 */
export function readVector(bytes, dim) {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError(`@vector: expected stored bytes, got ${typeOf(bytes)}`)
  if (bytes.byteLength !== dim * BYTES_PER_DIM)
    throw new RangeError(
      `@vector(${dim}): stored value is ${bytes.byteLength} bytes, expected ${dim * BYTES_PER_DIM}`)
  return new Float32Array(bytes.buffer, bytes.byteOffset, dim)
}

/**
 * Turn a caller's numbers into the bytes a `@vector(dim)` column stores.
 *
 * Refuses three things, and the third is the one that matters — see
 * `refuseUnstorable` for why a zero vector is not a value.
 */
export function toVectorBytes(values, dim, label = '@vector') {
  const floats = values instanceof Float32Array ? values : Float32Array.from(values ?? [])
  refuseUnstorable(floats, dim, label)
  // A fresh buffer: `Float32Array.from` already made one, but a caller passing
  // a Float32Array view into a shared buffer would otherwise have the whole
  // buffer written to the column.
  return new Uint8Array(floats.buffer.byteLength === dim * BYTES_PER_DIM
    ? floats.buffer
    : floats.slice().buffer)
}

// ─── the two guards, which are measured rather than defensive ─────────────
//
// `vec_distance_cosine` answers NULL for a zero vector, because the norm is
// zero and the division has no answer. NULL sorts FIRST under `ORDER BY d ASC`.
// So a single zero vector is the best match for every question anybody ever
// asks, forever, with a 200 and nothing logged — and an all-zeros array is
// exactly what a failed, empty or not-yet-populated `embed()` call returns.
//
// `WHERE e IS NOT NULL` does not catch it: the column holds a perfectly valid
// blob and it is the DISTANCE that is null. The only place the shape can be
// refused is the write, which is why this is here and not in the read path.

export function isZeroVector(floats) {
  for (let i = 0; i < floats.length; i++) if (floats[i] !== 0) return false
  return true
}

export function refuseUnstorable(floats, dim, label = '@vector') {
  if (floats.length !== dim)
    throw new RangeError(
      `${label}(${dim}): got ${floats.length} dimension${floats.length === 1 ? '' : 's'}. ` +
      'The dimension is the column\'s and a vector of another size cannot be compared to it.')

  for (let i = 0; i < floats.length; i++)
    if (!Number.isFinite(floats[i]))
      throw new RangeError(
        `${label}(${dim}): dimension ${i} is ${floats[i]}. ` +
        'A NaN or an Infinity makes every distance involving this row NaN, which sorts unpredictably.')

  if (isZeroVector(floats))
    throw new RangeError(
      `${label}(${dim}): every dimension is zero, which is not an embedding — it is what an empty ` +
      'or failed embed() call returns.\n' +
      '  Stored, its cosine distance is NULL, NULL sorts first, and this row becomes the best match ' +
      'for every query with nothing raised. Refused here because the read cannot see it.')
}

// ─── the distance ─────────────────────────────────────────────────────────

/**
 * Cosine DISTANCE, matching `vec_distance_cosine` exactly.
 *
 * Not a similarity, which the roadmap sketch this replaced had it as: identical
 * vectors answer 0, orthogonal 1, opposite 2. A `threshold` compared the other
 * way round keeps the worst matches and returns rows either way, which is why
 * `FJS-D329` ships the number on the row instead of a cutoff option.
 *
 * Answers `null` for a zero-norm operand rather than 0 or NaN, because that is
 * what the extension answers and the oracle compares the two. Writes are
 * refused above, so a stored null is a bug and not a shape.
 */
export function cosineDistance(a, b) {
  if (a.length !== b.length)
    throw new RangeError(
      `@vector: cannot compare ${a.length} dimensions to ${b.length}`)

  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    dot += x * y
    na  += x * x
    nb  += y * y
  }
  if (na === 0 || nb === 0) return null
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score candidate rows and order them, which is the JS half of
 * `orderBy: { embedding: { near: v } }`.
 *
 * Takes rows the caller's `where` — and therefore the gate, both row policies
 * and the tenant filter — has already narrowed. That ordering is not an
 * optimization: on the browser engine the read is 5.4-5.9x the arithmetic, so
 * the candidate count is the only lever there is.
 *
 * A row whose column is null is DROPPED rather than throwing. The extension
 * throws on a null operand, which means one un-embedded row makes the whole
 * query fail instead of that row losing — so a backfill in progress would 500
 * every read. The compiled SQL carries `IS NOT NULL` for the same reason; this
 * is the same refusal on the path that has no SQL.
 *
 * `take`/`skip` are the caller's `limit`/`offset` and they are applied HERE,
 * after the sort, because that is the only place they can be: the candidate
 * query cannot page a ranking it has not computed. So the scan is the whole
 * filtered set, which is why the record calls the caller's `where` the prune
 * rather than an optimization.
 */
export function scoreByDistance(rows, query, { column, dim, take = Infinity, skip = 0, dir = 'asc', as = DISTANCE_FIELD }) {
  const q = query instanceof Float32Array ? query : Float32Array.from(query ?? [])
  refuseUnstorable(q, dim, 'orderBy.near')

  const scored = []
  for (const row of rows) {
    const bytes = row[column]
    if (bytes === null || bytes === undefined) continue
    const d = cosineDistance(readVector(bytes, dim), q)
    if (d === null) continue
    scored.push({ row, d })
  }
  // Stable, and that is the parity argument rather than a detail: the rows
  // arrive in the order the candidate query sorted them, so a tie here breaks
  // exactly the way the trailing orderBy keys decided — which is what the SQL
  // path's `ORDER BY <distance>, <the rest>` does. An unstable sort would make
  // the two engines disagree on rows at equal distance.
  scored.sort(dir === 'desc' ? (x, y) => y.d - x.d : (x, y) => x.d - y.d)

  const out = []
  const from = Math.max(0, skip)
  for (let i = from; i < scored.length && out.length < take; i++)
    out.push({ ...scored[i].row, [as]: scored[i].d })
  return out
}

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}
