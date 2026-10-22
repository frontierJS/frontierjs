// splitStatements scans by char code and copies slices (FJS-112 P3); these pin
// what the per-character version answered, edge by edge.
import { test, expect, describe } from 'bun:test'
import { splitStatements } from '../src/core/migrate.js'

describe('splitStatements', () => {
  test('splits at top-level semicolons and drops empties', () => {
    expect(splitStatements('a;b;;c')).toEqual(['a', 'b', 'c'])
    expect(splitStatements('')).toEqual([])
  })

  test('a semicolon inside a string or quoted identifier does not split', () => {
    expect(splitStatements(`select 'a;b'; select "c;d"; select \`e;f\``))
      .toEqual([`select 'a;b'`, `select "c;d"`, 'select `e;f`'])
    expect(splitStatements(`select 'it\\'s;' ; x`)).toEqual([`select 'it\\'s;'`, 'x'])
  })

  test('comments are dropped, and a line comment takes its newline', () => {
    expect(splitStatements('a -- x;y\nb; /* ; */ c')).toEqual(['a b', 'c'])
    expect(splitStatements('a -- no newline')).toEqual(['a'])
    expect(splitStatements('a; /* unterminated ;')).toEqual(['a'])
  })

  test('a trigger body, CASE included, stays one statement', () => {
    const trig = 'CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a = CASE WHEN 1 THEN 2 END; DELETE FROM z; END'
    expect(splitStatements(`${trig}; select 1`)).toEqual([trig, 'select 1'])
    expect(splitStatements('create temp trigger z after delete on q begin delete from r; end; x'))
      .toEqual(['create temp trigger z after delete on q begin delete from r; end', 'x'])
  })

  test('a transaction BEGIN ends at its own semicolon; words that merely contain a keyword do not count', () => {
    expect(splitStatements('BEGIN; COMMIT; BEGIN TRANSACTION; x')).toEqual(['BEGIN', 'COMMIT', 'BEGIN TRANSACTION', 'x'])
    expect(splitStatements('select UNBOUNDED, ENDING; y')).toEqual(['select UNBOUNDED, ENDING', 'y'])
  })
})
