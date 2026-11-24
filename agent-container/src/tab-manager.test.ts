import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tabManager } from './tab-manager'

/** A stand-in for one agent-browser instance's socket: records each command, answers as `answer` says. */
function fakeDaemon(dir: string, session: string, answer: (command: Record<string, unknown>) => Record<string, unknown>) {
  const commands: Array<Record<string, unknown>> = []
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const command = JSON.parse(chunk.toString()) as Record<string, unknown>
      commands.push(command)
      socket.end(JSON.stringify(answer(command)))
    })
  })
  const listening = new Promise<void>((resolve) => server.listen(path.join(dir, `${session}.sock`), resolve))
  return { commands, listening, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const tab = (tabId: string, url: string, active: boolean) => ({ tabId, targetId: `T-${tabId}`, label: null, url, title: '', active })
const answering = (tabs: ReturnType<typeof tab>[]) => () => ({ success: true, data: { tabs } })

let dir: string
const env = { ...process.env }
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
  process.env.AGENT_BROWSER_SOCKET_DIR = dir
})
afterEach(() => {
  process.env = { ...env }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('queryTabs', () => {
  it('asks the named session\'s instance, which marks that session\'s tab active', async () => {
    const a = fakeDaemon(dir, 's-a', answering([tab('t1', 'https://a.com/', true), tab('t2', 'https://b.com/', false)]))
    const b = fakeDaemon(dir, 's-b', answering([tab('t1', 'https://a.com/', false), tab('t2', 'https://b.com/', true)]))
    await Promise.all([a.listening, b.listening])

    expect((await tabManager.queryTabs('s-a')).find(t => t.active)?.url).toBe('https://a.com/')
    expect((await tabManager.queryTabs('s-b')).find(t => t.active)?.url).toBe('https://b.com/')
    expect(a.commands).toEqual([{ id: 'tab-q', action: 'tab_list' }])
    await Promise.all([a.close(), b.close()])
  })
})

describe('findMatchingTab', () => {
  it('skips a tab the caller cannot use (another session is on it), and takes the next match', async () => {
    const daemon = fakeDaemon(dir, 's-a', answering([
      tab('t1', 'https://a.com/x', true),
      tab('t2', 'https://b.com/page', false),
      tab('t3', 'https://b.com/page#top', false),
    ]))
    await daemon.listening

    expect((await tabManager.findMatchingTab('s-a', 'https://b.com/page'))?.tabId).toBe('t2')
    expect((await tabManager.findMatchingTab('s-a', 'https://b.com/page', (t) => t.targetId !== 'T-t2'))?.tabId).toBe('t3')
    expect(await tabManager.findMatchingTab('s-a', 'https://b.com/page', () => false)).toBeNull()
    await daemon.close()
  })
})
