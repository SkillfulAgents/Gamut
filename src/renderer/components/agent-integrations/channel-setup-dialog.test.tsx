// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { ChannelSetupDialog } from './channel-setup-dialog'
import type { IntegrationSetupProvider } from './setup-types'

const defer = vi.hoisted(() => vi.fn())
vi.mock('@renderer/hooks/use-finished-setup', () => ({ useSetChannelDeferred: () => ({ mutate: defer, isPending: false }) }))

afterEach(cleanup)

const provider: IntegrationSetupProvider = {
  slug: 'slack', label: 'Slack', description: '', Setup: () => null, ConnectionSettings: () => <p>connection settings</p>,
}
const pending = { id: 'pending-slack', provider: 'slack', hasCredentials: false } as PublicAgentIntegration

it('saves a pending installation for later unless another installation already completes the channel', () => {
  const target = { provider, integrationId: pending.id }
  const view = render(<ChannelSetupDialog agentSlug="a" target={target} integrations={[pending]} onClose={vi.fn()} />)
  expect(screen.getByText('connection settings')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Set this up later' }))
  expect(defer).toHaveBeenCalledWith({ provider: 'slack', deferred: true }, expect.anything())
  const connected = { ...pending, id: 'connected-slack', hasCredentials: true }
  view.rerender(<ChannelSetupDialog agentSlug="a" target={target} integrations={[pending, connected]} onClose={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Set this up later' })).toBeNull()
})
