/*
 * docfences.spec.js
 *
 * Three readers each had a fence regex and disagreed on indentation, `~~~` and
 * what closes a block (`FJS-2331`). Every row is written against one of those
 * disagreements, each paired with the shape that must stay unchanged.
 */

import { docFences, isRunnable, RUNNABLE_LANGS } from '../../src/docfences/docfences.js'

const doc = [
  '# Page',            // 1
  '',                  // 2
  '```lite',           // 3
  'model A { id Int }',// 4
  '```',               // 5
  '',                  // 6
  '```js throws',      // 7
  'db.a.create()',     // 8
  '```',               // 9
  '',                  // 10
  '```lite fragment',  // 11
  '@@gate(1)',         // 12
  '```',               // 13
  '```ts',             // 14
  'db.b',              // 15
  '```',               // 16
].join('\n')

test('a block carries its opener line, lang, info words and body', () => {
  const [a, b] = docFences(doc)
  if (a.line !== 3 || a.lang !== 'lite' || a.body !== 'model A { id Int }') throw new Error(JSON.stringify(a))
  if (b.line !== 7 || b.lang !== 'js' || !b.words.has('throws') || b.words.has('fragment')) throw new Error(JSON.stringify(b))
})

test('the schema in scope is the nearest preceding non-fragment lite block', () => {
  const [a, b, c, d] = docFences(doc)
  if (a.schema !== null) throw new Error('a schema block has none above it')
  if (b.schema !== 'model A { id Int }') throw new Error('js under a lite block')
  if (c.schema !== 'model A { id Int }') throw new Error('a fragment does not replace the schema')
  if (d.schema !== 'model A { id Int }') throw new Error('a fragment never becomes the schema in scope')
})

test('index is the offset of the opener line', () => {
  for (const f of docFences(doc)) {
    if (!doc.slice(f.index).startsWith(doc.split('\n')[f.line - 1])) throw new Error(`line ${f.line} at ${f.index}`)
  }
})

test('a longer fence holds a shorter one, and ~~~ is a fence', () => {
  const text = '````md\n```js\nnot a block\n```\n````\n\n~~~js\nx\n~~~\n'
  const blocks = docFences(text)
  if (blocks.length !== 2) throw new Error(`${blocks.length} blocks`)
  if (blocks[0].lang !== 'md' || !blocks[0].body.includes('```js')) throw new Error('the inner fence ended the outer')
  if (blocks[1].lang !== 'js' || blocks[1].body !== 'x') throw new Error('~~~ not read')
})

test('an indented fence is read, and a bare fence has lang ""', () => {
  const blocks = docFences('- item\n\n  ```js\n  x()\n  ```\n\n```\nplain\n```\n')
  if (blocks.length !== 2 || blocks[0].lang !== 'js' || blocks[1].lang !== '') throw new Error(JSON.stringify(blocks))
  if (isRunnable(blocks[1])) throw new Error('a bare fence is not runnable')
})

test('an unclosed fence runs to the end of the text and terminates', () => {
  const [a] = docFences('```js\nx()\ny()')
  if (a.body !== 'x()\ny()') throw new Error(a.body)
})

test('runnable is a runnable tag not marked fragment', () => {
  const f = docFences(doc)
  const got = f.map(isRunnable)
  if (got.join() !== 'true,true,false,true') throw new Error(got.join())
  if (RUNNABLE_LANGS.has('prisma')) throw new Error('prisma is unverified, not runnable')
})
