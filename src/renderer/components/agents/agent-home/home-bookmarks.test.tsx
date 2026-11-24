// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Bookmark } from '@shared/lib/utils/bookmarks'
import { HomeBookmarks } from './home-bookmarks'

const openFile = vi.fn()
const openFolder = vi.fn()
const mocks = vi.hoisted(() => ({
  bookmarks: [] as Bookmark[],
}))
const ALL_KINDS: Bookmark[] = [
  { name: 'Daily report', file: '/workspace/reports/daily.csv' },
  { name: 'Reports', folder: '/workspace/reports' },
  { name: 'Project site', link: 'https://example.com/project' },
]

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile, openFolder }),
}))

vi.mock('@renderer/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({ data: mocks.bookmarks }),
  useUpdateBookmarks: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

describe('HomeBookmarks', () => {
  beforeEach(() => {
    openFile.mockReset()
    openFolder.mockReset()
    mocks.bookmarks = ALL_KINDS
  })

  it('titles the panel Pinned Items', () => {
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.getByRole('region', { name: 'Pinned Items' })).toBeVisible()
  })

  it('filters pinned items by kind', async () => {
    const user = userEvent.setup()
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['All', 'Files', 'Folders', 'Links'])

    await user.click(screen.getByRole('tab', { name: 'Links' }))
    expect(screen.getByRole('link', { name: 'Project site' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Daily report' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reports' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByRole('button', { name: 'Daily report' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Project site' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Daily report' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reports' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Project site' })).toBeVisible()
  })

  it('offers tabs only for the kinds it holds', () => {
    mocks.bookmarks = [ALL_KINDS[0], ALL_KINDS[2]]
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['All', 'Files', 'Links'])
  })

  it('shows no filter while it holds a single kind', () => {
    mocks.bookmarks = [ALL_KINDS[2], { name: 'Docs', link: 'https://example.com/docs' }]
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docs' })).toBeVisible()
  })

  it('opens workspace folders in the file preview context', async () => {
    const user = userEvent.setup()
    render(<HomeBookmarks agentSlug="test-agent" />)

    await user.click(screen.getByRole('button', { name: 'Reports' }))

    expect(openFolder).toHaveBeenCalledWith('/workspace/reports', 'test-agent')
  })

  it('opens workspace files in the file preview context', async () => {
    const user = userEvent.setup()
    render(<HomeBookmarks agentSlug="test-agent" />)

    await user.click(screen.getByRole('button', { name: 'Daily report' }))

    expect(openFile).toHaveBeenCalledWith('/workspace/reports/daily.csv', 'test-agent')
  })

  it("shows a link's favicon, and a globe once it fails to load", () => {
    mocks.bookmarks = [ALL_KINDS[2]]
    render(<HomeBookmarks agentSlug="test-agent" />)
    const link = screen.getByRole('link', { name: 'Project site' })

    const favicon = link.querySelector('img')
    expect(favicon).toHaveAttribute('src', 'https://example.com/favicon.ico')
    expect(link.querySelector('.lucide-arrow-up-right')).not.toBeNull()

    fireEvent.error(favicon!)
    expect(link.querySelector('img')).toBeNull()
    expect(link.querySelector('.lucide-globe')).not.toBeNull()
  })

  it('keeps web bookmarks as external links', () => {
    render(<HomeBookmarks agentSlug="test-agent" />)

    expect(screen.getByRole('link', { name: 'Project site' })).toHaveAttribute(
      'href',
      'https://example.com/project',
    )
  })
})
