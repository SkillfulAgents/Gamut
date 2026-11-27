import { describe, expect, it } from 'vitest'
import { AGENT_AVATAR_COLORS, AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS, TEAM_BRAIN_AVATAR_SHAPE } from '@shared/lib/types/agent-avatar'
import { orbRestingPhi } from './agent-avatar'
import { avatarSource } from './avatar-source'
import { DEFAULT_ORBS, OFFERED_ORBS } from '@shared/lib/types/agent-avatar-orbs'
import { BRAIN_SHAPE, ORB_SHAPES } from '@shared/lib/types/agent-avatar-shapes'

it('renders every persisted color and every offered shape, including every randomly assigned default', () => {
  expect(OFFERED_ORBS.map(orb => orb.name)).toEqual([...AGENT_AVATAR_COLORS])
  expect(DEFAULT_ORBS.map(orb => orb.name)).toEqual([...DEFAULT_AGENT_AVATAR_COLORS])
  expect(ORB_SHAPES.map(shape => shape.name)).toEqual([...AGENT_AVATAR_SHAPES])
  for (const color of AGENT_AVATAR_COLORS) {
    for (const shape of AGENT_AVATAR_SHAPES) {
      const source = avatarSource({ color, shape })
      expect(source.orb.name).toBe(color)
      expect(source.shape.name).toBe(shape)
    }
  }
})

it("keeps Team Brain's brain out of the shapes everyone is offered and randomly given, and draws it once stored", () => {
  expect(AGENT_AVATAR_SHAPES).not.toContain(TEAM_BRAIN_AVATAR_SHAPE)
  expect(avatarSource({ color: 'tonal-blush', shape: TEAM_BRAIN_AVATAR_SHAPE }).shape).toBe(BRAIN_SHAPE)
  // The iOS app pins the same samples (AgentAvatarWebParityTests).
  const samples = [0, 60, 120, 180].map(i => BRAIN_SHAPE.points[i].map(v => Number(v.toFixed(5)) + 0))
  expect(samples).toEqual([[0.91426, 0], [0, 0.7786], [-0.91426, 0], [0, -0.78322]])
})

describe('orbRestingPhi', () => {
  it('keeps the decorative resting gaze stable per seed', () => {
    expect(orbRestingPhi('abc')).toBe(orbRestingPhi('abc'))
    expect(orbRestingPhi('abc')).toBeGreaterThanOrEqual(-240)
    expect(orbRestingPhi('abc')).toBeLessThan(60)
  })
})
