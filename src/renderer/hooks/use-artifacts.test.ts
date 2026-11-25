import { describe, it, expect } from 'vitest'
import { artifactsRefetchIntervalMs, type ArtifactInfo } from './use-artifacts'

function artifact(status: ArtifactInfo['status'], slug = 'dash'): ArtifactInfo {
  return { slug, name: slug, description: '', status, port: 1 }
}

describe('artifactsRefetchIntervalMs', () => {
  it('escalates only when pollFast is requested or some dashboard is starting', () => {
    expect(artifactsRefetchIntervalMs(undefined, false)).toBe(60_000)
    expect(artifactsRefetchIntervalMs([artifact('stopped')], false)).toBe(60_000)
    expect(artifactsRefetchIntervalMs([artifact('starting')], false)).toBe(1_000)
    expect(artifactsRefetchIntervalMs([artifact('stopped')], true)).toBe(300)
    expect(artifactsRefetchIntervalMs(undefined, true)).toBe(300)
  })

  it('keeps a 1s floor while a dashboard view is watching, even without a starting artifact', () => {
    // The slow-start case: pollFast has turned off at the wait bound and the
    // queued dashboard still reports 'stopped' — watching must prevent the
    // fall-back to the 60s idle cadence.
    expect(artifactsRefetchIntervalMs([artifact('stopped')], false, true)).toBe(1_000)
    expect(artifactsRefetchIntervalMs(undefined, false, true)).toBe(1_000)
    expect(artifactsRefetchIntervalMs([artifact('running')], false, true)).toBe(1_000)
    // pollFast still wins over the floor
    expect(artifactsRefetchIntervalMs([artifact('stopped')], true, true)).toBe(300)
    // not watching, nothing starting → idle cadence unchanged
    expect(artifactsRefetchIntervalMs([artifact('running')], false, false)).toBe(60_000)
  })

  it('uses the caller\'s idle interval only when nothing is starting or watched', () => {
    // The sidebar's slow fallback behind the notifications stream.
    expect(artifactsRefetchIntervalMs(undefined, false, false, 300_000)).toBe(300_000)
    expect(artifactsRefetchIntervalMs([artifact('running')], false, false, 300_000)).toBe(300_000)
    expect(artifactsRefetchIntervalMs([artifact('stopped')], false, false, 300_000)).toBe(300_000)
    expect(artifactsRefetchIntervalMs([artifact('crashed')], false, false, 300_000)).toBe(300_000)
    // The cadences of a starting dashboard never slow.
    expect(artifactsRefetchIntervalMs([artifact('running', 'a'), artifact('starting', 'b')], false, false, 300_000)).toBe(1_000)
    expect(artifactsRefetchIntervalMs([artifact('running')], false, true, 300_000)).toBe(1_000)
    expect(artifactsRefetchIntervalMs([artifact('running')], true, false, 300_000)).toBe(300)
  })
})
