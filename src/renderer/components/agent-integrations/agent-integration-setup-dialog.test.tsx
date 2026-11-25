// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentIntegrationSetupDialog } from './agent-integration-setup-dialog'
import type { IntegrationSetupProvider } from './setup-types'
import type { AgentIntegrationProvider } from '@shared/lib/agent-integrations/provider-types'

vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { slug: 'a', name: 'Recruiter', avatar: null } }) }))
vi.mock('@renderer/components/ui/displaced-dot-field', () => ({ DisplacedDotField: () => null }))
const defer = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('@renderer/hooks/use-finished-setup', () => ({ useSetChannelDeferred: () => ({ mutate: defer.mutate, isPending: false }) }))

afterEach(cleanup)

const provider = (slug: AgentIntegrationProvider): IntegrationSetupProvider => ({
  slug, label: slug, description: '', Setup: () => <p>steps for {slug}</p>,
})

it('opens on the integration’s intro, and Get started moves on to its steps', () => {
  render(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('telegram')} onOpenChange={vi.fn()} />)
  expect(screen.getByRole('dialog', { name: /Chat with this agent in Telegram/ })).toBeInTheDocument()
  expect(screen.queryByText('steps for telegram')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
  expect(screen.getByText('steps for telegram')).toBeInTheDocument()
})

it('starts at the intro again for another integration', () => {
  const view = render(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('telegram')} onOpenChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
  view.rerender(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('slack')} onOpenChange={vi.fn()} />)
  expect(screen.getByRole('dialog', { name: /Add this agent to Slack as a teammate/ })).toBeInTheDocument()
})

it('goes straight to the steps for an integration without an intro', () => {
  // Every provider today has one; a new provider added without one still opens on its steps.
  render(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('custom' as AgentIntegrationProvider)} onOpenChange={vi.fn()} />)
  expect(screen.getByText('steps for custom')).toBeInTheDocument()
})

it('offers Set this up later on the intro and the steps only when the dialog allows it', () => {
  const view = render(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('telegram')} onOpenChange={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Set this up later' })).toBeNull()
  view.rerender(<AgentIntegrationSetupDialog agentSlug="a" provider={provider('telegram')} allowDefer onOpenChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Set this up later' }))
  expect(defer.mutate).toHaveBeenCalledWith({ provider: 'telegram', deferred: true }, expect.anything())
})
