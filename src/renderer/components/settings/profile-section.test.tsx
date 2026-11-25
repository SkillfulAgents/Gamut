// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const publicAuthConfigMock = vi.fn()
const updateUserMock = vi.fn()
const toastSuccessMock = vi.fn()

vi.mock('@renderer/hooks/use-public-auth-config', () => ({
  usePublicAuthConfig: () => publicAuthConfigMock(),
}))

// The signed-in session. A test renames the user by replacing `user` and
// re-rendering, as a refreshed session does.
const session = vi.hoisted(() => ({ user: { id: 'u1', email: 'a@example.com', name: 'Ada' } }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => session,
}))

vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {
    updateUser: (...args: unknown[]) => updateUserMock(...args),
    changePassword: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}))

// usePasswordPolicy fetches /api/auth-config on mount; answer with a non-OK
// response so the default policy stands and nothing hits the network.
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
}))

import { ProfileSection } from './profile-section'

describe('ProfileSection', () => {
  beforeEach(() => {
    session.user = { id: 'u1', email: 'a@example.com', name: 'Ada' }
    updateUserMock.mockReset()
    toastSuccessMock.mockReset()
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: false,
    })
  })

  it('shows the signed-in email read-only and the name in an editable field', () => {
    render(<ProfileSection />)
    expect(screen.getByText('a@example.com')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('hides Change password when local auth is off', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: false },
      isLoading: false,
    })
    render(<ProfileSection />)
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
  })

  it('hides Change password while auth-config is loading', () => {
    publicAuthConfigMock.mockReturnValue({
      config: { allowLocalAuth: true },
      isLoading: true,
    })
    render(<ProfileSection />)
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
  })

  it('shows Change password whenever local auth is enabled', () => {
    render(<ProfileSection />)
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  it('expands the password form in place and collapses it on Cancel', () => {
    render(<ProfileSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  it('saves an edited name, confirms with a toast, and re-disables Save', async () => {
    updateUserMock.mockResolvedValue({ error: null })
    render(<ProfileSection />)

    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    await waitFor(() => expect(save).toBeEnabled())

    fireEvent.click(save)
    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: 'Ada Lovelace' }))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Name updated'))
    await waitFor(() => expect(save).toBeDisabled())
  })

  it('keeps a draft typed before the session catches up with a save', async () => {
    updateUserMock.mockResolvedValue({ error: null })
    const { rerender } = render(<ProfileSection />)
    const name = screen.getByLabelText('Name')
    const save = screen.getByRole('button', { name: 'Save' })

    fireEvent.change(name, { target: { value: 'Ada Lovelace' } })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Name updated'))
    await waitFor(() => expect(save).toBeDisabled())

    fireEvent.change(name, { target: { value: 'Unsaved edit' } })
    await waitFor(() => expect(save).toBeEnabled())
    // The session only now reads the saved name back.
    session.user = { ...session.user, name: 'Ada Lovelace' }
    rerender(<ProfileSection />)

    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved edit')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    // Typed back to the saved name, it is no longer an edit.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
  })

  it('takes a name changed elsewhere as the value and the baseline, unless a draft is being typed', async () => {
    const { rerender } = render(<ProfileSection />)
    const save = () => screen.getByRole('button', { name: 'Save' })

    session.user = { ...session.user, name: 'Countess' }
    rerender(<ProfileSection />)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Countess'))
    expect(save()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } })
    await waitFor(() => expect(save()).toBeEnabled())
    session.user = { ...session.user, name: 'Countess of Lovelace' }
    rerender(<ProfileSection />)
    expect(screen.getByLabelText('Name')).toHaveValue('Draft')
    expect(save()).toBeEnabled()
    // The draft is compared with the new name, not the one it was typed over.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Countess' } })
    await waitFor(() => expect(save()).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Countess of Lovelace' } })
    await waitFor(() => expect(save()).toBeDisabled())
  })

  it('surfaces a failed name update inline', async () => {
    updateUserMock.mockResolvedValue({ error: { message: 'Name is taken' } })
    render(<ProfileSection />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    const save = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)

    // RequestError prefixes its default "Error" label to the message.
    expect(await screen.findByText('Error: Name is taken')).toBeInTheDocument()
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})
