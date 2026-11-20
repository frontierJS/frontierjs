// JavaScript and TypeScript. One table each, TypeScript being
// JavaScript's with more keywords and the built-in type names.
//
// Only a block comment and a template literal span lines. A quoted string ends
// at its line's end even unclosed, so typing a quote recolors one line rather
// than the rest of the file. `{` is not tracked: a nesting depth in the state
// would make every brace typed re-tokenize everything below it.

const words = (list) => new RegExp(`\\b(?:${list.join('|')})\\b`)

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
]
const TS_KEYWORDS = [
  'abstract', 'as', 'asserts', 'declare', 'enum', 'implements', 'infer', 'interface', 'is', 'keyof',
  'namespace', 'override', 'private', 'protected', 'public', 'readonly', 'satisfies', 'type', 'unique',
]
const TS_TYPES = ['any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'unknown']

// A slash starts a regex where a value is expected: after an operator, an
// opening bracket, a comma, a keyword that takes an expression, or nothing.
const REGEX = /(?<=(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\byield|\bawait)\s*)\/(?![*/])(?:[^/\\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[dgimsuyv]*/

function rules(keywords, extra = []) {
  const self = []
  const template = {
    begin: /`/,
    end: /`/,
    type: 'string',
    inside: 'string',
    rules: [
      { match: /\\./, type: 'escape' },
      { begin: /\$\{/, end: /\}/, type: 'punctuation', rules: self },
    ],
  }
  self.push(
    // A hashbang, before the regex rule would read `!/usr/` as one.
    { match: /^#!.*/, type: 'comment' },
    { match: /\/\/.*/, type: 'comment' },
    { begin: /\/\*/, end: /\*\//, type: 'comment' },
    { match: /"(?:[^"\\]|\\.)*"?/, type: 'string' },
    { match: /'(?:[^'\\]|\\.)*'?/, type: 'string' },
    template,
    { match: REGEX, type: 'regexp' },
    { match: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?|\.\d[\d_]*(?:[eE][+-]?\d+)?/, type: 'number' },
    { match: words(keywords), type: 'keyword' },
    { match: /\b(?:true|false|null|undefined|NaN|Infinity)\b/, type: 'constant' },
    ...extra,
    { match: /#?[A-Za-z_$][\w$]*(?=\s*\()/, type: 'function' },
    { match: /\b[A-Z][\w$]*/, type: 'type' },
    // An identifier is one token, so a keyword inside `$if` or `x_const` is not found.
    { match: /#?[A-Za-z_$][\w$]*/, type: null },
  )
  return self
}

export const js = { name: 'js', rules: rules(JS_KEYWORDS) }
export const ts = {
  name: 'ts',
  rules: rules([...JS_KEYWORDS, ...TS_KEYWORDS], [{ match: words(TS_TYPES), type: 'type' }]),
}
