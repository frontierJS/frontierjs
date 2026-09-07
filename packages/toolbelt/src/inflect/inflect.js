/*
 * inflect.js — how a NAME is spelled, one definition per axis.
 *
 * Three axes. NUMBER is `post` ⇄ `posts`; SHAPE is `product_variants` ⇄
 * `ProductVariant` ⇄ `productVariant`; READER is `postal_code` → `Postal
 * Code`. They are one kit because they are one question: every caller crossing
 * between a table, a model, a service path and a screen asks more than one of
 * them in the same expression, and the sites that asked them separately got
 * the number from here and the shape from a hand copy (see § shape).
 *
 * The first two are structural and the third is not, which is the one thing to
 * know before editing: what NUMBER and SHAPE answer must not change when a
 * reader changes, and what READER answers must. § Reader states the single
 * rule that differs and why it may not be lifted upward.
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
 *
 * That locale rule is the NUMBER and SHAPE axes' and not the READER axis's:
 * `humanize` splits an identifier by the code's own spelling conventions and
 * translates nothing, so it takes no locale either, but for a different reason
 * — see § Reader.
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

/*
 * Words whose singular and plural are the SAME word. Not a rule and not
 * derivable: nothing in `series` distinguishes it from `movies`, and every
 * ending-based guess gets one of the two wrong. Both directions must return the
 * word untouched, or the pair stops round-tripping — `series` singularised to
 * `sery` is what made a correctly-named `model MetricSeries` fail invariant 2's
 * check, and the check was right to ask.
 *
 * Only whole words match, for IRREGULAR's reason: reaching inside a compound
 * would rename a table.
 */
const INVARIANT = new Set([
  'series', 'species', 'news', 'means', 'sheep', 'deer', 'fish', 'aircraft',
  'offspring', 'salmon', 'trout', 'bison', 'moose', 'swine',
  'information', 'equipment', 'software', 'furniture', 'luggage',
])

/*
 * Singulars that end in `-ie` and pluralise to `-ies`, where the `-y` rule
 * below would otherwise invent a word.
 *
 * A LIST rather than a rule, for SES_BARE_S's reason: `movies` and `bodies` are
 * identical in shape, and no ending separates `movie` from `body`. The wrong
 * answers round-trip — `pluralize('movy') === 'movies'` — so the pair stays
 * self-consistent and every symmetry test passes while both halves name a word
 * that does not exist (`FJS-959`).
 *
 * The stakes are the `-ses` comment's, one ending along: junction derives a
 * model name from a service name with this function, and a service that
 * resolves to no model has NO @@gate and NO validation. `cookie` is the entry
 * that makes this concrete rather than pedantic — a web framework naming a
 * `model Cookie` with a `cookies` service is the ordinary case, and it resolved
 * to `Cooky`.
 *
 * Only whole words match, as IRREGULAR does: reaching inside a compound would
 * rename a table, and `OrderCookies` is handled by `headOf` splitting first.
 */
const IE_SINGULAR = new Set([
  // The short ones, where the plural is genuinely `-ies`.
  'pie', 'tie', 'lie', 'die', 'vie',
  // The ones an application plausibly names.
  'cookie', 'movie', 'genie', 'calorie', 'prairie', 'sortie', 'collie', 'magpie',
  'necktie', 'bowtie', 'freebie', 'rookie', 'zombie', 'brownie', 'newbie',
  'selfie', 'birdie', 'pixie', 'hoodie', 'bogie', 'auntie', 'cutie', 'foodie',
  'goalie', 'junkie', 'kiddie', 'veggie', 'yuppie', 'beanie', 'boogie', 'cowrie',
  'lassie', 'hippie', 'meanie', 'oldie', 'pinkie', 'quickie', 'smoothie',
  'softie', 'sweetie', 'techie', 'toughie', 'townie', 'walkie', 'weenie', 'wheelie',
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
  if (INVARIANT.has(lower)) return word
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
  if (INVARIANT.has(lower)) return word
  if (lower in SINGULAR_OF) return matchCase(word, SINGULAR_OF[lower])

  const [prefix, head] = headOf(word)
  if (prefix) return INVARIANT.has(head.toLowerCase()) ? word : prefix + rules(head)

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
  if (/ies$/i.test(word)) {
    // Strip one `s` and ask the list, exactly as `-ses` does below: `movies`
    // gives `movie`, which is a word; `bodies` gives `bodie`, which is not, and
    // falls through to the `-y` rule that is right for it.
    const ie = word.slice(0, -1)
    if (IE_SINGULAR.has(ie.toLowerCase())) return ie
    return word.slice(0, -3) + 'y'
  }

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

// ─── shape ────────────────────────────────────────────────────────────────────
//
// The other axis of the same question. Number is `post` ⇄ `posts`; shape is
// `product_variants` ⇄ `ProductVariant` ⇄ `productVariant` ⇄ `product-variant`.
//
// Six hand copies of `pascal` answered this with FOUR different splitters —
// `split('_')` in two of litestone's importers, `split(/[_\s]+/)` in `eject`,
// `replace(/[^A-Za-z0-9]+/g, ' ')` in the frappe reader, `split(/[-_]/)` in the
// cli's checks. Four of them spelled `pascal(singularize(t))`, which is
// Invariant 2's model name, so `order-item` was `OrderItem` to the rule that
// GRADES model names and `Order-item` to two of the readers that PRODUCE them —
// and `Order-item` is not an identifier. Every one of those sites already
// imported `singularize` from here: half the derivation was a shared kit and
// the other half of the same expression was hand-rolled six times, four ways.
//
// `modelName` is exported for that reason. Exporting `pascal` alone leaves the
// composition restated at each call site, one import deeper than before.

/**
 * The words of an identifier, in order, with their own capitals intact.
 *
 * `product_variants` · `product-variants` · `productVariants` → the same two
 * words. A run of capitals stays one word — `orderID` is `order` + `ID` and
 * `HTTPStatus` is `HTTP` + `Status` — because splitting on every capital gives
 * letters nobody wrote.
 *
 * **A digit does NOT start a new word here**, which is the deliberate
 * difference from `humanize` at the foot of this file: a person reads `line1`
 * as `Line 1`, and an identifier means `line1`. Splitting it would make
 * `kebab('address1')` into `address-1`, renaming a column.
 *
 * Only `_`, `-` and whitespace separate. Anything else is left inside the word,
 * so a qualified name like `partman.template_x` comes back visibly wrong rather
 * than as a plausible `PartmanTemplateX` the caller would go on to use as a
 * model name.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function words(name) {
  if (typeof name !== 'string' || !name) return []
  return name
    .replace(/[_\-\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
}

const upperFirst = (w) => w.charAt(0).toUpperCase() + w.slice(1)

/**
 * `product_variants` → `ProductVariants`. A word's own tail is left alone, so
 * `SKU` stays `SKU` where lodash's `camelCase`-then-`upperFirst` gives `Sku`.
 *
 * @param {string} name
 * @returns {string}
 */
export function pascal(name) {
  return words(name).map(upperFirst).join('')
}

/**
 * `product_variants` → `productVariants`.
 *
 * A leading initialism is lowered WHOLE — `HTTPStatus` is `httpStatus` and a
 * column named `SKU` is `sku`. Lowering only the first character is what the
 * copies did and it produced `hTTPStatus`.
 *
 * @param {string} name
 * @returns {string}
 */
export function camel(name) {
  const parts = words(name)
  if (!parts.length) return ''
  const [head, ...tail] = parts
  const lead = /^[A-Z0-9]+$/.test(head) ? head.toLowerCase() : head.charAt(0).toLowerCase() + head.slice(1)
  return lead + tail.map(upperFirst).join('')
}

/**
 * `ProductVariant` → `product-variant`.
 *
 * @param {string} name
 * @returns {string}
 */
export function kebab(name) {
  return words(name).map(w => w.toLowerCase()).join('-')
}

/**
 * `ProductVariant` → `product_variant`.
 *
 * @param {string} name
 * @returns {string}
 */
export function snake(name) {
  return words(name).map(w => w.toLowerCase()).join('_')
}

/**
 * The model a name plainly MEANS — Invariant 2's derivation, named once.
 *
 * `product_variants` · `product-variants` · `productVariants` → `ProductVariant`.
 *
 * Singular first, then shape: `singularize` reads a compound's head, and the
 * head of `product_variants` is the word that has to lose its `s`.
 *
 * @param {string} name  a table, a service path or an accessor
 * @returns {string}
 */
export function modelName(name) {
  return pascal(singularize(name))
}

/**
 * A name safe to put in a URL or a filename.
 *
 * One rule and one stated exception: **every run of non-alphanumerics becomes
 * one separator, except an apostrophe, which is deleted**. Five copies of this
 * had two separators between them and two different answers for punctuation —
 * `v1.2` was `v12` to the `@slug` transform and `v1-2` everywhere else.
 *
 * The apostrophe is not an arbitrary entry on a list: it sits INSIDE a word
 * where every other mark sits between two, so `It's a C++ thing` is
 * `its-a-c-thing` and separating it gives `it-s`, which is a word that is not
 * there. Rails' `parameterize` writes `it-s`; Django and WordPress write `its`.
 *
 * Accents are folded rather than dropped: `Café` is `cafe`, not `caf`. Dropping
 * the letter loses it silently, and this runs over names a person typed.
 *
 * `max` truncates and then re-trims, which is why it is here rather than a
 * `.slice()` at the call site — a cut lands mid-word as often as not, and
 * `strategy-and-` is a slug with a trailing separator nobody meant to store.
 *
 * @param {string} value
 * @param {{ sep?: string, max?: number }} [opts]  `sep` defaults to `-`; a
 *   filename segment wants `_`.
 * @returns {string}
 */
export function slug(value, { sep = '-', max } = {}) {
  let out = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(sep)

  if (max != null && out.length > max) {
    out = out.slice(0, max)
    // `sep` is caller-supplied, so an empty one would make `endsWith` always
    // true and this loop never end.
    if (sep) while (out.endsWith(sep)) out = out.slice(0, -sep.length)
  }
  return out
}

/* ── Reader ────────────────────────────────────────────────────────── */

// The third axis, and the only one that answers to somebody else. NUMBER and
// SHAPE above are structural — a table, an accessor, a service path — and what
// they answer must not change when the reader changes. This one is text FOR a
// reader: `@frontierjs/ui` labels a control whose field declared no `@label`,
// and `@frontierjs/sierra` falls back to it when a stored value has no row to
// read a label from (`FJS-D225`).
//
// It is in this kit rather than beside it because the question is the same one
// — how is this name spelled — and a caller crossing from a column to a screen
// asks both halves in one expression. Two subpaths did not remove the
// divergence between them, they put it in two headers that argued with each
// other across a folder boundary (`FJS-D236`).
//
// No locale. Splitting an identifier is about the identifier's own spelling
// conventions, which are the code's rather than the reader's; translating the
// words it produces is a different job and belongs wherever an app answers it.

/**
 * `firstName` → `First Name` · `postal_code` → `Postal Code` · `sku` → `Sku`
 *
 * `words()` plus EXACTLY ONE added rule — a digit starts a word of its own, so
 * `line1` reads `Line 1`. That rule is the whole difference between the two
 * halves of this kit and it does not generalize: applying it above turns
 * `kebab('address1')` into `address-1`, renaming a column. The spec asserts
 * both answers in one row, so unifying them reds it.
 *
 * A run of capitals is left whole by `words()` — `SKU` stays `SKU`, `orderID`
 * is `Order ID` — and the title-casing below must not touch that tail.
 *
 * Anything that is not a string comes back as an empty string: this is a label,
 * and `[object Object]` on a screen is worse than nothing there.
 *
 * @param {string} value
 * @returns {string}
 */
export function humanize(value) {
  if (typeof value !== 'string') return ''
  return words(value.replace(/([a-zA-Z])(\d)/g, '$1 $2'))
    // An initialism is already correct and upper-casing its tail would break it.
    .map(w => (/^[A-Z0-9]+$/.test(w) ? w : upperFirst(w)))
    .join(' ')
}
