// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileDownloadPill } from './file-download-pill'

vi.mock('@renderer/context/agent-file-opener-context', () => ({
  useAgentFileOpener: () => ({ openFile: vi.fn() }),
}))

describe('FileDownloadPill', () => {
  it('renders a file with view button', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/report.pdf" agentSlug="test-agent" />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('report.pdf')
  })

  it('renders a folder with folder icon and no button', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/my-project/" agentSlug="test-agent" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('my-project')).toBeInTheDocument()
  })

  it('extracts folder name from trailing-slash path', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/datawizz-app/" agentSlug="test-agent" />)
    expect(screen.getByText('datawizz-app')).toBeInTheDocument()
  })

  it('extracts filename from file path', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/1234-notes.txt" agentSlug="test-agent" />)
    expect(screen.getByText('1234-notes.txt')).toBeInTheDocument()
  })

  it('handles nested folder path with trailing slash', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/deep/nested/folder/" agentSlug="test-agent" />)
    expect(screen.getByText('folder')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
