// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import { claudeCodeSetup, codexSetup } from '@shared/lib/mcp-server/client-setup'
import { McpServerTab } from './mcp-server-tab'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
const user = vi.hoisted(() => ({ isAdmin: false, isAuthMode: false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => user }))

const mockApiFetch = vi.mocked(apiFetch)
const ENDPOINT = 'http://localhost:47891/mcp'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><McpServerTab /></QueryClientProvider>)
}

describe('McpServerTab', () => {
  let state: { available: boolean; enabled: boolean; endpointUrl: string; token: string | null }

  beforeEach(() => {
    state = { available: true, enabled: true, endpointUrl: ENDPOINT, token: 'gamut_mcp_first' }
    mockApiFetch.mockReset()
    mockApiFetch.mockImplementation(async (path, init) => {
      if (path === '/api/mcp-server') return json(state)
      if (path === '/api/mcp-server/enabled' && init?.method === 'PUT') {
        state = { ...state, enabled: JSON.parse(String(init.body)).enabled }
        return json(state)
      }
      if (path === '/api/mcp-server/token/regenerate' && init?.method === 'POST') {
        state = { ...state, token: 'gamut_mcp_second' }
        return json(state)
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
    })
  })

  it('shows the endpoint and copy-ready setup carrying the token', async () => {
    renderTab()
    expect(await screen.findByTestId('mcp-server-endpoint')).toHaveTextContent(ENDPOINT)
    expect(screen.getByTestId('mcp-setup-text-claude-code').textContent).toBe(claudeCodeSetup(ENDPOINT, 'gamut_mcp_first'))
    expect(screen.getByTestId('mcp-setup-text-codex').textContent).toBe(codexSetup(ENDPOINT, 'gamut_mcp_first'))
    expect(screen.getByTestId('mcp-setup-text-cursor').textContent).toContain('Bearer gamut_mcp_first')
  })

  it('turns the server off, and regenerates the token behind a confirmation', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('mcp-server-enabled-switch'))
    await waitFor(() => expect(screen.getByText(/Off: the endpoint does not answer/)).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('mcp-server-regenerate'))
    fireEvent.click(await screen.findByTestId('mcp-server-regenerate-confirm'))
    await waitFor(() => expect(screen.getByTestId('mcp-setup-text-claude-code').textContent).toContain('gamut_mcp_second'))
  })

  it('says so where the server is not available', async () => {
    state = { available: false, enabled: false, endpointUrl: ENDPOINT, token: null }
    renderTab()
    expect(await screen.findByTestId('mcp-server-unavailable')).toBeInTheDocument()
  })
})
