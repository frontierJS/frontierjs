// Litestone's schema language, .lite Learned from the real files
// under packages/*/db and the lexer in ../predicate/tokenize.js.
//
// Declarations (`model`, `enum`, `extend model` ...) are keywords only at column
// 0: `type`, `scope` and `from` are also field names, and a field is indented.
// The first word of an indented line is the field's name (`property`). The
// operator words inside an attribute's predicate (`and`, `is`, `in`) are
// keywords only after something else on the line, for the same reason.
//
// A backtick string is one line here; in the language it is a template that may
// span several, which this does not follow. `///` is a doc comment and gets the
// same type as `//`.

const DECLARATIONS = ['model', 'enum', 'trait', 'view', 'type', 'function', 'valueset', 'scope', 'database', 'tenancy', 'claim', 'import']

export const lite = {
  name: 'lite',
  rules: [
    { match: /\/\/.*/, type: 'comment' },
    { begin: /\/\*/, end: /\*\//, type: 'comment' },
    { match: /"(?:[^"\\]|\\.)*"?/, type: 'string' },
    { match: /'(?:[^'\\]|\\.)*'?/, type: 'string' },
    { match: /`(?:[^`\\]|\\.)*`?/, type: 'string' },
    { match: new RegExp(`^(?:extend[ \\t]+)?(?:${DECLARATIONS.join('|')})\\b`), type: 'keyword' },
    { match: /@@?[A-Za-z_]\w*/, type: 'special' },
    { match: /-?\d+(?:\.\d+)*(?:ms|[smhdwy])?\b/, type: 'number' },
    { match: /\b(?:true|false|null)\b/, type: 'constant' },
    { match: /(?<=\S[ \t]{1,16})\b(?:and|or|not|is|in|from|where|as)\b/, type: 'keyword' },
    { match: /(?<=^[ \t]{1,16})[a-z_]\w*/, type: 'property' },
    { match: /[A-Za-z_]\w*(?=\()/, type: 'function' },
    { match: /\b[A-Z][A-Z0-9_]+\b/, type: 'constant' },
    { match: /\b[A-Z]\w*/, type: 'type' },
    { match: /[A-Za-z_]\w*/, type: null },
  ],
}
