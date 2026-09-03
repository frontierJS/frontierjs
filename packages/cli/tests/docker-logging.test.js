// ─── docker-logging.test.js — the flags a started container is given ─────────
//
// Four places start a container — the deploy swap, the rollback, `deploy:local`
// and the Outpost — and before this they agreed on `--restart` and on nothing
// about logs, so all four inherited Docker's default json-file driver, which
// caps nothing. The failure is a full disk rather than a lost log line.
//
// What is asserted here is the shape of the decision rather than the default:
// the default is one line and the cases that matter are the two ways an
// operator says *I have already answered this*. A cap forced onto a machine
// whose daemon is pointed at journald is refused by Docker outright, so the
// opt-outs are the half that has to work.

import { describe, test, expect } from 'bun:test'
import { dockerLogArgs, DOCKER_LOG_DEFAULTS } from '../core/docker-logging.js'

const joined = (conf) => dockerLogArgs(conf).join(' ')

describe('dockerLogArgs', () => {

  test('an app that says nothing gets a bounded json-file log', () => {
    expect(joined(undefined)).toBe(
      '--log-driver json-file --log-opt max-size=10m --log-opt max-file=5')
    // The defaults are exported because the scaffold's deploy block prints them
    // as the commented-out example, and two spellings of 10m is how they drift.
    expect(DOCKER_LOG_DEFAULTS).toEqual({ maxSize: '10m', maxFiles: 5 })
  })

  test('an app with a deploy block but no logs key is the same app', () => {
    expect(joined({ db: { keep_backups: 5 } })).toBe(joined(undefined))
  })

  test('`logs: false` emits nothing, so the daemon default stands', () => {
    // Not `--log-driver json-file` with no options: that would override a
    // daemon configured fleet-wide, for this container alone.
    expect(dockerLogArgs({ logs: false })).toEqual([])
  })

  test('sizes are the operator’s when stated', () => {
    expect(joined({ logs: { max_size: '50m', max_files: 2 } }))
      .toBe('--log-driver json-file --log-opt max-size=50m --log-opt max-file=2')
  })

  test('a named driver carries no size options', () => {
    // `max-size` is json-file's spelling. journald refuses it and the container
    // does not start, so carrying the defaults across would break the machine
    // that was configured correctly.
    expect(joined({ logs: { driver: 'journald' } })).toBe('--log-driver journald')
  })

  test('a named driver takes its own options', () => {
    expect(joined({ logs: { driver: 'loki', options: { 'loki-url': 'http://h/api/prom/push' } } }))
      .toBe('--log-driver loki --log-opt loki-url=http://h/api/prom/push')
  })

  test('a value cannot break out of the argv it is interpolated into', () => {
    // These reach a machine inside a script sent to `sh -s`, built by string
    // interpolation — the same rule the deploy lock's values are under.
    const out = joined({ logs: { max_size: '10m; rm -rf /', max_files: '5 && curl evil' } })
    expect(out).not.toContain(';')
    expect(out).not.toContain('&')
    expect(out).not.toContain(' rm ')
    expect(out).toContain('--log-opt max-size=10m-rm--rf-/')
  })

  test('a driver name is bounded too', () => {
    expect(joined({ logs: { driver: 'journald `id`' } })).toBe('--log-driver journald-id-')
  })
})
