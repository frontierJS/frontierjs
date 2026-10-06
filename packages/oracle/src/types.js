// ─── types.js — the words an answer types a field with, and the column each is ─
//
// An answer never writes a `.lite` type. It says `money`, and this table says
// that money is `Int @money(USD)`, because a model reaching for a type from
// memory reaches for `Decimal` or `Float`, and the language refuses the first
// and the second is wrong for money in every language. Every row here was
// parsed and graded by `fli advise` and `fli check` (test/emit.test.js).
//
// `lite(field)` answers the column's type and its attributes, not counting
// `?`, `@unique`, `@system` and `@default`, which the emitter adds the same way
// for every type.

/**
 * @typedef {{ desc: string, lite: (f: import('./catalog.js').Field, enumName: string) => { type: string, attrs: string[] }, array?: boolean, alwaysSet?: boolean }} TypeRow
 */

/** @type {Record<string, TypeRow>} */
export const TYPES = {
  text:     { desc: 'a short line — a name, a title (≤ 200)',          lite: f => ({ type: 'String', attrs: ['@trim', `@length(${f.required ? 1 : 0}, 200)`] }) },
  longtext: { desc: 'plain text of any length — a description, a note', lite: () => ({ type: 'String', attrs: ['@length(0, 20000)'] }) },
  markdown: { desc: 'formatted prose — a post body, a document',        lite: () => ({ type: 'String', attrs: ['@syntax(md)', '@length(0, 100000)'] }) },
  email:    { desc: 'an email address',                                  lite: () => ({ type: 'String', attrs: ['@email', '@lower', '@trim'] }) },
  url:      { desc: 'a web address',                                     lite: () => ({ type: 'String', attrs: ['@url'] }) },
  phone:    { desc: 'a phone number',                                    lite: () => ({ type: 'String', attrs: ['@phone'] }) },
  slug:     { desc: 'a URL-safe identifier — my-first-post',            lite: () => ({ type: 'String', attrs: ['@slug', '@length(1, 120)'] }) },
  color:    { desc: 'a color as #rrggbb',                                lite: () => ({ type: 'String', attrs: ['@regex("^#[0-9a-fA-F]{6}$", "A color is #rrggbb")'] }) },
  int:      { desc: 'a whole number that may be negative',               lite: () => ({ type: 'Int', attrs: [] }) },
  count:    { desc: 'a whole number, zero or more — a quantity, minutes', lite: () => ({ type: 'Int', attrs: ['@gte(0)'] }) },
  number:   { desc: 'a measurement with a fraction — a coordinate, a weight', lite: () => ({ type: 'Float', attrs: [] }) },
  money:    { desc: 'an amount of money',                                lite: () => ({ type: 'Int', attrs: ['@money(USD)'] }) },
  percent:  { desc: 'a whole percentage, 0 to 100',                      lite: () => ({ type: 'Int', attrs: ['@gte(0)', '@lte(100)'] }) },
  bool:     { desc: 'yes or no — always set, false unless defaulted',    lite: () => ({ type: 'Boolean', attrs: [] }), alwaysSet: true },
  datetime: { desc: 'a moment — when something happened or will',       lite: () => ({ type: 'DateTime', attrs: [] }) },
  date:     { desc: 'a calendar day with no time, YYYY-MM-DD',           lite: () => ({ type: 'String', attrs: ['@date'] }) },
  json:     { desc: 'structured data whose shape the app owns — settings, a form\'s questions', lite: () => ({ type: 'Json', attrs: [] }) },
  file:     { desc: 'one uploaded file',                                 lite: () => ({ type: 'File', attrs: [] }) },
  image:    { desc: 'one uploaded image',                                lite: () => ({ type: 'File', attrs: ['@accept("image/*")'] }) },
  files:    { desc: 'several uploaded files',                            lite: () => ({ type: 'File[]', attrs: [] }), array: true },
  tags:     { desc: 'a list of short labels',                            lite: () => ({ type: 'String[]', attrs: [] }), array: true },
  secret:   { desc: 'a credential the app uses and nobody reads back — an API key, a token', lite: () => ({ type: 'String', attrs: ['@secret'] }) },
  enum:     { desc: 'one of a fixed list of values — needs `values`',   lite: (f, enumName) => ({ type: enumName, attrs: [] }) },
}
