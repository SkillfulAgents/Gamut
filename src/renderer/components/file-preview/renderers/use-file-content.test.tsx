// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileLoadErrorTone, useFileContent } from './use-file-content'

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })}>{children}</QueryClientProvider>
}

afterEach(() => vi.unstubAllGlobals())

describe('useFileContent', () => {
  it('shows a missing file once, with the server\'s message, and retries a server failure', async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ error: 'File not found' }), { status: 404 }))
    vi.stubGlobal('fetch', missing)
    const { result } = renderHook(() => useFileContent('/api/agents/a/files/gone.txt'), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toBe('File not found'))
    expect(missing).toHaveBeenCalledTimes(1)
    expect(fileLoadErrorTone(result.current.error!)).toBe('text-muted-foreground')

    const failing = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', failing)
    const second = renderHook(() => useFileContent('/api/agents/a/files/b.txt'), { wrapper })
    await waitFor(() => expect(second.result.current.error).toBeTruthy())
    expect(failing).toHaveBeenCalledTimes(4)
    expect(second.result.current.error?.message).toBe('Failed to load file')
    expect(fileLoadErrorTone(second.result.current.error!)).toBe('text-destructive')
  })
})
