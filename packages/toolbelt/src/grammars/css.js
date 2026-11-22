// CSS. Two contexts: the top level (selectors and at-rules) and a
// declaration block (properties and values).
//
// A `{ }` block is a region, and a block inside one is a region too, so nesting
// is a stack and not a counted depth. A nested rule's selector (inside @media,
// say) is told from a declaration by a `{` later on its line: `a:hover {` is a
// selector and `color: red` a property. A selector wrapped over several lines
// is read as declarations. An at-rule's prelude (`screen and (min-width: 1px)`) is untyped text so its
// words are not painted as tag names.

const comment = { begin: /\/\*/, end: /\*\//, type: 'comment' }
const strings = [
  { match: /"(?:[^"\\]|\\.)*"?/, type: 'string' },
  { match: /'(?:[^'\\]|\\.)*'?/, type: 'string' },
]

export const block = []
block.push(
  comment,
  ...strings,
  { begin: /\{/, end: /\}/, type: 'punctuation', rules: block },
  { match: /!\s*important\b/, type: 'special' },
  { match: /@[\w-]+/, type: 'special' },
  { match: /(?<=@[\w-]+[ \t]{1,4})[^{;"'\s][^{;"']*/, type: null },
  { match: /#[\w-]+(?=[^;{}]*\{)/, type: 'type' },
  { match: /::?[A-Za-z-]+(?:\([^)]*\))?(?=[^;{}]*\{)/, type: 'keyword' },
  { match: /#[\da-fA-F]{3,8}\b/, type: 'number' },
  // An unquoted url() argument is a string whatever dots and slashes it holds.
  { match: /(?<=\burl\()[^)"'\s][^)]*/, type: 'string' },
  { match: /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|[A-Za-z]+)?/, type: 'number' },
  { match: /--[\w-]+(?=[ \t]*:)/, type: 'property' },
  { match: /-?[A-Za-z_][\w-]*(?=[ \t]*:(?![^;{}]*\{))/, type: 'property' },
  { match: /-?[A-Za-z_][\w-]*(?=\()/, type: 'function' },
  { match: /\.[A-Za-z_-][\w-]*/, type: 'type' },
  { match: /[A-Za-z][\w-]*(?=[^;{}]*\{)/, type: 'type' },
  // An identifier is one token, so the digits in `h1` or `a-1` are not a number.
  { match: /-{1,2}[A-Za-z_][\w-]*|[A-Za-z_][\w-]*/, type: null },
)

export const css = {
  name: 'css',
  rules: [
    comment,
    ...strings,
    { begin: /\{/, end: /\}/, type: 'punctuation', rules: block },
    { match: /@[\w-]+/, type: 'special' },
    { match: /(?<=@[\w-]+[ \t]{1,4})[^{;"'\s][^{;"']*/, type: null },
    // A custom property is never a selector, so a declaration quoted without
    // its rule (a docs fragment) keeps its name whole.
    { match: /--[\w-]+(?=[ \t]*:)/, type: 'property' },
    { match: /::?[A-Za-z-]+(?:\([^)]*\))?/, type: 'keyword' },
    { match: /\[[^\]]*\]/, type: 'attribute' },
    { match: /[#.][A-Za-z_-][\w-]*/, type: 'type' },
    { match: /\d+(?:\.\d+)?%/, type: 'number' },
    { match: /[A-Za-z][\w-]*|\*/, type: 'type' },
  ],
}
