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

const MIXED_HTML = ['html', 'jsx', 'php', 'astro', 'dhtml', 'vue', 'svelte', 'hb']
const LINE_COMMENT = { clojure: ';;', lua: '--', python: '#' }
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
  go: 'chan|fallthrough'
}

// special rules (growing list)
const RULES = {
  css: [
    { tag: 'strong', re: /#[0-9a-f]{3,7}/gi },
    { tag: 'label', re: /!important/gi },
    { tag: 'em', re: /--[\w\d\-]+/gi }
  ],

  json: [{ tag: 'b', re: /(".+"):/gi }],
  yaml: [{ tag: 'b', re: /([\w ]+):/gi }]
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

function getTags(lang) {
  const tags = HTML_TAGS.filter((el) => !el.lang || el.lang.includes(lang))

  // custom keywords
  if (!['yaml', 'html', 'json'].includes(lang)) {
    const w = SPECIAL_WORDS[lang]
    const words = (w ? w + '|' : '') + COMMON_WORDS
    const re = new RegExp(`\\b(${words})\\b`, 'gi')
    tags.splice(4, 0, { tag: 'strong', re })
  }

  // custom rules
  const rules = RULES[lang]
  if (rules) tags.unshift(...rules)

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
  const tags = isMD(lang) ? getMDTags(row) : getTags(lang)
  const tokens = []

  // line comment (language specific)
  const re = new RegExp(`${LINE_COMMENT[lang] || '//'} .+`)
  tags.unshift({ tag: 'sup', re })

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
        const is_md = isMD(lang)
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

  return `<code language="${lang || '*'}">${html.join(NL)}</code>`
}
