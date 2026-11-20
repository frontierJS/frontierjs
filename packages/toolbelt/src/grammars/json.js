// JSON and JSONC. One grammar: comments are accepted everywhere,
// since a strict .json file has none to mistake and a tsconfig has them.
//
// A string is a key when a colon follows it on the same line, so a key and its
// colon split over two lines paints the key as a string. A string ends at its
// line's end even unclosed: typing a quote recolors one line, not the file.

export const json = {
  name: 'json',
  rules: [
    { match: /\/\/.*/, type: 'comment' },
    { begin: /\/\*/, end: /\*\//, type: 'comment' },
    { match: /"(?:[^"\\]|\\.)*"(?=[ \t]*:)/, type: 'property' },
    { match: /"(?:[^"\\]|\\.)*"?/, type: 'string' },
    { match: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, type: 'number' },
    { match: /\b(?:true|false|null)\b/, type: 'constant' },
  ],
}
