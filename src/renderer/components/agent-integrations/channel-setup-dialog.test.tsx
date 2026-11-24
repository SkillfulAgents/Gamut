// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { ChannelSetupDialog } from './channel-setup-dialog'
import type { IntegrationSetupProvider } from './setup-types'

vi.mock('@renderer/hooks/use-finished-setup', () => ({ useSetChannelDeferred: () => ({ mutate: vi.fn(), isPending: false }) }))

afterEach(cleanup)

const provider: IntegrationSetupProvider = {
  slug: 'slack', label: 'Slack', description: '', Setup: () => null, ConnectionSettings: () => <p>connection settings</p>,
}
const pending = { id: 'pending-slack', provider: 'slack', hasCredentials: false } as PublicAgentIntegration

it('offers Set this up later when finishing an installation only where the dialog allows it', () => {
  const target = { provider, integrationId: pending.id }
  const view = render(<ChannelSetupDialog agentSlug="a" target={target} integrations={[pending]} onClose={vi.fn()} />)
  expect(screen.getByText('connection settings')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Set this up later' })).toBeNull()
  view.rerender(<ChannelSetupDialog agentSlug="a" target={target} integrations={[pending]} onClose={vi.fn()} allowDefer />)
  expect(screen.getByRole('button', { name: 'Set this up later' })).toBeInTheDocument()
})
