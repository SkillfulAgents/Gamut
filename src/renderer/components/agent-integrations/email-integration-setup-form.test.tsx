// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { EmailIntegrationSetupForm } from './email-integration-setup-form'


const state = vi.hoisted(() => ({
  setupError: null as Error | null,
  emailDomain: undefined as string | undefined,
  create: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Assistant' } }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { connected: true } }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, user: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrationSetup: () => ({
    error: state.setupError,
    data: state.emailDomain ? { emailDomain: state.emailDomain, agentUserEmails: ['owner@example.com'] } : undefined,
    isPending: false,
  }),
  useCreateAgentIntegration: () => ({ mutateAsync: state.create, isPending: false }),
}))

beforeEach(() => { vi.clearAllMocks(); state.setupError = null; state.emailDomain = undefined })
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
