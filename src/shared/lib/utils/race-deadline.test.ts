import { describe, expect, it } from 'vitest'
import { DEADLINE, raceDeadline } from './race-deadline'

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

describe('raceDeadline', () => {
  it('answers the value when the promise settles first', async () => {
    expect(await raceDeadline(later(5, 'done'), Date.now() + 1_000)).toBe('done')
  })

  it('answers DEADLINE when the deadline passes first, leaving the promise running', async () => {
    let settled = false
    const work = later(80, 'late').then((value) => { settled = true; return value })
    expect(await raceDeadline(work, Date.now() + 10)).toBe(DEADLINE)
    expect(settled).toBe(false)
    expect(await work).toBe('late')
  })

  it('answers DEADLINE at once for a deadline already past, even for a settled promise', async () => {
    expect(await raceDeadline(Promise.resolve('ready'), Date.now() - 1)).toBe(DEADLINE)
  })

  it('passes a rejection that comes first through', async () => {
    await expect(raceDeadline(Promise.reject(new Error('boom')), Date.now() + 1_000)).rejects.toThrow('boom')
  })
})
