// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invokeAgentRenderer } from './renderer'

const openUtility = vi.fn()
const session = { isActive: true, isAwaitingInput: false }
vi.mock('@renderer/context/session-tray-context', () => ({ useSessionTray: () => ({ openUtility }) }))
vi.mock('@renderer/hooks/use-agents', async original => ({
  ...await original<typeof import('@renderer/hooks/use-agents')>(),
  useAgents: () => ({ data: [{ slug: 'writer', name: 'Writer', avatar: { color: 'tonal-purple', shape: 'circle' } }] }),
}))
vi.mock('@renderer/hooks/use-invocations', () => ({ useInvocationList: () => ({ data: [
  { agentSlug: 'writer', sessionId: 'other', prompt: 'Draft', toolUseId: 'other-tool' },
  { agentSlug: 'writer', sessionId: 'child', prompt: 'Draft', toolUseId: 'this-tool' },
] }) }))
vi.mock('@tanstack/react-query', async original => ({
  ...await original<typeof import('@tanstack/react-query')>(), useQuery: () => ({ data: session }),
}))

it('opens the delivered session for this tool id, reflects changes of state, and keeps details independently accessible', async () => {
  const Header = invokeAgentRenderer.Header!
  const props = { input: { slug: 'writer', prompt: 'Draft' }, toolUseId: 'this-tool', agentSlug: 'caller', sessionId: 'parent',
    isSessionActive: true, expanded: false, toggleDetails: vi.fn() }
  const user = userEvent.setup()
  const view = render(<Header {...props} />)
  expect(screen.getByRole('img', { name: 'Working' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Open Writer session in tray' }))
  expect(openUtility).toHaveBeenCalledWith('invoked-agents', { slug: 'writer', sessionId: 'child' })
  session.isAwaitingInput = true
  view.rerender(<Header {...props} />)
  expect(screen.getByRole('img', { name: 'Waiting for input' })).toBeVisible()
  session.isAwaitingInput = false
  session.isActive = false
  view.rerender(<Header {...props} />)
  expect(screen.getByRole('img', { name: 'Idle' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Expand invoke agent tool details' }))
  expect(props.toggleDetails).toHaveBeenCalledOnce()
  view.rerender(<Header {...props} toolUseId="undelivered" />)
  expect(screen.queryByRole('button', { name: 'Open Writer session in tray' })).toBeNull()
})
