/*
 * glow.js — source code to highlighted HTML.
 *
 * A pure function: `glow(source, opts)` returns a string and touches nothing
 * else, which is what lets it live in @frontierjs/toolbelt and be imported from
 * any package in the tree.
 *
 * ── Why there are no CSS classes in the output ────────────────────────
 *
 * A token is marked with the HTML element that already means it — <em> for a
 * string, <sup> for a comment, <b> for an identifier — so the whole theme is
 * `code[language] em { … }` and a consumer needs no class contract to style
 * it. @frontierjs/css ships that theme in components/code.css.
 *
 * The wrapper carries the language as an attribute (`<code language="css">`)
 * so a theme can key off it without the caller adding anything.
 *
 * ── The line-prefix trap ──────────────────────────────────────────────
 *
 * With `prefix` on, a line starting `+`, `-` or `>` is a diff/callout marker
 * and the marker character is REMOVED from the output. In CSS all three are
 * also legal first characters — `--custom-prop`, `> .child`, `+ .sibling` —
 * so highlighting a stylesheet with prefixes on silently eats one character
 * per line. `--` is disambiguated below because two dashes are never a diff
 * marker; the combinators are not, so a CSS caller wants `prefix: false`.
 */

const MIXED_HTML = ['html', 'jsx', 'php', 'astro', 'dhtml', 'vue', 'svelte', 'hb', 'mesa']
const LINE_COMMENT = { clojure: ';;', lua: '--', python: '#', sql: '--' }
const PREFIXES = { '+': 'ins', '-': 'del', '>': 'dfn' }
const MARK = /(••?)([^•]+)\1/g // ALT + q
const NL = '\n'

const COMMON_WORDS =
  'null|true|false|undefined|import|from|async|await|package|begin\
|interface|class|new|int|func|function|get|set|export|default|const|var|let\
|return|yield|for|while|defer|if|then|else|elif|fi|int|string|number|def|public|static|void\
|continue|break|switch|case|final|finally|try|catch|while|super|long|float\
|throw|fun|val|use|fn|my|end|local|until|next|bool|ns|defn|puts|require|each'

// Implement most~50% of words to cover 95% of cases
const SPECIAL_WORDS = {
  cpp: 'cout|cin|using|namespace',
  python: 'None|nonlocal|lambda',
  go: 'chan|fallthrough',
  /* Litestone's seed language. The declaration keywords are all it needs
     beyond the common set — a field line is `name Type @attr`, which the
     type rule and the attribute rule below already cover. */
  lite: 'model|extend|valueset|tenancy|database|generator|strategy|column|claim|resolve|source|scope|where',
  /* Nothing in the common list is SQL, so a statement came out as one long
     unlit line with its string literals coloured — the shape of DDL is its
     keywords, and they were the only part not marked. Uppercase by
     convention, matched case-insensitively like every other language here. */
  sql: 'select|insert|into|values|update|set|delete|create|alter|drop|table|view|index|unique|primary|foreign|key|references|autoincrement|constraint|check|integer|text|real|blob|numeric|boolean|timestamp|from|where|join|left|inner|outer|on|group|order|by|having|limit|offset|distinct|as|and|or|not|in|is|exists|case|when|then|else|end|asc|desc|with|union|all'
}

/*
 * A shell line is a command and its arguments. It has no keywords, and the
 * common word list is full of things that are ordinary argument text —
 * `my`, `use`, `end`, `local`, `next`, `get`, `set` — so `cd my-app` came out
 * with `my` coloured as a keyword and the rest of the directory name plain.
 * getTags withholds the keyword pass from these languages; what is left is
 * the command itself, which is the token a reader is actually looking for.
 */
const SHELL = [
  // the command, after a prompt, a pipe or a &&
  { tag: 'strong', re: /(?:^|[|&;]\s*)\$?\s*([a-z][\w.\/-]*)/g, shift: true },

  // a flag
  { tag: 'label', re: /(?:^|\s)(-{1,2}[\w][\w-]*)/g, shift: true },

  /* A hyphenated word is one word. Without this the punctuation rule cuts
     `my-app` in three and the argument stops reading as a name. */
  { tag: 'b', re: /\b[a-z][\w.]*(?:-[\w.]+)+/gi }
]

// special rules (growing list)
const RULES = {
  css: [
    { tag: 'strong', re: /#[0-9a-f]{3,7}/gi },
    { tag: 'label', re: /!important/gi },
    { tag: 'em', re: /--[\w\d\-]+/gi }
  ],

  /* `true`, `false` and `null` are the only bare words JSON has, and getTags
     below withholds the COMMON_WORDS keyword pass from this language — rightly,
     since everything else in a document is a string, a number or punctuation.
     Without a rule of their own the three literals were the only values in a
     highlighted document with no colour, so a `null` and a key spelled "null"
     rendered identically (FJS-405). Inside a string they are safe by position
     rather than by order: the string token starts at the quote, which is
     earlier, and renderRow drops a token that opens inside one already
     emitted. */
  json: [
    { tag: 'b', re: /(".+"):/gi },
    { tag: 'strong', re: /\b(?:true|false|null)\b/g }
  ],
  yaml: [{ tag: 'b', re: /([\w ]+):/gi }],

  /* A `.lite` field line is `name Type @attr(arg)`, and two of those three
     have no rule that reaches them.

     A model-level attribute is written with TWO ats, and the generic
     `\B@[\w\-]+` below can only take one — it matched at the second `@`,
     so every `@@gate` in a schema rendered as a stray punctuation mark
     followed by an attribute. Both forms are one rule here.

     The type is capitalised and the common keyword pass is case-insensitive,
     so `Int`, `String` and `Float` were already coloured as keywords while
     `DateTime`, `Boolean`, `Json` and a `model`'s own name were not — the
     column that says what a field IS, half-lit down the page. Matched by
     shape rather than by a list, so a relation to another model gets the
     same treatment as a scalar and a new scalar type needs no edit here. */
  lite: [
    { tag: 'label', re: /@@?[\w\-]+/g },
    { tag: 'strong', re: /\b[A-Z]\w*/g }
  ],

  sh: SHELL,
  bash: SHELL,
  shell: SHELL
}

const HTML_TAGS = [
  // line comment
  { tag: 'sup', re: /# .+/ },

  { tag: 'label', re: /\[([a-z\-]+)/g, lang: ['md', 'toml'], shift: true },

  // string value (keep second on the list)
  { tag: 'em', re: /'[^']*'|"[^"]*"/g, is_string: true },

  // HTML tag name
  { tag: 'strong', re: /<([\w\-]+ )/g, shift: true, lang: MIXED_HTML },
  { tag: 'strong', re: /<\/?([\w\-]+)>/g, shift: true, lang: MIXED_HTML },

  // ALL CAPS (constants)
  // { tag: 'b', re: /\b[A-Z]{2,}\b/g },

  // @special
  { tag: 'label', re: /\B@[\w\-]+/gi },

  // char
  { tag: 'i', re: /[^\w •]/g },

  // variable name
  { tag: 'b', re: /\b([a-z][\w\-]+)\s*[:=\(!\[]/gi },

  // property name
  { tag: 'b', re: /"\w+":/g },

  // function name
  { tag: 'b', re: /([\w]+)\(/gi },

  // numeric value
  { tag: 'em', re: /\b\d+\.?[%\w\b]*/g },

  // variable name
  { tag: 'b', re: /([\w]+)\./g, lang: ['js'] }
]

/*
 * `language` may be a LIST, and the first entry is the primary one — it is
 * what the `<code language>` attribute carries, and what decides the block
 * comment syntax and whether this is markdown.
 *
 * A transcript is why. A command and the SQL it compiled to, a request and
 * its JSON response, a query beside the WHERE clause a policy appended to it
 * — these are the samples worth showing, and they are two languages in one
 * block. Given one, half the sample loses its comments and its keywords:
 * under `js` a `--` comment is two punctuation marks, and under `sql` a `//`
 * comment is not a comment at all.
 */
function asLangs(lang) {
  return (Array.isArray(lang) ? lang : [lang]).filter(Boolean)
}

const primaryLang = (lang) => asLangs(lang)[0]

/* Languages whose vocabulary the common keyword pass does not describe:
   two data formats, a markup language, and the shell. */
const NO_KEYWORDS = ['yaml', 'html', 'json', 'sh', 'bash', 'shell']

function getTags(lang) {
  const langs = asLangs(lang)
  const tags = HTML_TAGS.filter((el) => !el.lang || langs.some((l) => el.lang.includes(l)))

  // custom keywords
  if (!langs.every((l) => NO_KEYWORDS.includes(l))) {
    const w = langs.map((l) => SPECIAL_WORDS[l]).filter(Boolean).join('|')
    const words = (w ? w + '|' : '') + COMMON_WORDS
    const re = new RegExp(`\\b(${words})\\b`, 'gi')
    tags.splice(4, 0, { tag: 'strong', re })
  }

  // custom rules
  const rules = langs.flatMap((l) => RULES[l] ?? [])
  if (rules.length) tags.unshift(...rules)

  return tags
}

/* `&` first, or the ampersand of an escape written by this function is escaped
   again. A source line holding the literal text `&lt;` must come back as
   `&lt;`, not as `<`. */
function encode(str) {
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// wrap token
function elem(name, str) {
  if (str == '<') str = '&lt;'
  else if (str == '>') str = '&gt;'
  else if (str == '&') str = '&amp;'
  return `<${name}>${str}</${name}>`
}

/*
  Markdown/MDX requires a special treatment, because it's so
  different from others (not a programming language)
*/
function isMD(lang) {
  return ['md', 'mdx', 'nuemark'].includes(lang)
}

function getMDTags(str) {
  const s = str.trim()
  const c = s[0]

  // divider
  if (s.startsWith('---')) return [{ tag: 'i', re: /-+/ }]

  // line comment
  if (s.startsWith('// ')) return [{ tag: 'sup', re: /.+/ }]

  if (['![', '[!'].includes(s.slice(0, 2))) return [{ tag: 'em', re: /.+/ }]

  if (['import', 'export'].includes(s.slice(0, 6))) return getTags('js')

  // HTML
  if (c == '<') return getTags('html')

  // heading
  if (c == '#') return [{ tag: 'label', re: /.+/ }]

  // quote
  if (c == '>') {
    return [
      { tag: 'i', re: />/ },
      { tag: 'sup', re: / .+/ }
    ]
  }

  // front matter / yaml
  if (/^\w+: /.exec(s)) return getTags('yaml')

  // component
  if (c == '[' && s.endsWith(']')) {
    return s[1] == '.' ? [{ tag: 'label', re: /\w+/g }] : getTags('md')
  }

  // lists, links, images, fenced code
  return [
    // inline code
    { tag: 'strong', re: /\`.+\`/g },

    // image
    { tag: 'em', re: /^(!.+)/g, shift: true },

    // list
    { tag: 'b', re: /[\*\_\[\]\(\)<>]+/g }
  ]
}

export function parseRow(row, lang) {
  const tags = isMD(primaryLang(lang)) ? getMDTags(row) : getTags(lang)
  const tokens = []

  /* Line comments, one syntax per language in the list. A language with no
     entry gets `//`, so `['js', 'sql']` recognises both spellings and a
     transcript keeps its commentary on either side of the seam. */
  for (const mark of new Set(asLangs(lang).map((l) => LINE_COMMENT[l] || '//')))
    tags.unshift({ tag: 'sup', re: new RegExp(`${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .+`) })

  /* A block comment that opens and closes on one line, after code.
     parseSyntax leaves these to be highlighted rather than swallowing the
     line, so the comment needs a token of its own — without it the words
     inside get tokenised as code. Markdown has neither syntax. */
  if (!isMD(lang)) tags.unshift(...INLINE_COMMENT_TAGS)

  for (const el of tags) {
    const { re, shift } = el

    row.replace(re, function (match, start, n) {
      if (arguments.length == 4) {
        const more = shift ? match.indexOf(start) : 0
        match = start
        start = n + more
      }
      const end = start + match.length
      tokens.push({ start, end, ...el })
    })
  }
  return tokens.sort((a, b) => a.start - b.start)
}

function renderString(str) {
  return encode(str).replace(/\$?\{([^\}]+)\}/g, function (_, content) {
    return elem('i', _.replace(content, elem('b', content)))
  })
}

// exported for testing purposes
export function renderRow(row, lang, mark = true) {
  if (!row) return ''

  const els = parseRow(row, lang)
  const ret = []
  let index = 0

  for (var i = 0, max = 0, len = els.length, el, next; (el = els[i]); i++) {
    const { start, end } = el
    next = els[i + 1] || []

    // skip overlappings
    if (start < max) continue
    if (start == next[0] && next[1] > end) continue
    if (end > max) max = end
    else continue

    /* The text BETWEEN two tokens is a raw slice of the source as much as a
       token is. It only looked safe because `<`, `>` and `&` are punctuation
       rules in most languages and therefore usually tokens — in a language
       whose rules do not claim them, the gap carried them to the page raw. */
    ret.push(encode(row.substring(index, start)))
    const code = row.substring(start, end)
    /* Every token is a raw slice of the source, so it is encoded here.
       elem() only ever encoded a token that was a lone < or >, which was
       enough while no rule matched more than one character at a time —
       a multi-character match (`<!-- … -->`, `// see <div>`) went to the
       page as live markup. */
    ret.push(elem(el.tag, el.is_string ? renderString(code) : encode(code)))

    index = end
  }

  ret.push(encode(row.substring(index)))
  const res = ret.join('')

  return !mark
    ? res
    : res.replace(MARK, (_, marker, content) => {
        return elem(marker[1] ? 'u' : 'mark', content)
      })
}

// comment start & end
const COMMENT = [/(\/\*|^ *{# |<!--|'''|=begin)/, /(\*\/|#}|-->|'''|=end)$/]

/*
  A block comment that opens mid-line and closes on the same line is a
  trailing comment, not a comment block — and treating it as one turned
  every character before it into commentary as well:

    --bs-btn-hover-bg: #5b21b6;   /* your call *\/

  ...rendered whole as a comment, which reads as a disabled line. Only the
  two paired syntaxes are handled; ''' and =begin have no trailing form.
*/
const INLINE_COMMENT = [
  ['/*', '*/'],
  ['<!--', '-->']
]

const INLINE_COMMENT_TAGS = [
  { tag: 'sup', re: /\/\*[\s\S]*?\*\//g },
  { tag: 'sup', re: /<!--[\s\S]*?-->/g }
]

function isTrailingComment(line) {
  return INLINE_COMMENT.some(function ([open, close]) {
    const at = line.indexOf(open)
    /* Opening the line (whitespace aside) means a block, which may well run
       on to the next line — the case this must not steal. */
    if (at < 0 || !line.slice(0, at).trim()) return false
    return line.indexOf(close, at + open.length) > -1
  })
}

export function parseSyntax(lines, lang, prefix = true) {
  const [comm_start, comm_end] = COMMENT
  const html = []

  // multi-line comment
  let comment

  function endComment() {
    html.push({ comment })
    comment = null
  }

  lines.forEach((line, i) => {
    if (!comment) {
      if (comm_start.test(line) && !isTrailingComment(line)) {
        comment = [line]
        if (comm_end.test(line) && line?.trim() != "'''") endComment()
      } else {
        // highlighted line
        const is_md = isMD(primaryLang(lang))
        const c = line[0]
        let wrap = prefix && (is_md ? c == '|' && 'dfn' : PREFIXES[c])
        if (wrap && is_md && line == '---') wrap = null
        /* `--custom-property: …` is not a removed line. Two dashes never
           start a diff marker, so this costs nothing and stops the marker
           eating one character off every CSS variable declaration. */
        if (wrap && c == '-' && line[1] == '-') wrap = null
        if (wrap) line = (line[1] == ' ' ? ' ' : '') + line.slice(1)

        // escape character
        if (prefix && c == '\\') line = line.slice(1)

        html.push({ line, wrap })
      }
    } else {
      comment.push(line)
      if (comm_end.test(line)) endComment()
    }
  })

  return html
}

// code, { language: 'js', numbered: true }
export function glow(str, opts = { prefix: true, mark: true }) {
  if (typeof opts === 'string') opts = { language: opts }
  const lines = Array.isArray(str) ? str : str?.split(/\r?\n/)

  /* `''.split()` is `['']` — one empty line, not no lines — so without the
     second clause an empty source returns an empty <code> block while an
     empty array returns nothing. One of them has to be wrong. */
  if (!lines || !lines.length || (lines.length == 1 && !lines[0])) return ''

  // language
  let lang = opts.language
  if (!lang && lines[0][0] == '<') lang = 'html'
  const attr = primaryLang(lang)
  const html = []

  function push(line) {
    html.push(opts.numbered ? elem('span', line) : line)
  }

  parseSyntax(lines, lang, opts.prefix).forEach(function (block) {
    let { line, comment, wrap } = block

    // EOL comment
    if (comment) {
      return comment.forEach((el) => push(elem('sup', encode(el))))
    } else {
      line = renderRow(line, lang, opts.mark)
    }

    if (wrap) line = elem(wrap, line)
    push(line)
  })

  return `<code language="${attr || '*'}">${html.join(NL)}</code>`
}
