// YAML, for .yml files and a markdown file's front matter. Per line: a key is
// the name before a `: `, and a value is typed by its shape. A quoted string
// ends at its line's end, and a block scalar's (`|`, `>`) lines are plain, as
// a line cannot know it is inside one.

export const yaml = {
  name: 'yaml',
  rules: [
    { match: /(?<=^|\s)#.*/, type: 'comment' },
    { match: /^(?:---|\.\.\.)(?=\s|$)/, type: 'punctuation' },
    // A key: plain, or quoted, before a colon that ends the line or a space follows.
    // A key starts a line's content or follows a flow `{` or `,`: free to start
    // anywhere, a colon-less line was rescanned to its end from every word.
    { match: /(?<=^[ \t]*(?:[-?][ \t]+)*|[{,][ \t]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,[\]{}][^#:]*?|-[^\s#:][^#:]*?)(?=[ \t]*:(?:\s|$))/, type: 'property' },
    { match: /"(?:[^"\\]|\\.)*"?/, type: 'string' },
    { match: /'(?:[^']|'')*'?/, type: 'string' },
    { match: /[&*][^\s,[\]{}]+/, type: 'special' },
    { match: /![^\s,[\]{}]*/, type: 'special' },
    { match: /(?<=^|[\s:,[{-])(?:true|false|yes|no|on|off|null|~)(?=[ \t]*(?:$|#|[,\]}]))/i, type: 'constant' },
    { match: /(?<=^|[\s:,[{-])[-+]?(?:0x[\da-fA-F]+|0o[0-7]+|\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|\.nan)(?=[ \t]*(?:$|#|[,\]}]))/i, type: 'number' },
    // A sequence dash, a mapping colon, flow brackets and a block scalar's indicator;
    // a colon inside a plain value (a URL) is the value's.
    { match: /^[ \t]*(?:[-?][ \t]+)*[-?](?=\s|$)|:(?=\s|$)|[,[\]{}]|[|>][-+]?\d*(?=[ \t]*(?:#|$))/, type: 'punctuation' },
  ],
}
