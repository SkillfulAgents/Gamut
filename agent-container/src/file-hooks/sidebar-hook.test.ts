import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'

const host = vi.hoisted(() => ({ callHost: vi.fn() }))
vi.mock('../tools/agents/host-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/agents/host-client')>()),
  callHost: host.callHost,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, promises: { ...actual.promises, writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}) } }
})

import { SidebarFileHook } from './sidebar-hook'
import { XAgentError } from '../tools/agents/host-client'

const PATH = '/workspace/sidebar.json'
const context = { sessionId: 'session-1' }
const file = [{ id: 'root', name: 'Your Agents', agents: ['agent-a'] }, { id: 'f-sales', name: 'Sales', agents: [] }]

describe('SidebarFileHook', () => {
  const hook = new SidebarFileHook()

  beforeEach(() => {
    host.callHost.mockReset()
    vi.mocked(fs.promises.writeFile).mockClear()
    vi.mocked(fs.promises.rm).mockClear()
  })

  it('writes the file fresh for this session before a read, and removes it when there is no sidebar to show', async () => {
    host.callHost.mockResolvedValueOnce({ sections: file })
    expect(await hook.beforeRead(PATH, context)).toEqual({})
    expect(host.callHost).toHaveBeenCalledWith('sidebar-sections', {}, expect.anything(), { callerSessionId: 'session-1' })
    expect(fs.promises.writeFile).toHaveBeenCalledWith(PATH, `${JSON.stringify(file, null, 2)}\n`)

    // No sidebar: the copy goes, and the Read is refused with the app's reason.
    host.callHost.mockResolvedValueOnce({ sections: null, reason: 'No person wrote in this session.' })
    expect(await hook.beforeRead(PATH, context)).toEqual({ error: 'No person wrote in this session.' })
    expect(fs.promises.rm).toHaveBeenCalledWith(PATH, { force: true })
    host.callHost.mockRejectedValueOnce(new Error('down'))
    expect((await hook.beforeRead(PATH, context)).error).toMatch(/could not be loaded/)
    host.callHost.mockRejectedValueOnce(new XAgentError(409, 'No running session.'))
    expect((await hook.beforeRead(PATH, context)).error).toBe('No running session.')
  })

  it('refuses a Write the app would not take, with the reason', () => {
    expect(hook.onWrite(PATH, JSON.stringify(file)).error).toBeUndefined()
    expect(hook.onWrite(PATH, 'not json').error).toMatch(/valid JSON/)
    expect(hook.onWrite(PATH, JSON.stringify([file[1]])).error).toMatch(/"root"/)
    expect(hook.onWrite(PATH, JSON.stringify([file[0], { ...file[1], agents: ['agent-a'] }])).error).toMatch(/more than one place/)
  })

  it('sends a change to the app, and on a refusal removes the copy and says to read again', async () => {
    // Applied as written: the copy stays.
    host.callHost.mockResolvedValueOnce({ sections: file })
    expect(await hook.onChange(PATH, 'before', JSON.stringify(file), context)).toEqual({})
    host.callHost.mockResolvedValueOnce({ sections: file })
    const reordered = file.map(({ id, name, agents }) => ({ agents, name, id }))
    expect(await hook.onChange(PATH, 'before', JSON.stringify(reordered), context)).toEqual({})
    expect(host.callHost).toHaveBeenCalledWith('sidebar-sections', { before: 'before', after: JSON.stringify(file) }, expect.anything(), { callerSessionId: 'session-1' })
    expect(fs.promises.writeFile).not.toHaveBeenCalled()

    // Applied differently (an agent left out moved): the copy becomes what the app applied, and the agent hears so.
    host.callHost.mockResolvedValueOnce({ sections: file })
    expect((await hook.onChange(PATH, 'before', JSON.stringify([file[1]]), context)).warning).toMatch(/now shows it as the app applied it/)
    expect(fs.promises.writeFile).toHaveBeenCalledWith(PATH, `${JSON.stringify(file, null, 2)}\n`)
    expect(fs.promises.rm).not.toHaveBeenCalled()

    host.callHost.mockRejectedValueOnce(new XAgentError(409, 'The sidebar changed since sidebar.json was read.'))
    const { warning } = await hook.onChange(PATH, 'before', 'after', context)
    expect(warning).toContain('The sidebar changed since sidebar.json was read.')
    expect(warning).toContain('Read it again')
    expect(fs.promises.rm).toHaveBeenCalledWith(PATH, { force: true })

    // No answer from the app: the change may have landed.
    host.callHost.mockRejectedValueOnce(new XAgentError(0, 'Network error'))
    expect((await hook.onChange(PATH, 'before', 'after', context)).warning).toMatch(/^The change could not be confirmed/)
    host.callHost.mockRejectedValueOnce(new XAgentError(502, 'Bad gateway'))
    expect((await hook.onChange(PATH, 'before', 'after', context)).warning).toMatch(/^The change could not be confirmed/)
  })
})
