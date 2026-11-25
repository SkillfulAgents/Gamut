// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { PublicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const AGENT = { slug: 'a', name: 'Infra Agent', description: 'Keeps the servers up', avatar: { color: 'tonal-amber', shape: 'circle' } }
const state = vi.hoisted(() => ({ relayAvailable: true, requests: [] as Array<{ url: string; method: string; body: any }>, agent: null as unknown }))
vi.mock('@renderer/lib/api', () => {
  const apiFetch = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/webhook-relay') return Response.json({ available: state.relayAvailable })
    if (url === '/api/agents/a') return Response.json(state.agent)
    if (url === '/api/agent-integrations/agents/a' && method === 'POST') {
      return Response.json(makeChatIntegration({ id: 'int-9', provider: 'slack', status: 'disconnected', hasCredentials: false,
        slack: { botTokenSaved: false, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } } }), { status: 201 })
    }
    return Response.json(makeChatIntegration({ provider: 'slack' }))
  }
  return { apiFetch, apiJson: async (url: string) => (await apiFetch(url)).json() }
})
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
import { SlackConnectionSettings, SlackSetup } from './slack-setup'
import { slackBackgroundColor } from './slack-app-identity'
import { SlackAppAppearanceCard } from './slack-app-appearance'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'

let client: QueryClient
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const setup = () => render(<Dialog open><DialogContent><SlackSetup agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { relayAvailable: true, requests: [], agent: AGENT })
})

// A setup is one step per screen: these move between them, or jump to one by its name in the rail.
const next = () => fireEvent.click(screen.getByTestId('integration-setup-next'))
const goTo = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
/** The step on screen: the others stay mounted, hidden. */
const step = () => screen.getByTestId('integration-setup-step')

describe('SlackSetup', () => {
  it('sends an explicit off for threading turned off at setup, so the server default does not turn it back on', async () => {
    setup()
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    fireEvent.change(await screen.findByLabelText('Signing Secret'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    // The options are a step of their own, sent with Connect.
    goTo('Review settings')
    fireEvent.click(screen.getByRole('switch', { name: /Reply in thread/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(state.requests[1]).toBeDefined())
    expect(state.requests[1].body.config).toMatchObject({ answerInThread: false, newSessionPerThread: false })
  })

  it('with a relay, creates the installation first and opens Slack with the webhook URL in the manifest', async () => {
    setup()
    await screen.findByTestId('slack-create-app')
    // No Socket Mode token to paste, and nothing to paste into until the app exists.
    expect(screen.queryByRole('button', { name: 'Paste the app token' })).toBeNull()
    goTo('Paste the bot token')
    expect(screen.getByLabelText('Bot Token')).toBeDisabled()
    goTo('Review settings')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    goTo('Create the app')

    fireEvent.click(screen.getByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/agents/a', method: 'POST', body: expect.objectContaining({ provider: 'slack', config: { webhooks: true, onlyMentioned: true, answerInThread: true, newSessionPerThread: true } }) })
    const opened = new URL(fakeLoginWindow.navigate.mock.calls[0][0])
    expect(opened.origin + opened.pathname).toBe('https://api.slack.com/apps')
    expect(JSON.parse(opened.searchParams.get('manifest_json')!)).toMatchObject({
      display_information: { name: 'Infra Agent' },
      settings: { socket_mode_enabled: false, event_subscriptions: { request_url: 'https://relay.test/v1/hooks/whep_1' }, interactivity: { request_url: 'https://relay.test/v1/hooks/whep_1' } },
    })
    // Creating the app moves on to its Signing Secret. Back on the first step, the choice is fixed once the installation exists.
    await screen.findByLabelText('Signing Secret')
    goTo('Create the app')
    expect(screen.getByTestId('slack-webhooks-choice')).toBeDisabled()

    goTo('Paste the secret')
    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    goTo('Paste the bot token')
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    goTo('Review settings')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(state.requests[1]).toEqual({ url: '/api/agent-integrations/int-9', method: 'PATCH', body: { status: 'active', showToolCalls: false, sessionTimeout: 6, config: { botToken: 'xoxb-1', signingSecret: 'secret', onlyMentioned: true, answerInThread: true, newSessionPerThread: true } } })
  })

  it('names the Slack app and its bot after the agent, in its colour, and offers its icon', async () => {
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    expect(state.requests[0].body.name).toBeUndefined()
    const manifest = JSON.parse(new URL(fakeLoginWindow.navigate.mock.calls[0][0]).searchParams.get('manifest_json')!)
    expect(manifest.display_information).toEqual({ name: 'Infra Agent', description: 'Keeps the servers up', background_color: slackBackgroundColor(avatarSource(AGENT.avatar as AgentAvatar).orb) })
    expect(manifest.features.bot_user.display_name).toBe('Infra Agent')
  })

  it('gives the icon a step of its own, after the secret copied from the same page in Slack', async () => {
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    // There before the app is: the download needs nothing from Slack.
    await screen.findByTestId('slack-create-app')
    const rail = Array.from(document.querySelectorAll('[role=dialog] aside ol button')).map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(rail.map(label => label?.replace(/^\d+/, ''))).toEqual(['Create the app', 'Paste the secret', 'Add the icon', 'Paste the bot token', 'Review settings'])
    goTo('Add the icon')
    expect(step()).toHaveAttribute('data-step', '3')
    expect(screen.getByTestId('slack-app-icon-download')).toHaveTextContent('Download icon')
    // Beside it, the picture it saves: the icon's own SVG, on its ground.
    expect(screen.getByTestId('slack-app-icon-thumbnail').getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    // The preview shows the app as Slack will: this agent's name beside its icon.
    expect(screen.getByTestId('slack-app-icon-preview').parentElement).toHaveTextContent('Infra Agent')
    // The manifest already carries the colour, so only an app made from scratch is told to set it.
    expect(step()).not.toHaveTextContent('background color')
    // Optional: the step moves on without it.
    next()
    expect(step()).toHaveAttribute('data-step', '4')
  })

  it('falls back to Gamut Bot, with no colour or icon, for an agent without an avatar', async () => {
    state.agent = { slug: 'a', name: '', avatar: null }
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    const manifest = JSON.parse(new URL(fakeLoginWindow.navigate.mock.calls[0][0]).searchParams.get('manifest_json')!)
    expect(manifest.display_information).toEqual({ name: 'Gamut Bot' })
    expect(screen.queryByTestId('slack-app-icon-download')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add the icon' })).toBeNull()
  })

  it('keeps a created installation’s form while the relay goes away and comes back', async () => {
    setup()
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    fireEvent.change(await screen.findByLabelText('Signing Secret'), { target: { value: 'secret' } })
    goTo('Create the app')
    state.relayAvailable = false
    await client.invalidateQueries({ queryKey: ['webhook-relay'] })
    await waitFor(() => expect(screen.queryByTestId('slack-webhooks-choice')).toBeNull())
    // Still the webhook setup's steps, not Socket Mode's.
    expect(screen.queryByRole('button', { name: 'Paste the app token' })).toBeNull()
    next()
    expect(screen.getByLabelText('Signing Secret')).toHaveValue('secret')
    goTo('Create the app')
    state.relayAvailable = true
    await client.invalidateQueries({ queryKey: ['webhook-relay'] })
    await screen.findByTestId('slack-webhooks-choice')
    // The Slack app already targets the first installation's URL.
    expect(screen.getByTestId('slack-setup-webhook-url')).toHaveTextContent('https://relay.test/v1/hooks/whep_1')
    next()
    expect(screen.getByLabelText('Signing Secret')).toHaveValue('secret')
    next()
    expect(screen.getByLabelText('Bot Token')).toBeEnabled()
    expect(state.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('uses Socket Mode without a relay, or when webhooks are turned off', async () => {
    state.relayAvailable = false
    // Socket Mode's steps: the manifest, the app, then a token each.
    const view = setup()
    await screen.findByTestId('integration-setup-wizard')
    next(); next()
    expect(screen.getByLabelText('App-Level Token')).toBeInTheDocument()
    next()
    expect(screen.getByLabelText('Bot Token')).toBeInTheDocument()
    expect(screen.queryByTestId('slack-webhooks-choice')).toBeNull()
    view.unmount()

    state.relayAvailable = true
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    setup()
    fireEvent.click(await screen.findByTestId('slack-webhooks-choice'))
    await screen.findByTestId('integration-setup-wizard')
    // The Socket Mode setup opens on its first step, where the choice still is.
    expect(screen.getByTestId('slack-webhooks-choice')).not.toBeChecked()
    next(); next()
    expect(screen.getByLabelText('App-Level Token')).toBeInTheDocument()
  })

  it('shows the manifest from the start, with a copy button on it', async () => {
    state.relayAvailable = false
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    // No button to reveal it: the manifest is there to read.
    const manifest = await screen.findByTestId('slack-manifest')
    await waitFor(() => expect(JSON.parse(manifest.textContent!).display_information.name).toBe('Infra Agent'))
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy manifest' }))
    await waitFor(() => expect(screen.getByTestId('slack-manifest-copy')).toHaveTextContent('Copied'))
    expect(writeText).toHaveBeenCalledWith(manifest.textContent)
  })

  it.each(['manifest', 'from scratch'])('connects a named Socket Mode app set up %s', async mode => {
    state.relayAvailable = false
    setup()
    const name = await screen.findByLabelText('App name')
    fireEvent.change(name, { target: { value: 'Support Desk' } })
    if (mode === 'from scratch') {
      fireEvent.click(screen.getByRole('button', { name: 'Set up from scratch' }))
      expect(screen.getByLabelText('App name')).toHaveValue('Support Desk')
    } else {
      const manifest = JSON.parse(screen.getByTestId('slack-manifest').textContent!)
      expect(manifest.features.bot_user.display_name).toBe('Support Desk')
    }
    goTo('Paste the app token')
    fireEvent.change(screen.getByLabelText('App-Level Token'), { target: { value: 'xapp-fixture' } })
    goTo('Paste the bot token')
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-fixture' } })
    goTo('Review settings')
    fireEvent.click(screen.getByRole('switch', { name: 'Only respond when @mentioned' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].body).toMatchObject({ provider: 'slack', name: 'Support Desk' })
    expect(state.requests[0].body.config).toEqual({
      appToken: 'xapp-fixture', botToken: 'xoxb-fixture', onlyMentioned: false, answerInThread: true, newSessionPerThread: true,
    })
  })

  it('has the icon step in both Socket Mode setups, with the colour for an app made from scratch', async () => {
    state.relayAvailable = false
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    const color = slackBackgroundColor(avatarSource(AGENT.avatar as AgentAvatar).orb)
    // From a manifest: after the app token, which comes from the same page.
    goTo('Add the icon')
    expect(step()).toHaveAttribute('data-step', '4')
    expect(screen.getByTestId('slack-app-icon-download')).toBeInTheDocument()
    expect(screen.queryByText(color)).toBeNull()

    goTo('Copy the manifest')
    fireEvent.click(screen.getByRole('button', { name: 'Set up from scratch' }))
    goTo('Add the icon')
    expect(step()).toHaveAttribute('data-step', '4')
    expect(step()).toHaveTextContent('and set the background color')
    expect(screen.getByText(color)).toBeInTheDocument()
  })
})

describe('SlackConnectionSettings', () => {
  const integration = (delivery: Partial<PublicSlackDelivery>) => makeChatIntegration({ id: 'int-9', name: 'Helper', provider: 'slack',
    slack: { botTokenSaved: false, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' }, ...delivery } })

  it('finishes an installation whose app setup stopped partway', async () => {
    render(<SlackConnectionSettings integration={integration({})} />, { wrapper })
    expect(screen.getByRole('link', { name: 'Create app in Slack' }).getAttribute('href')).toContain('manifest_json=')
    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(state.requests).toEqual([{ url: '/api/agent-integrations/int-9', method: 'PATCH', body: { status: 'active', config: { botToken: 'xoxb-1', signingSecret: 'secret' } } }]))
  })

  it('shows nothing once the app is connected', () => {
    const { container } = render(<SlackConnectionSettings integration={integration({ botTokenSaved: true })} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SlackAppAppearanceCard', () => {
  const integration = (botTokenSaved: boolean) => makeChatIntegration({ provider: 'slack',
    slack: { botTokenSaved, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: botTokenSaved ? 'verified' : 'pending' } } })

  it('offers a connected app the agent’s icon and colour', async () => {
    render(<SlackAppAppearanceCard integration={integration(true)} />, { wrapper })
    expect(await screen.findByTestId('slack-app-icon-download')).toBeInTheDocument()
    expect(screen.getByTestId('slack-app-appearance')).toHaveTextContent(slackBackgroundColor(avatarSource(AGENT.avatar as AgentAvatar).orb))
  })

  it('leaves an app still being set up to its setup steps', async () => {
    const { container } = render(<SlackAppAppearanceCard integration={integration(false)} />, { wrapper })
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    expect(container).toBeEmptyDOMElement()
  })
})
