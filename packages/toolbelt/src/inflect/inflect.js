/*
 * inflect.js — English singular ⇄ plural, one definition.
 *
 * FrontierJS names one thing three ways — `model Post` in the schema, `posts`
 * for the service and the URL, `db.post` for the accessor — and Invariant 2
 * holds only while every resolver agrees about how to cross between them. Five
 * copies of these rules used to answer that question and they did not agree:
 * the two in litestone knew twenty irregulars, junction's knew none but had the
 * guards that stop `status` becoming `statu`, and sierra's was `endsWith('s')`.
 * A model named `Status` therefore resolved in three places and singularised to
 * `statuse` in the fourth, where the miss is silent — a warning and a resource
 * with no schema.
 *
 * The rules here are ENGLISH'S REGULAR ONES plus a fixed irregular table. They
 * are not a dictionary and cannot become one — the ambiguities are structural,
 * not omissions: `bases` is `basis` here and never `base`, `houses`
 * singularises to `hous`, and `lens` to `len`, because `pens` is a real plural
 * with the same ending. Anything a schema needs that these cannot reach is
 * said by hand: `@@map` in the Data realm, `createResource('people', { model:
 * 'Person' })` in the UI.
 *
 * This kit never takes a locale. What it inflects is structural — a table name,
 * an accessor, a service path — so a Spanish caller still reads `db.person`
 * from `model Person`, and teaching these rules a second language renames tables
 * in every schema that already has one. Pluralising a MESSAGE for a reader is a
 * different problem with different rules (CLDR plural categories, one/few/many/
 * other) and belongs in whatever answers it, never here.
 */

/*
 * Both directions of one table. Written out rather than derived, because the
 * reverse of a rule is not a rule — `data` → `datum` cannot be computed from
 * `datum` → `data` without knowing which words play.
 */
const IRREGULAR = {
  person: 'people',   child: 'children', man: 'men',       woman: 'women',
  tooth: 'teeth',     foot: 'feet',      mouse: 'mice',    goose: 'geese',
  ox: 'oxen',         leaf: 'leaves',    life: 'lives',    knife: 'knives',
  index: 'indices',   matrix: 'matrices', vertex: 'vertices',
  analysis: 'analyses', basis: 'bases',  crisis: 'crises',
  datum: 'data',      medium: 'media',   criterion: 'criteria',
}

const SINGULAR_OF = Object.fromEntries(
  Object.entries(IRREGULAR).map(([one, many]) => [many, one])
)

/*
 * The table is lowercase and the callers are not: litestone inflects a
 * snake_case table name, sierra a camelCase accessor, and a model name arrives
 * PascalCase. Only the first character can be restored without guessing, which
 * is all any caller here needs.
 */
function matchCase(sample, word) {
  return sample[0] === sample[0].toUpperCase() && sample[0] !== sample[0].toLowerCase()
    ? word.charAt(0).toUpperCase() + word.slice(1)
    : word
}

/**
 * The plural of an English word.
 *
 * @param {string} word
 * @returns {string}
 */
export function pluralize(word) {
  if (typeof word !== 'string' || !word) return word

  /* The irregular table is consulted FIRST. It used to come last, behind the
     sibilant rule, so seven of its own entries were unreachable — `index` was
     caught by `x$` and pluralised to `indexes`, `analysis` and `crisis` by
     `s$`, and the table said otherwise in vain. */
  const lower = word.toLowerCase()
  if (lower in IRREGULAR) return matchCase(word, IRREGULAR[lower])

  if (/[^aeiou]y$/i.test(word))     return word.slice(0, -1) + 'ies'  // category → categories
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word + 'es'              // bus → buses, box → boxes
  return word + 's'
}

/**
 * The singular of an English word. A word that is already singular comes back
 * unchanged wherever the rules can tell — which is what the `us`/`is`/`as`
 * guards are for: without them `status` singularises to `statu` and the model
 * it names is never found.
 *
 * @param {string} word
 * @returns {string}
 */
export function singularize(word) {
  if (typeof word !== 'string' || !word) return word

  const lower = word.toLowerCase()
  if (lower in SINGULAR_OF) return matchCase(word, SINGULAR_OF[lower])

  if (/ies$/i.test(word))                     return word.slice(0, -3) + 'y'
  if (/(?:ses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word) && !/(?:ss|us|is|as)$/i.test(word)) return word.slice(0, -1)
  return word
}
