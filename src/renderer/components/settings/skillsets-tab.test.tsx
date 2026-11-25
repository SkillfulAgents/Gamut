// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SkillsetsTab } from './skillsets-tab'

const state = vi.hoisted(() => ({
  skillsets: [] as Array<Record<string, unknown>>,
  validate: vi.fn(),
  add: vi.fn(),
}))

vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: state.skillsets, isLoading: false }),
  useValidateSkillset: () => ({ mutateAsync: state.validate, isPending: false }),
  useAddSkillset: () => ({ mutateAsync: state.add, isPending: false }),
  useRemoveSkillset: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshSkillset: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSkillsetCredential: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@renderer/lib/capabilities', () => ({ offersPrivateSkillsets: () => true }))

beforeEach(() => {
  state.skillsets = []
  state.validate.mockReset()
  state.add.mockReset()
})

afterEach(cleanup)

describe('SkillsetsTab', () => {
  it('lists each skillset as a row, with its skill count and badges', () => {
    state.skillsets = [
      { id: 'a', name: 'Gamut Community', skillCount: 1, badgeLabel: 'Public', description: 'Agent templates.', url: 'https://example.com/a', showUrl: true },
      { id: 'b', name: 'Team Skills', skillCount: 3, credential: { tokenPreview: '••••lder' } },
    ]
    render(<SkillsetsTab />)

    const rows = screen.getAllByTestId('skillset-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('1 skill')).toBeTruthy()
    expect(within(rows[0]).getByText('Public')).toBeTruthy()
    expect(within(rows[0]).getByText('https://example.com/a')).toBeTruthy()
    expect(within(rows[1]).getByText('3 skills')).toBeTruthy()
    expect(within(rows[1]).getByText('Private · ••••lder')).toBeTruthy()
  })

  it('says so when there are none, and keeps the add form out of the page', () => {
    render(<SkillsetsTab />)

    expect(screen.getByTestId('skillsets-empty')).toBeTruthy()
    expect(screen.queryByLabelText('Repository URL')).toBeNull()
  })

  it('adds a skillset from the dialog the Add button opens, then closes it', async () => {
    state.validate.mockResolvedValue({ valid: true })
    state.add.mockResolvedValue({})
    render(<SkillsetsTab />)

    fireEvent.click(screen.getByTestId('skillsets-add-button'))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: ' https://github.com/org/skills ' } })
    fireEvent.change(screen.getByLabelText('Repository token (optional)'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByTestId('skillsets-add-submit'))

    const input = { url: 'https://github.com/org/skills', token: 'tok' }
    await waitFor(() => expect(state.add).toHaveBeenCalledWith(input))
    expect(state.validate).toHaveBeenCalledWith(input)
    await waitFor(() => expect(screen.queryByTestId('skillsets-add-dialog')).toBeNull())
  })

  it('keeps the dialog open with the reason when the repository does not validate', async () => {
    state.validate.mockResolvedValue({ valid: false, error: 'No index.json found' })
    render(<SkillsetsTab />)

    fireEvent.click(screen.getByTestId('skillsets-add-button'))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/org/skills' } })
    fireEvent.click(screen.getByTestId('skillsets-add-submit'))

    expect(await screen.findByText('No index.json found')).toBeTruthy()
    expect(state.add).not.toHaveBeenCalled()
    expect(screen.getByTestId('skillsets-add-dialog')).toBeTruthy()
  })
})
