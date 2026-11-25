// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { apiFetch } from '@renderer/lib/api'
import { TelegramSetupForm } from './telegram-setup-form'

vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Support Agent' } }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
const api = vi.mocked(apiFetch)
beforeEach(() => { api.mockReset() })

function setup() {
  const close = vi.fn()
  render(<QueryClientProvider client={new QueryClient()}>
    <Dialog open><DialogContent><TelegramSetupForm agentSlug="a" onClose={close} /></DialogContent></Dialog>
  </QueryClientProvider>)
  return close
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const token = (value: string) => fireEvent.change(screen.getByLabelText('Paste the token BotFather sends back'), { target: { value } })
const nameField = () => screen.findByRole('textbox', { name: 'Integration name' })

it('keeps an empty or rejected token on the first step and lets Next retry', async () => {
  setup()
  token('   ')
  click('Next')
  expect(screen.getByRole('alert')).toHaveTextContent('Paste the bot token first.')
  expect(api).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Say hello' })).toBeDisabled()

  api.mockResolvedValueOnce(Response.json({ error: 'Invalid bot token' }, { status: 400 }))
  token('mistyped')
  click('Review settings')
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid bot token')
  expect(screen.getByTestId('integration-setup-step')).toHaveAttribute('data-step', '1')

  api.mockResolvedValueOnce(Response.json({ valid: true, botName: 'Support Desk', botUsername: 'support_bot' }))
  token('  corrected  ')
  click('Next')
  expect(await nameField()).toHaveValue('Support Desk')
  expect(api).toHaveBeenLastCalledWith('/api/agent-integrations/test-credentials', expect.objectContaining({
    body: JSON.stringify({ provider: 'telegram', config: { botToken: 'corrected' } }),
  }))
})

it('reuses an explicit verification, saves the customized settings, and keeps them read-only after connecting', async () => {
  const close = setup()
  api.mockResolvedValueOnce(Response.json({ valid: true, botName: 'Support Desk', botUsername: 'support_bot' }))
  token('fixture-token')
  click('Verify')
  expect(await screen.findByRole('status')).toHaveTextContent('Bot token verified for Support Desk (@support_bot).')
  expect(screen.getByTestId('integration-setup-step')).toHaveAttribute('data-step', '1')
  click('Next')
  const name = await nameField()
  expect(name).toHaveValue('Support Desk')
  fireEvent.change(name, { target: { value: 'Telegram Support' } })
  click('Back')
  click('Review settings')
  expect(await nameField()).toHaveValue('Telegram Support')
  expect(api).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('switch', { name: 'Show tool calls in chat' }))
  fireEvent.change(screen.getByLabelText(/Chat ID/), { target: { value: 'chat-id' } })
  api.mockResolvedValueOnce(Response.json({ id: 'new', agentSlug: 'a' }))
  click('Connect')
  expect(await screen.findByRole('button', { name: 'Done' })).toBeEnabled()
  expect(JSON.parse(String(api.mock.lastCall?.[1]?.body))).toMatchObject({
    name: 'Telegram Support', config: { botToken: 'fixture-token', chatId: 'chat-id' }, showToolCalls: true,
  })
  click('Back')
  expect(name).toBeDisabled()
  expect(screen.getByLabelText(/Chat ID/)).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Show tool calls in chat' })).toBeDisabled()
  expect(screen.getByRole('combobox')).toBeDisabled()
  click('Next')
  click('Done')
  expect(close).toHaveBeenCalledOnce()
  expect(api).toHaveBeenCalledTimes(2)
})

it('shares a pending check and ignores its result after the user changes the token', async () => {
  setup()
  const first = Promise.withResolvers<Response>()
  api.mockReturnValueOnce(first.promise)
  token('first-token')
  click('Verify')
  click('Next')
  click('Review settings')
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
  token('second-token')
  await act(async () => { first.resolve(Response.json({ valid: true, botName: 'First bot' })) })
  expect(screen.getByTestId('integration-setup-step')).toHaveAttribute('data-step', '1')
  expect(screen.queryByRole('status')).toBeNull()

  api.mockResolvedValueOnce(Response.json({ valid: true, botUsername: 'second_bot' }))
  click('Next')
  expect(await nameField()).toHaveValue('second_bot')
  api.mockResolvedValueOnce(Response.json({ id: 'new', agentSlug: 'a' }))
  click('Connect')
  await screen.findByRole('button', { name: 'Done' })
  expect(JSON.parse(String(api.mock.lastCall?.[1]?.body))).toMatchObject({ name: 'second_bot', config: { botToken: 'second-token' } })
})

it.each([false, true])('updates the bot default on a new token and respects an edited name (edited: %s)', async (edited) => {
  setup()
  api.mockResolvedValueOnce(Response.json({ valid: true, botName: 'First bot' }))
  token('first')
  click('Next')
  const name = await nameField()
  expect(name).toHaveValue('First bot')
  if (edited) fireEvent.change(name, { target: { value: 'My bot' } })
  click('Back')
  token('second')
  api.mockResolvedValueOnce(Response.json({ valid: true, botName: 'Second bot' }))
  click('Next')
  expect(await nameField()).toHaveValue(edited ? 'My bot' : 'Second bot')
})
