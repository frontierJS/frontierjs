// tests/series-key.test.ts
//
// `MetricSeries.labelsKey` is `@unique` and is what every write upserts on, so
// it IS the series' identity. Two callers spelling one series differently mint
// two series, and each then holds half the readings — which draws a graph with
// a step in it and says nothing about why.
//
// That is why the spelling is a function rather than a convention: the scrape
// and `app.metrics.record()` both go through it, and so does every reader that
// wants to find a series by name.

import { test, expect, describe } from 'bun:test'
import { seriesKey } from '../src/core/metrics.ts'

describe('seriesKey — the identity of one series', () => {

  test('no labels is the bare name, so nothing already written moves', () => {
    // The scrape has written unlabelled series since the store landed. A format
    // that wrapped them — `up{}` — would orphan every row in every installed
    // app on the first boot after an upgrade.
    expect(seriesKey('up')).toBe('up')
    expect(seriesKey('process.memoryMb', {})).toBe('process.memoryMb')
    expect(seriesKey('process.memoryMb', null)).toBe('process.memoryMb')
  })

  test('labels are sorted, so insertion order is not part of the identity', () => {
    // The row this exists for. Two call sites building the same labels in
    // different orders is not a hypothetical — it is what happens the moment a
    // second one is written — and object key order is a property of whichever
    // literal was typed first.
    expect(seriesKey('m', { server: 'a', region: 'b' }))
      .toBe(seriesKey('m', { region: 'b', server: 'a' }))
    expect(seriesKey('m', { server: 'a', region: 'b' })).toBe('m{region="b",server="a"}')
  })

  test('numbers and strings that look alike are the same series', () => {
    // A label is a string in the key whatever the caller passed, because the
    // column is Json and `1` from one call site and `'1'` from another are the
    // same machine.
    expect(seriesKey('m', { id: 1 })).toBe(seriesKey('m', { id: '1' }))
  })

  test('A VALUE CANNOT FORGE A SECOND LABEL', () => {
    // The one that matters. Without escaping, a value containing `",` closes the
    // pair and opens another — so a caller who controls a label value controls
    // the whole key, and can address a series belonging to somebody else. Every
    // label here is written by this repo today, which is exactly the state a
    // format is in before the first one is not.
    const forged = seriesKey('m', { serverId: 'a",tenant="other' })
    expect(forged).toBe('m{serverId="a\\",tenant=\\"other"}')
    // And it is NOT equal to the key it was trying to become.
    expect(forged).not.toBe(seriesKey('m', { serverId: 'a', tenant: 'other' }))
  })

  test('a backslash and a newline are escaped too', () => {
    // The other two characters that would let a value end the quoted run.
    expect(seriesKey('m', { p: 'a\\b' })).toBe('m{p="a\\\\b"}')
    expect(seriesKey('m', { p: 'a\nb' })).toBe('m{p="a\\nb"}')
  })

  test('the format is OpenMetrics\', so a key is a name a person recognizes', () => {
    // Not a private encoding: `name{k="v"}` is what every exporter's
    // documentation writes, so a key read out of this database can be pasted
    // into one and understood.
    expect(seriesKey('http.requests.total', { method: 'GET', status: 200 }))
      .toBe('http.requests.total{method="GET",status="200"}')
  })
})
