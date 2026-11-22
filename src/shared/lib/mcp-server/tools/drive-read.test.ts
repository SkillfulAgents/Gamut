/**
 * readAll against the VolumeFile contract: `stream` once and the stream
 * releases the open when it ends (read through, cancelled, errored); `close`
 * only when no stream is taken.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BaseMountableVolume, VolumeFile } from '@shared/lib/volumes/base-mountable-volume'
import { decodeText, pageLines, readAll } from './drive-tools'

function fakeFile(chunks: Uint8Array[], options: { size?: number; streamFails?: boolean; readFails?: boolean } = {}) {
  const released = { cancelled: false, closed: 0, streams: 0 }
  const file: VolumeFile = {
    size: options.size ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    stream: async () => {
      released.streams++
      if (options.streamFails) throw new Error('remote source refused')
      let index = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (options.readFails && index === 1) return controller.error(new Error('connection reset'))
          if (index < chunks.length) controller.enqueue(chunks[index++])
          else controller.close()
        },
        cancel() { released.cancelled = true },
      })
    },
    close: vi.fn(async () => { released.closed++ }),
  }
  const volume = { read: async () => file } as unknown as BaseMountableVolume<unknown>
  return { volume, released }
}

const bytes = (text: string) => new TextEncoder().encode(text)

describe('readAll', () => {
  it('reads a file through its stream and does not close it again', async () => {
    const { volume, released } = fakeFile([bytes('hello '), bytes('world')])
    const read = await readAll(volume, 'a.txt', 1_000)
    expect(new TextDecoder().decode(read.bytes!)).toBe('hello world')
    expect(released).toEqual({ cancelled: false, closed: 0, streams: 1 })
  })

  it('closes a file it will not read (over the bound by its size) without taking a stream', async () => {
    const { volume, released } = fakeFile([bytes('x')], { size: 5_000 })
    expect(await readAll(volume, 'big.bin', 1_000)).toEqual({ size: 5_000, bytes: null })
    expect(released).toEqual({ cancelled: false, closed: 1, streams: 0 })
  })

  it('cancels the stream of a file whose bytes run past the bound (a wrong size)', async () => {
    const { volume, released } = fakeFile([bytes('a'.repeat(600)), bytes('b'.repeat(600)), bytes('c'), bytes('d')], { size: 10 })
    expect((await readAll(volume, 'liar.bin', 1_000)).bytes).toBeNull()
    expect(released).toMatchObject({ cancelled: true, closed: 0 })
  })

  it('closes the file when its stream cannot be started, and rethrows', async () => {
    const { volume, released } = fakeFile([], { streamFails: true })
    await expect(readAll(volume, 'remote.txt', 1_000)).rejects.toThrow('remote source refused')
    expect(released.closed).toBe(1)
  })

  it('leaves an errored stream to release itself, and rethrows', async () => {
    const { volume, released } = fakeFile([bytes('a'), bytes('b')], { readFails: true })
    await expect(readAll(volume, 'flaky.txt', 1_000)).rejects.toThrow('connection reset')
    expect(released.closed).toBe(0)
  })
})

describe('text helpers', () => {
  it('decodes UTF-8 text and refuses NUL bytes or invalid UTF-8', () => {
    expect(decodeText(bytes('héllo'))).toBe('héllo')
    expect(decodeText(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull()
    expect(decodeText(new Uint8Array([0xff, 0xfe]))).toBeNull()
  })

  it('pages lines within a character budget, cutting a line longer than a page', () => {
    expect(pageLines('a\nb\nc\n', 1, 1, 100)).toMatchObject({ content: 'b', linesReturned: 1, totalLines: 3, nextOffset: 2 })
    const long = pageLines(`${'x'.repeat(50)}\nnext`, 0, 10, 20)
    expect(long).toMatchObject({ linesReturned: 1, nextOffset: 1, truncatedLine: true })
  })
})
