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
 * are not a dictionary and cannot become one — some ambiguities are structural,
 * not omissions: `bases` is `basis` here and never `base`. Anything a schema
 * needs that these cannot reach is said by hand: `@@map` in the Data realm,
 * `createResource('people', { model: 'Person' })` in the UI.
 *
 * This kit never takes a locale. What it inflects is structural — a table name,
 * an accessor, a service path — so a Spanish caller still reads `db.person`
 * from `model Person`, and teaching these rules a second language renames tables
 * in every schema that already has one. Pluralising a MESSAGE for a reader is a
 * different problem with different rules (CLDR plural categories, one/few/many/
 * other) and belongs in whatever answers it, never here.
 */

/*
 * THESE ARE ENGLISH PLURAL FORMS, NOT PROSE. A spelling sweep must not touch
 * them: `analyses` is the plural of `analysis` on both sides of the Atlantic,
 * and a find/replace of `analyse` → `analyze` once rewrote it to `analyzes`
 * here AND in the test that guards it, in one commit, leaving nothing to fail.
 *
 * Both directions of one table. Written out rather than derived, because the
 * reverse of a rule is not a rule — `data` → `datum` cannot be computed from
 * `datum` → `data` without knowing which words play.
 */
export const IRREGULAR = {
  person: 'people',   child: 'children', man: 'men',       woman: 'women',
  tooth: 'teeth',     foot: 'feet',      mouse: 'mice',    goose: 'geese',
  ox: 'oxen',         quiz: 'quizzes',
  index: 'indices',   matrix: 'matrices', vertex: 'vertices',
  analysis: 'analyses', basis: 'bases',  crisis: 'crises',
  datum: 'data',      medium: 'media',   criterion: 'criteria',

  /* The `-f`/`-fe` stems. A closed list for SES_BARE_S's reason: `leaf` is
     `leaves` and `roof` is `roofs`, and no ending tells them apart. Only the
     whole word is matched, so `BookShelf` is still `bookshelfs` — pluralize
     never reaches inside a compound, or `audit_index` would rename a table. */
  leaf: 'leaves',     life: 'lives',     knife: 'knives',  wife: 'wives',
  half: 'halves',     calf: 'calves',    loaf: 'loaves',   thief: 'thieves',
  shelf: 'shelves',   self: 'selves',    wolf: 'wolves',   elf: 'elves',
  sheaf: 'sheaves',   scarf: 'scarves',
}

/*
 * Singulars that already end in a bare `s` and take `-es`. A LIST rather than a
 * rule, and it has to be: `statuses` → `status` and `cases` → `case` differ by
 * whether the stem before `es` is itself a word, which no ending can see —
 * `status` and `cas` both end in a vowel + `s`. The list is the closed half of
 * that pair; everything else is `-se` and there are thousands of those.
 */
const SES_BARE_S = new Set([
  'status', 'bus', 'gas', 'lens', 'plus', 'bias', 'atlas', 'canvas', 'iris',
  'virus', 'campus', 'alias', 'census', 'focus', 'bonus', 'corpus', 'sinus',
  'apparatus', 'surplus', 'census', 'chassis', 'axis',
])

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

/*
 * A caller's word is usually a COMPOUND — `account_aliases` is a table name,
 * `salesPeople` an accessor, `UserStatuses` a model. English inflects the head
 * noun and leaves the modifier alone, and the two lookups below key on a whole
 * word, so every compound missed both: `user_aliases` fell past the `-ses` list
 * to `user_aliase`, and `sales_people` matched no irregular and came back
 * unchanged. The suffix rules only ever look at the end of the word, which IS
 * the head, so routing a compound through its head is at least as good
 * everywhere and is the only thing that reaches the tables.
 */
function headOf(word) {
  const underscore = word.lastIndexOf('_')
  if (underscore > 0 && underscore < word.length - 1)
    return [word.slice(0, underscore + 1), word.slice(underscore + 1)]

  const hump = word.search(/[a-z0-9][A-Z][a-z]*$/)
  if (hump > 0) return [word.slice(0, hump + 1), word.slice(hump + 1)]

  return ['', word]
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

  const [prefix, head] = headOf(word)
  if (prefix) return prefix + rules(head)

  return rules(word)
}

/*
 * The suffix rules alone, with no irregular table. A compound is inflected on
 * its head by these and NEVER by the table, which is the asymmetry the round
 * trip needs: `pluralize` must not reach inside a compound, because turning
 * `audit_index` into `audit_indices` renames a table in every schema that
 * already has one — so `AuditIndex` is `audit_indexes`, and reading that back
 * has to answer `AuditIndex` rather than `audit_indice`.
 *
 * Whole-word rules missing a compound is what broke it: `UserStatus` is
 * `user_statuses` and read back was `user_statuse`, `UserAlias` was
 * `user_aliase`. Junction derives a model name from a service name with this,
 * and a service that resolves to no model has no @@gate and no validation, so
 * a broken round trip fails OPEN.
 */
function rules(word) {
  if (/ies$/i.test(word))                     return word.slice(0, -3) + 'y'

  /* `-ses` is the one ending where stripping `es` and stripping `s` are both
     ordinary English, and they disagree on words an application actually names:
     `statuses` is `status` but `purchases` is `purchase`. Stripping `es` for
     both was the wrong way round — a singular ending in a bare `s` is a closed
     list (`status`, `bus`, `lens`) and a singular ending in `-se` is most of
     the language (`case`, `release`, `license`, `expense`, `response`,
     `database`, `warehouse`, `phase`, `lease`, `clause`, `course`, `house`).
     So: strip one `s` by default, and strip `es` for the `-ss` stems and for
     the list.

     The stakes are why this is a rule and not a preference: junction derives a
     model name from a service name with this function, and a service that
     resolves to no model has NO @@gate and NO validation — it fails open. */
  if (/ses$/i.test(word)) {
    const stem = word.slice(0, -2)
    if (/ss$/i.test(stem)) return stem                          // classes → class
    if (SES_BARE_S.has(stem.toLowerCase())) return stem          // statuses → status
    return word.slice(0, -1)                                     // cases → case
  }

  if (/(?:xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word) && !/(?:ss|us|is|as)$/i.test(word)) return word.slice(0, -1)
  return word
}
