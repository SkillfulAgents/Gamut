// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

// Each source's folder routes, faked at the HTTP boundary: what was listed, and what was made where.
const state = vi.hoisted(() => ({
  created: [] as { type: string; body: Record<string, string> }[],
  /** The next create is refused, as a name already taken is. */
  refuse: null as string | null,
  /** A repository made a moment ago has no branch to list yet. */
  branches: ['main'],
}))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => false, usesHostFolderPaths: () => false, agentsRunInAppSandbox: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: true }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccountsByToolkit: () => ({ data: { accounts: [{ id: 'acct', displayName: 'Work account', status: 'active' }] }, isLoading: false }),
}))
vi.mock('@renderer/hooks/use-connect-account', () => ({ useConnectAccount: () => ({ connect: vi.fn(), connecting: null, canCancel: false, cancel: () => {}, error: null }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, 'http://app')
    const type = pathname.split('/')[3]
    if (init?.method === 'POST') {
      if (state.refuse) {
        const error = state.refuse
        state.refuse = null
        return Response.json({ error }, { status: 409 })
      }
      const body = JSON.parse(String(init.body)) as Record<string, string>
      state.created.push({ type, body })
      if (type === 'github') return Response.json({ folder: { id: '42', name: `acme/${body.name}` } })
      if (type === 'dropbox') return Response.json({ folder: { id: `${body.path}/${body.name}`, name: body.name } })
      return Response.json({ folder: { id: `made-${body.name}`, name: body.name } })
    }
    if (type === 'github') return Response.json({ folders: searchParams.get('repoId') ? state.branches.map(name => ({ id: name, name })) : [] })
    if (type === 'googledrive') {
      const folderId = searchParams.get('folderId')
      if (!folderId) return Response.json({ folders: [{ id: 'mydrive', name: 'My Drive' }, { id: 'shared1', name: 'Company' }] })
      return Response.json({ folders: folderId === 'mydrive' ? [{ id: 'team', name: 'Team' }] : [] })
    }
    return Response.json({ folders: [] })
  },
}))

import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { dropboxVolumeSetup } from './dropbox-volume-setup'
import { githubVolumeSetup } from './github-volume-setup'
import { googleDriveVolumeSetup } from './google-drive-volume-setup'
import { platformVolumeSetup } from './platform-volume-setup'
import { VolumeSetupFolderContext, type VolumeSetupFolderMode } from './volume-setup-layout'
import type { VolumeSetupProps } from './volume-setup'

beforeEach(() => { state.created = []; state.refuse = null; state.branches = ['main'] })
afterEach(cleanup)

/** A drive's set-up as a host that names the drive itself shows it, at its details step. */
async function open(Setup: ComponentType<VolumeSetupProps>, mode: VolumeSetupFolderMode, onSubmit = vi.fn(async () => {}), error: string | null = null) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Dialog open><DialogContent>
      <VolumeSetupFolderContext.Provider value={mode}>
        <Setup initialConfig={undefined} initialDetails={{ name: 'Team Brain', visibility: 'public' }} onSubmit={onSubmit} onBack={vi.fn()} onCancel={vi.fn()}
          isSaving={false} error={error} clearError={vi.fn()} attachToAgent />
      </VolumeSetupFolderContext.Provider>
    </DialogContent></Dialog>
  </QueryClientProvider>)
  // The lone account is chosen for it; a source without accounts is at its details already.
  const next = screen.queryByRole('button', { name: 'Next' })
  if (next) {
    await waitFor(() => expect(next).toBeEnabled())
    await userEvent.click(next)
  }
  return onSubmit
}

describe('a drive set-up for a host after a new folder', () => {
  it('Google Drive names the folder, puts it in My Drive unless another place is picked, and makes it on save', async () => {
    const onSubmit = await open(googleDriveVolumeSetup.Setup, 'new')
    expect(screen.getByRole('heading', { name: 'Create a Google Drive folder' })).toBeInTheDocument()
    // The folder's name is asked for, the drive's is not.
    expect(screen.getByLabelText('Folder name')).toHaveValue('Team Brain')
    expect(screen.queryByLabelText('Name')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('My Drive'))

    await userEvent.clear(screen.getByLabelText('Folder name'))
    await userEvent.type(screen.getByLabelText('Folder name'), 'Acme Brain')
    // Another place: the picker opens where the folder would go, and its button says what choosing does.
    await userEvent.click(screen.getByRole('button', { name: /^Create in/ }))
    const picker = within(await screen.findByTestId('googledrive-folder-picker'))
    await userEvent.click(await picker.findByRole('button', { name: 'Team', pressed: false }))
    expect(picker.queryByRole('button', { name: /New folder/ })).toBeNull()
    await userEvent.click(picker.getByRole('button', { name: 'Create in “Team”' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('My Drive / Team')
    expect(state.created).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(state.created).toEqual([{ type: 'googledrive', body: { accountId: 'acct', folderId: 'team', name: 'Acme Brain' } }])
    expect(onSubmit).toHaveBeenCalledWith(
      { accountId: 'acct', folderId: 'made-Acme Brain', folderName: 'Acme Brain', driveName: 'My Drive' },
      { name: 'Team Brain', visibility: 'public' },
    )
  })

  it('keeps the folder it made, so a save the host fails afterwards tries again without making a second', async () => {
    const onSubmit = vi.fn(async () => {})
    onSubmit.mockRejectedValueOnce(new Error('Could not install the agent'))
    await open(dropboxVolumeSetup.Setup, 'new', onSubmit)
    // A Dropbox folder goes at the top unless another place is picked.
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('Dropbox')
    await userEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not install the agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(state.created).toEqual([{ type: 'dropbox', body: { accountId: 'acct', path: '', name: 'Team Brain' } }])
    expect(onSubmit).toHaveBeenLastCalledWith({ accountId: 'acct', path: '/Team Brain' }, { name: 'Team Brain', visibility: 'public' })
  })

  it('says why a folder could not be made, and makes nothing of the host’s', async () => {
    state.refuse = '“Team Brain” is already used here.'
    const onSubmit = await open(dropboxVolumeSetup.Setup, 'new')
    await userEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('“Team Brain” is already used here.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('GitHub makes a private repository and uses its root on the branch GitHub started it with', async () => {
    const onSubmit = await open(githubVolumeSetup.Setup, 'new')
    expect(screen.getByRole('heading', { name: 'Create a GitHub repository' })).toBeInTheDocument()
    expect(screen.getByLabelText('Repository name')).toHaveValue('team-brain')
    // An account is the one place a repository goes: nowhere to pick.
    expect(screen.queryByTestId('selected-volume-folder')).toBeNull()

    // A repository made a moment ago can have no branch yet: the retry reads it again and makes no second repository.
    state.branches = []
    await userEvent.click(screen.getByRole('button', { name: 'Create repository' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub is still preparing the repository.')
    state.branches = ['main']
    await userEvent.click(screen.getByRole('button', { name: 'Create repository' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(state.created).toEqual([{ type: 'github', body: { accountId: 'acct', name: 'team-brain' } }])
    expect(onSubmit).toHaveBeenCalledWith({ accountId: 'acct', repoId: 42, owner: 'acme', repo: 'team-brain', branch: 'main', path: '' }, { name: 'Team Brain', visibility: 'public' })
  })

  it('a Gamut drive is made by name alone', async () => {
    const onSubmit = await open(platformVolumeSetup.Setup, 'new')
    expect(screen.getByLabelText('Drive name')).toHaveValue('Team Brain')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ volumeId: 'made-Team Brain' }, { name: 'Team Brain', visibility: 'public' }))
    expect(state.created).toEqual([{ type: 'platform', body: { name: 'Team Brain' } }])
  })
})

describe('a drive set-up for a host after a folder that is there already', () => {
  it('selects the folder and asks for no name', async () => {
    const onSubmit = await open(googleDriveVolumeSetup.Setup, 'existing')
    expect(screen.getByRole('heading', { name: 'Choose a Google Drive folder' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByLabelText('Folder name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    const picker = within(await screen.findByTestId('googledrive-folder-picker'))
    await userEvent.click(await picker.findByRole('button', { name: 'Team', pressed: false }))
    await userEvent.click(picker.getByRole('button', { name: 'Use “Team”' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({ accountId: 'acct', folderId: 'team', folderName: 'Team', driveName: 'My Drive' }, expect.anything())
    expect(state.created).toEqual([])
  })
})
