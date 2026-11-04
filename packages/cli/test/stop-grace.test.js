// ─── stop-grace.test.js — the grace a deployed container is started with ─────
import { describe, test, expect } from 'bun:test'
import { stopGraceArgs, DEFAULT_STOP_GRACE_S } from '../core/stop-grace.js'

describe('stopGraceArgs', () => {
  test('an app that says nothing gets the default, as the flag and the env var', () => {
    expect(stopGraceArgs(undefined)).toEqual(['--stop-timeout 40', '--env FRONTIER_STOP_GRACE=40'])
    expect(DEFAULT_STOP_GRACE_S).toBe(40)
  })

  test('deploy.stopGrace is the operator’s when stated', () => {
    expect(stopGraceArgs({ stopGrace: 25 })).toEqual(['--stop-timeout 25', '--env FRONTIER_STOP_GRACE=25'])
  })

  test('a grace that is not a whole number of seconds, at least 2, is refused', () => {
    for (const bad of [1, 0, -5, 2.5, '30', 'soon'])
      expect(() => stopGraceArgs({ stopGrace: bad })).toThrow(/deploy\.stopGrace/)
  })
})
