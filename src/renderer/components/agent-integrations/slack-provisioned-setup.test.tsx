// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const AGENT = { slug: 'a', name: 'Infra Agent', description: 'Keeps the servers up', avatar: null }
const state = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body: any }>,
  provisioning: true as boolean,
  installed: false,
  rejectPatch: false,
  relay: true,
}))
const pending = () => makeChatIntegration({
  id: 'int-9', provider: 'slack', status: state.installed ? 'active' : 'disconnected', hasCredentials: state.installed,
  slack: { botTokenSaved: state.installed, appTokenSaved: false, signingSecretSaved: true, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } },
  provisionedApp: { directoryId: 'dir-1', installed: state.installed, name: 'Infra Agent', iconSet: false },
})
vi.mock('@renderer/lib/api', () => {
  const apiFetch = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/webhook-relay') return Response.json(state.relay ? { available: true } : { available: false, unavailableReason: 'not_configured' })
    if (url === '/api/agents/a') return Response.json(AGENT)
    if (url.startsWith('/api/agent-integrations/agents/a/providers/slack/setup')) {
      return Response.json(state.provisioning ? { transports: ['relay', 'direct'], provisioning: { directoryId: 'dir-1', workspace: 'Acme' } } : { transports: ['relay', 'direct'] })
    }
    if (url === '/api/agent-integrations/agents/a' && method === 'POST') return Response.json(pending(), { status: 201 })
    if (url === '/api/agent-integrations/int-9/authorize') return Response.json({ url: 'https://slack.com/oauth/v2/authorize?client_id=1&state=s' })
    if (method === 'PATCH' && state.rejectPatch) return Response.json({ error: 'Settings unavailable' }, { status: 503 })
    if (url === '/api/agent-integrations/int-9') return Response.json(pending())
    return Response.json(makeChatIntegration({ provider: 'slack' }))
  }
  return { apiFetch, apiJson: async (url: string) => (await apiFetch(url)).json() }
})
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
import { SlackSetup } from './slack-setup'

let client: QueryClient
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const setup = () => render(<Dialog open><DialogContent><SlackSetup agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { requests: [], provisioning: true, installed: false, relay: true, rejectPatch: false })
})

describe('Slack setup through a team directory', () => {
  it('creates the agent’s app, then installs it with one click', async () => {
    setup()
    expect(await screen.findByTestId('slack-provisioned-setup')).toHaveTextContent('Gamut creates this agent’s Slack app in Acme')
    // One step per screen: installing waits on its own step until the app exists.
    fireEvent.click(screen.getByRole('button', { name: 'Install the app' }))
    expect(screen.getByTestId('slack-provisioned-install')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Create the app' }))

    await waitFor(() => expect(screen.getByTestId('slack-provisioned-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-create'))
    // Creating the app moves on to its options; unchanged, they need no saving.
    await screen.findByRole('switch', { name: /Reply in thread/ })
    // Once created, this installation still belongs to the directory if relay availability changes.
    state.relay = false
    await client.invalidateQueries({ queryKey: ['webhook-relay'] })
    fireEvent.click(screen.getByTestId('integration-setup-next'))
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-created')).toHaveTextContent('App created in Acme'))
    expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/agents/a', method: 'POST', body: expect.objectContaining({
      provider: 'slack',
      config: expect.objectContaining({ webhooks: true, provision: { directoryId: 'dir-1', name: 'Infra Agent', description: 'Keeps the servers up' } }),
    }) })

    await waitFor(() => expect(screen.getByTestId('slack-provisioned-install')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-install'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?client_id=1&state=s'))
    expect(state.requests.at(-1)).toMatchObject({ url: '/api/agent-integrations/int-9/authorize', method: 'POST' })

    // The install lands in the other window; the dialog closes when the integration reports it.
    state.installed = true
    await client.invalidateQueries()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it.each(['Continue', 'Install the app'])('saves edited behavior before installation via %s', async navigation => {
    setup()
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-create')).toBeEnabled())
    const name = screen.getByLabelText('App name')
    expect(name).toHaveValue('Infra Agent')
    fireEvent.change(name, { target: { value: 'Infra Support' } })
    fireEvent.click(screen.getByTestId('slack-provisioned-create'))
    const mention = await screen.findByRole('switch', { name: /Only respond when @mentioned/ })
    expect(state.requests[0].body).toMatchObject({ name: 'Infra Support', config: { provision: { name: 'Infra Support' } } })
    fireEvent.click(mention)
    fireEvent.click(screen.getByRole('switch', { name: /Show tool calls/ }))
    fireEvent.click(screen.getByRole('button', { name: navigation }))
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-install')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-install'))
    await waitFor(() => expect(state.requests).toHaveLength(3))
    expect(state.requests.slice(1)).toMatchObject([
      { method: 'PATCH', body: { config: { onlyMentioned: false }, showToolCalls: true } },
      { method: 'POST', url: '/api/agent-integrations/int-9/authorize' },
    ])
  })

  it('keeps a failed edit available for retry before authorizing', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-create'))
    fireEvent.click(await screen.findByRole('switch', { name: /Only respond when @mentioned/ }))
    state.rejectPatch = true
    fireEvent.click(screen.getByRole('button', { name: 'Install the app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings unavailable')
    expect(screen.getByRole('switch', { name: /Only respond when @mentioned/ })).not.toBeChecked()
    expect(state.requests.some(request => request.url.endsWith('/authorize'))).toBe(false)
    state.rejectPatch = false
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-install')).toBeEnabled())
  })

  it('keeps the manual setup a click away', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText('App name'), { target: { value: 'Escalations' } })
    fireEvent.click(screen.getByTestId('slack-setup-manually'))
    expect(await screen.findByTestId('slack-create-app')).toBeInTheDocument()
    expect(screen.getByLabelText('App name')).toHaveValue('Escalations')
    fireEvent.click(screen.getByTestId('slack-webhooks-choice'))
    const manifest = await screen.findByTestId('slack-manifest')
    expect(JSON.parse(manifest.textContent!).display_information.name).toBe('Escalations')
    fireEvent.click(screen.getByTestId('slack-webhooks-choice'))
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    const url = new URL(fakeLoginWindow.navigate.mock.calls[0][0])
    expect(JSON.parse(url.searchParams.get('manifest_json')!).features.bot_user.display_name).toBe('Escalations')
    expect(state.requests[0].body.name).toBe('Escalations')
  })

  it('is the manual setup when no directory can create apps', async () => {
    state.provisioning = false
    setup()
    expect(await screen.findByTestId('slack-create-app')).toBeInTheDocument()
    expect(screen.queryByTestId('slack-provisioned-setup')).toBeNull()
    expect(screen.queryByTestId('slack-provisioning-needs-relay')).toBeNull()
  })

  it('says why the setup is by hand when a directory could create the app but this host has no relay', async () => {
    state.relay = false
    setup()
    expect(await screen.findByTestId('slack-provisioning-needs-relay')).toHaveTextContent('One-click setup through Acme needs a webhook relay')
    expect(screen.queryByTestId('slack-provisioned-setup')).toBeNull()
  })
})
