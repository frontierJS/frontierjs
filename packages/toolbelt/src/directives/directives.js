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
 * The read direction only. Junction's browser client writes `$` names on the
 * way out (`buildQueryString` / `buildWsQuery`) from a typed QueryDirectives,
 * field by field rather than by table lookup; its own suite asserts that every
 * name it emits is one this table strips, which is the property that matters.
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
  { param: '$select',        name: 'select',        read: asIs    },
  { param: '$populate',      name: 'populate',      read: asIs    },
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
    for (const k in params) {
      if (!RESERVED_PARAMS.has(k)) query[k] = params[k]
    }
  }
  return { query, directives: parseDirectives(params) }
}
