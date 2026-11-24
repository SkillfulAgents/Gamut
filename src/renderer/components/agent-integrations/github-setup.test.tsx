// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { agentIntegrationKeys } from '@renderer/hooks/use-agent-integrations'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import { makeChatIntegration } from './test-factories'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.request }))
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Release Assistant' } }) }))
import { GitHubSetupForm, GitHubConnectionSettings } from './github-setup'
let client: QueryClient
let connected: boolean
let failAuthorization: boolean
const onClose = vi.fn()
const integration = () => ({ ...makeChatIntegration(), id: 'github-1', agentSlug: 'a', provider: 'github', settings: {}, hasCredentials: connected, authorizationPendingUntil: connected ? undefined : Date.now() + 900000 })
const creates = () => mocks.request.mock.calls.filter(([url, options]) => url === '/api/agent-integrations/agents/a' && options?.method === 'POST')
function renderForm() { return render(<QueryClientProvider client={client}><Dialog open><DialogContent><GitHubSetupForm agentSlug="a" onClose={onClose} /></DialogContent></Dialog></QueryClientProvider>) }
beforeEach(() => {
  vi.clearAllMocks(); connected = false; failAuthorization = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  mocks.request.mockImplementation(async (url: string) => {
    if (url.includes('/providers/github/setup?')) return Response.json({ transports: ['relay'] })
    if (url.endsWith('/authorize')) return failAuthorization ? Response.json({ error: 'Relay unavailable' }, { status: 400 }) : Response.json({ url: 'https://host.test/api/agent-integrations/providers/github/launch?state=valid' })
    return Response.json(integration())
  })
})
afterEach(() => client.clear())
// The account is chosen first; creating the app is the step after it.
const next = () => fireEvent.click(screen.getByTestId('integration-setup-next'))
it('uses the shared modal and creates nothing until the user continues', async () => {
  renderForm()
  expect(screen.getByTestId('integration-setup-wizard')).toBeInTheDocument()
  // No name to fill in: the app is named after the agent, and can be renamed later.
  expect(screen.queryByLabelText('Integration name')).toBeNull()
  // Their own account unless they say otherwise, with no name to type for it.
  expect(screen.getByRole('radio', { name: 'Your personal account' })).toBeChecked()
  expect(screen.queryByLabelText('Organization name')).toBeNull()
  next()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  expect(creates()).toHaveLength(0)
})
it('launches the manifest flow and moves on to mentioning it only when the callback has completed installation', async () => {
  renderForm()
  fireEvent.click(screen.getByRole('radio', { name: 'An organization' }))
  // An organization needs its name before the setup can move on.
  expect(screen.getByTestId('integration-setup-next')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: ' team ' } })
  next()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith(expect.stringContaining('/providers/github/launch?state=')))
  expect(JSON.parse(creates()[0][1].body)).toMatchObject({ provider: 'github', name: 'Release Assistant', config: { organization: 'team' } })
  expect(onClose).not.toHaveBeenCalled()
  connected = true
  await client.invalidateQueries({ queryKey: agentIntegrationKeys.detail('github-1') })
  await waitFor(() => expect(screen.getByTestId('integration-setup-step')).toHaveAttribute('data-step', '3'))
  expect(fakeLoginWindow.close).toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(onClose).toHaveBeenCalledOnce()
})
it('retries setup on the same row after a failed authorization launch', async () => {
  failAuthorization = true; renderForm()
  next()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Relay unavailable')
  failAuthorization = false
  fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalled())
  expect(creates()).toHaveLength(1)
})
it('sends someone who skipped ahead back for the organization’s name, and forgets a name once the choice is their own account', async () => {
  renderForm()
  fireEvent.click(screen.getByRole('radio', { name: 'An organization' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create the app' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter the organization’s name first.')
  expect(screen.getByTestId('integration-setup-step')).toHaveAttribute('data-step', '1')
  expect(creates()).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'team' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Your personal account' }))
  next()
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  await waitFor(() => expect(creates()).toHaveLength(1))
  expect(JSON.parse(creates()[0][1].body).config).toEqual({})
})

it('shows the connected bot identity and reuses the same authorization flow for reconnect', async () => {
  render(<QueryClientProvider client={client}><GitHubConnectionSettings integration={{ ...makeChatIntegration(), id: 'github-1', agentSlug: 'a', provider: 'github', settings: { botLogin: 'release-helper[bot]', account: 'team', appUrl: 'https://github.com/apps/release-helper' } }} /></QueryClientProvider>)
  expect(screen.getByText('GitHub Account')).toBeInTheDocument()
  expect(screen.getByText('release-helper[bot] · team')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect GitHub' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith(expect.stringContaining('/providers/github/launch')))
  expect(creates()).toHaveLength(0)
})
