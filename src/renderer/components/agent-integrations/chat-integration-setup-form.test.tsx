// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { ChatIntegrationSetupForm } from './chat-integration-setup-form'

const create = vi.hoisted(() => vi.fn())
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Support Agent' } }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useCreateAgentIntegration: () => ({ mutateAsync: create, isPending: false }),
  useTestAgentIntegrationCredentials: () => ({ isPending: false }),
}))
beforeEach(() => { create.mockClear() })

it('keeps the saved Telegram settings read-only when going back from Say hello', async () => {
  const close = vi.fn()
  render(<Dialog open><DialogContent><ChatIntegrationSetupForm provider="telegram" agentSlug="a" onClose={close} /></DialogContent></Dialog>)
  fireEvent.change(screen.getByLabelText('Paste the token BotFather sends back'), { target: { value: 'fixture-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  const name = screen.getByLabelText('Integration name')
  expect(name).toHaveValue('Support Agent')
  fireEvent.change(name, { target: { value: 'Telegram Support' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Show tool calls in chat' }))
  fireEvent.change(screen.getByLabelText(/Chat ID/), { target: { value: 'chat-id' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled())
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Telegram Support', config: { botToken: 'fixture-token', chatId: 'chat-id' }, showToolCalls: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(name).toBeDisabled()
  expect(screen.getByLabelText(/Chat ID/)).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Show tool calls in chat' })).toBeDisabled()
  expect(screen.getByRole('combobox')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(close).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce()
})

it('lets someone replace a suggested iMessage integration name before connecting', async () => {
  const close = vi.fn()
  render(<Dialog open><DialogContent><ChatIntegrationSetupForm provider="imessage" agentSlug="a" onClose={close} initial={{ name: 'Personal phone' }} /></DialogContent></Dialog>)
  fireEvent.click(screen.getByRole('button', { name: 'Enter the code' }))
  fireEvent.change(screen.getByLabelText('Your phone number'), { target: { value: '+15555550100' } })
  fireEvent.change(screen.getByLabelText('Setup code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  const name = screen.getByLabelText('Integration name')
  expect(name).toHaveValue('Personal phone')
  fireEvent.change(name, { target: { value: 'Work phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'imessage', name: 'Work phone' }))
})
