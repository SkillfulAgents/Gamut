/**
 * A test may replace the registry module with only what it uses. The module
 * that makes desktop's actors is loaded all the same (through the barrel), and
 * must load beside such a registry: it names the test default to a module of
 * its own, not to the registry.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./registry', () => ({
  agentRegistry: { get: (slug: string) => ({ slug, standIn: true }) },
}))

describe('the local actor beside a registry module a test replaced', () => {
  it('loads, and the test reaches its own registry', async () => {
    const agents = await import('./index')

    expect(agents.agentRegistry.get('sales-agent')).toEqual({ slug: 'sales-agent', standIn: true })
    expect(agents.createLocalAgentActor).toBeTypeOf('function')
  })
})
