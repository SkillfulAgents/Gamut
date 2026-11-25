/**
 * Size of the sessions file.
 *
 * One file holds every session of an agent, the container rewrites all of it on
 * each message, and the cloud controller reads all of it. Agent-wide data copied
 * into each record grows it by tens of MB within weeks on an agent with frequent
 * automations. The host sends that data with every connection runtime, so a
 * record must not keep it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('./browser-state', () => ({
  releaseBrowserSession: vi.fn(),
  renameBrowserSession: vi.fn(),
}))

class MockClaudeProcess extends EventEmitter {
  constructor(readonly options: { sessionId: string }) {
    super()
  }

  get sessionId(): string {
    return this.options.sessionId
  }

  async start(): Promise<void> {}

  async sendMessage(): Promise<void> {
    this.emit('claude-session-id', this.sessionId)
    this.emit('init-complete')
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}

  isRunning(): boolean {
    return true
  }

  get slashCommands() {
    return []
  }
}

vi.mock('./claude-code', () => ({
  ClaudeCodeProcess: class {
    constructor(options: { sessionId: string }) {
      return new MockClaudeProcess(options)
    }
  },
}))

describe('SessionManager sessions file', () => {
  let workDir: string
  let sessionsFile: string

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-file-test-'))
    sessionsFile = path.join(workDir, 'sessions.json')
    vi.resetModules()
    vi.stubEnv('SUPERAGENT_SESSIONS_FILE', sessionsFile)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('adds only a small record per session, however large the model data the host sends', async () => {
    const { SessionManager } = await import('./session-manager')
    const manager = new SessionManager(workDir, { prewarmEnabled: false, idleEvictionMs: -1, automatedIdleEvictionMs: -1 })
    // What the host sends with every session of an agent on a provider catalog.
    const subagentModels = Array.from({ length: 21 }, (_, i) => ({
      id: `model-${i}`,
      label: `Model ${i}`,
      blurb: 'A general model for long tasks that need careful reasoning. '.repeat(3),
      family: 'general',
      isLatest: true,
      pricing: { inputPerMtok: 3, outputPerMtok: 15 },
    }))
    const modelContextWindows = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`model-${i}`, 1_000_000]))
    const modelPromptHints = ['Call one tool at a time and wait for its result before the next call. '.repeat(15)]
    expect(JSON.stringify([subagentModels, modelContextWindows, modelPromptHints]).length).toBeGreaterThan(5_000)
    const start = () =>
      manager.createSession({
        initialMessage: 'Check every open order and post the slow ones.',
        model: 'model-0',
        effort: 'high',
        subagentModels,
        modelContextWindows,
        modelPromptHints,
        metadata: { isAutomated: true },
      })

    try {
      await start()
      const before = fs.statSync(sessionsFile).size
      const runs = 50
      for (let i = 0; i < runs; i++) await start()

      expect((fs.statSync(sessionsFile).size - before) / runs).toBeLessThan(1024)
    } finally {
      await manager.stopAll()
    }
  })
})
