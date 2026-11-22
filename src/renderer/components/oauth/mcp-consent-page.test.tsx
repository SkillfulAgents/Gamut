// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import { McpConsentPage } from './mcp-consent-page'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ user: { email: 'member@example.com' } }) }))

const mockApiFetch = vi.mocked(apiFetch)
const assign = vi.fn()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function open(query: Record<string, string>) {
  const search = `?${new URLSearchParams({ sig: 'signed', exp: String(Math.floor(Date.now() / 1000) + 600), ...query })}`
  window.history.replaceState(null, '', `/oauth/consent${search}`)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><McpConsentPage /></QueryClientProvider>)
}

let consentBodies: Array<Record<string, unknown>>
let client: Record<string, unknown>

beforeEach(() => {
  consentBodies = []
  client = { clientId: 'c1', name: '<img src=x onerror=alert(1)>', registration: 'dynamic', documentHost: null, redirectHost: '127.0.0.1 (this computer)', redirectHosts: [] }
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, get search() { return globalThis.document.location.search } } })
  mockApiFetch.mockReset()
  mockApiFetch.mockImplementation(async (path, init) => {
    if (path.startsWith('/api/mcp-server/oauth/consent-client')) return json(client)
    if (path === '/api/auth/oauth2/consent') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      consentBodies.push(body)
      return json({ redirect: true, url: body.accept ? 'http://127.0.0.1:5555/callback?code=abc' : 'http://127.0.0.1:5555/callback?error=access_denied' })
    }
    throw new Error(`Unexpected ${path}`)
  })
})

afterEach(() => {
  assign.mockReset()
})

describe('McpConsentPage', () => {
  it('names the client as text, shows where it returns, and warns about running agents', async () => {
    open({ client_id: 'c1', scope: 'gamut:read gamut:run offline_access', redirect_uri: 'http://127.0.0.1:5555/callback' })
    expect(await screen.findByTestId('mcp-consent-client-name')).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByTestId('mcp-consent-redirect-host')).toHaveTextContent('127.0.0.1 (this computer)')
    expect(screen.getByTestId('mcp-consent-verification')).toHaveTextContent('cannot verify this app')
    expect(screen.getByTestId('mcp-consent-run-warning')).toHaveTextContent('act with the accounts connected to them')
  })

  it('approves with the scopes left ticked, and follows the redirect', async () => {
    open({ client_id: 'c1', scope: 'gamut:read gamut:run offline_access' })
    fireEvent.click(await screen.findByTestId('mcp-consent-scope-run'))
    expect(screen.queryByTestId('mcp-consent-run-warning')).toBeNull()
    fireEvent.click(screen.getByTestId('mcp-consent-allow'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5555/callback?code=abc'))
    expect(consentBodies[0]).toMatchObject({ accept: true, scope: 'gamut:read offline_access' })
    expect(String(consentBodies[0].oauth_query)).toContain('sig=signed')
  })

  it('denies, which sends access_denied back to the client', async () => {
    open({ client_id: 'c1', scope: 'gamut:read gamut:run offline_access' })
    fireEvent.click(await screen.findByTestId('mcp-consent-deny'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5555/callback?error=access_denied'))
    expect(consentBodies[0]).toMatchObject({ accept: false })
  })

  it('names the document host of a metadata-document client', async () => {
    client = { ...client, name: 'Doc Client', registration: 'metadata-document', documentHost: 'claude.ai' }
    open({ client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', scope: 'gamut:read' })
    expect(await screen.findByTestId('mcp-consent-verification')).toHaveTextContent('claude.ai')
    expect(screen.queryByTestId('mcp-consent-scope-run')).toBeNull()
  })

  it('grants only what was asked: a run-only request has no Read row and sends no read scope', async () => {
    open({ client_id: 'c1', scope: 'gamut:run offline_access' })
    await screen.findByTestId('mcp-consent-scope-run')
    expect(screen.queryByTestId('mcp-consent-scope-read')).toBeNull()
    fireEvent.click(screen.getByTestId('mcp-consent-allow'))
    await waitFor(() => expect(consentBodies[0]).toMatchObject({ accept: true, scope: 'gamut:run offline_access' }))
  })

  it('cannot approve a run-only request with run unticked, and shows nothing to approve without an MCP scope', async () => {
    open({ client_id: 'c1', scope: 'gamut:run offline_access' })
    fireEvent.click(await screen.findByTestId('mcp-consent-scope-run'))
    expect(screen.getByTestId('mcp-consent-allow')).toBeDisabled()
    open({ client_id: 'c1', scope: 'openid profile' })
    expect((await screen.findAllByTestId('mcp-consent-problem')).at(-1)).toHaveTextContent('no Gamut permission')
  })

  it('says a request expired, or is missing, without asking anything', async () => {
    open({ client_id: 'c1', exp: '1' })
    expect(await screen.findByTestId('mcp-consent-problem')).toHaveTextContent('last ten minutes')
    window.history.replaceState(null, '', '/oauth/consent')
    const client = new QueryClient()
    render(<QueryClientProvider client={client}><McpConsentPage /></QueryClientProvider>)
    expect(screen.getAllByTestId('mcp-consent-problem').at(-1)).toHaveTextContent('Start the connection again')
  })
})
