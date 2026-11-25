// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { EmailSettingsCard } from './email-settings-card'
import { EmailIntegrationSetupForm } from './email-integration-setup-form'


const state = vi.hoisted(() => ({
  setupError: null as Error | null,
  emailDomain: undefined as string | undefined,
  agentName: 'Assistant' as string | undefined,
  create: vi.fn(),
  update: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: state.agentName ? { name: state.agentName } : undefined }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { connected: true } }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, user: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrationSetup: () => ({
    error: state.setupError,
    data: state.emailDomain ? { emailDomain: state.emailDomain, agentUserEmails: ['owner@example.com'] } : undefined,
    isPending: false,
  }),
  useUpdateAgentIntegration: () => ({ mutate: state.update, isPending: false }),
  useCreateAgentIntegration: () => ({ mutateAsync: state.create, isPending: false }),
}))

beforeEach(() => { vi.clearAllMocks(); state.setupError = null; state.emailDomain = undefined; state.agentName = 'Assistant' })
afterEach(cleanup)
function renderSetup() {
  return render(<Dialog open><DialogContent><EmailIntegrationSetupForm agentSlug="agent" onClose={vi.fn()} /></DialogContent></Dialog>)
}

it('shows the discovery failure before creating an inbox', () => {
  state.setupError = new Error('Platform deployment discovery unavailable')
  renderSetup()
  expect(screen.getByRole('alert')).toHaveTextContent(state.setupError.message)
  expect(state.create).not.toHaveBeenCalled()
})

it('shows the address, the name beside its domain, without an error after discovery succeeds', () => {
  state.emailDomain = 'company.ongamut.so'
  renderSetup()
  expect(screen.getByLabelText(/^Email address/)).toHaveValue('assistant')
  expect(screen.getByLabelText(/^Email address/)).toHaveAccessibleDescription('@company.ongamut.so This can’t be changed later.')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(state.create).not.toHaveBeenCalled()
})

it('asks for the address, then the sender name, then who it talks to', () => {
  state.emailDomain = 'company.ongamut.so'
  renderSetup()
  const step = () => screen.getByTestId('integration-setup-step')
  expect(step()).toHaveAttribute('data-step', '1')
  expect(screen.getByRole('textbox', { name: /^Email address/ })).toHaveValue('assistant')
  expect(screen.queryByRole('textbox', { name: 'Sender name' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('integration-setup-next'))
  expect(step()).toHaveAttribute('data-step', '2')
  expect(screen.getByRole('textbox', { name: 'Sender name' })).toHaveValue('Assistant')
  expect(screen.queryByRole('textbox', { name: /^Email address/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('integration-setup-next'))
  expect(step()).toHaveAttribute('data-step', '3')
  expect(screen.getByTestId('integration-setup-finish')).toHaveTextContent('Create inbox')
})

it('previews the sender name as an inbox row, following the field as it is typed', () => {
  renderSetup()
  fireEvent.click(screen.getByTestId('integration-setup-next'))
  expect(screen.getByTestId('email-sender-preview')).toHaveTextContent('Assistant')
  fireEvent.change(screen.getByRole('textbox', { name: 'Sender name' }), { target: { value: 'Outbound Sales Guru' } })
  expect(screen.getByTestId('email-sender-preview')).toHaveTextContent('Outbound Sales Guru')
  fireEvent.change(screen.getByRole('textbox', { name: 'Sender name' }), { target: { value: '  ' } })
  expect(screen.getByTestId('email-sender-preview')).toHaveTextContent('Assistant')
})

it('follows the agent name when it loads and preserves an edited sender on refresh', () => {
  state.agentName = undefined
  const form = () => <Dialog open><DialogContent><EmailIntegrationSetupForm agentSlug="agent" onClose={vi.fn()} /></DialogContent></Dialog>
  const view = render(form())
  fireEvent.click(screen.getByRole('button', { name: 'Name the sender' }))
  const name = screen.getByLabelText('Sender name')
  expect(name).toHaveValue('agent')
  state.agentName = 'Support Agent'
  view.rerender(form())
  expect(name).toHaveValue('Support Agent')
  fireEvent.change(name, { target: { value: 'Help Desk' } })
  state.agentName = 'Renamed Agent'
  view.rerender(form())
  expect(name).toHaveValue('Help Desk')
})

it('says in the button row that mail failing sender checks is rejected, except for an inbox open to anyone', async () => {
  state.emailDomain = 'company.ongamut.so'
  renderSetup()
  fireEvent.click(screen.getByTestId('integration-setup-next'))
  fireEvent.click(screen.getByTestId('integration-setup-next'))
  const footer = screen.getByTestId('integration-setup-finish').closest('footer')!
  expect(footer).toHaveTextContent('Mail that fails sender checks is rejected.')
  const user = userEvent.setup()
  await user.click(screen.getByTestId('email-access-anyone'))
  expect(footer).not.toHaveTextContent('sender checks')
})

it.each(['setup', 'settings'])('requires the whole visible domain list to be valid in %s', surface => {
  state.create.mockResolvedValue({ id: 'email' })
  if (surface === 'setup') {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: 'Choose who it talks to' }))
    fireEvent.click(screen.getByTestId('email-access-allowed-domains'))
  } else {
    const integration = { id: 'email', agentSlug: 'agent', settings: {
      address: 'agent@company.org', accessLevel: 'allowed-domains', allowedDomains: [],
    } } as unknown as PublicAgentIntegration
    render(<EmailSettingsCard integration={integration} canManageAccess />)
  }
  const input = screen.getByLabelText('Allowed domains')
  const save = screen.getByRole('button', { name: surface === 'setup' ? 'Create inbox' : 'Save email access' })
  const mutation = surface === 'setup' ? state.create : state.update
  fireEvent.change(input, { target: { value: 'first.example, invalid' } })
  expect(input).toHaveValue('invalid')
  expect(save).toBeDisabled()
  fireEvent.click(save)
  expect(mutation).not.toHaveBeenCalled()
  // The corrected draft counts even when submission beats blur.
  fireEvent.change(input, { target: { value: 'https://directory.example/people/contact@customer.example' } })
  fireEvent.click(save)
  expect(mutation.mock.calls[0][0].config.allowedDomains).toEqual(['first.example', 'directory.example'])
})

it('keeps overflow editable and saves the chosen 50 domains after one is removed', () => {
  state.create.mockResolvedValue({ id: 'email' })
  renderSetup()
  fireEvent.click(screen.getByRole('button', { name: 'Choose who it talks to' }))
  fireEvent.click(screen.getByTestId('email-access-allowed-domains'))
  const input = screen.getByLabelText('Allowed domains')
  const entries = Array.from({ length: 51 }, (_, i) => `team${i}.example`)
  fireEvent.change(input, { target: { value: entries.join(', ') } })
  expect(input).toHaveValue(entries[50])
  expect(input).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('50 domains')
  const create = screen.getByRole('button', { name: 'Create inbox' })
  expect(create).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Remove team0.example' }))
  fireEvent.click(create)
  expect(state.create.mock.calls[0][0].config.allowedDomains).toEqual(entries.slice(1))
})
