/*
 * search.js — the guide's search: the ranker, and the half of the index
 * that can be derived from data.
 *
 * It is a separate file for the same reason decisions.js is one. guide.js
 * is an ES module that imports glow, so test/run.js cannot inline it and
 * nothing in it can be tested; this file is a classic script declaring
 * plain functions, injected into the suite exactly the way vocabulary.js
 * is. A search box whose ranking nothing checks is a search box that goes
 * subtly wrong and reports nothing.
 *
 * ── The division of labor ────────────────────────────────────────────
 *
 *   here        the ranker, the tokeniser, and the term entries built
 *               from VOCAB
 *   guide.js    harvests page and section entries out of the rendered
 *               pages, and draws the palette
 *
 * Sections are harvested rather than listed for the same reason the page
 * outline is: a hand-kept index of a 51-page guide goes stale on the first
 * heading anyone edits, and it goes stale silently — a missing entry looks
 * like a page that simply has less in it.
 *
 * ── The entry shape ───────────────────────────────────────────────────
 *
 *   { kind, title, sub, page, section?, text, keys? }
 *
 * `kind` is one of term | page | section, and decides both the label on
 * the row and a small ranking bonus. `page` + `section` are what the href
 * is built from, so they are ids, never labels. `keys` are exact-match
 * strings that are not in the title — a term's class name, which is the
 * thing a CSS author actually types.
 */

/* ── Slugs ─────────────────────────────────────────────────────────── */

/*
 * Section ids come from the heading text, so a link to one survives the
 * page being reordered.
 *
 * It lives here, rather than beside tagSections in guide.js, because two
 * things have to agree on it exactly: the id stamped onto a rendered
 * section, and the href a search result points at. Two copies would agree
 * until the day someone allowed a new character in one of them, and then a
 * result would land on the top of the right page with no way to tell why.
 */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* ── Tokens ────────────────────────────────────────────────────────── */

/*
 * `-` is part of a token, not a separator.
 *
 * The things people search a CSS guide for are class names, and
 * `surface-header` split into two words matches every section that
 * mentions a surface and every section that mentions a header — which is
 * most of them. A leading `.` or `#` falls off because the pattern only
 * starts on an alphanumeric, which is what makes typing `.card` work: that
 * is how a CSS author says "the class", not "a sentence about cards".
 */
function searchTokens(q) {
  return String(q == null ? '' : q)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]*/g) || []
}

/* Does `t` start a word in `hay`? Both are already lowercase. */
function searchWordStart(hay, t) {
  let i = hay.indexOf(t)
  while (i > -1) {
    if (i === 0 || !/[a-z0-9]/.test(hay.charAt(i - 1))) return true
    i = hay.indexOf(t, i + 1)
  }
  return false
}

/* ── Ranking ───────────────────────────────────────────────────────── */

/*
 * A term outranks the page named after it. Searching "card" wants the one
 * sentence that says what a Card IS before it wants the page of examples,
 * and the page is the second row either way.
 */
const SEARCH_KIND_BONUS = { term: 12, page: 10, section: 4 }

/*
 * The ladder, and it is steep on purpose: a title hit is worth more than
 * any number of body hits, because a guide's body text repeats its own
 * vocabulary constantly. Ranking body matches near title matches would
 * bury the Cards page under the nine other pages that mention a card.
 */
const SEARCH_WEIGHT = {
  titleExact: 120,
  key: 100,
  titlePrefix: 70,
  titleWord: 50,
  titlePart: 30,
  sub: 14,
  textWord: 10,
  textPart: 5
}

/* Lowercased forms, cached on the entry — rank() is called on every
   keystroke over the whole corpus, and toLowerCase() on ~400 body strings
   per stroke is the one thing here that is actually expensive. */
function searchPrep(e) {
  if (e._lower) return e
  e._lower = {
    title: String(e.title || '').toLowerCase(),
    sub: String(e.sub || '').toLowerCase(),
    text: String(e.text || '').toLowerCase(),
    keys: (e.keys || []).map(function (k) { return String(k).toLowerCase() })
  }
  return e
}

/*
 * How often the token appears, capped.
 *
 * Without it every body match is worth the same, and the tiebreak is then
 * title length — so "dense" answered with a table's Variants section, which
 * says the word once, above the three sections of the Density page that are
 * about nothing else. Bounded at +5 so frequency can nudge an order and
 * never outrank a title.
 */
function searchFrequency(hay, t) {
  let n = 0
  let at = hay.indexOf(t)
  while (at > -1 && n < 6) { n++; at = hay.indexOf(t, at + t.length) }
  return Math.min(5, n - 1)
}

function searchScoreToken(e, t) {
  const L = e._lower
  if (L.title === t) return SEARCH_WEIGHT.titleExact
  if (L.keys.indexOf(t) > -1) return SEARCH_WEIGHT.key
  if (L.title.indexOf(t) === 0) return SEARCH_WEIGHT.titlePrefix
  if (searchWordStart(L.title, t)) return SEARCH_WEIGHT.titleWord
  if (L.title.indexOf(t) > -1) return SEARCH_WEIGHT.titlePart
  if (L.sub.indexOf(t) > -1) return SEARCH_WEIGHT.sub
  if (searchWordStart(L.text, t)) return SEARCH_WEIGHT.textWord + searchFrequency(L.text, t)
  if (L.text.indexOf(t) > -1) return SEARCH_WEIGHT.textPart + searchFrequency(L.text, t)
  return 0
}

/*
 * Every token has to land somewhere, so a second word narrows rather than
 * widens. "card header" must not return everything about cards plus
 * everything about headers — that is the behavior that teaches people to
 * type one word and scroll.
 */
function searchRank(entries, query, limit) {
  const tokens = searchTokens(query)
  if (!tokens.length) return []

  const whole = String(query).toLowerCase().trim()
  const out = []

  for (let i = 0; i < entries.length; i++) {
    const e = searchPrep(entries[i])
    let score = 0
    let missed = false

    for (let j = 0; j < tokens.length; j++) {
      const s = searchScoreToken(e, tokens[j])
      if (!s) { missed = true; break }
      score += s
    }
    if (missed) continue

    score += SEARCH_KIND_BONUS[e.kind] || 0

    /* A multi-word query that appears intact in a title beats the same
       words scattered through it: "section header" is a thing, and the
       page called Section header should not lose to a page whose body
       says "header" in one section and "section" in another. */
    if (tokens.length > 1 && e._lower.title.indexOf(whole) > -1) score += 40

    /* Shorter titles win ties. "Tabs" over "Tabs, panels and the roving
       tabindex" for the query "tabs" — the shorter one is the more
       general answer, and the more general answer is what a one-word
       query asked for. */
    score -= Math.min(10, e._lower.title.length / 8)

    out.push({ entry: e, score: score, tokens: tokens, i: i })
  }

  /* Insertion order is the tiebreak, and it is NAV order — so equal-scoring
     rows come back in the order the sidebar lists them rather than in
     whatever order the corpus happened to be built. */
  out.sort(function (a, b) { return b.score - a.score || a.i - b.i })

  return limit ? out.slice(0, limit) : out
}

/* ── Snippets ──────────────────────────────────────────────────────── */

/*
 * The window around the first hit, with every hit inside it marked.
 *
 * Returns parts — `[{ text, hit }]` — rather than HTML, because the caller
 * is the only thing that knows how to escape. Building `<mark>` here means
 * building a string that must not be escaped later, and a search result is
 * the one place in a guide where the text being searched for is arbitrary
 * user input.
 */
function searchSnippet(text, tokens, width) {
  const src = String(text || '')
  if (!src) return []
  const lower = src.toLowerCase()
  const span = width || 150

  /* Where the first token lands decides the window. */
  let first = -1
  for (let i = 0; i < tokens.length; i++) {
    const at = lower.indexOf(tokens[i])
    if (at > -1 && (first < 0 || at < first)) first = at
  }

  let start = first < 0 ? 0 : Math.max(0, first - Math.floor(span / 3))
  let end = Math.min(src.length, start + span)

  /* Don't start or stop mid-word — a snippet is read, not parsed. */
  if (start > 0) {
    const sp = src.indexOf(' ', start)
    if (sp > -1 && sp - start < 20) start = sp + 1
  }
  if (end < src.length) {
    const sp = src.lastIndexOf(' ', end)
    if (sp > start + span / 2) end = sp
  }

  /* Every occurrence inside the window, merged so two tokens that overlap
     do not produce two nested marks. */
  const ranges = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    let at = lower.indexOf(t, start)
    while (at > -1 && at < end) {
      ranges.push([at, Math.min(end, at + t.length)])
      at = lower.indexOf(t, at + t.length)
    }
  }
  ranges.sort(function (a, b) { return a[0] - b[0] })

  const merged = []
  for (let i = 0; i < ranges.length; i++) {
    const last = merged[merged.length - 1]
    if (last && ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1])
    else merged.push([ranges[i][0], ranges[i][1]])
  }

  const parts = []
  let at = start
  for (let i = 0; i < merged.length; i++) {
    if (merged[i][0] > at) parts.push({ text: src.slice(at, merged[i][0]), hit: false })
    parts.push({ text: src.slice(merged[i][0], merged[i][1]), hit: true })
    at = merged[i][1]
  }
  if (at < end) parts.push({ text: src.slice(at, end), hit: false })

  if (!parts.length) return []
  if (start > 0) parts[0] = { text: '…' + parts[0].text, hit: parts[0].hit }
  if (end < src.length) {
    const tail = parts[parts.length - 1]
    parts[parts.length - 1] = { text: tail.text + '…', hit: tail.hit }
  }
  return parts
}

/* ── The half of the index that is data ────────────────────────────── */

/*
 * One entry per vocabulary term, pointing at its tier's section on the
 * Vocabulary page.
 *
 * The link is built from the tier rather than from a term → page map,
 * because a map is a second list of 54 things that nothing checks: a term
 * renamed in vocabulary.js would keep an href that still resolves, to the
 * wrong place. The tier is already in the row.
 *
 * The class name matters more than the title does — `btn` is what a CSS
 * author types, and it is nowhere in the word "Button". Which class a row
 * names is vocabulary.js's own rule, so `vocabClass` is asked for it
 * rather than the two-branch check being written out a third time.
 */
function searchVocabEntries(vocab) {
  const out = []
  const tiers = vocab || (typeof VOCAB !== 'undefined' ? VOCAB : [])

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i][0]
    const rows = tiers[i][2]

    for (let j = 0; j < rows.length; j++) {
      const row = rows[j]
      const term = row[0]
      const el = row[1]
      const meaning = row[2]
      const cls = vocabClass(row)

      out.push({
        kind: 'term',
        title: term,
        sub: tier + ' · ' + el,
        page: 'vocabulary',
        section: slugify(tier),
        text: meaning,
        keys: cls ? [cls] : []
      })
    }
  }

  return out
}
