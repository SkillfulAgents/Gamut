// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotMountedVolume } from '@shared/lib/types/mount'
import { AgentBanners } from './agent-banners'

const state = vi.hoisted(() => ({
  missingDrives: undefined as NotMountedVolume[] | undefined,
  status: 'running' as 'running' | 'stopped',
  canUseAgent: true,
  restart: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null as Error | null },
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: { status: state.status, missingDrives: state.missingDrives } }),
}))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => state.canUseAgent }) }))
vi.mock('@renderer/hooks/use-mounts', () => ({ useRestartAgent: () => state.restart }))
vi.mock('@renderer/hooks/use-runtime-status', () => ({ useRuntimeStatus: () => ({ data: undefined }) }))

const startAgent = { isError: false, error: null } as unknown as Parameters<typeof AgentBanners>[0]['startAgent']
const banners = () => <AgentBanners slug="agent-a" startAgent={startAgent} />

beforeEach(() => {
  state.missingDrives = undefined
  state.canUseAgent = true
  state.status = 'running'
  state.restart = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }
})

describe('AgentBanners: drives the agent started without', () => {
  it('offers Restart only where a restart can mount the drive, and only to someone who can use the agent', () => {
    state.missingDrives = [{ name: 'Notes', reason: 'ready after a restart' }]
    const { rerender } = render(banners())
    expect(screen.getByText('Notes is back. Restart the agent to mount it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(state.restart.mutate).toHaveBeenCalledWith('agent-a')

    state.missingDrives = [{ name: 'Notes', reason: 'not found' }, { name: 'Repo', reason: 'not supported here' }, { name: 'Docs', reason: 'not supported here' }]
    rerender(banners())
    expect(screen.getByText("Notes's folder no longer exists. Drives can't mount in this runtime.")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()

    state.missingDrives = [{ name: 'Notes', reason: 'ready after a restart' }]
    state.canUseAgent = false
    rerender(banners())
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('keeps a dismissal until the list changes or empties at a stop', () => {
    state.missingDrives = [{ name: 'Notes', reason: 'not found' }]
    const { container, rerender } = render(banners())
    const dismiss = () => fireEvent.click(container.querySelector('[data-top-banner] button:last-child')!)

    dismiss()
    rerender(banners())
    expect(screen.queryByText("Notes's folder no longer exists.")).toBeNull()

    state.missingDrives = []
    rerender(banners())
    state.missingDrives = [{ name: 'Notes', reason: 'not found' }]
    rerender(banners())
    expect(screen.getByText("Notes's folder no longer exists.")).toBeTruthy()

    dismiss()
    state.missingDrives = [{ name: 'Notes', reason: 'ready after a restart' }]
    rerender(banners())
    expect(screen.getByText('Notes is back. Restart the agent to mount it.')).toBeTruthy()
  })

  it('shows a failed restart in the error banner, and clears it once the agent runs again', () => {
    state.status = 'stopped'
    state.restart = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: true, error: new Error('Failed to start agent') }
    const { rerender } = render(banners())
    expect(screen.getByText('Failed to start agent')).toBeTruthy()
    expect(state.restart.reset).not.toHaveBeenCalled()

    state.status = 'running'
    rerender(banners())
    expect(state.restart.reset).toHaveBeenCalledOnce()
  })
})
