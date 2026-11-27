import { describe, it, expect } from 'vitest'
import { IN_FRAME_MARKER, topFrameScript, ranInFrame, frameSelectionOf, stepOutOfFrame } from './top-frame-probe'

describe('topFrameScript', () => {
  it('runs the script on the top frame and answers the marker inside a frame', () => {
    const script = topFrameScript('JSON.stringify({u:location.href})')
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('window', 'location', `return ${script}`)
    // On the top frame window.top is the window itself; in a frame it is the page's.
    const topWindow: { top?: unknown } = {}
    topWindow.top = topWindow
    expect(evaluate(topWindow, { href: 'https://x.test/' })).toBe('{"u":"https://x.test/"}')
    expect(evaluate({ top: topWindow }, { href: 'https://pay.test/' })).toBe(IN_FRAME_MARKER)
  })

  it('recognises the marker as the CLI prints it, and nothing else', () => {
    expect(ranInFrame(`${JSON.stringify(IN_FRAME_MARKER)}\n`)).toBe(true)
    expect(ranInFrame('"{\\"url\\":\\"https://x.test/\\"}"')).toBe(false)
    expect(ranInFrame(IN_FRAME_MARKER)).toBe(false)
  })
})

describe('frameSelectionOf', () => {
  it('takes the last frame command, main clearing it', () => {
    expect(frameSelectionOf([['frame', 'iframe[title="Pay"]']])).toBe('iframe[title="Pay"]')
    expect(frameSelectionOf([['frame', '@e12'], ['fill', '#card', '4242']])).toBe('@e12')
    expect(frameSelectionOf([['frame', '@e12'], ['frame', 'main']])).toBeNull()
    expect(frameSelectionOf([['FRAME', '--', '#pay']])).toBe('#pay')
  })

  it('is undefined when no command selects a frame', () => {
    expect(frameSelectionOf([['click', '@e1']])).toBeUndefined()
    expect(frameSelectionOf([['frame']])).toBeUndefined()
    expect(frameSelectionOf([])).toBeUndefined()
  })
})

describe('stepOutOfFrame', () => {
  type Call = { args: string[]; exitCode: number; stdout: string }
  function runner(answers: Record<string, Partial<Call>> = {}) {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      const key = args[0] === 'eval' ? 'eval' : args.join(' ')
      const answer = answers[key] ?? {}
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '✓ Done' }
    }
    return { calls, run }
  }

  it('reads the top frame and selects the agent\'s frame again', async () => {
    const s = { frame: '#pay' as string | null, frameStep: null as Promise<void> | null }
    const { calls, run } = runner({ eval: { stdout: '"{\\"url\\":\\"https://shop.test/\\"}"' } })
    const r = await stepOutOfFrame(s, 'JSON.stringify(1)', run)
    expect(r.stdout).toBe('"{\\"url\\":\\"https://shop.test/\\"}"')
    expect(calls.map(c => c[0] === 'eval' ? 'eval' : c.join(' '))).toEqual(['frame main', 'eval', 'frame #pay'])
    expect(s.frame).toBe('#pay')
    expect(s.frameStep).toBeNull()
  })

  it('leaves the session on the top frame when the agent\'s frame is gone', async () => {
    const s = { frame: '#pay' as string | null, frameStep: null as Promise<void> | null }
    const { run } = runner({ 'frame #pay': { exitCode: 1, stdout: '✗ Element not found' } })
    await stepOutOfFrame(s, '1', run)
    expect(s.frame).toBeNull()
  })

  it('reads the page once to select a frame again by a ref an in-frame snapshot replaced', async () => {
    const s = { frame: '@e3' as string | null, frameStep: null as Promise<void> | null }
    const calls: string[] = []
    let restored = false
    const run = async (args: string[]) => {
      calls.push(args[0] === 'eval' ? 'eval' : args.join(' '))
      if (args[0] === 'snapshot') restored = true
      if (args.join(' ') === 'frame @e3' && !restored) return { exitCode: 1, stdout: '✗ Unknown ref: e3' }
      return { exitCode: 0, stdout: '✓ Done' }
    }
    await stepOutOfFrame(s, '1', run)
    expect(calls).toEqual(['frame main', 'eval', 'frame @e3', 'snapshot -i -c', 'frame @e3'])
    expect(s.frame).toBe('@e3')
  })

  it('does not read the page for a selector that no longer matches', async () => {
    const s = { frame: '#pay' as string | null, frameStep: null as Promise<void> | null }
    const calls: string[] = []
    const run = async (args: string[]) => {
      calls.push(args[0] === 'eval' ? 'eval' : args.join(' '))
      return args.join(' ') === 'frame #pay' ? { exitCode: 1, stdout: '✗ Could not find frame for selector' } : { exitCode: 0, stdout: '✓ Done' }
    }
    await stepOutOfFrame(s, '1', run)
    expect(calls).toEqual(['frame main', 'eval', 'frame #pay'])
    expect(s.frame).toBeNull()
  })

  it('answers the failure when it cannot step out, without reading', async () => {
    const s = { frame: '#pay' as string | null, frameStep: null as Promise<void> | null }
    const { calls, run } = runner({ 'frame main': { exitCode: 1, stdout: '✗ Browser not launched' } })
    const r = await stepOutOfFrame(s, '1', run)
    expect(r.exitCode).toBe(1)
    expect(calls).toEqual([['frame', 'main']])
    expect(s.frameStep).toBeNull()
  })

  it('runs one step at a time for a session', async () => {
    const s = { frame: '#pay' as string | null, frameStep: null as Promise<void> | null }
    const order: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = async (args: string[]) => {
      order.push(args.join(' ').slice(0, 10))
      if (args[0] === 'eval' && order.length === 2) await gate
      return { exitCode: 0, stdout: '1' }
    }
    const first = stepOutOfFrame(s, '1', run)
    const second = stepOutOfFrame(s, '2', run)
    await Promise.resolve()
    expect(s.frameStep).not.toBeNull()
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['frame main', 'eval (wind', 'frame #pay', 'frame main', 'eval (wind', 'frame #pay'])
  })
})
