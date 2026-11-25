import { describe, expect, it } from 'vitest'
import { browserAlone, browserCommand } from './browser-gate'

/** A piece of work that runs until released, recording when it starts and ends. */
function work(log: string[], name: string) {
  let release = () => {}
  const done = new Promise<void>((resolve) => { release = resolve })
  return {
    run: async () => {
      log.push(`${name}:start`)
      await done
      log.push(`${name}:end`)
    },
    release,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('the browser gate', () => {
  it('runs a session\'s commands side by side, and its operation only once none is running', async () => {
    const log: string[] = []
    const first = work(log, 'command-1')
    const second = work(log, 'command-2')
    const operation = work(log, 'operation')
    const commands = [browserCommand('s-1', first.run), browserCommand('s-1', second.run)]
    const alone = browserAlone('s-1', operation.run)
    await tick()
    expect(log).toEqual(['command-1:start', 'command-2:start'])

    first.release()
    await tick()
    expect(log).not.toContain('operation:start')
    second.release()
    await tick()
    expect(log.at(-1)).toBe('operation:start')
    operation.release()
    await Promise.all([...commands, alone])
  })

  it('holds back a command of the session that starts while its operation waits, so a busy browser cannot keep it waiting', async () => {
    const log: string[] = []
    const first = work(log, 'command-1')
    const later = work(log, 'command-2')
    const operation = work(log, 'operation')
    const running = browserCommand('s-1', first.run)
    await tick()
    const alone = browserAlone('s-1', operation.run)
    await tick()
    const held = browserCommand('s-1', later.run)
    await tick()
    expect(log).toEqual(['command-1:start'])

    first.release()
    await tick()
    expect(log).toEqual(['command-1:start', 'command-1:end', 'operation:start'])
    operation.release()
    await tick()
    expect(log.slice(3)).toEqual(['operation:end', 'command-2:start'])
    later.release()
    await Promise.all([running, alone, held])
  })

  it('holds a command back while its session\'s operation runs, and runs operations one at a time, whoever\'s', async () => {
    const log: string[] = []
    const first = work(log, 'operation-1')
    const second = work(log, 'operation-2')
    const command = work(log, 'command')
    const operations = [browserAlone('s-1', first.run), browserAlone('s-2', second.run)]
    await tick()
    const held = browserCommand('s-1', command.run)
    await tick()
    expect(log).toEqual(['operation-1:start'])

    first.release()
    await tick()
    expect(log).toEqual(['operation-1:start', 'operation-1:end', 'operation-2:start', 'command:start'])
    second.release()
    command.release()
    await Promise.all([...operations, held])
  })

  it('never holds another session\'s commands: its instance is on a tab of its own', async () => {
    const log: string[] = []
    const mine = work(log, 'command-s1')
    const operation = work(log, 'operation-s2')
    const theirs = work(log, 'command-s2')
    const running = browserCommand('s-2', theirs.run)
    await tick()
    const alone = browserAlone('s-2', operation.run)
    await tick()
    const other = browserCommand('s-1', mine.run)
    await tick()
    expect(log).toEqual(['command-s2:start', 'command-s1:start'])
    mine.release()
    theirs.release()
    await tick()
    expect(log.at(-1)).toBe('operation-s2:start')
    operation.release()
    await Promise.all([running, alone, other])
  })

  it('lets a failed operation go, and passes its error on', async () => {
    await expect(browserAlone('s-1', async () => { throw new Error('the browser went away') })).rejects.toThrow('the browser went away')
    expect(await browserCommand('s-1', async () => 'ran')).toBe('ran')
    expect(await browserAlone('s-2', async () => 'next')).toBe('next')
  })
})
