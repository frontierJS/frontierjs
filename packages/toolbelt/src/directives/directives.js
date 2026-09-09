/*
 * directives.js — the `$` convention, one definition.
 *
 * FrontierJS carries two different kinds of thing in one bag of parameters: the
 * FILTERS (`status=active` — columns, values, a WHERE) and the DIRECTIVES
 * (`$limit=20` — how much, in what order, which fields). The `$` is what tells
 * them apart, and it is transport syntax: nothing past the boundary that reads
 * it should ever see one (repo Invariant 10).
 *
 * There are two boundaries that read it, not one, which is why this is here
 * rather than in either of them:
 *
 *   Junction's bridge   — an HTTP query string / a WS frame → ctx.query + ctx.directives
 *   Sierra's router     — a URL's search string             → page.query + page.directives
 *
 * Same grammar, same table, two realms. `/inflect` is in this package for the
 * identical reason, and it is worth repeating the lesson: five copies of the
 * inflection rules answered one invariant and disagreed. A directive this table
 * does not name lands in the WHERE clause as a column nobody declared — which
 * the Data boundary reports as a filter typo, three layers from the cause.
 *
 * BOTH directions, off one table. `parseDirectives` reads and `directiveParams`
 * writes, because a URL is round-tripped rather than only consumed: Junction's
 * client sends one and Sierra's router hands one back to a page that has to
 * write the next. Junction's client held its own field-by-field copy of the
 * write half and named itself the one table in its own comment, which is the
 * shape `FJS-306` is about — a directive added to a list somebody has to
 * remember is a directive half wired.
 */

/*
 * How a value arrives. Over HTTP everything is a string; a caller that has
 * already coerced (a URL parser, an internal call) passes numbers and booleans.
 * Every reader takes both, and answers `undefined` for *not asked* — an absent
 * key must stay absent, since a caller merging these over its own values
 * depends on the difference between "no opinion" and "the default".
 */
const truthy = (v) => v === true || v === 'true' || v === '1'

const asNumber = (v) => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// A shape this module deliberately does not fix: `-createdAt`, `{name:'asc'}`
// and `[{…}]` are all legal orderBys, and only the query builder can say which.
const asIs = (v) => v

const asText = (v) => (typeof v === 'string' && v !== '' ? v : undefined)

const asBool = (v) => (v === undefined ? undefined : truthy(v))

/*
 * The write direction, for the two rows that do not travel as themselves. A
 * list of field names is a comma-joined string on the wire, where the parser
 * takes `$select` as-is — so writing the array would put `[object Object]` or a
 * JSON string where a reader expects names.
 */
const asCsv = (v) => (Array.isArray(v) ? v.join(',') : v)

/*
 * The directives proper — each has a structured form on the other side, and
 * this is the ONE place the pairing is written down.
 *
 * A Data-realm feature that grows a per-call option (`@@softDelete`,
 * `@@hasTemplates`) is invisible to every wire until it is named here; before
 * this was a table the wire name, the parse and the reserved-key set were three
 * hand-written lists, and `@@hasTemplates` had all three empty — an app
 * declaring it had a template screen it could not build over HTTP (FJS-306).
 * A new directive is one row.
 */
const DIRECTIVES = Object.freeze([
  { param: '$limit',         name: 'limit',         read: asNumber },
  { param: '$offset',        name: 'offset',        read: asNumber },
  // The window's far edge, opaque. A cursor is minted by the server and handed
  // back verbatim — `asText` and never `asNumber`, because the token is base64
  // and a numeric-looking one must not be read as a number (`FJS-D145`).
  { param: '$after',         name: 'after',         read: asText  },
  { param: '$orderBy',       name: 'orderBy',       read: asIs    },
  { param: '$select',        name: 'select',        read: asIs,   write: asCsv },
  { param: '$populate',      name: 'populate',      read: asIs,   write: asCsv },
  { param: '$search',        name: 'search',        read: asText  },
  { param: '$withDeleted',   name: 'withDeleted',   read: asBool  },
  { param: '$onlyDeleted',   name: 'onlyDeleted',   read: asBool  },
  { param: '$withTemplates', name: 'withTemplates', read: asBool  },
  { param: '$onlyTemplates', name: 'onlyTemplates', read: asBool  },
].map(Object.freeze))

/** Every `$` name that has a structured form. Derived — never restated. */
export const DIRECTIVE_PARAMS = Object.freeze(DIRECTIVES.map((d) => d.param))

/*
 * Transport-only, with no structured form: they change how the answer is
 * shaped, not what is asked. They are stripped from the filters exactly like a
 * directive, and that is the whole of their handling here.
 */
export const TRANSPORT_PARAMS = Object.freeze(['$first', '$wrap'])

/** Every `$` key the wire understands. Neither kind is a filter. */
export const RESERVED_PARAMS = new Set([...DIRECTIVE_PARAMS, ...TRANSPORT_PARAMS])

/**
 * The `$` keys this table does not know, in the order they arrived.
 *
 * The kit REPORTS and the boundary REFUSES, because this package is a pure
 * function below the dependency graph (`FJS-D26`) and a refusal is a decision
 * about a request. It is here rather than at either boundary so the list a
 * refusal names is derived from the same table `splitParams` strips by — a
 * second list would go stale the moment a directive is added, which is the
 * failure the table itself was built to end (`FJS-306`).
 *
 * `$` alone is included: it is not a name this table holds, and a caller who
 * wrote it meant something.
 *
 * @param {Record<string, unknown>} params
 * @returns {string[]}
 */
export function unknownDirectives(params) {
  if (!params || typeof params !== 'object') return []
  return Object.keys(params).filter((k) => k.startsWith('$') && !RESERVED_PARAMS.has(k))
}

/**
 * The `$` keys of a parameter bag → the structured directives.
 *
 * Absent keys stay absent — an empty object means *nothing was asked*, which is
 * not the same as asking for the defaults.
 *
 * @param {Record<string, unknown>} params
 * @returns {{ limit?: number, offset?: number, after?: string, orderBy?: unknown, select?: unknown,
 *             populate?: unknown, search?: string,
 *             withDeleted?: boolean, onlyDeleted?: boolean,
 *             withTemplates?: boolean, onlyTemplates?: boolean }}
 */
export function parseDirectives(params) {
  const d = {}
  if (!params || typeof params !== 'object') return d

  for (const { param, name, read } of DIRECTIVES) {
    const value = read(params[param])
    if (value !== undefined) d[name] = value
  }

  return d
}

/**
 * The structured directives → the `$` keys that carry them.
 *
 * `parseDirectives`' inverse, off the same table, which is the whole reason it
 * is here. Junction's browser client held a hand-written copy of this list and
 * called itself the one table in its own comment; sierra needs the same inverse
 * to hand a URL's directives to a component that speaks `$` (Invariant 10 makes
 * the `$` form the transport vocabulary, so anything ROUND-TRIPPING a URL needs
 * both directions). A second list goes stale on the next directive, which is
 * the failure this table was built to end (`FJS-306`).
 *
 * Values keep their own types — `encodeQueryString` and the transport's parser
 * are inverses by construction (`FJS-D125`), so a structure travels AS a
 * structure and a JSON string here would be read back as text (`FJS-962`). The
 * two rows that do NOT travel as themselves say so in the table.
 *
 * Absent stays absent, for `parseDirectives`' reason: an empty object means
 * nothing was asked, which is not asking for the defaults.
 *
 * @param {object | null | undefined} directives
 * @returns {Record<string, unknown>}
 */
export function directiveParams(directives) {
  const p = {}
  if (!directives || typeof directives !== 'object') return p

  for (const { param, name, write } of DIRECTIVES) {
    const value = directives[name]
    if (value === undefined || value === null) continue
    p[param] = write ? write(value) : value
  }

  return p
}

/**
 * One bag of parameters → the two things it was carrying.
 *
 * `query` is the filters, with every `$` key removed — a directive left in it
 * is a WHERE clause on a column that does not exist. `directives` is the
 * structured form. Neither half ever contains a `$`.
 *
 * @param {Record<string, unknown>} params
 * @returns {{ query: Record<string, unknown>, directives: object }}
 */
export function splitParams(params) {
  const query = {}
  if (params && typeof params === 'object') {
    // Own keys, and defined rather than assigned. A WS frame's query bag is
    // `JSON.parse`d, so `__proto__` arrives as an OWN key — `query[k] = v`
    // reaches Object.prototype's setter, which drops the filter and replaces
    // the bag's prototype, leaving an object that `Object.keys` and a spread
    // see one way and a property read sees another. `for...in` compounds it by
    // enumerating what a previous pass put there (`FJS-996`).
    for (const k of Object.keys(params)) {
      // Two conditions, and the prefix is the one that holds the invariant.
      // Asking only whether the name is a KNOWN directive let every other `$`
      // key through — `$nope`, `$$limit`, a misspelled `$limitt` — each landing
      // in the filters as a WHERE on a column that cannot exist, which is the
      // consequence this function's own contract names (FJS-988). The
      // recognized names were removed correctly, so nothing failed.
      if (k.startsWith('$') || RESERVED_PARAMS.has(k)) continue
      Object.defineProperty(query, k, { value: params[k], writable: true, enumerable: true, configurable: true })
    }
  }
  return { query, directives: parseDirectives(params) }
}
