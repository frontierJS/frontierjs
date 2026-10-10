import { test, expect } from 'bun:test'
import { lines, wrap, visibleLength } from '../core/text.js'

test('lines drops false, null and undefined, keeps 0 and a blank line', () => {
  expect(lines(['a', false, null, undefined, 0, '', 'b'], { indent: 2 })).toBe('  a\n  0\n\n  b')
})

test('lines with no indent joins as written', () => {
  expect(lines(['a', 'b'])).toBe('a\nb')
})

test('style wraps the joined block once', () => {
  expect(lines(['a', false, 'b'], { indent: 1, style: s => `[${s}]` })).toBe('[ a\n b]')
})

test('wrap breaks at the last space within the width', () => {
  expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrap('short', 0)).toEqual(['short'])
})

// A style open at a break would otherwise color the prefix printed before the
// next row, and the prefix's own close would end it.
test('wrap ignores escape codes in the width and reopens an open style', () => {
  const red = '\x1b[31m'
  const rows = wrap(`${red}aaa bbb\x1b[39m ccc`, 4)
  expect(rows.map(visibleLength)).toEqual([3, 3, 3])
  expect(rows[0]).toBe(`${red}aaa\x1b[0m`)
  expect(rows[1].startsWith(`${red}bbb`)).toBe(true)
  // Reopened and then closed again by the code that followed it: plain.
  expect(rows[2].endsWith('\x1b[39mccc')).toBe(true)
})

test('an emoji counts two columns', () => {
  expect(visibleLength('🚀 x')).toBe(4)
})
